import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');
const UNSAFE_AUTH_MAP_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type AuthEntry = Record<string, unknown>;
type AuthFile = Record<string, AuthEntry>;
type AuthStorageOverrides = {
  authFile?: string;
  dataDir?: string;
  fs?: typeof fs;
  randomUUID?: () => string;
  platform?: NodeJS.Platform;
};

const resolveAuthStorage = (overrides: AuthStorageOverrides = {}) => {
  const authFile = overrides.authFile
    || (overrides.dataDir ? path.join(overrides.dataDir, 'auth.json') : AUTH_FILE);
  return {
    authFile,
    directory: path.dirname(authFile),
    fileSystem: overrides.fs || fs,
    randomUUID: overrides.randomUUID || randomUUID,
    platform: overrides.platform || process.platform,
  };
};

const chmodPrivate = (
  storage: ReturnType<typeof resolveAuthStorage>,
  filePath: string,
  mode: number,
): void => {
  try {
    storage.fileSystem.chmodSync(filePath, mode);
  } catch (error) {
    if (storage.platform !== 'win32') throw error;
    // Windows does not expose POSIX mode bits consistently.
  }
};

const assertSafeProviderId = (providerId: string): void => {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }
  if (UNSAFE_AUTH_MAP_KEYS.has(providerId.toLowerCase())) {
    throw new Error('Provider ID is invalid');
  }
};

export const readAuthFile = (storageOverrides?: AuthStorageOverrides): AuthFile => {
  const storage = resolveAuthStorage(storageOverrides);
  if (!storage.fileSystem.existsSync(storage.authFile)) {
    return {};
  }
  try {
    const content = storage.fileSystem.readFileSync(storage.authFile, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed) as AuthFile;
  } catch {
    console.error('Failed to read OpenCode auth configuration');
    throw new Error('Failed to read OpenCode auth configuration');
  }
};

export const writeAuthFile = (auth: AuthFile, storageOverrides?: AuthStorageOverrides): void => {
  const storage = resolveAuthStorage(storageOverrides);
  const temporaryFile = path.join(
    storage.directory,
    `.${path.basename(storage.authFile)}.${process.pid}.${storage.randomUUID()}.tmp`,
  );
  try {
    storage.fileSystem.mkdirSync(storage.directory, { recursive: true, mode: 0o700 });
    chmodPrivate(storage, storage.directory, 0o700);

    if (storage.fileSystem.existsSync(storage.authFile)) {
      chmodPrivate(storage, storage.authFile, 0o600);
      const backupFile = `${storage.authFile}.openchamber.backup`;
      storage.fileSystem.copyFileSync(storage.authFile, backupFile);
      try {
        chmodPrivate(storage, backupFile, 0o600);
      } catch (error) {
        try {
          storage.fileSystem.unlinkSync(backupFile);
        } catch {
          // Preserve the permission failure; backup cleanup is best effort.
        }
        throw error;
      }
    }

    storage.fileSystem.writeFileSync(temporaryFile, `${JSON.stringify(auth, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    chmodPrivate(storage, temporaryFile, 0o600);
    storage.fileSystem.renameSync(temporaryFile, storage.authFile);
    chmodPrivate(storage, storage.authFile, 0o600);
  } catch {
    try {
      if (storage.fileSystem.existsSync(temporaryFile)) {
        storage.fileSystem.unlinkSync(temporaryFile);
      }
    } catch {
      // Preserve the write failure; temp cleanup is best effort.
    }
    console.error('Failed to write OpenCode auth configuration');
    throw new Error('Failed to write OpenCode auth configuration');
  }
};

export const removeProviderAuth = (providerId: string, storageOverrides?: AuthStorageOverrides): boolean => {
  assertSafeProviderId(providerId);

  const auth = readAuthFile(storageOverrides);

  if (!Object.prototype.hasOwnProperty.call(auth, providerId)) {
    return false;
  }

  delete auth[providerId];
  writeAuthFile(auth, storageOverrides);
  return true;
};

export const getProviderAuth = (providerId: string, storageOverrides?: AuthStorageOverrides): AuthEntry | null => {
  assertSafeProviderId(providerId);
  const auth = readAuthFile(storageOverrides);
  return Object.prototype.hasOwnProperty.call(auth, providerId) ? auth[providerId] : null;
};

export const writeProviderApiKey = (
  providerId: string,
  apiKey: string,
  storageOverrides?: AuthStorageOverrides,
): void => {
  assertSafeProviderId(providerId);
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('API key is required');
  }

  const auth = readAuthFile(storageOverrides);
  auth[providerId] = { type: 'api', key: apiKey };
  writeAuthFile(auth, storageOverrides);
};
