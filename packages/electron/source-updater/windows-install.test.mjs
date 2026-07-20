import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  consumeWindowsInstallResult,
  scheduleWindowsInstallAndRelaunch,
  stageWindowsInstaller,
  verifyPreparedWindowsInstaller,
} from './windows-install.mjs';

const sha = (character) => character.repeat(40);

const createFixture = async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-windows-install-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  const updateRoot = path.join(root, 'local-app-data', 'OpenChamberUpdate');
  const dist = path.join(repository, 'packages', 'electron', 'dist');
  await Promise.all([
    fsp.mkdir(dist, { recursive: true }),
    fsp.mkdir(updateRoot, { recursive: true }),
  ]);
  const installer = path.join(dist, 'OpenChamber-2.0.0-win-x64.exe');
  await fsp.writeFile(installer, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62, 1)]));
  return { root, repository, updateRoot, installer };
};

test('gates and content-addresses the built Windows installer', async (context) => {
  const fixture = await createFixture(context);
  const ready = await stageWindowsInstaller({
    stagingRepository: fixture.repository,
    updateRoot: fixture.updateRoot,
    version: '2.0.0',
    architecture: 'x64',
    upstreamSha: sha('a'),
    sourceHeadSha: sha('c'),
    rebasedHeadSha: sha('b'),
    minInstallerBytes: 2,
    createId: (() => {
      let value = 0;
      return () => `fixture-${value += 1}`;
    })(),
  });
  assert.match(ready.installer.file, /^OpenChamber-2\.0\.0-win-x64-[0-9a-f]{16}\.exe$/);
  await verifyPreparedWindowsInstaller({
    updateRoot: fixture.updateRoot,
    readyManifest: ready,
    minInstallerBytes: 2,
  });

  await fsp.appendFile(path.join(fixture.updateRoot, 'ready', ready.installer.file), 'tampered');
  await assert.rejects(
    verifyPreparedWindowsInstaller({
      updateRoot: fixture.updateRoot,
      readyManifest: ready,
      minInstallerBytes: 2,
    }),
    /size does not match/,
  );
});

test('schedules a single detached hidden helper only after re-verification', async (context) => {
  const fixture = await createFixture(context);
  const ready = await stageWindowsInstaller({
    stagingRepository: fixture.repository,
    updateRoot: fixture.updateRoot,
    version: '2.0.0',
    architecture: 'x64',
    upstreamSha: sha('a'),
    sourceHeadSha: sha('c'),
    rebasedHeadSha: sha('b'),
    minInstallerBytes: 2,
  });
  const systemRoot = path.join(fixture.root, 'Windows');
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const currentExecutable = path.join(fixture.root, 'OpenChamber.exe');
  await fsp.mkdir(path.dirname(powershell), { recursive: true });
  await Promise.all([
    fsp.writeFile(powershell, 'fixture'),
    fsp.writeFile(currentExecutable, 'fixture'),
  ]);
  const calls = [];
  const result = await scheduleWindowsInstallAndRelaunch({
    updateRoot: fixture.updateRoot,
    readyManifest: ready,
    currentExecutablePath: currentExecutable,
    currentProcessId: 1234,
    platform: 'win32',
    systemRoot,
    environment: {
      SystemRoot: systemRoot,
      PATH: process.env.PATH,
      OPENAI_API_KEY: 'must-not-leak',
    },
    minInstallerBytes: 2,
    spawnDetached: async (...args) => calls.push(args),
  });
  assert.equal(result.scheduled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], powershell);
  assert.ok(calls[0][1].includes('-NonInteractive'));
  assert.ok(calls[0][1].includes('-WindowStyle'));
  const encoded = calls[0][1].at(-1);
  const helper = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.match(helper, /Get-FileHash/);
  assert.match(helper, /UTF8Encoding\(\$false\)/);
  assert.match(helper, /Start-Process -FilePath \$installer/);
  assert.match(helper, /Write-InstallResult 'error' \$failureCode/);
  assert.match(helper, /\$resultFile = \$candidateResultFile/);
  assert.match(helper, /-not \$targetStillRunning/);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[0][2].env.OPENAI_API_KEY, undefined);
});

test('consumes a bounded install result exactly once', async (context) => {
  const fixture = await createFixture(context);
  const reportsDirectory = path.join(fixture.updateRoot, 'reports');
  await fsp.mkdir(reportsDirectory, { recursive: true });
  await fsp.writeFile(path.join(reportsDirectory, 'install-result.json'), JSON.stringify({
    status: 'error',
    code: 'installer_hash_mismatch',
    completedAt: '2026-07-20T12:00:00.000Z',
  }));

  assert.deepEqual(await consumeWindowsInstallResult({ updateRoot: fixture.updateRoot }), {
    status: 'error',
    code: 'installer_hash_mismatch',
    completedAt: '2026-07-20T12:00:00.000Z',
  });
  assert.equal(await consumeWindowsInstallResult({ updateRoot: fixture.updateRoot }), null);
});

test('rejects and removes inconsistent install results', async (context) => {
  const fixture = await createFixture(context);
  const reportsDirectory = path.join(fixture.updateRoot, 'reports');
  const resultFile = path.join(reportsDirectory, 'install-result.json');
  await fsp.mkdir(reportsDirectory, { recursive: true });
  await fsp.writeFile(resultFile, JSON.stringify({
    status: 'success',
    code: 'installer_failed',
    completedAt: '2026-07-20T12:00:00.000Z',
  }));

  await assert.rejects(
    consumeWindowsInstallResult({ updateRoot: fixture.updateRoot }),
    (error) => error.code === 'INVALID_INSTALL_RESULT',
  );
  await assert.rejects(fsp.stat(resultFile), (error) => error.code === 'ENOENT');
});
