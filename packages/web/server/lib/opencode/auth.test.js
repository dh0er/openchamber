import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAuthFile, writeAuthFile } from './auth.js';

const temporaryDirectories = [];

const createTemporaryAuthPath = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-auth-'));
  temporaryDirectories.push(directory);
  return { directory, authFile: path.join(directory, 'auth.json') };
};

afterEach(() => {
  const temporaryRoot = path.resolve(os.tmpdir());
  for (const directory of temporaryDirectories.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== temporaryRoot) {
      throw new Error(`Refusing to remove unexpected test directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('OpenCode auth storage', () => {
  it('atomically creates private auth JSON in the target directory', () => {
    const { directory, authFile } = createTemporaryAuthPath();
    const auth = { anthropic: { type: 'api', key: 'test-secret' } };

    writeAuthFile(auth, { authFile, randomUUID: () => 'create' });

    expect(readAuthFile({ authFile })).toEqual(auth);
    expect(fs.readdirSync(directory)).toEqual(['auth.json']);
    if (process.platform !== 'win32') {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the original file and cleans the private temp file when rename fails', () => {
    const { directory, authFile } = createTemporaryAuthPath();
    const original = '{"openai":{"type":"oauth"}}\n';
    fs.writeFileSync(authFile, original, { mode: 0o644 });
    let temporaryWriteOptions = null;
    const fileSystem = Object.create(fs);
    fileSystem.writeFileSync = (target, value, options) => {
      if (target !== authFile) temporaryWriteOptions = options;
      return fs.writeFileSync(target, value, options);
    };
    fileSystem.renameSync = () => {
      const error = new Error('rename blocked');
      error.code = 'EPERM';
      throw error;
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => writeAuthFile(
      { anthropic: { type: 'api', key: 'new-secret-must-not-log' } },
      { authFile, fs: fileSystem, randomUUID: () => 'rename-failure' },
    )).toThrow('Failed to write OpenCode auth configuration');

    expect(fs.readFileSync(authFile, 'utf8')).toBe(original);
    expect(fs.readFileSync(`${authFile}.openchamber.backup`, 'utf8')).toBe(original);
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    expect(temporaryWriteOptions).toMatchObject({ flag: 'wx', mode: 0o600 });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('new-secret-must-not-log');
    if (process.platform !== 'win32') {
      expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(`${authFile}.openchamber.backup`).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed and removes a backup when POSIX chmod cannot secure it', () => {
    const { directory, authFile } = createTemporaryAuthPath();
    const original = '{"openai":{"type":"oauth"}}\n';
    fs.writeFileSync(authFile, original, { mode: 0o600 });
    const fileSystem = Object.create(fs);
    fileSystem.chmodSync = (target, mode) => {
      if (target.endsWith('.openchamber.backup')) throw new Error('chmod blocked');
      return fs.chmodSync(target, mode);
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => writeAuthFile(
      { anthropic: { type: 'api', key: 'chmod-secret-must-not-log' } },
      { authFile, fs: fileSystem, platform: 'linux', randomUUID: () => 'chmod-failure' },
    )).toThrow('Failed to write OpenCode auth configuration');

    expect(fs.readFileSync(authFile, 'utf8')).toBe(original);
    expect(fs.existsSync(`${authFile}.openchamber.backup`)).toBe(false);
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('chmod-secret-must-not-log');
  });
});
