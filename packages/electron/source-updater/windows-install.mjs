import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  READY_UPDATE_KIND,
  READY_UPDATE_MANIFEST_FILE,
  READY_UPDATE_SCHEMA_VERSION,
  SourceUpdateError,
  assertPathInside,
  ensureRealDirectoryInside,
  hashFileSha256,
  readJsonFile,
  toPublicPreparedUpdate,
  validateReadyUpdateManifest,
  writeJsonAtomic,
} from './contracts.mjs';
import { createSafeChildEnvironment } from './environment.mjs';

const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,99}$/;
const WINDOWS_ARCHITECTURES = new Set(['x64', 'arm64']);
const DEFAULT_MIN_INSTALLER_BYTES = 1024 * 1024;
const INSTALL_RESULT_CODES = new Set([
  'installed',
  'unsafe_installer_path',
  'unsafe_result_path',
  'invalid_installer_extension',
  'invalid_relaunch_extension',
  'app_exit_timeout',
  'installer_missing',
  'installer_hash_mismatch',
  'installer_size_mismatch',
  'installer_failed',
  'relaunch_missing',
  'helper_failed',
]);

const assertRegularFile = async (filePath, code, message) => {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    throw new SourceUpdateError(code, message, { cause: error });
  }
  if (!stat.isFile()) throw new SourceUpdateError(code, message);
  return stat;
};

const assertPeExecutable = async (filePath) => {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, 2, 0);
    if (bytesRead !== 2 || header.toString('ascii') !== 'MZ') {
      throw new SourceUpdateError('INVALID_INSTALLER', 'Built Windows installer does not have a valid executable header.');
    }
  } finally {
    await handle.close();
  }
};

const assertRealPathInside = async (rootPath, candidatePath, label) => {
  const [realRoot, realCandidate] = await Promise.all([
    fsp.realpath(rootPath),
    fsp.realpath(candidatePath),
  ]);
  assertPathInside(realRoot, realCandidate, label);
  return realCandidate;
};

export const stageWindowsInstaller = async ({
  stagingRepository,
  updateRoot,
  version,
  architecture,
  upstreamSha,
  sourceHeadSha,
  rebasedHeadSha,
  now = () => new Date(),
  createId = () => crypto.randomUUID(),
  hashFile = hashFileSha256,
  minInstallerBytes = DEFAULT_MIN_INSTALLER_BYTES,
} = {}) => {
  if (!SAFE_VERSION_RE.test(version || '')) {
    throw new SourceUpdateError('INVALID_INSTALLER', 'Electron package version is not safe for an installer file name.');
  }
  if (!WINDOWS_ARCHITECTURES.has(architecture)) {
    throw new SourceUpdateError('INVALID_INSTALLER', `Unsupported Windows installer architecture: ${architecture}.`);
  }

  const expectedFile = `OpenChamber-${version}-win-${architecture}.exe`;
  const distDirectory = path.join(stagingRepository, 'packages', 'electron', 'dist');
  const sourceInstaller = path.join(distDirectory, expectedFile);
  assertPathInside(stagingRepository, sourceInstaller, 'Built installer');
  const sourceStat = await assertRegularFile(
    sourceInstaller,
    'INSTALLER_NOT_FOUND',
    `Electron build did not produce the expected ${expectedFile} installer.`,
  );
  if (sourceStat.size < minInstallerBytes) {
    throw new SourceUpdateError('INVALID_INSTALLER', 'Built Windows installer is unexpectedly small.');
  }
  await assertRealPathInside(stagingRepository, sourceInstaller, 'Built installer');
  await assertPeExecutable(sourceInstaller);
  const sourceSha256 = await hashFile(sourceInstaller);

  const readyDirectory = path.join(updateRoot, 'ready');
  assertPathInside(updateRoot, readyDirectory, 'Ready update directory');
  await ensureRealDirectoryInside(updateRoot, readyDirectory, 'Ready update directory');
  const installerFile = `OpenChamber-${version}-win-${architecture}-${sourceSha256.slice(0, 16)}.exe`;
  const finalInstaller = path.join(readyDirectory, installerFile);
  const temporaryInstaller = path.join(readyDirectory, `.${installerFile}.${process.pid}.${createId()}.tmp`);
  try {
    await fsp.copyFile(sourceInstaller, temporaryInstaller, fsp.constants?.COPYFILE_EXCL);
    const copiedStat = await assertRegularFile(temporaryInstaller, 'INVALID_INSTALLER', 'Copied installer is missing.');
    if (copiedStat.size !== sourceStat.size || await hashFile(temporaryInstaller) !== sourceSha256) {
      throw new SourceUpdateError('INSTALLER_INTEGRITY_FAILED', 'Copied installer failed its integrity check.');
    }
    await assertPeExecutable(temporaryInstaller);
    try {
      await fsp.rename(temporaryInstaller, finalInstaller);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existingStat = await assertRegularFile(finalInstaller, 'INVALID_INSTALLER', 'Prepared installer is invalid.');
      if (existingStat.size !== sourceStat.size || await hashFile(finalInstaller) !== sourceSha256) throw error;
      await fsp.rm(temporaryInstaller, { force: true });
    }

    const readyManifest = validateReadyUpdateManifest({
      schemaVersion: READY_UPDATE_SCHEMA_VERSION,
      kind: READY_UPDATE_KIND,
      id: createId(),
      preparedAt: now().toISOString(),
      version,
      architecture,
      upstreamSha,
      sourceHeadSha,
      rebasedHeadSha,
      installer: {
        file: installerFile,
        sha256: sourceSha256,
        size: sourceStat.size,
      },
    });
    await writeJsonAtomic(path.join(readyDirectory, READY_UPDATE_MANIFEST_FILE), readyManifest);

    const files = await fsp.readdir(readyDirectory);
    await Promise.all(files
      .filter((file) => /^OpenChamber-.*-win-(?:x64|arm64)-[0-9a-f]{16}\.exe$/.test(file) && file !== installerFile)
      .map((file) => fsp.rm(path.join(readyDirectory, file), { force: true })));

    return readyManifest;
  } finally {
    await fsp.rm(temporaryInstaller, { force: true }).catch(() => {});
  }
};

export const verifyPreparedWindowsInstaller = async ({
  updateRoot,
  readyManifest,
  hashFile = hashFileSha256,
  minInstallerBytes = DEFAULT_MIN_INSTALLER_BYTES,
} = {}) => {
  const manifest = validateReadyUpdateManifest(readyManifest);
  const readyDirectory = path.join(updateRoot, 'ready');
  const installerPath = assertPathInside(
    updateRoot,
    path.join(readyDirectory, manifest.installer.file),
    'Prepared installer',
  );
  const stat = await assertRegularFile(installerPath, 'INSTALLER_NOT_FOUND', 'Prepared installer no longer exists.');
  if (stat.size !== manifest.installer.size || stat.size < minInstallerBytes) {
    throw new SourceUpdateError('INSTALLER_INTEGRITY_FAILED', 'Prepared installer size does not match its manifest.');
  }
  await assertRealPathInside(updateRoot, installerPath, 'Prepared installer');
  await assertPeExecutable(installerPath);
  if (await hashFile(installerPath) !== manifest.installer.sha256) {
    throw new SourceUpdateError('INSTALLER_INTEGRITY_FAILED', 'Prepared installer hash does not match its manifest.');
  }
  return { manifest, installerPath };
};

const quotePowerShellLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const createWindowsInstallHelperScript = ({ payloadBase64 }) => `
$ErrorActionPreference = 'Stop'
$payload = $null
$relaunch = $null
$resultFile = $null
function Write-InstallResult([string]$status, [string]$code) {
  if (-not $resultFile) { return }
  $temporaryResult = "$resultFile.tmp"
  $resultJson = @{ status = $status; code = $code; completedAt = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json -Compress
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($temporaryResult, $resultJson, $utf8NoBom)
  Move-Item -LiteralPath $temporaryResult -Destination $resultFile -Force
}
try {
  $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quotePowerShellLiteral(payloadBase64)}))
  $payload = $payloadJson | ConvertFrom-Json
  $root = [IO.Path]::GetFullPath([string]$payload.updateRoot).TrimEnd('\\') + '\\'
  $installer = [IO.Path]::GetFullPath([string]$payload.installerPath)
  $relaunch = [IO.Path]::GetFullPath([string]$payload.relaunchPath)
  $candidateResultFile = [IO.Path]::GetFullPath([string]$payload.resultFile)
  if (-not $installer.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe_installer_path' }
  if (-not $candidateResultFile.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe_result_path' }
  $resultFile = $candidateResultFile
  if ([IO.Path]::GetExtension($installer) -ne '.exe') { throw 'invalid_installer_extension' }
  if ([IO.Path]::GetExtension($relaunch) -ne '.exe') { throw 'invalid_relaunch_extension' }

  $deadline = [DateTime]::UtcNow.AddMinutes(5)
  while (Get-Process -Id ([int]$payload.targetProcessId) -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'app_exit_timeout' }
    Start-Sleep -Milliseconds 250
  }

  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'installer_missing' }
  $actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne ([string]$payload.installerSha256).ToLowerInvariant()) { throw 'installer_hash_mismatch' }
  if ((Get-Item -LiteralPath $installer).Length -ne [long]$payload.installerSize) { throw 'installer_size_mismatch' }

  $installerProcess = Start-Process -FilePath $installer -ArgumentList @('/S') -WindowStyle Hidden -Wait -PassThru
  if ($installerProcess.ExitCode -ne 0) { throw 'installer_failed' }
  if (-not (Test-Path -LiteralPath $relaunch -PathType Leaf)) { throw 'relaunch_missing' }
  Write-InstallResult 'success' 'installed'
  Start-Process -FilePath $relaunch
  exit 0
} catch {
  $knownCodes = @(
    'unsafe_installer_path', 'unsafe_result_path', 'invalid_installer_extension',
    'invalid_relaunch_extension', 'app_exit_timeout', 'installer_missing',
    'installer_hash_mismatch', 'installer_size_mismatch', 'installer_failed', 'relaunch_missing'
  )
  $failureCode = [string]$_.Exception.Message
  if ($knownCodes -notcontains $failureCode) { $failureCode = 'helper_failed' }
  try { Write-InstallResult 'error' $failureCode } catch {
  }
  try {
    $targetStillRunning = $payload -and (Get-Process -Id ([int]$payload.targetProcessId) -ErrorAction SilentlyContinue)
    if (-not $targetStillRunning -and $relaunch -and [IO.Path]::GetExtension($relaunch) -eq '.exe' -and (Test-Path -LiteralPath $relaunch -PathType Leaf)) {
      Start-Process -FilePath $relaunch
    }
  } catch {
  }
  exit 1
}
`.trim();

export const consumeWindowsInstallResult = async ({ updateRoot } = {}) => {
  const reportsDirectory = assertPathInside(
    updateRoot,
    path.join(updateRoot, 'reports'),
    'Install reports directory',
  );
  try {
    const [realUpdateRoot, realReportsDirectory] = await Promise.all([
      fsp.realpath(updateRoot),
      fsp.realpath(reportsDirectory),
    ]);
    assertPathInside(realUpdateRoot, realReportsDirectory, 'Install reports directory');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const resultFile = assertPathInside(
    updateRoot,
    path.join(reportsDirectory, 'install-result.json'),
    'Install result file',
  );
  let raw;
  try {
    raw = await readJsonFile(resultFile, { maxBytes: 16 * 1024 });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT') return null;
    await fsp.rm(resultFile, { force: true }).catch(() => {});
    throw new SourceUpdateError('INVALID_INSTALL_RESULT', 'Previous source-update install result is invalid.', { cause: error });
  }
  await fsp.rm(resultFile, { force: true });
  const status = raw?.status;
  const code = raw?.code;
  const completedAt = raw?.completedAt;
  if (
    (status !== 'success' && status !== 'error')
    || typeof code !== 'string'
    || !INSTALL_RESULT_CODES.has(code)
    || (status === 'success' && code !== 'installed')
    || (status === 'error' && code === 'installed')
    || typeof completedAt !== 'string'
    || completedAt.length > 100
    || !Number.isFinite(Date.parse(completedAt))
  ) {
    throw new SourceUpdateError('INVALID_INSTALL_RESULT', 'Previous source-update install result is invalid.');
  }
  return Object.freeze({ status, code, completedAt });
};

export const spawnDetachedProcess = (executable, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, {
    ...options,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', reject);
  child.once('spawn', () => {
    child.unref();
    resolve();
  });
});

export const scheduleWindowsInstallAndRelaunch = async ({
  updateRoot,
  readyManifest,
  currentExecutablePath,
  currentProcessId = process.pid,
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
  environment = process.env,
  hashFile = hashFileSha256,
  minInstallerBytes = DEFAULT_MIN_INSTALLER_BYTES,
  spawnDetached = spawnDetachedProcess,
} = {}) => {
  if (platform !== 'win32') {
    throw new SourceUpdateError('UNSUPPORTED_PLATFORM', 'Source-built installation is currently supported only on Windows.');
  }
  if (!path.isAbsolute(updateRoot)) {
    throw new SourceUpdateError('UNSAFE_PATH', 'Source update directory must be absolute.');
  }
  const { manifest, installerPath } = await verifyPreparedWindowsInstaller({
    updateRoot,
    readyManifest,
    hashFile,
    minInstallerBytes,
  });

  if (!path.isAbsolute(currentExecutablePath) || path.extname(currentExecutablePath).toLowerCase() !== '.exe') {
    throw new SourceUpdateError('INVALID_RELAUNCH_TARGET', 'OpenChamber executable path is invalid.');
  }
  await assertRegularFile(
    currentExecutablePath,
    'INVALID_RELAUNCH_TARGET',
    'OpenChamber executable cannot be found for relaunch.',
  );
  if (!Number.isSafeInteger(currentProcessId) || currentProcessId <= 0) {
    throw new SourceUpdateError('INVALID_RELAUNCH_TARGET', 'OpenChamber process identifier is invalid.');
  }

  const powershellPath = path.join(
    systemRoot || '',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (!systemRoot || !path.isAbsolute(powershellPath)) {
    throw new SourceUpdateError('INSTALL_HELPER_UNAVAILABLE', 'Windows PowerShell location is unavailable.');
  }
  await assertRegularFile(
    powershellPath,
    'INSTALL_HELPER_UNAVAILABLE',
    'Windows PowerShell could not be found.',
  );

  const reportsDirectory = path.join(updateRoot, 'reports');
  await ensureRealDirectoryInside(updateRoot, reportsDirectory, 'Install reports directory');
  const resultFile = assertPathInside(
    updateRoot,
    path.join(reportsDirectory, 'install-result.json'),
    'Install result file',
  );
  await Promise.all([
    fsp.rm(resultFile, { force: true }),
    fsp.rm(`${resultFile}.tmp`, { force: true }),
  ]);
  const payloadBase64 = Buffer.from(JSON.stringify({
    updateRoot,
    installerPath,
    installerSha256: manifest.installer.sha256,
    installerSize: manifest.installer.size,
    relaunchPath: currentExecutablePath,
    targetProcessId: currentProcessId,
    resultFile,
  }), 'utf8').toString('base64');
  const script = createWindowsInstallHelperScript({ payloadBase64 });
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');

  try {
    await spawnDetached(powershellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodedCommand,
    ], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: createSafeChildEnvironment(environment, { includeProxy: false }),
    });
  } catch (error) {
    throw new SourceUpdateError('INSTALL_HELPER_START_FAILED', 'Unable to schedule the Windows update helper.', { cause: error });
  }

  return {
    scheduled: true,
    update: toPublicPreparedUpdate(manifest),
  };
};
