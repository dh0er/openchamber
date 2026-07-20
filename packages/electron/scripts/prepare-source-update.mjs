import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OFFICIAL_BRANCH,
  OFFICIAL_REPOSITORY_URL,
  SOURCE_UPDATE_KIND,
  SOURCE_UPDATE_MANIFEST_FILE,
  SOURCE_UPDATE_SCHEMA_VERSION,
  hashFileSha256,
  validateSourceUpdateManifest,
  writeJsonAtomic,
} from '../source-updater/contracts.mjs';
import { createSafeChildEnvironment } from '../source-updater/environment.mjs';
import { createCommandRunner } from '../source-updater/process-runner.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDirectory, '../../..');
const defaultOutputDirectory = path.resolve(scriptDirectory, '../resources/source-update');
const defaultTrackingRef = 'refs/remotes/upstream/main';

const trimLine = (value) => String(value || '').trim();

const normalizeRepositoryUrl = (value) => {
  const raw = trimLine(value).replace(/[\\/]+$/, '');
  const scpMatch = raw.match(/^git@github\.com:(.+)$/i);
  if (scpMatch) return `https://github.com/${scpMatch[1]}`.toLowerCase().replace(/\.git$/, '');
  const sshMatch = raw.match(/^ssh:\/\/git@github\.com\/(.+)$/i);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`.toLowerCase().replace(/\.git$/, '');
  return raw.toLowerCase().replace(/\.git$/, '');
};

const trackingRefParts = (trackingRef) => {
  const match = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(trackingRef);
  if (!match || match[2] !== OFFICIAL_BRANCH) {
    throw new Error(`Source updater tracking ref must end in /${OFFICIAL_BRANCH}: ${trackingRef}`);
  }
  return { remote: match[1], branch: match[2] };
};

const commandFailure = (label, result) => {
  const detail = trimLine(result.stderr || result.stdout);
  return new Error(`${label} failed with exit code ${result.code}${detail ? `: ${detail}` : ''}`);
};

export const prepareSourceUpdate = async ({
  repoRoot = defaultRepoRoot,
  outputDirectory = defaultOutputDirectory,
  trackingRef = process.env.OPENCHAMBER_SOURCE_UPDATE_UPSTREAM_REF || defaultTrackingRef,
  expectedRepositoryUrl = OFFICIAL_REPOSITORY_URL,
  runCommand = createCommandRunner(),
  now = () => new Date(),
  environment = process.env,
} = {}) => {
  const root = path.resolve(repoRoot);
  const output = path.resolve(outputDirectory);
  const { remote } = trackingRefParts(trackingRef);
  const gitEnvironment = {
    ...createSafeChildEnvironment(environment),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
  const git = async (args, label) => {
    const result = await runCommand(process.platform === 'win32' ? 'git.exe' : 'git', args, {
      cwd: root,
      env: gitEnvironment,
      timeoutMs: 120_000,
      maxOutputBytes: 128 * 1024,
    });
    if (result.code !== 0) throw commandFailure(label, result);
    return result.stdout;
  };

  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'Checking source tree cleanliness');
  if (status.length > 0) {
    throw new Error('Source update bundle requires a completely clean Git worktree.');
  }

  const branchRef = trimLine(await git(['symbolic-ref', '-q', 'HEAD'], 'Resolving source update branch'));
  await git(['check-ref-format', branchRef], 'Validating source update branch');
  if (!branchRef.startsWith('refs/heads/')) {
    throw new Error('Source update bundle must be built from a local branch.');
  }

  const configuredRemoteUrl = trimLine(await git(
    ['config', '--get', `remote.${remote}.url`],
    'Resolving official upstream remote',
  ));
  if (normalizeRepositoryUrl(configuredRemoteUrl) !== normalizeRepositoryUrl(expectedRepositoryUrl)) {
    throw new Error(`Remote ${remote} is not the expected official OpenChamber repository.`);
  }

  const headSha = trimLine(await git(['rev-parse', '--verify', 'HEAD^{commit}'], 'Resolving customization head'));
  const observedSha = trimLine(await git(
    ['rev-parse', '--verify', `${trackingRef}^{commit}`],
    'Resolving tracked official upstream head',
  ));
  const baseSha = trimLine(await git(
    ['merge-base', headSha, observedSha],
    'Resolving customization base',
  ));
  const commitLines = trimLine(await git(
    ['rev-list', '--reverse', '--parents', `${baseSha}..${headSha}`],
    'Inspecting customization topic stack',
  ));
  const commits = commitLines ? commitLines.split(/\r?\n/) : [];
  if (commits.length === 0) {
    throw new Error('Source update bundle requires at least one customization commit.');
  }
  if (commits.some((line) => line.trim().split(/\s+/).length !== 2)) {
    throw new Error('Source update customization stack must be linear and contain no merge commits.');
  }
  const firstParent = commits[0].trim().split(/\s+/)[1];
  if (firstParent !== baseSha) {
    throw new Error('Source update customization stack does not start at its official merge base.');
  }
  for (let index = 1; index < commits.length; index += 1) {
    const previousCommit = commits[index - 1].trim().split(/\s+/)[0];
    const parent = commits[index].trim().split(/\s+/)[1];
    if (parent !== previousCommit) {
      throw new Error('Source update customization commits are not a single first-parent chain.');
    }
  }

  const packageJson = JSON.parse(await fsp.readFile(path.join(root, 'packages/electron/package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new Error('Electron package version is missing.');
  }

  await fsp.mkdir(output, { recursive: true });
  const temporaryBundle = path.join(output, `.customizations.${process.pid}.${Date.now()}.tmp`);
  try {
    await git(
      ['bundle', 'create', temporaryBundle, branchRef, `^${baseSha}`],
      'Creating customization bundle',
    );
    await git(['bundle', 'verify', temporaryBundle], 'Verifying customization bundle');
    const bundleHeads = trimLine(await git(
      ['bundle', 'list-heads', temporaryBundle],
      'Inspecting customization bundle',
    )).split(/\r?\n/).filter(Boolean);
    if (bundleHeads.length !== 1 || bundleHeads[0] !== `${headSha} ${branchRef}`) {
      throw new Error('Customization bundle does not contain exactly the expected branch head.');
    }

    const bundleSha256 = await hashFileSha256(temporaryBundle);
    const bundleFile = `customizations-${bundleSha256.slice(0, 16)}.bundle`;
    const finalBundle = path.join(output, bundleFile);
    try {
      await fsp.rename(temporaryBundle, finalBundle);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await hashFileSha256(finalBundle) !== bundleSha256) throw error;
      await fsp.rm(temporaryBundle, { force: true });
    }
    const bundleStat = await fsp.stat(finalBundle);

    const manifest = validateSourceUpdateManifest({
      schemaVersion: SOURCE_UPDATE_SCHEMA_VERSION,
      kind: SOURCE_UPDATE_KIND,
      generatedAt: now().toISOString(),
      official: {
        repositoryUrl: expectedRepositoryUrl,
        branch: OFFICIAL_BRANCH,
        trackingRef,
        baseSha,
        observedSha,
      },
      customizations: {
        branchRef,
        headSha,
        commitCount: commits.length,
        bundle: {
          file: bundleFile,
          sha256: bundleSha256,
          size: bundleStat.size,
        },
      },
      application: {
        version: packageJson.version,
      },
    }, { expectedRepositoryUrl });

    await writeJsonAtomic(path.join(output, SOURCE_UPDATE_MANIFEST_FILE), manifest);

    const outputFiles = await fsp.readdir(output);
    await Promise.all(outputFiles
      .filter((file) => /^customizations-[0-9a-f]{16}\.bundle$/.test(file) && file !== bundleFile)
      .map((file) => fsp.rm(path.join(output, file), { force: true })));

    return manifest;
  } finally {
    await fsp.rm(temporaryBundle, { force: true }).catch(() => {});
  }
};

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  prepareSourceUpdate()
    .then((manifest) => {
      console.log(
        `[electron] source update bundle prepared (${manifest.customizations.commitCount} commits, base ${manifest.official.baseSha.slice(0, 12)}, observed ${manifest.official.observedSha.slice(0, 12)})`,
      );
    })
    .catch((error) => {
      console.error(`[electron] unable to prepare source update bundle: ${error.message}`);
      process.exitCode = 1;
    });
}
