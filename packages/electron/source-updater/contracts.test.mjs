import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OFFICIAL_REPOSITORY_URL,
  SOURCE_UPDATE_KIND,
  SOURCE_UPDATE_SCHEMA_VERSION,
  hashFileSha256,
  readJsonFile,
  sanitizeReportText,
  validateSourceUpdateManifest,
  writeJsonAtomic,
} from './contracts.mjs';

const sha = (character) => character.repeat(40);
const digest = (character) => character.repeat(64);

const validManifest = () => ({
  schemaVersion: SOURCE_UPDATE_SCHEMA_VERSION,
  kind: SOURCE_UPDATE_KIND,
  generatedAt: '2026-07-20T12:00:00.000Z',
  official: {
    repositoryUrl: OFFICIAL_REPOSITORY_URL,
    branch: 'main',
    trackingRef: 'refs/remotes/upstream/main',
    baseSha: sha('a'),
    observedSha: sha('b'),
  },
  customizations: {
    branchRef: 'refs/heads/codex/custom-source-updater',
    headSha: sha('c'),
    commitCount: 5,
    bundle: {
      file: 'customizations-1234567890abcdef.bundle',
      sha256: digest('d'),
      size: 1234,
    },
  },
  application: { version: '1.16.2' },
});

test('validates the fixed official source-update contract', () => {
  const manifest = validateSourceUpdateManifest(validManifest());
  assert.equal(manifest.official.baseSha, sha('a'));
  assert.equal(manifest.customizations.commitCount, 5);

  const wrongRemote = validManifest();
  wrongRemote.official.repositoryUrl = 'https://example.invalid/openchamber.git';
  assert.throws(() => validateSourceUpdateManifest(wrongRemote), /official repository/);

  const unsafeBundle = validManifest();
  unsafeBundle.customizations.bundle.file = '../customizations.bundle';
  assert.throws(() => validateSourceUpdateManifest(unsafeBundle), /safe file name/);
});

test('hashes assets and bounds sanitized diagnostic output', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-contracts-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'asset.bin');
  await fsp.writeFile(file, 'source-update');
  assert.match(await hashFileSha256(file), /^[0-9a-f]{64}$/);

  const sanitized = sanitizeReportText(
    `https://alice:secret@example.com/repo ${file} ${'x'.repeat(100)}`,
    { roots: [root], maxCharacters: 80 },
  );
  assert.doesNotMatch(sanitized, /alice|secret|openchamber-contracts/);
  assert.match(sanitized, /\[truncated\]/);
  assert.ok(sanitized.length < 110);

  const manifestFile = path.join(root, 'atomic.json');
  await writeJsonAtomic(manifestFile, { value: 1 });
  await writeJsonAtomic(manifestFile, { value: 2 });
  assert.deepEqual(JSON.parse(await fsp.readFile(manifestFile, 'utf8')), { value: 2 });
});

test('redacts paths and credentials while retaining useful diagnostics', () => {
  const root = path.resolve('C:\\Users\\Daniel\\AppData\\Local\\OpenChamberUpdate');
  const slashRoot = root.replace(/\\/g, '/');
  const report = [
    `native path: ${root}\\staging\\repo`,
    `normalized path: ${slashRoot}/reports/update.txt`,
    `case-insensitive path: ${slashRoot.toUpperCase()}/ready`,
    'remote: https://alice:p%40ss@example.com/openchamber.git',
    'authorization: Bearer eyJhbGciOi.test-signature',
    'query: https://example.com/models?api_key=sk-query-secret&status=failed',
    'env: OPENAI_API_KEY=sk-env-secret',
    'json: "refresh_token": "refresh secret value", "status": "failed"',
    "assignment: password='password secret value'",
    'ordinary: token parser failed at line 42; note=keep-this',
  ].join('\n');

  const sanitized = sanitizeReportText(report, { roots: [root] });

  assert.doesNotMatch(sanitized, /OpenChamberUpdate/i);
  assert.doesNotMatch(sanitized, /alice|p%40ss|eyJhbGciOi|sk-query-secret|sk-env-secret|refresh secret|password secret/i);
  assert.match(sanitized, /native path: <update-path>[\\/]staging[\\/]repo/);
  assert.match(sanitized, /normalized path: <update-path>\/reports\/update\.txt/);
  assert.match(sanitized, /remote: https:\/\/<credentials>@example\.com\/openchamber\.git/);
  assert.match(sanitized, /authorization: Bearer <redacted>/);
  assert.match(sanitized, /query: https:\/\/example\.com\/models\?api_key=<redacted>&status=failed/);
  assert.match(sanitized, /env: OPENAI_API_KEY=<redacted>/);
  assert.match(sanitized, /json: "refresh_token": "<redacted>", "status": "failed"/);
  assert.match(sanitized, /assignment: password='<redacted>'/);
  assert.match(sanitized, /ordinary: token parser failed at line 42; note=keep-this/);
});

test('reads PowerShell UTF-8 JSON files with a byte-order mark', async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-source-json-'));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'result.json');
  await fsp.writeFile(filePath, `\uFEFF${JSON.stringify({ status: 'success' })}`, 'utf8');

  assert.deepEqual(await readJsonFile(filePath), { status: 'success' });
});
