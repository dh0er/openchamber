import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareSourceUpdate } from '../scripts/prepare-source-update.mjs';
import { createSourceUpdater } from './core.mjs';
import { createCommandRunner } from './process-runner.mjs';

const gitExecutable = process.platform === 'win32' ? 'git.exe' : 'git';
const git = (cwd, args) => execFileSync(gitExecutable, args, {
  cwd,
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const write = async (filePath, contents) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents);
};

test('imports the packaged patch bundle and really rebases it onto the pinned upstream SHA', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-source-e2e-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const officialWorktree = path.join(root, 'official-worktree');
  const officialBare = path.join(root, 'official.git');
  const customWorktree = path.join(root, 'custom-worktree');
  const resourcesPath = path.join(root, 'packaged-resources');
  const resourceDirectory = path.join(resourcesPath, 'source-update');
  const localAppData = path.join(root, 'local-app-data');

  await fsp.mkdir(officialWorktree, { recursive: true });
  git(officialWorktree, ['init', '--initial-branch=main']);
  git(officialWorktree, ['config', 'user.name', 'Fixture']);
  git(officialWorktree, ['config', 'user.email', 'fixture@example.invalid']);
  await write(path.join(officialWorktree, 'packages/electron/package.json'), JSON.stringify({ version: '2.0.0' }));
  await write(path.join(officialWorktree, 'package.json'), JSON.stringify({
    packageManager: 'bun@1.3.14',
    engines: { node: '>=22.0.0' },
  }));
  await write(path.join(officialWorktree, 'base.txt'), 'base\n');
  git(officialWorktree, ['add', '.']);
  git(officialWorktree, ['commit', '-m', 'base']);
  git(root, ['clone', '--bare', officialWorktree, officialBare]);
  git(root, ['clone', officialBare, customWorktree]);
  git(customWorktree, ['config', 'user.name', 'Fixture']);
  git(customWorktree, ['config', 'user.email', 'fixture@example.invalid']);
  git(customWorktree, ['remote', 'rename', 'origin', 'upstream']);
  git(customWorktree, ['switch', '-c', 'codex/custom-source-updater']);
  await write(path.join(customWorktree, 'custom.txt'), 'custom patch\n');
  git(customWorktree, ['add', '.']);
  git(customWorktree, ['commit', '-m', 'feat: custom patch']);

  await write(path.join(officialWorktree, 'upstream.txt'), 'new upstream\n');
  git(officialWorktree, ['add', '.']);
  git(officialWorktree, ['commit', '-m', 'feat: upstream change']);
  git(officialWorktree, ['push', officialBare, 'main']);
  const targetSha = git(officialWorktree, ['rev-parse', 'HEAD']);
  git(customWorktree, ['fetch', 'upstream', 'main']);

  await prepareSourceUpdate({
    repoRoot: customWorktree,
    outputDirectory: resourceDirectory,
    expectedRepositoryUrl: officialBare,
  });

  const realRunCommand = createCommandRunner();
  const observed = {};
  const runCommand = async (executable, args, options) => {
    if (executable === 'node-fixture' && args.length === 1 && args[0] === '--version') {
      return { code: 0, stdout: 'v24.15.0\n', stderr: '' };
    }
    if (executable !== 'bun-fixture') return realRunCommand(executable, args, options);
    if (args.length === 1 && args[0] === '--version') {
      return { code: 0, stdout: '1.3.14\n', stderr: '' };
    }
    if (args[0] === 'test') {
      observed.head = git(options.cwd, ['rev-parse', 'HEAD']);
      observed.base = git(options.cwd, ['merge-base', 'HEAD', 'refs/remotes/upstream/main']);
      observed.commitSubjects = git(options.cwd, [
        'log',
        '--format=%s',
        '--reverse',
        'refs/remotes/upstream/main..HEAD',
      ]).split(/\r?\n/).filter(Boolean);
      observed.customFile = await fsp.readFile(path.join(options.cwd, 'custom.txt'), 'utf8');
      observed.upstreamFile = await fsp.readFile(path.join(options.cwd, 'upstream.txt'), 'utf8');
    }
    if (args.at(-1) === 'electron:build') {
      const distDirectory = path.join(options.cwd, 'packages', 'electron', 'dist');
      await prepareSourceUpdate({
        repoRoot: options.cwd,
        outputDirectory: path.join(distDirectory, 'win-unpacked', 'resources', 'source-update'),
        expectedRepositoryUrl: officialBare,
      });
      await fsp.mkdir(distDirectory, { recursive: true });
      await fsp.writeFile(
        path.join(distDirectory, 'OpenChamber-2.0.0-win-x64.exe'),
        Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62, 1)]),
      );
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const updater = createSourceUpdater({
    resourcesPath,
    currentExecutablePath: path.join(root, 'OpenChamber.exe'),
    localAppData,
    platform: 'win32',
    architecture: 'x64',
    environment: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      USERPROFILE: root,
    },
    dependencies: {
      runCommand,
      officialRepositoryUrl: officialBare,
      bunExecutable: 'bun-fixture',
      nodeExecutable: 'node-fixture',
      minInstallerBytes: 2,
    },
  });

  const checked = await updater.check();
  assert.equal(checked.latestUpstreamSha, targetSha);
  const prepared = await updater.prepare({ expectedUpstreamSha: targetSha });

  assert.equal(prepared.upstreamSha, targetSha);
  assert.notEqual(observed.head, targetSha);
  assert.equal(observed.base, targetSha);
  assert.deepEqual(observed.commitSubjects, ['feat: custom patch']);
  assert.equal(observed.customFile, 'custom patch\n');
  assert.equal(observed.upstreamFile, 'new upstream\n');
});
