import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { ElectronSshManager } from './ssh-manager.mjs';

const servers = [];
const tempDirs = [];

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
};

const readBody = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  return body;
};

const createFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    queueMicrotask(() => {
      if (child.exitCode !== null) return;
      child.exitCode = -1;
      child.emit('close', -1);
    });
    return true;
  };
  child.unref = () => undefined;
  return child;
};

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ElectronSshManager', () => {
  test('force shutdown clears timers and kills tracked SSH processes', () => {
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'openchamber-ssh-force-shutdown.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });
    const signals = [];
    const timer = setTimeout(() => {}, 60_000);
    manager.monitorTimers.set('ssh-1', timer);
    manager.sessions.set('ssh-1', {
      mainForward: { kill: (signal) => signals.push(['forward', signal]) },
      master: { kill: (signal) => signals.push(['master', signal]) },
    });
    manager.connecting.set('ssh-2', Promise.resolve());

    manager.forceShutdownAll();

    expect(signals).toEqual([
      ['forward', 'SIGKILL'],
      ['master', 'SIGKILL'],
    ]);
    expect(manager.monitorTimers.size).toBe(0);
    expect(manager.sessions.size).toBe(0);
    expect(manager.connecting.size).toBe(0);
  });

  test('force shutdown kills disconnecting children after their session was removed', async () => {
    const spawned = [];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-disconnect-test-'));
    tempDirs.push(tempDir);
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(tempDir, 'settings.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      spawnProcess: () => {
        const child = createFakeChild();
        spawned.push(child);
        return child;
      },
    });
    const parsed = { args: [], destination: 'test-host' };
    const master = await manager.spawnMasterProcess(parsed, path.join(tempDir, 'control.sock'), path.join(tempDir, 'askpass.sh'), null);
    const mainForward = await manager.spawnMainForward(parsed, path.join(tempDir, 'control.sock'), '127.0.0.1', 3000, 4000);
    manager.sessions.set('ssh-1', {
      instance: {
        remoteOpenchamber: {
          mode: 'external',
          keepRunning: true,
        },
      },
      parsed,
      sessionDir: tempDir,
      controlPath: path.join(tempDir, 'control.sock'),
      remotePort: 4000,
      startedByUs: false,
      master,
      mainForward,
    });

    const disconnecting = manager.disconnectInternal('ssh-1', false);

    expect(manager.sessions.has('ssh-1')).toBe(false);
    expect(spawned).toHaveLength(3);

    manager.forceShutdownAll();
    await disconnecting;

    expect(spawned[0].signals).toContain('SIGKILL');
    expect(spawned[1].signals).toContain('SIGKILL');
    expect(spawned[2].signals).toEqual(['SIGKILL']);
    expect(manager.activeChildren.size).toBe(0);
  });

  test('force shutdown kills connecting children and prevents later SSH spawns', async () => {
    const spawned = [];
    const manager = new ElectronSshManager({
      settingsFilePath: path.join(os.tmpdir(), 'openchamber-ssh-connecting-shutdown.json'),
      appVersion: '0.0.0-test',
      emit: () => undefined,
      spawnProcess: () => {
        const child = createFakeChild();
        spawned.push(child);
        return child;
      },
    });
    const parsed = { args: [], destination: 'test-host' };
    const connectingChild = await manager.spawnMasterProcess(parsed, 'control.sock', 'askpass.sh', null);
    manager.connecting.set('ssh-1', new Promise(() => {}));

    manager.forceShutdownAll();

    expect(connectingChild.signals).toEqual(['SIGKILL']);
    expect(manager.connecting.size).toBe(0);
    expect(() => manager.runTrackedOutput('ssh', ['-V'])).toThrow('SSH manager is shutting down');
    await expect(manager.spawnMasterProcess(parsed, 'control.sock', 'askpass.sh', null)).rejects.toThrow('SSH manager is shutting down');
    expect(spawned).toHaveLength(1);
  });

  test('stores a client token for forwarded OpenChamber hosts when UI password is configured', async () => {
    let loginPayload = null;
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/auth/session') {
        loginPayload = JSON.parse(await readBody(req));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: true, clientToken: 'ssh-client-token' }));
        return;
      }
      res.writeHead(404).end();
    });
    const localUrl = await listen(server);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ssh-manager-test-'));
    tempDirs.push(tempDir);
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const manager = new ElectronSshManager({
      settingsFilePath,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    const token = await manager.issueClientToken(localUrl, 'ui-secret');
    await manager.updateHostRuntime('ssh-1', 'SSH Host', localUrl, token);

    const settings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(loginPayload).toMatchObject({
      password: 'ui-secret',
      trustDevice: true,
      issueClientToken: true,
    });
    expect(settings.desktopHosts).toEqual([{ id: 'ssh-1', label: 'SSH Host', url: localUrl, apiUrl: localUrl, clientToken: 'ssh-client-token' }]);
  });
});
