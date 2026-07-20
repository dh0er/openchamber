import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  OFFICIAL_REPOSITORY_URL,
  READY_UPDATE_MANIFEST_FILE,
  SOURCE_UPDATE_MANIFEST_FILE,
  SOURCE_UPDATE_RESOURCE_DIRECTORY,
  SourceUpdateError,
  assertPathInside,
  ensureRealDirectoryInside,
  hashFileSha256,
  readJsonFile,
  sanitizeReportText,
  toPublicPreparedUpdate,
  validateReadyUpdateManifest,
  validateSourceUpdateManifest,
  writeJsonAtomic,
} from './contracts.mjs';
import { createSafeChildEnvironment } from './environment.mjs';
import { verifyPackagedSourceUpdateAssets } from './packaged-assets.mjs';
import { createCommandRunner } from './process-runner.mjs';
import {
  consumeWindowsInstallResult,
  scheduleWindowsInstallAndRelaunch,
  stageWindowsInstaller,
  verifyPreparedWindowsInstaller,
} from './windows-install.mjs';

const DEFAULT_PIPELINE = Object.freeze([
  Object.freeze({ id: 'install-dependencies', args: ['install', '--frozen-lockfile'], timeoutMs: 20 * 60_000 }),
  Object.freeze({ id: 'test', args: ['test'], timeoutMs: 45 * 60_000 }),
  Object.freeze({ id: 'type-check', args: ['run', 'type-check'], timeoutMs: 30 * 60_000 }),
  Object.freeze({ id: 'lint', args: ['run', 'lint'], timeoutMs: 30 * 60_000 }),
  Object.freeze({ id: 'build', args: ['run', 'electron:build'], timeoutMs: 60 * 60_000 }),
]);

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;
const REPORT_SCHEMA_VERSION = 1;
const LOCK_STALE_AFTER_MS = 24 * 60 * 60_000;
const LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
const LOCK_HEARTBEAT_STALE_AFTER_MS = 2 * 60_000;
const SAFE_PIPELINE_IDS = new Set(DEFAULT_PIPELINE.map((step) => step.id));
const ACTIVE_PROCESS_LOCK_NONCES = new Set();
const PROXY_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

const normalizeArchitecture = (value) => {
  if (value === 'x64' || value === 'arm64') return value;
  throw new SourceUpdateError('UNSUPPORTED_ARCHITECTURE', `Unsupported source update architecture: ${value}.`);
};

const safeLogger = (logger, level, message) => {
  try {
    logger?.[level]?.(message);
  } catch {
    // Logging must never change update state.
  }
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    throw new SourceUpdateError('PROCESS_ABORTED', 'Source update preparation was cancelled.');
  }
};

const defaultIsProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
};

const withoutProxyEnvironment = (environment) => {
  const result = { ...environment };
  for (const key of PROXY_ENVIRONMENT_KEYS) delete result[key];
  return result;
};

const emitProgress = (callback, event, logger) => {
  safeLogger(logger, 'info', `[source-updater] stage=${event.stage}`);
  try {
    callback?.(Object.freeze({ ...event }));
  } catch {
    // Renderer callbacks are observational only.
  }
};

const parseRemoteHead = (output, branch) => {
  const expectedRef = `refs/heads/${branch}`;
  const rows = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  const matches = rows
    .map((row) => row.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[1] === expectedRef && FULL_SHA_RE.test(parts[0]));
  if (matches.length !== 1) {
    throw new SourceUpdateError('UPSTREAM_CHECK_FAILED', `Official upstream did not advertise ${expectedRef}.`);
  }
  return matches[0][0];
};

const commandDetails = (result, roots) => sanitizeReportText(
  [result?.stderr, result?.stdout].filter(Boolean).join('\n'),
  { roots, maxCharacters: 16_000 },
);

const safeConflictFiles = (output) => String(output || '')
  .split('\0')
  .map((value) => value.trim().replaceAll('\\', '/'))
  .filter((value) => (
    value
    && value.length <= 300
    && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:\//.test(value)
    && !value.split('/').includes('..')
  ))
  .slice(0, 100);

const createGitEnvironment = (baseEnvironment, emptyConfigPath) => {
  const environment = createSafeChildEnvironment(baseEnvironment);
  for (const key of Object.keys(environment)) {
    if (
      key === 'GIT_DIR'
      || key === 'GIT_WORK_TREE'
      || key === 'GIT_INDEX_FILE'
      || key === 'GIT_OBJECT_DIRECTORY'
      || key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
      || key === 'GIT_PROXY_COMMAND'
      || key === 'GIT_SSH'
      || key === 'GIT_SSH_COMMAND'
      || key === 'GIT_EXTERNAL_DIFF'
      || key === 'GIT_CONFIG_COUNT'
      || key.startsWith('GIT_CONFIG_KEY_')
      || key.startsWith('GIT_CONFIG_VALUE_')
    ) delete environment[key];
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfigPath,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'Never',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
};

const validatePipeline = (pipeline) => {
  if (!Array.isArray(pipeline) || pipeline.length !== DEFAULT_PIPELINE.length) {
    throw new SourceUpdateError('INVALID_PIPELINE', 'Source update validation pipeline is incomplete.');
  }
  const ids = pipeline.map((step) => step?.id);
  if (
    ids.some((id, index) => !SAFE_PIPELINE_IDS.has(id) || id !== DEFAULT_PIPELINE[index].id)
    || new Set(ids).size !== SAFE_PIPELINE_IDS.size
  ) {
    throw new SourceUpdateError('INVALID_PIPELINE', 'Source update validation pipeline stages are missing or out of order.');
  }
  for (const step of pipeline) {
    if (!Array.isArray(step.args) || step.args.some((argument) => typeof argument !== 'string')) {
      throw new SourceUpdateError('INVALID_PIPELINE', `Source update pipeline stage ${step.id} has invalid arguments.`);
    }
  }
  return pipeline;
};

const resolveBunExecutable = async ({ environment, explicitExecutable }) => {
  if (explicitExecutable) return explicitExecutable;
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = process.platform === 'win32'
    ? [
      environment.BUN_INSTALL ? path.join(environment.BUN_INSTALL, 'bin', 'bun.exe') : null,
      environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'Programs', 'bun', 'bun.exe') : null,
      environment.LOCALAPPDATA
        ? path.join(environment.LOCALAPPDATA, 'Programs', 'bun', 'node_modules', '.bin', 'bun.exe')
        : null,
      environment.USERPROFILE ? path.join(environment.USERPROFILE, '.bun', 'bin', 'bun.exe') : null,
    ]
    : [environment.BUN_INSTALL ? path.join(environment.BUN_INSTALL, 'bin', 'bun') : null];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      if ((await fsp.stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next known installation location before falling back to PATH.
    }
  }
  return executable;
};

const ensureUpdateRoot = async (localAppData) => {
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw new SourceUpdateError('UPDATE_STORAGE_UNAVAILABLE', 'LOCALAPPDATA is unavailable for source updates.');
  }
  const localRoot = path.resolve(localAppData);
  const updateRoot = path.join(localRoot, 'OpenChamberUpdate');
  await fsp.mkdir(updateRoot, { recursive: true });
  const [realLocalRoot, realUpdateRoot] = await Promise.all([
    fsp.realpath(localRoot),
    fsp.realpath(updateRoot),
  ]);
  const expectedRealRoot = path.join(realLocalRoot, 'OpenChamberUpdate');
  const samePath = process.platform === 'win32'
    ? realUpdateRoot.toLowerCase() === expectedRealRoot.toLowerCase()
    : realUpdateRoot === expectedRealRoot;
  if (!samePath) {
    throw new SourceUpdateError('UNSAFE_PATH', 'Source update directory resolves outside LOCALAPPDATA.');
  }
  return realUpdateRoot;
};

const acquireUpdateLock = async (updateRoot, now, isProcessAlive) => {
  const locksDirectory = path.join(updateRoot, 'locks');
  assertPathInside(updateRoot, locksDirectory, 'Update locks directory');
  const realLocksDirectory = await ensureRealDirectoryInside(
    updateRoot,
    locksDirectory,
    'Update locks directory',
  );
  const nonce = crypto.randomBytes(16).toString('hex');
  const lockPath = path.join(realLocksDirectory, `update-${process.pid}-${nonce}.lock`);
  assertPathInside(realLocksDirectory, lockPath, 'Update lock');
  let handle;
  try {
    handle = await fsp.open(lockPath, 'wx');
    ACTIVE_PROCESS_LOCK_NONCES.add(nonce);
    await handle.writeFile(`${JSON.stringify({
      pid: process.pid,
      nonce,
      createdAt: now().toISOString(),
    })}\n`);

    const contenders = await fsp.readdir(realLocksDirectory, { withFileTypes: true });
    let competingOwner = false;
    for (const entry of contenders) {
      if (!entry.isFile() || entry.name === path.basename(lockPath)) continue;
      const contenderPath = path.join(realLocksDirectory, entry.name);
      assertPathInside(realLocksDirectory, contenderPath, 'Update lock');
      const match = /^update-(\d+)-([0-9a-f]{32})\.lock$/.exec(entry.name);
      if (!match) {
        const stat = await fsp.stat(contenderPath).catch(() => null);
        if (!stat || now().getTime() - stat.mtimeMs <= LOCK_STALE_AFTER_MS) {
          competingOwner = true;
        } else {
          await fsp.rm(contenderPath, { force: true }).catch(() => {});
        }
        continue;
      }
      const ownerPid = Number.parseInt(match[1], 10);
      const contenderNonce = match[2];
      const stat = await fsp.stat(contenderPath).catch(() => null);
      const heartbeatFresh = Boolean(
        stat && now().getTime() - stat.mtimeMs <= LOCK_HEARTBEAT_STALE_AFTER_MS,
      );
      let ownerAlive = true;
      if (ownerPid === process.pid) {
        ownerAlive = ACTIVE_PROCESS_LOCK_NONCES.has(contenderNonce);
      } else if (!heartbeatFresh) {
        ownerAlive = false;
      } else {
        try {
          ownerAlive = await isProcessAlive(ownerPid);
        } catch {
          ownerAlive = true;
        }
      }
      if (ownerAlive) {
        competingOwner = true;
      } else {
        await fsp.rm(contenderPath, { force: true }).catch(() => {});
      }
    }
    if (competingOwner) {
      throw new SourceUpdateError('UPDATE_BUSY', 'Another source update is already running.');
    }
    const heartbeat = setInterval(() => {
      const timestamp = now();
      void handle.utimes(timestamp, timestamp).catch(() => {});
    }, LOCK_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    return { handle, heartbeat, lockPath, nonce };
  } catch (error) {
    ACTIVE_PROCESS_LOCK_NONCES.delete(nonce);
    await handle?.close().catch(() => {});
    await fsp.rm(lockPath, { force: true }).catch(() => {});
    if (error instanceof SourceUpdateError) throw error;
    throw new SourceUpdateError('UPDATE_BUSY', 'Another source update is already running.', { cause: error });
  }
};

const releaseUpdateLock = async (lock) => {
  if (!lock) return;
  if (lock.heartbeat) clearInterval(lock.heartbeat);
  if (lock.nonce) ACTIVE_PROCESS_LOCK_NONCES.delete(lock.nonce);
  await lock.handle.close().catch(() => {});
  await fsp.rm(lock.lockPath, { force: true }).catch(() => {});
};

const readPackageVersion = async (repositoryPath) => {
  const packagePath = path.join(repositoryPath, 'packages', 'electron', 'package.json');
  let value;
  try {
    value = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
  } catch (error) {
    throw new SourceUpdateError('BUILD_OUTPUT_INVALID', 'Rebased Electron package metadata is invalid.', { cause: error });
  }
  if (typeof value.version !== 'string' || !value.version) {
    throw new SourceUpdateError('BUILD_OUTPUT_INVALID', 'Rebased Electron package version is missing.');
  }
  return value.version;
};

const parseVersion = (value, label) => {
  const match = String(value || '').trim().match(SEMVER_RE);
  if (!match) throw new SourceUpdateError('TOOLCHAIN_MISMATCH', `${label} did not report a supported semantic version.`);
  return match.slice(1, 4).map((part) => Number.parseInt(part, 10));
};

const compareVersionParts = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
};

const readToolchainRequirements = async (repositoryPath) => {
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(path.join(repositoryPath, 'package.json'), 'utf8'));
  } catch (error) {
    throw new SourceUpdateError('TOOLCHAIN_MISMATCH', 'Rebased root package metadata is invalid.', { cause: error });
  }
  const bunMatch = typeof metadata.packageManager === 'string'
    ? metadata.packageManager.match(/^bun@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)
    : null;
  const nodeMatch = typeof metadata.engines?.node === 'string'
    ? metadata.engines.node.trim().match(/^>=\s*(\d+\.\d+\.\d+)$/)
    : null;
  if (!bunMatch || !nodeMatch) {
    throw new SourceUpdateError(
      'TOOLCHAIN_MISMATCH',
      'Rebased source does not declare a supported exact Bun version and minimum Node version.',
    );
  }
  return {
    bunVersion: bunMatch[1],
    nodeMinimumVersion: nodeMatch[1],
  };
};

const verifyBuildToolchain = async ({
  repositoryPath,
  bunExecutable,
  nodeExecutable,
  environment,
  runCommand,
  signal,
}) => {
  const requirements = await readToolchainRequirements(repositoryPath);
  const bunResult = await runCommand(bunExecutable, ['--version'], {
    cwd: repositoryPath,
    env: environment,
    timeoutMs: 30_000,
    maxOutputBytes: 4 * 1024,
    signal,
  });
  if (bunResult.code !== 0) {
    throw new SourceUpdateError('TOOLCHAIN_UNAVAILABLE', 'The Bun executable required for source updates is unavailable.');
  }
  const actualBunVersion = bunResult.stdout.trim();
  if (actualBunVersion !== requirements.bunVersion) {
    throw new SourceUpdateError(
      'TOOLCHAIN_MISMATCH',
      `Source update requires Bun ${requirements.bunVersion}, but ${actualBunVersion || 'an unknown version'} is installed.`,
    );
  }

  const nodeResult = await runCommand(nodeExecutable, ['--version'], {
    cwd: repositoryPath,
    env: environment,
    timeoutMs: 30_000,
    maxOutputBytes: 4 * 1024,
    signal,
  });
  if (nodeResult.code !== 0) {
    throw new SourceUpdateError('TOOLCHAIN_UNAVAILABLE', 'The Node.js executable required for source updates is unavailable.');
  }
  const actualNodeVersion = parseVersion(nodeResult.stdout, 'Node.js');
  const minimumNodeVersion = parseVersion(requirements.nodeMinimumVersion, 'Required Node.js version');
  if (compareVersionParts(actualNodeVersion, minimumNodeVersion) < 0) {
    throw new SourceUpdateError(
      'TOOLCHAIN_MISMATCH',
      `Source update requires Node.js ${requirements.nodeMinimumVersion} or newer.`,
    );
  }
};

export const createSourceUpdater = ({
  resourcesPath,
  currentExecutablePath,
  localAppData = process.env.LOCALAPPDATA,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  logger,
  dependencies = {},
} = {}) => {
  if (!resourcesPath || !path.isAbsolute(resourcesPath)) {
    throw new SourceUpdateError('SOURCE_UPDATE_UNAVAILABLE', 'Packaged resource path is unavailable.');
  }
  const normalizedArchitecture = normalizeArchitecture(architecture);
  const runCommand = dependencies.runCommand || createCommandRunner();
  const now = dependencies.now || (() => new Date());
  const createId = dependencies.createId || (() => crypto.randomUUID());
  const hashFile = dependencies.hashFile || hashFileSha256;
  const isProcessAlive = dependencies.isProcessAlive || defaultIsProcessAlive;
  const officialRepositoryUrl = dependencies.officialRepositoryUrl || OFFICIAL_REPOSITORY_URL;
  const gitExecutable = dependencies.gitExecutable || (process.platform === 'win32' ? 'git.exe' : 'git');
  const nodeExecutable = dependencies.nodeExecutable || (platform === 'win32' ? 'node.exe' : 'node');
  const pipeline = validatePipeline(dependencies.pipeline || DEFAULT_PIPELINE);
  const resourceDirectory = path.join(resourcesPath, SOURCE_UPDATE_RESOURCE_DIRECTORY);
  const manifestPath = path.join(resourceDirectory, SOURCE_UPDATE_MANIFEST_FILE);
  const sensitiveReportRoots = [
    resourceDirectory,
    localAppData,
    environment.USERPROFILE,
    environment.HOME,
    environment.LOCALAPPDATA,
    environment.APPDATA,
  ].filter(Boolean);

  const loadPackagedAssets = async () => {
    let manifest;
    try {
      manifest = validateSourceUpdateManifest(await readJsonFile(manifestPath), {
        expectedRepositoryUrl: officialRepositoryUrl,
      });
    } catch (error) {
      if (error instanceof SourceUpdateError) throw error;
      throw new SourceUpdateError('INVALID_MANIFEST', 'Unable to read the packaged source update manifest.', { cause: error });
    }
    const bundlePath = path.join(resourceDirectory, manifest.customizations.bundle.file);
    assertPathInside(resourceDirectory, bundlePath, 'Customization bundle');
    let stat;
    try {
      stat = await fsp.stat(bundlePath);
    } catch (error) {
      throw new SourceUpdateError('BUNDLE_INTEGRITY_FAILED', 'Packaged customization bundle is missing.', { cause: error });
    }
    if (!stat.isFile() || stat.size !== manifest.customizations.bundle.size) {
      throw new SourceUpdateError('BUNDLE_INTEGRITY_FAILED', 'Packaged customization bundle size is invalid.');
    }
    if (await hashFile(bundlePath) !== manifest.customizations.bundle.sha256) {
      throw new SourceUpdateError('BUNDLE_INTEGRITY_FAILED', 'Packaged customization bundle hash is invalid.');
    }
    return { manifest, bundlePath };
  };

  const check = async ({ signal } = {}) => {
    throwIfAborted(signal);
    if (platform !== 'win32') {
      throw new SourceUpdateError('UNSUPPORTED_PLATFORM', 'Source-built updates are currently supported only on Windows.');
    }
    const { manifest } = await loadPackagedAssets();
    const updateRoot = await ensureUpdateRoot(localAppData);
    const emptyConfigPath = path.join(updateRoot, 'empty-gitconfig');
    await fsp.writeFile(emptyConfigPath, '', { flag: 'a' });
    const gitEnvironment = createGitEnvironment(environment, emptyConfigPath);
    const result = await runCommand(gitExecutable, [
      '-c', 'credential.helper=',
      'ls-remote',
      '--exit-code',
      '--heads',
      manifest.official.repositoryUrl,
      `refs/heads/${manifest.official.branch}`,
    ], {
      cwd: updateRoot,
      env: gitEnvironment,
      timeoutMs: 120_000,
      maxOutputBytes: 32 * 1024,
      signal,
    });
    throwIfAborted(signal);
    if (result.code !== 0) {
      const details = commandDetails(result, [updateRoot, ...sensitiveReportRoots]);
      throw new SourceUpdateError(
        'UPSTREAM_CHECK_FAILED',
        `Unable to check official upstream${details ? `: ${details}` : ''}`,
      );
    }
    const latestUpstreamSha = parseRemoteHead(result.stdout, manifest.official.branch);
    return Object.freeze({
      available: latestUpstreamSha !== manifest.official.baseSha,
      currentUpstreamSha: manifest.official.baseSha,
      observedUpstreamSha: manifest.official.observedSha,
      latestUpstreamSha,
      customHeadSha: manifest.customizations.headSha,
      customCommitCount: manifest.customizations.commitCount,
      currentVersion: manifest.application.version,
    });
  };

  const persistFailureReport = async (updateRoot, report) => {
    const reportsDirectory = path.join(updateRoot, 'reports');
    assertPathInside(updateRoot, reportsDirectory, 'Update reports directory');
    await ensureRealDirectoryInside(updateRoot, reportsDirectory, 'Update reports directory');
    const reportFile = `report-${report.id}.json`;
    const persistedReport = Object.freeze({ ...report, reportFile });
    await writeJsonAtomic(path.join(reportsDirectory, reportFile), persistedReport);
    return persistedReport;
  };

  const prepare = async ({ expectedUpstreamSha, onProgress, signal } = {}) => {
    throwIfAborted(signal);
    if (platform !== 'win32') {
      throw new SourceUpdateError('UNSUPPORTED_PLATFORM', 'Source-built updates are currently supported only on Windows.');
    }
    if (expectedUpstreamSha !== undefined && !FULL_SHA_RE.test(expectedUpstreamSha)) {
      throw new SourceUpdateError('INVALID_UPDATE_TARGET', 'Expected upstream revision must be a full Git SHA.');
    }

    const updateRoot = await ensureUpdateRoot(localAppData);
    const lock = await acquireUpdateLock(updateRoot, now, isProcessAlive);
    let stagingDirectory;
    let currentStage = 'verify';
    let reportPersisted = false;
    try {
      emitProgress(onProgress, { stage: currentStage }, logger);
      throwIfAborted(signal);
      const { manifest, bundlePath } = await loadPackagedAssets();
      const targetSha = expectedUpstreamSha || (await check({ signal })).latestUpstreamSha;
      if (targetSha === manifest.official.baseSha) {
        throw new SourceUpdateError('NO_UPDATE', 'The custom build is already based on the latest official upstream revision.');
      }

      const stagingParent = path.join(updateRoot, 'staging');
      assertPathInside(updateRoot, stagingParent, 'Staging directory');
      const previousRealStagingParent = await fsp.realpath(stagingParent).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (previousRealStagingParent) {
        assertPathInside(updateRoot, previousRealStagingParent, 'Staging directory');
        await fsp.rm(stagingParent, { recursive: true, force: true });
      }
      const realStagingParent = await ensureRealDirectoryInside(updateRoot, stagingParent, 'Staging directory');
      stagingDirectory = await fsp.mkdtemp(path.join(stagingParent, 'run-'));
      assertPathInside(realStagingParent, await fsp.realpath(stagingDirectory), 'Staging run directory');
      const repositoryPath = path.join(stagingDirectory, 'repository');
      const hooksPath = path.join(stagingDirectory, 'empty-hooks');
      const emptyConfigPath = path.join(stagingDirectory, 'empty-gitconfig');
      await Promise.all([
        fsp.mkdir(hooksPath, { recursive: true }),
        fsp.writeFile(emptyConfigPath, '', { flag: 'wx' }),
      ]);
      const gitEnvironment = createGitEnvironment(environment, emptyConfigPath);
      const gitConfigArguments = [
        '-c', `core.hooksPath=${hooksPath}`,
        '-c', 'credential.helper=',
        '-c', 'commit.gpgSign=false',
        '-c', 'tag.gpgSign=false',
        '-c', 'user.name=OpenChamber Source Updater',
        '-c', 'user.email=source-updater@localhost',
      ];
      const runGit = async (args, { allowFailure = false, cwd = repositoryPath } = {}) => {
        throwIfAborted(signal);
        const result = await runCommand(gitExecutable, [...gitConfigArguments, ...args], {
          cwd,
          env: gitEnvironment,
          timeoutMs: 10 * 60_000,
          maxOutputBytes: 64 * 1024,
          signal,
        });
        throwIfAborted(signal);
        if (!allowFailure && result.code !== 0) {
          throw new SourceUpdateError(
            'GIT_OPERATION_FAILED',
            `Git operation failed during ${currentStage}: ${commandDetails(result, [updateRoot, ...sensitiveReportRoots])}`,
          );
        }
        return result;
      };

      await runGit(['init', repositoryPath], { cwd: stagingDirectory });
      await runGit(['remote', 'add', 'upstream', manifest.official.repositoryUrl]);

      currentStage = 'fetch';
      emitProgress(onProgress, { stage: currentStage }, logger);
      await runGit([
        'fetch',
        '--no-tags',
        '--prune',
        'upstream',
        `+refs/heads/${manifest.official.branch}:refs/remotes/upstream/${manifest.official.branch}`,
      ]);
      const fetchedSha = (await runGit([
        'rev-parse',
        '--verify',
        `refs/remotes/upstream/${manifest.official.branch}^{commit}`,
      ])).stdout.trim();
      if (fetchedSha !== targetSha) {
        throw new SourceUpdateError(
          'UPDATE_TARGET_CHANGED',
          'Official upstream changed while the update was being prepared. Check again before retrying.',
        );
      }
      const upstreamAncestry = await runGit([
        'merge-base',
        '--is-ancestor',
        manifest.official.baseSha,
        targetSha,
      ], { allowFailure: true });
      if (upstreamAncestry.code !== 0) {
        throw new SourceUpdateError(
          'UPSTREAM_HISTORY_CHANGED',
          'Official upstream history no longer contains the build base; automatic rebase was stopped.',
        );
      }

      currentStage = 'verify-bundle';
      emitProgress(onProgress, { stage: currentStage }, logger);
      await runGit(['bundle', 'verify', bundlePath]);
      const bundleHeads = (await runGit(['bundle', 'list-heads', bundlePath])).stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const expectedBundleHead = `${manifest.customizations.headSha} ${manifest.customizations.branchRef}`;
      if (bundleHeads.length !== 1 || bundleHeads[0] !== expectedBundleHead) {
        throw new SourceUpdateError('BUNDLE_INTEGRITY_FAILED', 'Customization bundle head does not match its manifest.');
      }
      await runGit([
        'fetch',
        '--no-tags',
        bundlePath,
        `${manifest.customizations.branchRef}:refs/heads/openchamber-customizations`,
      ]);
      const importedHead = (await runGit([
        'rev-parse',
        '--verify',
        'refs/heads/openchamber-customizations^{commit}',
      ])).stdout.trim();
      if (importedHead !== manifest.customizations.headSha) {
        throw new SourceUpdateError('BUNDLE_INTEGRITY_FAILED', 'Imported customization head does not match its manifest.');
      }
      const customizationLines = (await runGit([
        'rev-list',
        '--reverse',
        '--parents',
        `${manifest.official.baseSha}..${importedHead}`,
      ])).stdout.trim().split(/\r?\n/).filter(Boolean);
      const parsedCustomizationLines = customizationLines.map((line) => line.trim().split(/\s+/));
      const hasLinearCustomizationParents = parsedCustomizationLines.every((parts, index) => (
        parts.length === 2
        && parts[1] === (
          index === 0
            ? manifest.official.baseSha
            : parsedCustomizationLines[index - 1][0]
        )
      ));
      if (
        customizationLines.length !== manifest.customizations.commitCount
        || !hasLinearCustomizationParents
        || parsedCustomizationLines.at(-1)?.[0] !== importedHead
      ) {
        throw new SourceUpdateError('BUNDLE_INTEGRITY_FAILED', 'Customization bundle is not the declared linear topic stack.');
      }
      await runGit(['checkout', '--force', 'openchamber-customizations']);

      currentStage = 'rebase';
      emitProgress(onProgress, { stage: currentStage }, logger);
      const rebaseResult = await runGit([
        'rebase',
        '--no-autostash',
        '--no-gpg-sign',
        '--onto',
        targetSha,
        manifest.official.baseSha,
      ], { allowFailure: true });
      if (rebaseResult.code !== 0) {
        const conflicts = await runGit(
          ['diff', '--name-only', '--diff-filter=U', '-z'],
          { allowFailure: true },
        );
        const currentPatch = await runGit(
          ['show', '-s', '--format=%s', 'REBASE_HEAD'],
          { allowFailure: true },
        );
        const conflictFiles = safeConflictFiles(conflicts.stdout);
        const patchSubject = sanitizeReportText(currentPatch.stdout.trim(), {
          roots: [updateRoot, ...sensitiveReportRoots],
          maxCharacters: 500,
        });
        const abort = await runGit(['rebase', '--abort'], { allowFailure: true });
        const isConflict = conflictFiles.length > 0;
        let report = {
          schemaVersion: REPORT_SCHEMA_VERSION,
          id: createId(),
          type: isConflict ? 'rebase-conflict' : 'rebase-failed',
          summary: isConflict
            ? 'Custom changes conflict with the latest official upstream revision.'
            : 'Git could not replay the custom changes onto the latest official upstream revision.',
          stage: 'rebase',
          createdAt: now().toISOString(),
          upstreamBaseSha: manifest.official.baseSha,
          upstreamTargetSha: targetSha,
          customizationHeadSha: manifest.customizations.headSha,
          conflictFiles,
          ...(patchSubject ? { patchSubject } : {}),
          rebaseAborted: abort.code === 0,
          logTail: commandDetails(rebaseResult, [updateRoot, ...sensitiveReportRoots]),
        };
        report = await persistFailureReport(updateRoot, report);
        reportPersisted = true;
        throw new SourceUpdateError(
          isConflict ? 'REBASE_CONFLICT' : 'REBASE_FAILED',
          isConflict
            ? 'Custom OpenChamber changes conflict with the latest official upstream revision.'
            : 'Git could not replay the custom OpenChamber changes.',
          { report },
        );
      }

      const rebasedHeadSha = (await runGit(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
      const status = (await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
      if (status.length > 0) {
        throw new SourceUpdateError('REBASE_DIRTY', 'Rebased source tree is not clean; update was stopped.');
      }

      const bunExecutable = await resolveBunExecutable({
        environment,
        explicitExecutable: dependencies.bunExecutable,
      });
      const cacheRoot = path.join(stagingDirectory, 'cache');
      const temporaryRoot = path.join(stagingDirectory, 'temp');
      const isolatedProfileRoot = path.join(stagingDirectory, 'profile');
      const isolatedAppData = path.join(isolatedProfileRoot, 'AppData', 'Roaming');
      const isolatedLocalAppData = path.join(isolatedProfileRoot, 'AppData', 'Local');
      const isolatedNpmConfig = path.join(isolatedProfileRoot, '.npmrc');
      await Promise.all([
        fsp.mkdir(cacheRoot, { recursive: true }),
        fsp.mkdir(temporaryRoot, { recursive: true }),
        fsp.mkdir(isolatedAppData, { recursive: true }),
        fsp.mkdir(isolatedLocalAppData, { recursive: true }),
      ]);
      await fsp.writeFile(isolatedNpmConfig, '', { flag: 'wx' });
      const buildEnvironment = {
        ...createGitEnvironment(environment, emptyConfigPath),
        APPDATA: isolatedAppData,
        BUN_INSTALL_CACHE_DIR: path.join(cacheRoot, 'bun'),
        CI: '1',
        ELECTRON_BUILDER_CACHE: path.join(cacheRoot, 'electron-builder'),
        ELECTRON_CACHE: path.join(cacheRoot, 'electron'),
        HOME: isolatedProfileRoot,
        LOCALAPPDATA: isolatedLocalAppData,
        npm_config_cache: path.join(cacheRoot, 'npm'),
        npm_config_devdir: path.join(cacheRoot, 'node-gyp'),
        npm_config_userconfig: isolatedNpmConfig,
        OPENCHAMBER_TARGET_ARCH: normalizedArchitecture,
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
        TMPDIR: temporaryRoot,
        USERPROFILE: isolatedProfileRoot,
        XDG_CACHE_HOME: path.join(cacheRoot, 'xdg'),
        XDG_CONFIG_HOME: path.join(isolatedProfileRoot, '.config'),
      };
      const validationEnvironment = withoutProxyEnvironment(buildEnvironment);
      for (const step of pipeline) {
        throwIfAborted(signal);
        currentStage = step.id;
        emitProgress(onProgress, { stage: currentStage }, logger);
        const stepEnvironment = step.id === 'install-dependencies' || step.id === 'build'
          ? buildEnvironment
          : validationEnvironment;
        if (step.id === 'install-dependencies') {
          await verifyBuildToolchain({
            repositoryPath,
            bunExecutable,
            nodeExecutable,
            environment: validationEnvironment,
            runCommand,
            signal,
          });
          throwIfAborted(signal);
        }
        const result = await runCommand(bunExecutable, step.args, {
          cwd: repositoryPath,
          env: stepEnvironment,
          timeoutMs: step.timeoutMs,
          maxOutputBytes: 64 * 1024,
          signal,
        });
        throwIfAborted(signal);
        if (result.code !== 0) {
          let report = {
            schemaVersion: REPORT_SCHEMA_VERSION,
            id: createId(),
            type: step.id === 'build' ? 'build-failed' : 'validation-failed',
            summary: `The ${step.id} source-update stage failed.`,
            stage: step.id,
            createdAt: now().toISOString(),
            upstreamTargetSha: targetSha,
            rebasedHeadSha,
            conflictFiles: [],
            logTail: commandDetails(result, [updateRoot, ...sensitiveReportRoots]),
          };
          report = await persistFailureReport(updateRoot, report);
          reportPersisted = true;
          throw new SourceUpdateError(
            step.id === 'build' ? 'BUILD_FAILED' : 'VALIDATION_FAILED',
            `Source update stopped because the ${step.id} stage failed.`,
            { report },
          );
        }
      }

      currentStage = 'prepare-installer';
      emitProgress(onProgress, { stage: currentStage }, logger);
      throwIfAborted(signal);
      const version = await readPackageVersion(repositoryPath);
      await verifyPackagedSourceUpdateAssets({
        repositoryPath,
        targetSha,
        rebasedHeadSha,
        version,
        architecture: normalizedArchitecture,
        expectedRepositoryUrl: officialRepositoryUrl,
        runGit,
        hashFile,
      });
      const readyManifest = await stageWindowsInstaller({
        stagingRepository: repositoryPath,
        updateRoot,
        version,
        architecture: normalizedArchitecture,
        upstreamSha: targetSha,
        sourceHeadSha: manifest.customizations.headSha,
        rebasedHeadSha,
        now,
        createId,
        hashFile,
        minInstallerBytes: dependencies.minInstallerBytes,
      });
      emitProgress(onProgress, { stage: 'ready' }, logger);
      return toPublicPreparedUpdate(readyManifest);
    } catch (error) {
      if (error instanceof SourceUpdateError && error.code === 'PROCESS_ABORTED') throw error;
      if (error instanceof SourceUpdateError && (error.report || reportPersisted)) throw error;
      const sanitizedErrorMessage = sanitizeReportText(
        error instanceof Error ? error.message : String(error),
        { roots: [updateRoot, ...sensitiveReportRoots], maxCharacters: 16_000 },
      );
      let report = {
        schemaVersion: REPORT_SCHEMA_VERSION,
        id: createId(),
        type: 'update-failed',
        summary: error instanceof SourceUpdateError
          ? sanitizeReportText(error.message, {
            roots: [updateRoot, ...sensitiveReportRoots],
            maxCharacters: 1_000,
          })
          : 'The source update could not be prepared.',
        stage: currentStage,
        createdAt: now().toISOString(),
        conflictFiles: [],
        logTail: sanitizedErrorMessage,
      };
      report = await persistFailureReport(updateRoot, report).catch(() => Object.freeze(report));
      if (error instanceof SourceUpdateError) {
        error.report = report;
        throw error;
      }
      throw new SourceUpdateError('SOURCE_UPDATE_FAILED', 'Unable to prepare the source-built update.', {
        cause: error,
        report,
      });
    } finally {
      if (stagingDirectory) {
        const stagingParent = path.join(updateRoot, 'staging');
        try {
          assertPathInside(stagingParent, stagingDirectory, 'Staging run directory');
          await fsp.rm(stagingDirectory, { recursive: true, force: true });
        } catch (error) {
          safeLogger(logger, 'warn', `[source-updater] staging cleanup failed: ${error.message}`);
        }
      }
      await releaseUpdateLock(lock);
    }
  };

  const readPreparedUpdateManifest = async () => {
    const updateRoot = await ensureUpdateRoot(localAppData);
    const manifestPath = path.join(updateRoot, 'ready', READY_UPDATE_MANIFEST_FILE);
    let manifest;
    try {
      manifest = validateReadyUpdateManifest(await readJsonFile(manifestPath));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SourceUpdateError && error.cause?.code === 'ENOENT') return null;
      throw error;
    }
    const { manifest: packagedManifest } = await loadPackagedAssets();
    if (
      manifest.sourceHeadSha !== packagedManifest.customizations.headSha
      || manifest.architecture !== normalizedArchitecture
    ) return null;
    await verifyPreparedWindowsInstaller({
      updateRoot,
      readyManifest: manifest,
      hashFile,
      minInstallerBytes: dependencies.minInstallerBytes,
    });
    return manifest;
  };

  const readPreparedUpdate = async () => {
    const manifest = await readPreparedUpdateManifest();
    return manifest ? toPublicPreparedUpdate(manifest) : null;
  };

  const scheduleInstallAndRelaunch = async ({ expectedUpstreamSha } = {}) => {
    if (expectedUpstreamSha !== undefined && !FULL_SHA_RE.test(expectedUpstreamSha)) {
      throw new SourceUpdateError('INVALID_UPDATE_TARGET', 'Expected upstream revision must be a full Git SHA.');
    }
    const updateRoot = await ensureUpdateRoot(localAppData);
    const readyManifest = await readPreparedUpdateManifest();
    if (!readyManifest) {
      throw new SourceUpdateError('NO_PREPARED_UPDATE', 'No source-built update is ready to install.');
    }
    if (expectedUpstreamSha && readyManifest.upstreamSha !== expectedUpstreamSha) {
      throw new SourceUpdateError(
        'PREPARED_UPDATE_MISMATCH',
        'Prepared source update no longer matches the selected upstream revision.',
      );
    }
    return scheduleWindowsInstallAndRelaunch({
      updateRoot,
      readyManifest,
      currentExecutablePath,
      platform,
      hashFile,
      minInstallerBytes: dependencies.minInstallerBytes,
      spawnDetached: dependencies.spawnDetached,
      systemRoot: dependencies.systemRoot || environment.SystemRoot,
      environment,
    });
  };

  const consumeInstallResult = async () => {
    const updateRoot = await ensureUpdateRoot(localAppData);
    return consumeWindowsInstallResult({ updateRoot });
  };

  return Object.freeze({
    check,
    consumeInstallResult,
    prepare,
    readPreparedUpdate,
    scheduleInstallAndRelaunch,
  });
};

export const sourceUpdatePipelineStages = Object.freeze(DEFAULT_PIPELINE.map((step) => step.id));
