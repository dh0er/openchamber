import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  READY_UPDATE_MANIFEST_FILE,
  SOURCE_UPDATE_KIND,
  SOURCE_UPDATE_MANIFEST_FILE,
  SOURCE_UPDATE_SCHEMA_VERSION,
  hashFileSha256,
} from './contracts.mjs';
import { createSourceUpdater } from './core.mjs';

const SHAS = Object.freeze({
  base: 'a'.repeat(40),
  target: 'b'.repeat(40),
  custom: 'c'.repeat(40),
  rebased: 'd'.repeat(40),
});

const writeFixtureLock = async (
  updateRoot,
  pid,
  nonceCharacter = 'a',
  modifiedAt = new Date('2026-07-20T12:00:00.000Z'),
) => {
  const locksDirectory = path.join(updateRoot, 'locks');
  await fsp.mkdir(locksDirectory, { recursive: true });
  const nonce = nonceCharacter.repeat(32);
  const lockPath = path.join(locksDirectory, `update-${pid}-${nonce}.lock`);
  await fsp.writeFile(lockPath, JSON.stringify({ pid, nonce }));
  await fsp.utimes(lockPath, modifiedAt, modifiedAt);
  return lockPath;
};

const createFixture = async (
  context,
  {
    rebaseConflict = false,
    rebaseFailure = false,
    failingPipelineStage = null,
    brokenBundleChain = false,
    installedBunVersion = '1.3.14',
    isProcessAlive,
  } = {},
) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-source-core-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const localAppData = path.join(root, 'local-app-data');
  const resourcesPath = path.join(root, 'resources');
  const resourceDirectory = path.join(resourcesPath, 'source-update');
  await Promise.all([
    fsp.mkdir(localAppData, { recursive: true }),
    fsp.mkdir(resourceDirectory, { recursive: true }),
  ]);
  const bundleFile = 'customizations-fixture.bundle';
  const bundlePath = path.join(resourceDirectory, bundleFile);
  await fsp.writeFile(bundlePath, 'fixture-bundle');
  const bundleStat = await fsp.stat(bundlePath);
  const repositoryUrl = 'https://fixture.invalid/openchamber.git';
  await fsp.writeFile(path.join(resourceDirectory, SOURCE_UPDATE_MANIFEST_FILE), JSON.stringify({
    schemaVersion: SOURCE_UPDATE_SCHEMA_VERSION,
    kind: SOURCE_UPDATE_KIND,
    generatedAt: '2026-07-20T12:00:00.000Z',
    official: {
      repositoryUrl,
      branch: 'main',
      trackingRef: 'refs/remotes/upstream/main',
      baseSha: SHAS.base,
      observedSha: SHAS.base,
    },
    customizations: {
      branchRef: 'refs/heads/codex/custom-source-updater',
      headSha: SHAS.custom,
      commitCount: brokenBundleChain ? 2 : 1,
      bundle: {
        file: bundleFile,
        sha256: await hashFileSha256(bundlePath),
        size: bundleStat.size,
      },
    },
    application: { version: '1.16.2' },
  }));

  const calls = [];
  const pipelineCalls = [];
  let repositoryPath;
  const runCommand = async (executable, args, options) => {
    calls.push({ executable, args, cwd: options.cwd, env: options.env });
    if (args.includes('ls-remote')) {
      return { code: 0, stdout: `${SHAS.target}\trefs/heads/main\n`, stderr: '' };
    }
    if (args.includes('init')) {
      repositoryPath = args.at(-1);
      await fsp.mkdir(repositoryPath, { recursive: true });
      await fsp.writeFile(path.join(repositoryPath, 'package.json'), JSON.stringify({
        packageManager: 'bun@1.3.14',
        engines: { node: '>=22.0.0' },
      }));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (executable === 'bun-fixture' && args.length === 1 && args[0] === '--version') {
      return { code: 0, stdout: `${installedBunVersion}\n`, stderr: '' };
    }
    if (executable === 'node-fixture' && args.length === 1 && args[0] === '--version') {
      return { code: 0, stdout: 'v24.15.0\n', stderr: '' };
    }
    if (executable === 'bun-fixture') {
      const stage = args[0] === 'install' ? 'install-dependencies' : args.at(-1);
      pipelineCalls.push(stage);
      if (stage === failingPipelineStage) {
        return { code: 2, stdout: '', stderr: `${options.cwd} https://alice:secret@example.invalid failed` };
      }
      if (stage === 'electron:build') {
        const electronDirectory = path.join(repositoryPath, 'packages', 'electron');
        const packagedSourceDirectory = path.join(
          electronDirectory,
          'dist',
          'win-unpacked',
          'resources',
          'source-update',
        );
        await fsp.mkdir(packagedSourceDirectory, { recursive: true });
        const packagedBundle = path.join(packagedSourceDirectory, 'customizations-rebased.bundle');
        await fsp.writeFile(packagedBundle, 'rebased-fixture-bundle');
        const packagedBundleStat = await fsp.stat(packagedBundle);
        await Promise.all([
          fsp.writeFile(path.join(electronDirectory, 'package.json'), JSON.stringify({ version: '2.0.0' })),
          fsp.writeFile(
            path.join(electronDirectory, 'dist', 'OpenChamber-2.0.0-win-x64.exe'),
            Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62, 1)]),
          ),
          fsp.writeFile(path.join(packagedSourceDirectory, SOURCE_UPDATE_MANIFEST_FILE), JSON.stringify({
            schemaVersion: SOURCE_UPDATE_SCHEMA_VERSION,
            kind: SOURCE_UPDATE_KIND,
            generatedAt: '2026-07-20T12:00:00.000Z',
            official: {
              repositoryUrl,
              branch: 'main',
              trackingRef: 'refs/remotes/upstream/main',
              baseSha: SHAS.target,
              observedSha: SHAS.target,
            },
            customizations: {
              branchRef: 'refs/heads/openchamber-customizations',
              headSha: SHAS.rebased,
              commitCount: 1,
              bundle: {
                file: path.basename(packagedBundle),
                sha256: await hashFileSha256(packagedBundle),
                size: packagedBundleStat.size,
              },
            },
            application: { version: '2.0.0' },
          })),
        ]);
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('list-heads')) {
      if (args.some((value) => value.includes('win-unpacked'))) {
        return {
          code: 0,
          stdout: `${SHAS.rebased} refs/heads/openchamber-customizations\n`,
          stderr: '',
        };
      }
      return {
        code: 0,
        stdout: `${SHAS.custom} refs/heads/codex/custom-source-updater\n`,
        stderr: '',
      };
    }
    if (args.includes('rev-list')) {
      if (args.includes(`${SHAS.target}..${SHAS.rebased}`)) {
        return { code: 0, stdout: `${SHAS.rebased} ${SHAS.target}\n`, stderr: '' };
      }
      if (brokenBundleChain) {
        return {
          code: 0,
          stdout: `${'e'.repeat(40)} ${SHAS.base}\n${SHAS.custom} ${SHAS.base}\n`,
          stderr: '',
        };
      }
      return { code: 0, stdout: `${SHAS.custom} ${SHAS.base}\n`, stderr: '' };
    }
    if (args.includes('rev-parse')) {
      const revision = args.at(-1);
      if (revision.startsWith('refs/remotes/upstream/')) {
        return { code: 0, stdout: `${SHAS.target}\n`, stderr: '' };
      }
      if (revision.startsWith('refs/heads/openchamber-customizations')) {
        return { code: 0, stdout: `${SHAS.custom}\n`, stderr: '' };
      }
      return { code: 0, stdout: `${SHAS.rebased}\n`, stderr: '' };
    }
    if (args.includes('rebase') && args.includes('--onto')) {
      return rebaseConflict || rebaseFailure
        ? { code: 1, stdout: '', stderr: `${options.cwd} conflict https://alice:secret@example.invalid/repo` }
        : { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('diff')) {
      return {
        code: 0,
        stdout: rebaseConflict ? 'packages/ui/src/conflict.ts\0' : '',
        stderr: '',
      };
    }
    if (args.includes('REBASE_HEAD')) {
      return { code: 0, stdout: 'feat: managed provider instances\n', stderr: '' };
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
      LOCALAPPDATA: localAppData,
      USERPROFILE: root,
      PATH: process.env.PATH,
      HTTPS_PROXY: 'https://proxy-user:proxy-secret@proxy.example.invalid:9000',
      OPENAI_API_KEY: 'must-not-leak',
      GITHUB_TOKEN: 'must-not-leak',
      PROVIDER_PASSWORD: 'must-not-leak',
    },
    dependencies: {
      runCommand,
      officialRepositoryUrl: repositoryUrl,
      bunExecutable: 'bun-fixture',
      nodeExecutable: 'node-fixture',
      minInstallerBytes: 2,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      createId: (() => {
        let id = 0;
        return () => `fixture-${id += 1}`;
      })(),
      ...(isProcessAlive ? { isProcessAlive } : {}),
    },
  });
  return { root, localAppData, resourcesPath, updater, calls, pipelineCalls };
};

test('checks exact upstream SHA then prepares a gated installer through every stage', async (context) => {
  const fixture = await createFixture(context);
  const checked = await fixture.updater.check();
  assert.equal(checked.available, true);
  assert.equal(checked.currentUpstreamSha, SHAS.base);
  assert.equal(checked.latestUpstreamSha, SHAS.target);

  const progress = [];
  const prepared = await fixture.updater.prepare({
    expectedUpstreamSha: checked.latestUpstreamSha,
    onProgress: (event) => progress.push(event.stage),
  });
  assert.equal(prepared.version, '2.0.0');
  assert.equal(prepared.upstreamSha, SHAS.target);
  assert.deepEqual(fixture.pipelineCalls, [
    'install-dependencies',
    'test',
    'type-check',
    'lint',
    'electron:build',
  ]);
  assert.deepEqual(progress, [
    'verify',
    'fetch',
    'verify-bundle',
    'rebase',
    'install-dependencies',
    'test',
    'type-check',
    'lint',
    'build',
    'prepare-installer',
    'ready',
  ]);
  assert.deepEqual(await fixture.updater.readPreparedUpdate(), prepared);
  await assert.rejects(
    fixture.updater.scheduleInstallAndRelaunch({ expectedUpstreamSha: SHAS.base }),
    (error) => error.code === 'PREPARED_UPDATE_MISMATCH',
  );
  const readyManifestPath = path.join(
    fixture.localAppData,
    'OpenChamberUpdate',
    'ready',
    READY_UPDATE_MANIFEST_FILE,
  );
  const wrongArchitectureManifest = JSON.parse(await fsp.readFile(readyManifestPath, 'utf8'));
  wrongArchitectureManifest.architecture = 'arm64';
  await fsp.writeFile(readyManifestPath, JSON.stringify(wrongArchitectureManifest));
  assert.equal(await fixture.updater.readPreparedUpdate(), null);
  for (const call of fixture.calls) {
    assert.equal(call.env.OPENAI_API_KEY, undefined);
    assert.equal(call.env.GITHUB_TOKEN, undefined);
    assert.equal(call.env.PROVIDER_PASSWORD, undefined);
  }
  const buildCalls = fixture.calls.filter((call) => call.executable === 'bun-fixture');
  const networkBuildCalls = buildCalls.filter((call) => (
    call.args[0] === 'install' || call.args.at(-1) === 'electron:build'
  ));
  const validationBuildCalls = buildCalls.filter((call) => !networkBuildCalls.includes(call));
  assert.ok(networkBuildCalls.every((call) => (
    call.env.HTTPS_PROXY === 'https://proxy-user:proxy-secret@proxy.example.invalid:9000'
  )));
  assert.ok(validationBuildCalls.every((call) => call.env.HTTPS_PROXY === undefined));
  assert.ok(buildCalls.every((call) => call.env.BUN_INSTALL_CACHE_DIR.includes('OpenChamberUpdate')));
  assert.ok(buildCalls.every((call) => call.env.ELECTRON_BUILDER_CACHE.includes('OpenChamberUpdate')));
  assert.ok(buildCalls.every((call) => call.env.TEMP.includes('OpenChamberUpdate')));
  assert.ok(buildCalls.every((call) => call.env.USERPROFILE.includes('OpenChamberUpdate')));
  assert.ok(buildCalls.every((call) => call.env.APPDATA.includes('OpenChamberUpdate')));
  assert.ok(buildCalls.every((call) => call.env.LOCALAPPDATA.includes('OpenChamberUpdate')));
  assert.ok(buildCalls.every((call) => call.env.npm_config_userconfig.includes('OpenChamberUpdate')));
  assert.ok(buildCalls.every((call) => call.env.USERPROFILE !== fixture.root));
  const staging = path.join(fixture.localAppData, 'OpenChamberUpdate', 'staging');
  assert.deepEqual(await fsp.readdir(staging), []);
});

test('aborts conflicts, persists only bounded sanitized details, and skips all gates', async (context) => {
  const fixture = await createFixture(context, { rebaseConflict: true });
  await assert.rejects(
    fixture.updater.prepare({ expectedUpstreamSha: SHAS.target }),
    (error) => {
      assert.equal(error.code, 'REBASE_CONFLICT');
      assert.equal(error.report.stage, 'rebase');
      assert.deepEqual(error.report.conflictFiles, ['packages/ui/src/conflict.ts']);
      assert.equal(error.report.patchSubject, 'feat: managed provider instances');
      assert.equal(error.report.rebaseAborted, true);
      assert.match(error.report.reportFile, /^report-fixture-/);
      assert.doesNotMatch(error.report.logTail, /alice|secret|openchamber-source-core-/);
      return true;
    },
  );
  assert.deepEqual(fixture.pipelineCalls, []);
  assert.ok(fixture.calls.some((call) => call.args.includes('--abort')));
  const reports = await fsp.readdir(path.join(fixture.localAppData, 'OpenChamberUpdate', 'reports'));
  assert.equal(reports.length, 1);
});

test('reports a non-conflict rebase failure without claiming conflicted files', async (context) => {
  const fixture = await createFixture(context, { rebaseFailure: true });
  await assert.rejects(
    fixture.updater.prepare({ expectedUpstreamSha: SHAS.target }),
    (error) => {
      assert.equal(error.code, 'REBASE_FAILED');
      assert.equal(error.report.type, 'rebase-failed');
      assert.deepEqual(error.report.conflictFiles, []);
      assert.equal(error.report.rebaseAborted, true);
      return true;
    },
  );
  assert.deepEqual(fixture.pipelineCalls, []);
});

test('rejects a bundled customization stack with a broken parent chain', async (context) => {
  const fixture = await createFixture(context, { brokenBundleChain: true });
  await assert.rejects(
    fixture.updater.prepare({ expectedUpstreamSha: SHAS.target }),
    (error) => error.code === 'BUNDLE_INTEGRITY_FAILED',
  );
  assert.deepEqual(fixture.pipelineCalls, []);
});

test('reclaims a lock owned by a dead updater process', async (context) => {
  const fixture = await createFixture(context, { isProcessAlive: () => false });
  const updateRoot = path.join(fixture.localAppData, 'OpenChamberUpdate');
  await fsp.mkdir(updateRoot, { recursive: true });
  const deadLock = await writeFixtureLock(updateRoot, 424242);
  const abandonedRun = path.join(updateRoot, 'staging', 'run-abandoned');
  await fsp.mkdir(abandonedRun, { recursive: true });
  await fsp.writeFile(path.join(abandonedRun, 'partial-build.txt'), 'abandoned');

  const prepared = await fixture.updater.prepare({ expectedUpstreamSha: SHAS.target });
  assert.equal(prepared.upstreamSha, SHAS.target);
  assert.deepEqual(await fsp.readdir(path.join(updateRoot, 'staging')), []);
  await assert.rejects(fsp.stat(deadLock), (error) => error.code === 'ENOENT');
});

test('does not steal a lock from a live updater process', async (context) => {
  const fixture = await createFixture(context, { isProcessAlive: () => true });
  const updateRoot = path.join(fixture.localAppData, 'OpenChamberUpdate');
  await fsp.mkdir(updateRoot, { recursive: true });
  const liveLock = await writeFixtureLock(updateRoot, 424242);

  await assert.rejects(
    fixture.updater.prepare({ expectedUpstreamSha: SHAS.target }),
    (error) => error.code === 'UPDATE_BUSY',
  );
  assert.equal((await fsp.stat(liveLock)).isFile(), true);
});

test('never lets concurrent preparations from the same process both pass the lock', async (context) => {
  const fixture = await createFixture(context, { isProcessAlive: () => true });
  const results = await Promise.allSettled([
    fixture.updater.prepare({ expectedUpstreamSha: SHAS.target }),
    fixture.updater.prepare({ expectedUpstreamSha: SHAS.target }),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.ok(fulfilled.length <= 1);
  assert.ok(rejected.length >= 1);
  assert.ok(rejected.every((result) => result.reason?.code === 'UPDATE_BUSY'));
  assert.ok(fixture.pipelineCalls.length <= 5);

  const locksDirectory = path.join(fixture.localAppData, 'OpenChamberUpdate', 'locks');
  assert.deepEqual(await fsp.readdir(locksDirectory), []);
  if (fulfilled.length === 0) {
    const retry = await fixture.updater.prepare({ expectedUpstreamSha: SHAS.target });
    assert.equal(retry.upstreamSha, SHAS.target);
  }
});

test('reclaims a stale heartbeat even when its PID has been reused', async (context) => {
  const fixture = await createFixture(context, { isProcessAlive: () => true });
  const updateRoot = path.join(fixture.localAppData, 'OpenChamberUpdate');
  await fsp.mkdir(updateRoot, { recursive: true });
  const reusedPidLock = await writeFixtureLock(
    updateRoot,
    424242,
    'b',
    new Date('2026-07-20T11:55:00.000Z'),
  );

  const prepared = await fixture.updater.prepare({ expectedUpstreamSha: SHAS.target });
  assert.equal(prepared.upstreamSha, SHAS.target);
  await assert.rejects(fsp.stat(reusedPidLock), (error) => error.code === 'ENOENT');
});

test('stops at a failed validation gate and never produces a ready installer', async (context) => {
  const fixture = await createFixture(context, { failingPipelineStage: 'type-check' });
  await assert.rejects(
    fixture.updater.prepare({ expectedUpstreamSha: SHAS.target }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_FAILED');
      assert.equal(error.report.stage, 'type-check');
      assert.doesNotMatch(error.report.logTail, /alice|secret|openchamber-source-core-/);
      return true;
    },
  );
  assert.deepEqual(fixture.pipelineCalls, ['install-dependencies', 'test', 'type-check']);
  await assert.rejects(fsp.stat(path.join(fixture.localAppData, 'OpenChamberUpdate', 'ready')));
});

test('stops before dependency installation when the pinned Bun version is unavailable', async (context) => {
  const fixture = await createFixture(context, { installedBunVersion: '1.3.13' });
  await assert.rejects(
    fixture.updater.prepare({ expectedUpstreamSha: SHAS.target }),
    (error) => {
      assert.equal(error.code, 'TOOLCHAIN_MISMATCH');
      assert.equal(error.report.stage, 'install-dependencies');
      return true;
    },
  );
  assert.deepEqual(fixture.pipelineCalls, []);
});
