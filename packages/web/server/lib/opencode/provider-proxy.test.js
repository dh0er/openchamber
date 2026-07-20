import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureConfiguredProviderProxyPlugin,
  fetchWithProviderProxy,
  readProviderProxies,
  readProviderProxy,
  removeProviderProxy,
  writeProviderProxy,
} from './provider-proxy.js';

const temporaryDirectories = [];
const servers = [];

function createStorage() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-provider-proxy-'));
  temporaryDirectories.push(directory);
  return {
    directory,
    overrides: {
      sidecarFile: path.join(directory, 'openchamber', 'provider-proxies.json'),
      pluginFile: path.join(directory, 'opencode', 'plugins', 'openchamber-provider-proxy.js'),
      randomUUID: () => 'test-write',
    },
  };
}

async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
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

describe('provider proxy persistence', () => {
  it('defaults missing exact provider IDs to direct mode', () => {
    const { overrides } = createStorage();

    expect(readProviderProxy('anthropic:openchamber:one', overrides)).toEqual({ mode: 'direct' });
    expect(Object.keys(readProviderProxies(overrides))).toEqual([]);
    expect(ensureConfiguredProviderProxyPlugin(overrides)).toBe(false);
    expect(fs.existsSync(overrides.pluginFile)).toBe(false);
  });

  it('persists exact non-direct mappings and installs a private inert plugin', () => {
    const { overrides } = createStorage();

    writeProviderProxy(
      'anthropic:openchamber:one',
      { mode: 'manual', url: 'http://127.0.0.1:9000' },
      overrides,
    );
    writeProviderProxy('anthropic:openchamber:two', { mode: 'system' }, overrides);

    expect({ ...readProviderProxies(overrides) }).toEqual({
      'anthropic:openchamber:one': { mode: 'manual', url: 'http://127.0.0.1:9000' },
      'anthropic:openchamber:two': { mode: 'system' },
    });
    expect(JSON.parse(fs.readFileSync(overrides.sidecarFile, 'utf8'))).toEqual({
      version: 1,
      providers: {
        'anthropic:openchamber:one': { mode: 'manual', url: 'http://127.0.0.1:9000' },
        'anthropic:openchamber:two': { mode: 'system' },
      },
    });

    const plugin = fs.readFileSync(overrides.pluginFile, 'utf8');
    expect(plugin).toContain('export const OpenChamberProviderProxy');
    expect(plugin).toContain("fetch: (input, init) => proxiedFetch(proxy, input, init)");
    expect(plugin).toContain("proxy: proxy.url");
    expect(plugin).toContain('GetSystemWebProxy()');
    expect(plugin).toContain('.GetProxy($target)');
    expect(plugin).not.toContain('apiKey');
    expect(ensureConfiguredProviderProxyPlugin(overrides)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(overrides.sidecarFile)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(overrides.sidecarFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(overrides.pluginFile).mode & 0o777).toBe(0o600);
    }
  });

  it('removes direct mappings and deletes an empty sidecar', () => {
    const { overrides } = createStorage();
    writeProviderProxy('provider:one', { mode: 'system' }, overrides);
    writeProviderProxy('provider:two', { mode: 'manual', url: 'https://proxy.example:8443' }, overrides);

    expect(removeProviderProxy('provider:one', overrides)).toBe(true);
    expect(readProviderProxy('provider:one', overrides)).toEqual({ mode: 'direct' });
    expect(fs.existsSync(overrides.sidecarFile)).toBe(true);

    expect(writeProviderProxy('provider:two', { mode: 'direct' }, overrides)).toEqual({ mode: 'direct' });
    expect(fs.existsSync(overrides.sidecarFile)).toBe(false);
    expect(fs.existsSync(overrides.pluginFile)).toBe(true);
    expect(removeProviderProxy('provider:two', overrides)).toBe(false);
  });

  it('rejects proxy credentials without creating storage', () => {
    const { overrides } = createStorage();

    expect(() => writeProviderProxy(
      'provider:one',
      { mode: 'manual', url: 'http://user:secret@proxy.example:8080' },
      overrides,
    )).toThrow('Proxy URL is invalid');

    expect(fs.existsSync(overrides.sidecarFile)).toBe(false);
    expect(fs.existsSync(overrides.pluginFile)).toBe(false);
  });

  it('cleans the private temporary file when an atomic rename fails', () => {
    const { directory, overrides } = createStorage();
    const fileSystem = Object.create(fs);
    fileSystem.renameSync = () => {
      throw new Error('rename blocked');
    };

    expect(() => writeProviderProxy('provider:one', { mode: 'system' }, {
      ...overrides,
      fs: fileSystem,
    })).toThrow('Failed to install provider proxy plugin');

    const files = fs.readdirSync(path.join(directory, 'opencode', 'plugins'));
    expect(files.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects an oversized UTF-8 sidecar without changing the previous file', () => {
    const { overrides } = createStorage();
    const maxBytes = 256 * 1024;
    const providers = {};
    let oversizedProviderId = '';
    let oversizedContent = '';

    for (let index = 0; index < 1_000; index += 1) {
      const providerId = `provider:${index}:${'ü'.repeat(480)}`;
      const nextProviders = { ...providers, [providerId]: { mode: 'system' } };
      const nextContent = `${JSON.stringify({ version: 1, providers: nextProviders }, null, 2)}\n`;
      if (Buffer.byteLength(nextContent, 'utf8') > maxBytes) {
        oversizedProviderId = providerId;
        oversizedContent = nextContent;
        break;
      }
      providers[providerId] = { mode: 'system' };
    }

    const originalContent = `${JSON.stringify({ version: 1, providers }, null, 2)}\n`;
    expect(oversizedProviderId).not.toBe('');
    expect(Buffer.byteLength(originalContent, 'utf8')).toBeLessThanOrEqual(maxBytes);
    expect(Buffer.byteLength(oversizedContent, 'utf8')).toBeGreaterThan(maxBytes);
    expect(oversizedContent.length).toBeLessThan(maxBytes);
    fs.mkdirSync(path.dirname(overrides.sidecarFile), { recursive: true });
    fs.writeFileSync(overrides.sidecarFile, originalContent, { encoding: 'utf8', mode: 0o600 });

    expect(() => writeProviderProxy(
      oversizedProviderId,
      { mode: 'system' },
      overrides,
    )).toThrow('Provider proxy configuration is too large');
    expect(fs.readFileSync(overrides.sidecarFile, 'utf8')).toBe(originalContent);
  });

  it('generates a loadable one-export OpenCode config hook with exact-ID matching', async () => {
    const { overrides } = createStorage();
    writeProviderProxy('provider:exact', { mode: 'system' }, overrides);
    const source = fs.readFileSync(overrides.pluginFile, 'utf8');
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const pluginModule = await import(moduleUrl);

    expect(Object.keys(pluginModule)).toEqual(['OpenChamberProviderProxy']);
    const hooks = await pluginModule.OpenChamberProviderProxy();
    const config = {
      provider: {
        'provider:exact': { options: { baseURL: 'https://gateway.example/v1' } },
        'provider:other': { options: {} },
      },
    };
    await hooks.config(config);

    expect(config.provider['provider:exact'].options.fetch).toEqual(expect.any(Function));
    expect(config.provider['provider:exact'].options.baseURL).toBe('https://gateway.example/v1');
    expect(config.provider['provider:other'].options.fetch).toBeUndefined();
  });

  it('applies exact-ID proxy mappings to a legacy plural-only provider config', async () => {
    const { overrides } = createStorage();
    writeProviderProxy('provider:exact', { mode: 'system' }, overrides);
    const source = fs.readFileSync(overrides.pluginFile, 'utf8');
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const pluginModule = await import(moduleUrl);
    const hooks = await pluginModule.OpenChamberProviderProxy();
    const config = {
      providers: {
        'provider:exact': { options: { baseURL: 'https://gateway.example/v1' } },
        'provider:other': { options: {} },
      },
    };

    await hooks.config(config);

    expect(config.providers['provider:exact'].options.fetch).toEqual(expect.any(Function));
    expect(config.providers['provider:exact'].options.baseURL).toBe('https://gateway.example/v1');
    expect(config.providers['provider:other'].options.fetch).toBeUndefined();
  });
});

describe('fetchWithProviderProxy', () => {
  it('uses the supplied global fetch unchanged in direct mode', async () => {
    const response = new Response('direct');
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const init = { headers: { authorization: 'Bearer test-only' } };

    await expect(fetchWithProviderProxy(
      'https://gateway.example/models',
      init,
      { mode: 'direct' },
      { fetchImpl },
    )).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith('https://gateway.example/models', init);
  });

  it('routes a manual discovery request through a per-request Node 22 proxy', async () => {
    const requests = [];
    const proxy = http.createServer((request, response) => {
      requests.push({ headers: request.headers, url: request.url });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[{"id":"test-model"}]}');
    });
    const port = await listen(proxy);

    const response = await fetchWithProviderProxy(
      'http://gateway.invalid/v1/models',
      { headers: { authorization: 'Bearer discovery-test' } },
      { mode: 'manual', url: `http://127.0.0.1:${port}` },
      { bunFetch: null, nodeVersion: '22.20.0' },
    );

    expect(response.status).toBe(200);
    expect(response.url).toBe('http://gateway.invalid/v1/models');
    expect(await response.json()).toEqual({ data: [{ id: 'test-model' }] });
    expect(requests).toEqual([expect.objectContaining({
      url: 'http://gateway.invalid/v1/models',
      headers: expect.objectContaining({ authorization: 'Bearer discovery-test' }),
    })]);
  });

  it('uses CONNECT for HTTPS discovery through a manual Node 22 proxy', async () => {
    const target = http.createServer((request, response) => {
      expect(request.url).toBe('/v1/models');
      response.end('tunneled');
    });
    const targetPort = await listen(target);
    const connectTargets = [];
    const proxy = http.createServer();
    proxy.on('connect', (request, clientSocket, head) => {
      connectTargets.push(request.url);
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
    });
    const proxyPort = await listen(proxy);
    const tlsConnect = vi.fn(({ socket }) => {
      socket.encrypted = true;
      queueMicrotask(() => socket.emit('secureConnect'));
      return socket;
    });

    const response = await fetchWithProviderProxy(
      `https://127.0.0.1:${targetPort}/v1/models`,
      {},
      { mode: 'manual', url: `http://127.0.0.1:${proxyPort}` },
      { bunFetch: null, nodeVersion: '22.20.0', tlsConnect },
    );

    expect(await response.text()).toBe('tunneled');
    expect(connectTargets).toEqual([`127.0.0.1:${targetPort}`]);
    expect(tlsConnect).toHaveBeenCalledTimes(1);
  });

  it('uses an injected Windows PAC resolver and caches its proxy result briefly', async () => {
    const proxy = http.createServer((_request, response) => response.end('proxied-system'));
    const port = await listen(proxy);
    const systemProxyResolver = vi.fn().mockResolvedValue(`http://127.0.0.1:${port}`);
    const systemProxyCache = new Map();

    const first = await fetchWithProviderProxy(
      'http://gateway.invalid/models',
      {},
      { mode: 'system' },
      {
        bunFetch: null,
        nodeVersion: '22.20.0',
        platform: 'win32',
        systemProxyCache,
        systemProxyResolver,
      },
    );
    const second = await fetchWithProviderProxy(
      'http://gateway.invalid/models',
      {},
      { mode: 'system' },
      {
        bunFetch: null,
        nodeVersion: '22.20.0',
        platform: 'win32',
        systemProxyCache,
        systemProxyResolver,
      },
    );

    expect(await first.text()).toBe('proxied-system');
    expect(await second.text()).toBe('proxied-system');
    expect(systemProxyResolver).toHaveBeenCalledTimes(1);
    expect(systemProxyResolver).toHaveBeenCalledWith(
      'http://gateway.invalid/models',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('respects PAC DIRECT without silently falling back to an environment proxy', async () => {
    const target = http.createServer((_request, response) => response.end('direct-system'));
    const port = await listen(target);

    const response = await fetchWithProviderProxy(
      `http://127.0.0.1:${port}/models`,
      {},
      { mode: 'system' },
      {
        bunFetch: null,
        nodeVersion: '22.20.0',
        platform: 'win32',
        systemProxyCache: new Map(),
        systemProxyResolver: vi.fn().mockResolvedValue('DIRECT'),
      },
    );

    expect(await response.text()).toBe('direct-system');
  });

  it('honors NO_PROXY for system settings on Node 22', async () => {
    const target = http.createServer((_request, response) => response.end('no-proxy'));
    const targetPort = await listen(target);
    const proxyRequests = [];
    const proxy = http.createServer((request, response) => {
      proxyRequests.push(request.url);
      response.end('proxied');
    });
    const proxyPort = await listen(proxy);

    const response = await fetchWithProviderProxy(
      `http://127.0.0.1:${targetPort}/models`,
      {},
      { mode: 'system' },
      {
        bunFetch: null,
        nodeVersion: '22.20.0',
        platform: 'linux',
        env: {
          HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
          NO_PROXY: `127.0.0.1:${targetPort}`,
        },
      },
    );

    expect(await response.text()).toBe('no-proxy');
    expect(proxyRequests).toEqual([]);
  });

  it('aborts an in-flight manual Node 22 proxy request', async () => {
    let markProxyReached;
    const proxyReached = new Promise((resolve) => {
      markProxyReached = resolve;
    });
    const proxy = http.createServer(() => markProxyReached());
    const proxyPort = await listen(proxy);
    const controller = new AbortController();
    const request = fetchWithProviderProxy(
      'http://gateway.invalid/models',
      { signal: controller.signal },
      { mode: 'manual', url: `http://127.0.0.1:${proxyPort}` },
      { bunFetch: null, nodeVersion: '22.20.0' },
    );

    await proxyReached;
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('strips authorization on cross-origin redirects while continuing through the proxy', async () => {
    const seen = [];
    const proxy = http.createServer((request, response) => {
      seen.push({ authorization: request.headers.authorization, url: request.url });
      if (request.url === 'http://first.invalid/start') {
        response.writeHead(302, { location: 'http://second.invalid/end' });
        response.end();
        return;
      }
      response.end('redirected');
    });
    const port = await listen(proxy);

    const response = await fetchWithProviderProxy(
      'http://first.invalid/start',
      { headers: { authorization: 'Bearer redirect-test' } },
      { mode: 'manual', url: `http://127.0.0.1:${port}` },
      { bunFetch: null, nodeVersion: '22.20.0' },
    );

    expect(await response.text()).toBe('redirected');
    expect(response.redirected).toBe(true);
    expect(seen).toEqual([
      { authorization: 'Bearer redirect-test', url: 'http://first.invalid/start' },
      { authorization: undefined, url: 'http://second.invalid/end' },
    ]);
  });

  it('fails clearly on unsupported Node runtimes', async () => {
    await expect(fetchWithProviderProxy(
      'https://gateway.example/models',
      {},
      { mode: 'manual', url: 'http://127.0.0.1:9000' },
      { bunFetch: null, nodeVersion: '21.7.0' },
    )).rejects.toThrow('Node.js 22 or newer');
  });
});
