import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SOURCE_UPDATE_KIND,
  SOURCE_UPDATE_MANIFEST_FILE,
  SOURCE_UPDATE_SCHEMA_VERSION,
  hashFileSha256,
} from './contracts.mjs';
import { verifyPackagedSourceUpdateAssets } from './packaged-assets.mjs';

const TARGET_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const REPOSITORY_URL = 'https://fixture.invalid/openchamber.git';

const createFixture = async (context, { architecture = 'x64' } = {}) => {
  const repositoryPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-packaged-source-'));
  context.after(() => fsp.rm(repositoryPath, { recursive: true, force: true }));
  const resourceDirectory = path.join(
    repositoryPath,
    'packages',
    'electron',
    'dist',
    architecture === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked',
    'resources',
    'source-update',
  );
  await fsp.mkdir(resourceDirectory, { recursive: true });
  const bundlePath = path.join(resourceDirectory, 'customizations.bundle');
  await fsp.writeFile(bundlePath, 'fixture bundle');
  const bundleStat = await fsp.stat(bundlePath);
  const manifest = {
    schemaVersion: SOURCE_UPDATE_SCHEMA_VERSION,
    kind: SOURCE_UPDATE_KIND,
    generatedAt: '2026-07-20T12:00:00.000Z',
    official: {
      repositoryUrl: REPOSITORY_URL,
      branch: 'main',
      trackingRef: 'refs/remotes/upstream/main',
      baseSha: TARGET_SHA,
      observedSha: TARGET_SHA,
    },
    customizations: {
      branchRef: 'refs/heads/openchamber-customizations',
      headSha: HEAD_SHA,
      commitCount: 1,
      bundle: {
        file: path.basename(bundlePath),
        sha256: await hashFileSha256(bundlePath),
        size: bundleStat.size,
      },
    },
    application: { version: '2.0.0' },
  };
  const manifestPath = path.join(resourceDirectory, SOURCE_UPDATE_MANIFEST_FILE);
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  const runGit = async (args) => {
    if (args.includes('list-heads')) {
      return { code: 0, stdout: `${HEAD_SHA} refs/heads/openchamber-customizations\n`, stderr: '' };
    }
    if (args.includes('rev-list')) {
      return { code: 0, stdout: `${HEAD_SHA} ${TARGET_SHA}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { repositoryPath, manifest, manifestPath, runGit };
};

test('verifies the packaged manifest and bundle against the rebased source', async (context) => {
  const fixture = await createFixture(context);
  const result = await verifyPackagedSourceUpdateAssets({
    repositoryPath: fixture.repositoryPath,
    targetSha: TARGET_SHA,
    rebasedHeadSha: HEAD_SHA,
    version: '2.0.0',
    architecture: 'x64',
    expectedRepositoryUrl: REPOSITORY_URL,
    runGit: fixture.runGit,
  });
  assert.equal(result.customizations.headSha, HEAD_SHA);
});

test('rejects a packaged source manifest with a stale upstream base', async (context) => {
  const fixture = await createFixture(context);
  fixture.manifest.official.baseSha = 'c'.repeat(40);
  await fsp.writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
  await assert.rejects(
    verifyPackagedSourceUpdateAssets({
      repositoryPath: fixture.repositoryPath,
      targetSha: TARGET_SHA,
      rebasedHeadSha: HEAD_SHA,
      version: '2.0.0',
      architecture: 'x64',
      expectedRepositoryUrl: REPOSITORY_URL,
      runGit: fixture.runGit,
    }),
    (error) => error.code === 'PACKAGED_SOURCE_MISMATCH',
  );
});

test('uses electron-builder arm64 unpacked output for arm64 updates', async (context) => {
  const fixture = await createFixture(context, { architecture: 'arm64' });
  const result = await verifyPackagedSourceUpdateAssets({
    repositoryPath: fixture.repositoryPath,
    targetSha: TARGET_SHA,
    rebasedHeadSha: HEAD_SHA,
    version: '2.0.0',
    architecture: 'arm64',
    expectedRepositoryUrl: REPOSITORY_URL,
    runGit: fixture.runGit,
  });
  assert.equal(result.official.baseSha, TARGET_SHA);
});

test('rejects a packaged customization stack with a broken parent chain', async (context) => {
  const fixture = await createFixture(context);
  fixture.manifest.customizations.commitCount = 2;
  await fsp.writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
  const firstSha = 'c'.repeat(40);
  const runGit = async (args) => {
    if (args.includes('list-heads')) {
      return { code: 0, stdout: `${HEAD_SHA} refs/heads/openchamber-customizations\n`, stderr: '' };
    }
    if (args.includes('rev-list')) {
      return {
        code: 0,
        stdout: `${firstSha} ${TARGET_SHA}\n${HEAD_SHA} ${TARGET_SHA}\n`,
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  await assert.rejects(
    verifyPackagedSourceUpdateAssets({
      repositoryPath: fixture.repositoryPath,
      targetSha: TARGET_SHA,
      rebasedHeadSha: HEAD_SHA,
      version: '2.0.0',
      architecture: 'x64',
      expectedRepositoryUrl: REPOSITORY_URL,
      runGit,
    }),
    (error) => error.code === 'PACKAGED_SOURCE_MISMATCH',
  );
});
