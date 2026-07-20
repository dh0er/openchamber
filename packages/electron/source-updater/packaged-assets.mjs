import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  SOURCE_UPDATE_MANIFEST_FILE,
  SOURCE_UPDATE_RESOURCE_DIRECTORY,
  SourceUpdateError,
  assertPathInside,
  hashFileSha256,
  readJsonFile,
  validateSourceUpdateManifest,
} from './contracts.mjs';

const assertDirectory = async (directoryPath, message) => {
  let stat;
  try {
    stat = await fsp.stat(directoryPath);
  } catch (error) {
    throw new SourceUpdateError('PACKAGED_SOURCE_INVALID', message, { cause: error });
  }
  if (!stat.isDirectory()) throw new SourceUpdateError('PACKAGED_SOURCE_INVALID', message);
};

const assertFile = async (filePath, message) => {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    throw new SourceUpdateError('PACKAGED_SOURCE_INVALID', message, { cause: error });
  }
  if (!stat.isFile()) throw new SourceUpdateError('PACKAGED_SOURCE_INVALID', message);
  return stat;
};

export const verifyPackagedSourceUpdateAssets = async ({
  repositoryPath,
  targetSha,
  rebasedHeadSha,
  version,
  architecture,
  expectedRepositoryUrl,
  runGit,
  hashFile = hashFileSha256,
} = {}) => {
  if (architecture !== 'x64' && architecture !== 'arm64') {
    throw new SourceUpdateError('PACKAGED_SOURCE_INVALID', 'Packaged source-update architecture is unsupported.');
  }
  const distDirectory = path.join(repositoryPath, 'packages', 'electron', 'dist');
  const unpackedDirectory = path.join(
    distDirectory,
    architecture === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked',
  );
  const resourceDirectory = path.join(
    unpackedDirectory,
    'resources',
    SOURCE_UPDATE_RESOURCE_DIRECTORY,
  );
  assertPathInside(repositoryPath, resourceDirectory, 'Packaged source-update resources');
  await assertDirectory(resourceDirectory, 'Electron build did not package source-update resources.');
  const [realDistDirectory, realResourceDirectory] = await Promise.all([
    fsp.realpath(distDirectory),
    fsp.realpath(resourceDirectory),
  ]);
  assertPathInside(realDistDirectory, realResourceDirectory, 'Packaged source-update resources');

  let manifest;
  try {
    manifest = validateSourceUpdateManifest(
      await readJsonFile(path.join(resourceDirectory, SOURCE_UPDATE_MANIFEST_FILE)),
      { expectedRepositoryUrl },
    );
  } catch (error) {
    if (error instanceof SourceUpdateError) throw error;
    throw new SourceUpdateError('PACKAGED_SOURCE_INVALID', 'Packaged source-update manifest is invalid.', { cause: error });
  }
  if (
    manifest.official.baseSha !== targetSha
    || manifest.official.observedSha !== targetSha
    || manifest.customizations.headSha !== rebasedHeadSha
    || manifest.application.version !== version
  ) {
    throw new SourceUpdateError(
      'PACKAGED_SOURCE_MISMATCH',
      'Built app does not carry the source-update revision that produced its installer.',
    );
  }

  const bundlePath = path.join(resourceDirectory, manifest.customizations.bundle.file);
  assertPathInside(resourceDirectory, bundlePath, 'Packaged customization bundle');
  const bundleStat = await assertFile(bundlePath, 'Electron build did not package its customization bundle.');
  const realBundlePath = await fsp.realpath(bundlePath);
  assertPathInside(realResourceDirectory, realBundlePath, 'Packaged customization bundle');
  if (
    bundleStat.size !== manifest.customizations.bundle.size
    || await hashFile(bundlePath) !== manifest.customizations.bundle.sha256
  ) {
    throw new SourceUpdateError('PACKAGED_SOURCE_INVALID', 'Packaged customization bundle failed integrity verification.');
  }

  await runGit(['bundle', 'verify', bundlePath]);
  const bundleHeads = (await runGit(['bundle', 'list-heads', bundlePath])).stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    bundleHeads.length !== 1
    || bundleHeads[0] !== `${rebasedHeadSha} ${manifest.customizations.branchRef}`
  ) {
    throw new SourceUpdateError('PACKAGED_SOURCE_MISMATCH', 'Packaged customization bundle head is stale.');
  }

  const commits = (await runGit([
    'rev-list',
    '--reverse',
    '--parents',
    `${targetSha}..${rebasedHeadSha}`,
  ])).stdout.trim().split(/\r?\n/).filter(Boolean);
  const parsedCommits = commits.map((line) => line.trim().split(/\s+/));
  const hasLinearParents = parsedCommits.every((parts, index) => (
    parts.length === 2
    && parts[1] === (index === 0 ? targetSha : parsedCommits[index - 1][0])
  ));
  if (
    commits.length !== manifest.customizations.commitCount
    || !hasLinearParents
    || parsedCommits.at(-1)?.[0] !== rebasedHeadSha
  ) {
    throw new SourceUpdateError('PACKAGED_SOURCE_MISMATCH', 'Packaged customization stack is not the rebased linear topic stack.');
  }

  return manifest;
};
