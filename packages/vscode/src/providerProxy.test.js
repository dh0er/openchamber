import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureProviderProxyPlugin as ensureWebProviderProxyPlugin } from '../../web/server/lib/opencode/provider-proxy.js';
import {
  ensureProviderProxyPluginInstalled,
  fetchWithProviderProxy,
  getProviderProxy,
  readProviderProxyFile,
  writeProviderProxy,
} from './providerProxy';

const temporaryDirectories = [];

const storage = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-provider-proxy-'));
  temporaryDirectories.push(root);
  return {
    root,
    sidecarPath: path.join(root, '.config', 'openchamber', 'provider-proxies.json'),
    pluginPath: path.join(root, '.config', 'opencode', 'plugins', 'openchamber-provider-proxy.js'),
  };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('VS Code provider proxy persistence', () => {
  test('round-trips only non-direct settings and normalizes manual proxy origins', () => {
    const target = storage();
    const providerId = 'openai:openchamber:11111111-1111-4111-8111-111111111111';
    writeProviderProxy(providerId, { mode: 'manual', url: 'http://localhost:9000/' }, target);

    expect(getProviderProxy(providerId, target)).toEqual({ mode: 'manual', url: 'http://localhost:9000' });
    expect(readProviderProxyFile(target)).toEqual({
      version: 1,
      providers: { [providerId]: { mode: 'manual', url: 'http://localhost:9000' } },
    });
    expect(fs.readFileSync(target.sidecarPath, 'utf8')).not.toContain('apiKey');

    writeProviderProxy(providerId, { mode: 'direct' }, target);
    expect(fs.existsSync(target.sidecarPath)).toBe(false);
    expect(getProviderProxy(providerId, target)).toEqual({ mode: 'direct' });
  });

  test('rejects credentialed, path-scoped, and malformed manual proxy URLs', () => {
    const target = storage();
    for (const url of [
      'http://user:secret@localhost:9000',
      'http://localhost:9000/proxy',
      'socks5://localhost:9000',
      'not a url',
    ]) {
      expect(() => writeProviderProxy('safe-provider', { mode: 'manual', url }, target)).toThrow();
    }
    expect(fs.existsSync(target.sidecarPath)).toBe(false);
  });

  test('generates the same single-export OpenCode plugin as the web runtime', async () => {
    const target = storage();
    const webPluginPath = path.join(target.root, 'web-plugin.js');
    writeProviderProxy('safe-provider', { mode: 'manual', url: 'http://localhost:9000' }, target);
    ensureWebProviderProxyPlugin({
      sidecarFile: target.sidecarPath,
      pluginFile: webPluginPath,
    });

    expect(fs.readFileSync(target.pluginPath, 'utf8')).toBe(fs.readFileSync(webPluginPath, 'utf8'));
    const pluginModule = await import(`${pathToFileURL(target.pluginPath).href}?test=${Date.now()}`);
    expect(Object.keys(pluginModule)).toEqual(['OpenChamberProviderProxy']);
    const hooks = await pluginModule.OpenChamberProviderProxy();
    const legacyConfig = { providers: { 'safe-provider': { options: { timeout: 10 } } } };
    await hooks.config(legacyConfig);
    expect(legacyConfig.providers['safe-provider'].options.timeout).toBe(10);
    expect(typeof legacyConfig.providers['safe-provider'].options.fetch).toBe('function');
  });

  test('rolls the sidecar back when plugin installation fails', () => {
    const target = storage();
    fs.mkdirSync(target.pluginPath, { recursive: true });
    expect(() => writeProviderProxy(
      'safe-provider',
      { mode: 'manual', url: 'http://localhost:9000' },
      target,
    )).toThrow('Failed to install the OpenCode provider proxy plugin');
    expect(fs.existsSync(target.sidecarPath)).toBe(false);
  });

  test('does not install a plugin when no non-direct mapping exists', () => {
    const target = storage();
    expect(ensureProviderProxyPluginInstalled(target)).toBe(false);
    expect(fs.existsSync(target.pluginPath)).toBe(false);
  });

  test('discovers through a manual HTTP proxy while keeping the API key in request headers', async () => {
    const proxyServer = http.createServer((request, response) => {
      expect(request.url).toBe('http://models.invalid/v1/models');
      expect(request.headers.authorization).toBe('Bearer discovery-secret');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'proxied-model' }] }));
    });
    await new Promise((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = proxyServer.address();
      if (!address || typeof address === 'string') throw new Error('Proxy server did not bind');
      const response = await fetchWithProviderProxy(
        'http://models.invalid/v1/models',
        'discovery-secret',
        { mode: 'manual', url: `http://127.0.0.1:${address.port}` },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: [{ id: 'proxied-model' }] });

      const systemResponse = await fetchWithProviderProxy(
        'http://models.invalid/v1/models',
        'discovery-secret',
        { mode: 'system' },
        {
          platform: 'linux',
          environment: {
            ...process.env,
            HTTP_PROXY: `http://127.0.0.1:${address.port}`,
            http_proxy: '',
            NO_PROXY: '',
            no_proxy: '',
          },
        },
      );
      expect(systemResponse.status).toBe(200);
      expect(await systemResponse.json()).toEqual({ data: [{ id: 'proxied-model' }] });

      await expect(fetchWithProviderProxy(
        'http://models.invalid/v1/models',
        'discovery-secret',
        { mode: 'system' },
        { platform: 'linux', environment: {} },
      )).rejects.toThrow('No system proxy is configured for this provider URL');
    } finally {
      await new Promise((resolve) => proxyServer.close(resolve));
    }
  });
});
