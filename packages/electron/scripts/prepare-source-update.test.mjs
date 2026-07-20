import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashFileSha256 } from '../source-updater/contracts.mjs';
import { createCommandRunner } from '../source-updater/process-runner.mjs';
import { prepareSourceUpdate } from './prepare-source-update.mjs';

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

test('builds an atomic verified bundle from a clean linear topic stack', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-source-build-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const officialWorktree = path.join(root, 'official-worktree');
  const officialBare = path.join(root, 'official.git');
  const customWorktree = path.join(root, 'custom-worktree');
  const output = path.join(root, 'output');

  await fsp.mkdir(officialWorktree, { recursive: true });
  git(officialWorktree, ['init', '--initial-branch=main']);
  git(officialWorktree, ['config', 'user.name', 'Fixture']);
  git(officialWorktree, ['config', 'user.email', 'fixture@example.invalid']);
  await write(path.join(officialWorktree, 'packages/electron/package.json'), JSON.stringify({ version: '1.0.0' }));
  await write(path.join(officialWorktree, 'base.txt'), 'base\n');
  git(officialWorktree, ['add', '.']);
  git(officialWorktree, ['commit', '-m', 'base']);
  const baseSha = git(officialWorktree, ['rev-parse', 'HEAD']);
  git(root, ['clone', '--bare', officialWorktree, officialBare]);
  git(root, ['clone', officialBare, customWorktree]);
  git(customWorktree, ['config', 'user.name', 'Fixture']);
  git(customWorktree, ['config', 'user.email', 'fixture@example.invalid']);
  git(customWorktree, ['remote', 'rename', 'origin', 'upstream']);
  git(customWorktree, ['switch', '-c', 'codex/custom-source-updater']);
  await write(path.join(customWorktree, 'topic-one.txt'), 'one\n');
  git(customWorktree, ['add', '.']);
  git(customWorktree, ['commit', '-m', 'feat: topic one']);
  await write(path.join(customWorktree, 'topic-two.txt'), 'two\n');
  git(customWorktree, ['add', '.']);
  git(customWorktree, ['commit', '-m', 'feat: topic two']);
  const customHead = git(customWorktree, ['rev-parse', 'HEAD']);

  await write(path.join(officialWorktree, 'upstream.txt'), 'new upstream\n');
  git(officialWorktree, ['add', '.']);
  git(officialWorktree, ['commit', '-m', 'feat: upstream']);
  git(officialWorktree, ['push', officialBare, 'main']);
  const observedSha = git(officialWorktree, ['rev-parse', 'HEAD']);
  git(customWorktree, ['fetch', 'upstream', 'main']);

  const commandEnvironments = [];
  const realRunCommand = createCommandRunner();
  const manifest = await prepareSourceUpdate({
    repoRoot: customWorktree,
    outputDirectory: output,
    expectedRepositoryUrl: officialBare,
    now: () => new Date('2026-07-20T12:00:00.000Z'),
    environment: {
      ...process.env,
      OPENAI_API_KEY: 'must-not-leak',
      GITHUB_TOKEN: 'must-not-leak',
    },
    runCommand: (...args) => {
      commandEnvironments.push(args[2].env);
      return realRunCommand(...args);
    },
  });
  assert.equal(manifest.official.baseSha, baseSha);
  assert.equal(manifest.official.observedSha, observedSha);
  assert.equal(manifest.customizations.headSha, customHead);
  assert.equal(manifest.customizations.commitCount, 2);
  const bundlePath = path.join(output, manifest.customizations.bundle.file);
  assert.equal(await hashFileSha256(bundlePath), manifest.customizations.bundle.sha256);
  assert.match(git(customWorktree, ['bundle', 'list-heads', bundlePath]), new RegExp(`^${customHead} refs/heads/codex/custom-source-updater$`));
  assert.equal((await fsp.readdir(output)).filter((file) => file.endsWith('.bundle')).length, 1);
  assert.ok(commandEnvironments.length > 0);
  assert.ok(commandEnvironments.every((value) => value.OPENAI_API_KEY === undefined));
  assert.ok(commandEnvironments.every((value) => value.GITHUB_TOKEN === undefined));

  await write(path.join(customWorktree, 'dirty.txt'), 'dirty\n');
  await assert.rejects(
    prepareSourceUpdate({
      repoRoot: customWorktree,
      outputDirectory: output,
      expectedRepositoryUrl: officialBare,
    }),
    /completely clean Git worktree/,
  );

  await fsp.rm(path.join(customWorktree, 'dirty.txt'));
  git(customWorktree, ['switch', '-c', 'fixture-side-topic']);
  await write(path.join(customWorktree, 'side-topic.txt'), 'side\n');
  git(customWorktree, ['add', '.']);
  git(customWorktree, ['commit', '-m', 'feat: side topic']);
  git(customWorktree, ['switch', 'codex/custom-source-updater']);
  await write(path.join(customWorktree, 'main-topic.txt'), 'main\n');
  git(customWorktree, ['add', '.']);
  git(customWorktree, ['commit', '-m', 'feat: main topic']);
  git(customWorktree, ['merge', '--no-ff', 'fixture-side-topic', '-m', 'merge fixture topic']);
  await assert.rejects(
    prepareSourceUpdate({
      repoRoot: customWorktree,
      outputDirectory: output,
      expectedRepositoryUrl: officialBare,
    }),
    /must be linear and contain no merge commits/,
  );
});
