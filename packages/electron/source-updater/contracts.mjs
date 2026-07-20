import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const SOURCE_UPDATE_SCHEMA_VERSION = 1;
export const SOURCE_UPDATE_KIND = 'openchamber-source-update';
export const READY_UPDATE_SCHEMA_VERSION = 1;
export const READY_UPDATE_KIND = 'openchamber-source-update-ready';
export const OFFICIAL_REPOSITORY_URL = 'https://github.com/openchamber/openchamber.git';
export const OFFICIAL_BRANCH = 'main';
export const SOURCE_UPDATE_RESOURCE_DIRECTORY = 'source-update';
export const SOURCE_UPDATE_MANIFEST_FILE = 'source-update-manifest.json';
export const READY_UPDATE_MANIFEST_FILE = 'update.json';

const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export class SourceUpdateError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'SourceUpdateError';
    this.code = code;
    if (options.report) this.report = options.report;
  }
}

const assertObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SourceUpdateError('INVALID_MANIFEST', `${label} must be an object.`);
  }
  return value;
};

const assertString = (value, label, { maxLength = 500 } = {}) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new SourceUpdateError('INVALID_MANIFEST', `${label} must be a non-empty string.`);
  }
  return value;
};

const assertSha1 = (value, label) => {
  const result = assertString(value, label, { maxLength: 40 }).toLowerCase();
  if (!SHA1_RE.test(result)) {
    throw new SourceUpdateError('INVALID_MANIFEST', `${label} must be a full Git SHA.`);
  }
  return result;
};

const assertSha256 = (value, label) => {
  const result = assertString(value, label, { maxLength: 64 }).toLowerCase();
  if (!SHA256_RE.test(result)) {
    throw new SourceUpdateError('INVALID_MANIFEST', `${label} must be a SHA-256 digest.`);
  }
  return result;
};

const assertPositiveInteger = (value, label, { allowZero = false } = {}) => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new SourceUpdateError('INVALID_MANIFEST', `${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  return value;
};

const assertSafeFileName = (value, label) => {
  const result = assertString(value, label, { maxLength: 200 });
  if (!SAFE_FILE_RE.test(result) || path.basename(result) !== result || result === '.' || result === '..') {
    throw new SourceUpdateError('INVALID_MANIFEST', `${label} must be a safe file name.`);
  }
  return result;
};

const assertRef = (value, label, prefix) => {
  const result = assertString(value, label, { maxLength: 300 });
  if (
    !result.startsWith(prefix)
    || result.includes('..')
    || result.includes('@{')
    || /[\u0000-\u0020\u007f~^:?*[\]\\]/.test(result)
    || result.endsWith('.')
    || result.endsWith('/')
  ) {
    throw new SourceUpdateError('INVALID_MANIFEST', `${label} is not a safe Git ref.`);
  }
  return result;
};

export const validateSourceUpdateManifest = (
  raw,
  { expectedRepositoryUrl = OFFICIAL_REPOSITORY_URL } = {},
) => {
  const manifest = assertObject(raw, 'Source update manifest');
  if (manifest.schemaVersion !== SOURCE_UPDATE_SCHEMA_VERSION || manifest.kind !== SOURCE_UPDATE_KIND) {
    throw new SourceUpdateError('INVALID_MANIFEST', 'Unsupported source update manifest schema.');
  }

  const official = assertObject(manifest.official, 'manifest.official');
  const repositoryUrl = assertString(official.repositoryUrl, 'manifest.official.repositoryUrl');
  if (repositoryUrl !== expectedRepositoryUrl) {
    throw new SourceUpdateError('INVALID_MANIFEST', 'Source update manifest does not target the official repository.');
  }
  if (official.branch !== OFFICIAL_BRANCH) {
    throw new SourceUpdateError('INVALID_MANIFEST', `Source update branch must be ${OFFICIAL_BRANCH}.`);
  }

  const customizations = assertObject(manifest.customizations, 'manifest.customizations');
  const bundle = assertObject(customizations.bundle, 'manifest.customizations.bundle');
  const application = assertObject(manifest.application, 'manifest.application');

  return Object.freeze({
    schemaVersion: SOURCE_UPDATE_SCHEMA_VERSION,
    kind: SOURCE_UPDATE_KIND,
    generatedAt: assertString(manifest.generatedAt, 'manifest.generatedAt', { maxLength: 100 }),
    official: Object.freeze({
      repositoryUrl,
      branch: OFFICIAL_BRANCH,
      trackingRef: assertRef(official.trackingRef, 'manifest.official.trackingRef', 'refs/remotes/'),
      baseSha: assertSha1(official.baseSha, 'manifest.official.baseSha'),
      observedSha: assertSha1(official.observedSha, 'manifest.official.observedSha'),
    }),
    customizations: Object.freeze({
      branchRef: assertRef(customizations.branchRef, 'manifest.customizations.branchRef', 'refs/heads/'),
      headSha: assertSha1(customizations.headSha, 'manifest.customizations.headSha'),
      commitCount: assertPositiveInteger(customizations.commitCount, 'manifest.customizations.commitCount'),
      bundle: Object.freeze({
        file: assertSafeFileName(bundle.file, 'manifest.customizations.bundle.file'),
        sha256: assertSha256(bundle.sha256, 'manifest.customizations.bundle.sha256'),
        size: assertPositiveInteger(bundle.size, 'manifest.customizations.bundle.size'),
      }),
    }),
    application: Object.freeze({
      version: assertString(application.version, 'manifest.application.version', { maxLength: 100 }),
    }),
  });
};

export const validateReadyUpdateManifest = (raw) => {
  const manifest = assertObject(raw, 'Prepared update manifest');
  if (manifest.schemaVersion !== READY_UPDATE_SCHEMA_VERSION || manifest.kind !== READY_UPDATE_KIND) {
    throw new SourceUpdateError('INVALID_READY_UPDATE', 'Unsupported prepared update manifest schema.');
  }

  return Object.freeze({
    schemaVersion: READY_UPDATE_SCHEMA_VERSION,
    kind: READY_UPDATE_KIND,
    id: assertString(manifest.id, 'prepared.id', { maxLength: 100 }),
    preparedAt: assertString(manifest.preparedAt, 'prepared.preparedAt', { maxLength: 100 }),
    version: assertString(manifest.version, 'prepared.version', { maxLength: 100 }),
    architecture: assertString(manifest.architecture, 'prepared.architecture', { maxLength: 20 }),
    upstreamSha: assertSha1(manifest.upstreamSha, 'prepared.upstreamSha'),
    sourceHeadSha: assertSha1(manifest.sourceHeadSha, 'prepared.sourceHeadSha'),
    rebasedHeadSha: assertSha1(manifest.rebasedHeadSha, 'prepared.rebasedHeadSha'),
    installer: Object.freeze({
      file: assertSafeFileName(assertObject(manifest.installer, 'prepared.installer').file, 'prepared.installer.file'),
      sha256: assertSha256(manifest.installer.sha256, 'prepared.installer.sha256'),
      size: assertPositiveInteger(manifest.installer.size, 'prepared.installer.size'),
    }),
  });
};

export const readJsonFile = async (filePath, { maxBytes = 1024 * 1024 } = {}) => {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
    throw new SourceUpdateError('INVALID_MANIFEST', `Manifest size is invalid.`);
  }
  let parsed;
  try {
    const contents = await fsp.readFile(filePath, 'utf8');
    parsed = JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new SourceUpdateError('INVALID_MANIFEST', 'Manifest is not valid JSON.', { cause: error });
  }
  return parsed;
};

export const hashFileSha256 = async (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  stream.on('error', reject);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
});

export const writeJsonAtomic = async (filePath, value) => {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fsp.rename(temporaryPath, filePath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
};

export const assertPathInside = (rootPath, candidatePath, label = 'Path') => {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (relative === '' || relative === '.' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new SourceUpdateError('UNSAFE_PATH', `${label} must be a child of the source update directory.`);
  }
  return candidate;
};

export const ensureRealDirectoryInside = async (rootPath, directoryPath, label = 'Directory') => {
  await fsp.mkdir(directoryPath, { recursive: true });
  const [realRoot, realDirectory] = await Promise.all([
    fsp.realpath(rootPath),
    fsp.realpath(directoryPath),
  ]);
  assertPathInside(realRoot, realDirectory, label);
  return realDirectory;
};

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SECRET_ASSIGNMENT_KEY = String.raw`(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|token|password|passwd|secret)`;

export const sanitizeReportText = (value, { roots = [], maxCharacters = 16_000 } = {}) => {
  let result = String(value ?? '');

  // Preserve the useful URL host/path while removing any userinfo component.
  result = result.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]+)@/gi, '$1<credentials>@');
  result = result.replace(/\b(Bearer)(\s+)[^\s"',;]+/gi, '$1$2<redacted>');

  const quotedSecretAssignment = new RegExp(
    `(["']?)(${SECRET_ASSIGNMENT_KEY})\\1(\\s*[:=]\\s*)(["'])([^\\r\\n]*?)\\4`,
    'gi',
  );
  result = result.replace(
    quotedSecretAssignment,
    (_match, keyQuote, key, separator, valueQuote) => `${keyQuote}${key}${keyQuote}${separator}${valueQuote}<redacted>${valueQuote}`,
  );

  const unquotedSecretAssignment = new RegExp(
    `(["']?)(${SECRET_ASSIGNMENT_KEY})\\1(\\s*[:=]\\s*)([^&\\s,;}\\]"']+)`,
    'gi',
  );
  result = result.replace(
    unquotedSecretAssignment,
    (_match, keyQuote, key, separator) => `${keyQuote}${key}${keyQuote}${separator}<redacted>`,
  );

  const rootVariants = roots
    .filter((root) => typeof root === 'string' && root.length > 0)
    .flatMap((root) => {
      const resolved = path.resolve(root);
      return [resolved, resolved.replace(/\\/g, '/')];
    })
    .filter((root, index, allRoots) => allRoots.findIndex((candidate) => candidate.toLowerCase() === root.toLowerCase()) === index)
    .sort((left, right) => right.length - left.length);

  for (const root of rootVariants) {
    result = result.replace(new RegExp(escapeRegularExpression(root), 'gi'), '<update-path>');
  }
  if (result.length > maxCharacters) {
    result = `[truncated]\n${result.slice(result.length - maxCharacters)}`;
  }
  return result;
};

export const toPublicPreparedUpdate = (manifest) => ({
  id: manifest.id,
  preparedAt: manifest.preparedAt,
  version: manifest.version,
  architecture: manifest.architecture,
  upstreamSha: manifest.upstreamSha,
  rebasedHeadSha: manifest.rebasedHeadSha,
  installerSha256: manifest.installer.sha256,
  installerSize: manifest.installer.size,
});
