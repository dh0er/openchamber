import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const PROVIDER_PROXY_VERSION = 1;
const PROVIDER_PROXY_CACHE_TTL_MS = 30_000;
const PROVIDER_PROXY_FILE = path.join(
  os.homedir(),
  '.config',
  'openchamber',
  'provider-proxies.json',
);
const PROVIDER_PROXY_PLUGIN_FILE = path.join(
  os.homedir(),
  '.config',
  'opencode',
  'plugins',
  'openchamber-provider-proxy.js',
);
const MAX_PROVIDER_PROXY_FILE_BYTES = 256 * 1024;
const UNSAFE_PROVIDER_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = [
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
];
const systemProxyCache = new Map();

const POWERSHELL_PROXY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$target = [Uri]::new([Console]::In.ReadToEnd())',
  '$resolver = [Net.WebRequest]::GetSystemWebProxy()',
  '$resolved = $resolver.GetProxy($target)',
  "if ($null -eq $resolved -or $resolved.Equals($target)) { [Console]::Out.Write('DIRECT') } else { [Console]::Out.Write($resolved.AbsoluteUri) }",
].join('; ');

const PROVIDER_PROXY_PLUGIN_SOURCE_TEMPLATE = String.raw`// Managed by OpenChamber. This plugin contains no provider credentials.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const SIDECAR_FILE = __SIDECAR_FILE__;
const VERSION = 1;
const CACHE_TTL_MS = 30000;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const cache = new Map();
const powershellScript = [
  "$ErrorActionPreference = 'Stop'",
  '$target = [Uri]::new([Console]::In.ReadToEnd())',
  '$resolver = [Net.WebRequest]::GetSystemWebProxy()',
  '$resolved = $resolver.GetProxy($target)',
  "if ($null -eq $resolved -or $resolved.Equals($target)) { [Console]::Out.Write('DIRECT') } else { [Console]::Out.Write($resolved.AbsoluteUri) }",
].join('; ');

function validProviderId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !RESERVED_IDS.has(value.toLowerCase());
}

function proxyUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Provider proxy URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
    || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('Provider proxy URL is invalid');
  }
  return parsed.origin;
}

function settings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider proxy settings are invalid');
  }
  if (value.mode === 'system') return { mode: 'system' };
  if (value.mode === 'manual' && typeof value.url === 'string') {
    return { mode: 'manual', url: proxyUrl(value.url) };
  }
  throw new Error('Provider proxy settings are invalid');
}

function readMappings() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(SIDECAR_FILE, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error('Failed to read provider proxy configuration');
  }
  if (!parsed || parsed.version !== VERSION || !parsed.providers
    || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) {
    throw new Error('Failed to read provider proxy configuration');
  }
  const result = {};
  for (const [providerId, value] of Object.entries(parsed.providers)) {
    if (!validProviderId(providerId)) {
      throw new Error('Failed to read provider proxy configuration');
    }
    result[providerId] = settings(value);
  }
  return result;
}

function inputUrl(input) {
  if (typeof input === 'string' || input instanceof URL) return new URL(input).href;
  if (input && typeof input.url === 'string') return new URL(input.url).href;
  throw new Error('Provider request URL is invalid');
}

function runPowerShell(executable, target, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      powershellScript,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      child.kill();
      finish(signal?.reason instanceof Error ? signal.reason : new Error('Provider proxy resolution aborted'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Failed to resolve Windows system proxy'));
    }, 10000);
    child.on('error', (error) => finish(error));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4096) {
        child.kill();
        finish(new Error('Failed to resolve Windows system proxy'));
      }
    });
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error('Failed to resolve Windows system proxy'));
      finish(null, stdout.trim());
    });
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(target);
  });
}

async function windowsSystemProxy(target, signal) {
  const cacheKey = createHash('sha256').update(target).digest('hex');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let raw;
  try {
    raw = await runPowerShell('powershell.exe', target, signal);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    raw = await runPowerShell('pwsh.exe', target, signal);
  }
  const value = raw === 'DIRECT' ? 'DIRECT' : proxyUrl(raw);
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

function systemEnvironmentProxy(target) {
  const protocol = new URL(target).protocol;
  const value = protocol === 'https:'
    ? (process.env.https_proxy || process.env.HTTPS_PROXY)
    : (process.env.http_proxy || process.env.HTTP_PROXY);
  if (!value) throw new Error('No system proxy is available for this provider URL');
  proxyUrl(value);
}

async function proxiedFetch(proxy, input, init) {
  if (typeof Bun === 'undefined' || typeof Bun.fetch !== 'function') {
    throw new Error('Provider proxy requires the Bun runtime');
  }
  if (proxy.mode === 'manual') {
    return Bun.fetch(input, { ...(init || {}), proxy: proxy.url });
  }
  const target = inputUrl(input);
  if (process.platform !== 'win32') {
    systemEnvironmentProxy(target);
    return Bun.fetch(input, init);
  }
  const resolved = await windowsSystemProxy(target, init?.signal);
  if (resolved === 'DIRECT') return Bun.fetch(input, init);
  return Bun.fetch(input, { ...(init || {}), proxy: resolved });
}

export const OpenChamberProviderProxy = async () => ({
  config: async (config) => {
    const mappings = readMappings();
    const providerMaps = new Set([config && config.provider, config && config.providers]);
    for (const providers of providerMaps) {
      if (!providers || typeof providers !== 'object' || Array.isArray(providers)) continue;
      for (const [providerId, proxy] of Object.entries(mappings)) {
        if (!Object.prototype.hasOwnProperty.call(providers, providerId)) continue;
        const provider = providers[providerId];
        if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
        const options = provider.options && typeof provider.options === 'object' && !Array.isArray(provider.options)
          ? provider.options
          : {};
        provider.options = {
          ...options,
          fetch: (input, init) => proxiedFetch(proxy, input, init),
        };
      }
    }
  },
});
`;

function resolveStorage(overrides = {}) {
  const homeDirectory = overrides.homeDirectory || os.homedir();
  const sidecarFile = overrides.sidecarFile
    || (overrides.homeDirectory
      ? path.join(homeDirectory, '.config', 'openchamber', 'provider-proxies.json')
      : PROVIDER_PROXY_FILE);
  const pluginFile = overrides.pluginFile
    || (overrides.homeDirectory
      ? path.join(homeDirectory, '.config', 'opencode', 'plugins', 'openchamber-provider-proxy.js')
      : PROVIDER_PROXY_PLUGIN_FILE);
  return {
    fileSystem: overrides.fs || fs,
    platform: overrides.platform || process.platform,
    randomUUID: overrides.randomUUID || randomUUID,
    sidecarFile,
    pluginFile,
  };
}

function chmodPrivate(storage, target, mode) {
  try {
    storage.fileSystem.chmodSync(target, mode);
  } catch (error) {
    if (storage.platform !== 'win32') throw error;
  }
}

function assertRegularTarget(storage, target) {
  if (!storage.fileSystem.existsSync(target)) return;
  const stat = storage.fileSystem.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Unsafe provider proxy storage target');
  }
}

function atomicPrivateWrite(target, content, storage, failureMessage) {
  const directory = path.dirname(target);
  const temporaryFile = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${storage.randomUUID()}.tmp`,
  );
  try {
    storage.fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodPrivate(storage, directory, 0o700);
    assertRegularTarget(storage, target);
    if (storage.fileSystem.existsSync(target)) chmodPrivate(storage, target, 0o600);
    storage.fileSystem.writeFileSync(temporaryFile, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    chmodPrivate(storage, temporaryFile, 0o600);
    storage.fileSystem.renameSync(temporaryFile, target);
    chmodPrivate(storage, target, 0o600);
  } catch {
    try {
      if (storage.fileSystem.existsSync(temporaryFile)) {
        storage.fileSystem.unlinkSync(temporaryFile);
      }
    } catch {
      // Preserve the original failure; cleanup is best effort.
    }
    throw new Error(failureMessage);
  }
}

function assertProviderId(providerId) {
  if (typeof providerId !== 'string'
    || providerId.length === 0
    || providerId.length > 512
    || providerId.trim() !== providerId
    || /[\u0000-\u001f\u007f]/.test(providerId)
    || UNSAFE_PROVIDER_IDS.has(providerId.toLowerCase())) {
    throw new Error('Provider ID is invalid');
  }
  return providerId;
}

function normalizeProxyUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Proxy URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
    || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('Proxy URL is invalid');
  }
  return parsed.origin;
}

function normalizeProxySettings(value, { allowDirect = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider proxy settings are invalid');
  }
  if (value.mode === 'direct' && allowDirect) return { mode: 'direct' };
  if (value.mode === 'system') return { mode: 'system' };
  if (value.mode === 'manual' && typeof value.url === 'string') {
    return { mode: 'manual', url: normalizeProxyUrl(value.url) };
  }
  throw new Error('Provider proxy settings are invalid');
}

function parseSidecar(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Failed to read provider proxy configuration');
  }
  if (!parsed || parsed.version !== PROVIDER_PROXY_VERSION
    || !parsed.providers
    || typeof parsed.providers !== 'object'
    || Array.isArray(parsed.providers)) {
    throw new Error('Failed to read provider proxy configuration');
  }
  const providers = Object.create(null);
  try {
    for (const [providerId, value] of Object.entries(parsed.providers)) {
      assertProviderId(providerId);
      providers[providerId] = normalizeProxySettings(value, { allowDirect: false });
    }
  } catch {
    throw new Error('Failed to read provider proxy configuration');
  }
  return providers;
}

function readProviderProxies(overrides = {}) {
  const storage = resolveStorage(overrides);
  if (!storage.fileSystem.existsSync(storage.sidecarFile)) return Object.create(null);
  try {
    assertRegularTarget(storage, storage.sidecarFile);
    const stat = storage.fileSystem.statSync(storage.sidecarFile);
    if (stat.size > MAX_PROVIDER_PROXY_FILE_BYTES) {
      throw new Error('Provider proxy configuration is too large');
    }
    return parseSidecar(storage.fileSystem.readFileSync(storage.sidecarFile, 'utf8'));
  } catch {
    throw new Error('Failed to read provider proxy configuration');
  }
}

function readProviderProxy(providerId, overrides = {}) {
  assertProviderId(providerId);
  const providers = readProviderProxies(overrides);
  return Object.prototype.hasOwnProperty.call(providers, providerId)
    ? providers[providerId]
    : { mode: 'direct' };
}

function serializeSidecar(providers) {
  return `${JSON.stringify({ version: PROVIDER_PROXY_VERSION, providers }, null, 2)}\n`;
}

function writeSidecar(providers, overrides = {}) {
  const storage = resolveStorage(overrides);
  const content = serializeSidecar(providers);
  if (Buffer.byteLength(content, 'utf8') > MAX_PROVIDER_PROXY_FILE_BYTES) {
    throw new Error('Provider proxy configuration is too large');
  }
  atomicPrivateWrite(
    storage.sidecarFile,
    content,
    storage,
    'Failed to write provider proxy configuration',
  );
}

function removeProviderProxy(providerId, overrides = {}) {
  assertProviderId(providerId);
  const storage = resolveStorage(overrides);
  const providers = readProviderProxies(overrides);
  if (!Object.prototype.hasOwnProperty.call(providers, providerId)) return false;
  delete providers[providerId];
  if (Object.keys(providers).length > 0) {
    writeSidecar(providers, overrides);
    return true;
  }
  try {
    assertRegularTarget(storage, storage.sidecarFile);
    storage.fileSystem.unlinkSync(storage.sidecarFile);
  } catch {
    throw new Error('Failed to write provider proxy configuration');
  }
  return true;
}

function buildPluginSource(sidecarFile) {
  return PROVIDER_PROXY_PLUGIN_SOURCE_TEMPLATE.replace(
    '__SIDECAR_FILE__',
    JSON.stringify(sidecarFile),
  );
}

function ensureProviderProxyPlugin(overrides = {}) {
  const storage = resolveStorage(overrides);
  const content = buildPluginSource(storage.sidecarFile);
  try {
    if (storage.fileSystem.existsSync(storage.pluginFile)) {
      assertRegularTarget(storage, storage.pluginFile);
      const current = storage.fileSystem.readFileSync(storage.pluginFile, 'utf8');
      if (current === content) {
        chmodPrivate(storage, path.dirname(storage.pluginFile), 0o700);
        chmodPrivate(storage, storage.pluginFile, 0o600);
        return storage.pluginFile;
      }
    }
  } catch {
    throw new Error('Failed to install provider proxy plugin');
  }
  atomicPrivateWrite(
    storage.pluginFile,
    content,
    storage,
    'Failed to install provider proxy plugin',
  );
  return storage.pluginFile;
}

function ensureConfiguredProviderProxyPlugin(overrides = {}) {
  if (Object.keys(readProviderProxies(overrides)).length === 0) return false;
  ensureProviderProxyPlugin(overrides);
  return true;
}

function writeProviderProxy(providerId, value, overrides = {}) {
  assertProviderId(providerId);
  const normalized = normalizeProxySettings(value);
  if (normalized.mode === 'direct') {
    removeProviderProxy(providerId, overrides);
    return normalized;
  }
  ensureProviderProxyPlugin(overrides);
  const providers = readProviderProxies(overrides);
  providers[providerId] = normalized;
  writeSidecar(providers, overrides);
  return normalized;
}

function getInputUrl(input) {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(input);
    if (input && typeof input.url === 'string') return new URL(input.url);
  } catch {
    // Use the stable error below without exposing a possibly sensitive URL.
  }
  throw new Error('Provider request URL is invalid');
}

function validateTargetUrl(input) {
  const target = getInputUrl(input);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Provider request URL must use HTTP or HTTPS');
  }
  return target;
}

function normalizeResolvedSystemProxy(value, target) {
  if (value === null || value === undefined || value === '' || value === 'DIRECT') {
    return 'DIRECT';
  }
  let resolved;
  try {
    resolved = new URL(value);
  } catch {
    throw new Error('Failed to resolve system proxy');
  }
  if (resolved.href === target.href) return 'DIRECT';
  return normalizeProxyUrl(resolved.href);
}

function runPowerShellProxyResolver(executable, target, overrides = {}) {
  const spawnImpl = overrides.spawn || spawn;
  const timeoutMs = overrides.systemProxyTimeoutMs || 10_000;
  const signal = overrides.signal;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      POWERSHELL_PROXY_SCRIPT,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      child.kill();
      finish(signal?.reason instanceof Error
        ? signal.reason
        : new Error('System proxy resolution aborted'));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('Failed to resolve Windows system proxy'));
    }, timeoutMs);
    child.on('error', (error) => finish(error));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4096) {
        child.kill();
        finish(new Error('Failed to resolve Windows system proxy'));
      }
    });
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error('Failed to resolve Windows system proxy'));
      finish(null, stdout.trim());
    });
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(target.href);
  });
}

async function resolveWindowsSystemProxy(target, overrides = {}) {
  const resolver = overrides.systemProxyResolver;
  const cache = overrides.systemProxyCache || systemProxyCache;
  const now = overrides.now ? overrides.now() : Date.now();
  const cacheKey = createHash('sha256').update(target.href).digest('hex');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  let raw;
  if (resolver) {
    raw = await resolver(target.href, { signal: overrides.signal });
  } else {
    const executables = overrides.powershellExecutables || ['powershell.exe', 'pwsh.exe'];
    let lastError;
    for (const executable of executables) {
      try {
        raw = await runPowerShellProxyResolver(executable, target, overrides);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'ENOENT') break;
      }
    }
    if (lastError) throw new Error('Failed to resolve Windows system proxy');
  }

  const value = normalizeResolvedSystemProxy(raw, target);
  cache.set(cacheKey, {
    value,
    expiresAt: now + (overrides.systemProxyCacheTtlMs || PROVIDER_PROXY_CACHE_TTL_MS),
  });
  return value;
}

function getEnvironmentProxy(target, overrides = {}) {
  const environment = overrides.env || process.env;
  const value = target.protocol === 'https:'
    ? (environment.https_proxy || environment.HTTPS_PROXY)
    : (environment.http_proxy || environment.HTTP_PROXY);
  if (!value) throw new Error('No system proxy is configured for this provider URL');
  const proxy = normalizeProxyUrl(value);
  return {
    HTTP_PROXY: target.protocol === 'http:' ? proxy : undefined,
    HTTPS_PROXY: target.protocol === 'https:' ? proxy : undefined,
    NO_PROXY: environment.no_proxy || environment.NO_PROXY || '',
  };
}

function manualProxyEnvironment(proxyUrl) {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: '',
  };
}

async function resolveProxyEnvironment(target, proxySettings, overrides = {}) {
  if (proxySettings.mode === 'manual') {
    return manualProxyEnvironment(proxySettings.url);
  }
  const platform = overrides.platform || process.platform;
  if (platform !== 'win32') return getEnvironmentProxy(target, overrides);
  const resolved = await resolveWindowsSystemProxy(target, overrides);
  return resolved === 'DIRECT'
    ? { HTTP_PROXY: undefined, HTTPS_PROXY: undefined, NO_PROXY: '*' }
    : manualProxyEnvironment(resolved);
}

function nodeVersionParts(overrides = {}) {
  const version = overrides.nodeVersion || process.versions.node || '';
  const [major, minor] = String(version).replace(/^v/, '').split('.');
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
  };
}

function supportsProxyEnvironmentAgents(overrides = {}) {
  const nodeVersion = nodeVersionParts(overrides);
  return nodeVersion.major > 24
    || (nodeVersion.major === 24 && nodeVersion.minor >= 5);
}

function responseHeaders(message) {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
  }
  return headers;
}

function requestOnceWithProxyEnvironment(target, state, proxyEnvironment) {
  const transport = target.protocol === 'https:' ? https : http;
  const Agent = target.protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new Agent({ proxyEnv: proxyEnvironment });
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = transport.request(target, {
        method: state.method,
        headers: Object.fromEntries(state.headers.entries()),
        signal: state.signal,
        agent,
      }, (message) => {
        const cleanup = () => agent.destroy();
        message.once('end', cleanup);
        message.once('close', cleanup);
        resolve(message);
      });
    } catch (error) {
      agent.destroy();
      reject(error);
      return;
    }
    request.once('error', (error) => {
      agent.destroy();
      reject(error);
    });
    request.end(state.body || undefined);
  });
}

function effectivePort(target) {
  if (target.port) return target.port;
  return target.protocol === 'https:' ? '443' : '80';
}

function hostnameWithoutBrackets(value) {
  return value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1)
    : value;
}

function parseNoProxyEntry(value) {
  const entry = value.trim().toLowerCase();
  if (!entry) return null;
  if (entry === '*') return { hostname: '*', port: '' };

  let hostname = entry;
  let port = '';
  if (entry.startsWith('[')) {
    const closingBracket = entry.indexOf(']');
    if (closingBracket === -1) return null;
    hostname = entry.slice(1, closingBracket);
    const suffix = entry.slice(closingBracket + 1);
    if (suffix) {
      if (!/^:\d+$/.test(suffix)) return null;
      port = suffix.slice(1);
    }
  } else {
    const colon = entry.lastIndexOf(':');
    if (colon > -1 && entry.indexOf(':') === colon && /^\d+$/.test(entry.slice(colon + 1))) {
      hostname = entry.slice(0, colon);
      port = entry.slice(colon + 1);
    }
  }

  hostname = hostname.replace(/\.$/, '');
  if (!hostname) return null;
  return { hostname, port };
}

function bypassesProxy(target, value) {
  if (!value) return false;
  const targetHostname = hostnameWithoutBrackets(target.hostname).toLowerCase().replace(/\.$/, '');
  const targetPort = effectivePort(target);
  for (const rawEntry of value.split(',')) {
    const entry = parseNoProxyEntry(rawEntry);
    if (!entry || (entry.port && entry.port !== targetPort)) continue;
    if (entry.hostname === '*') return true;
    if (entry.hostname.startsWith('*.')) {
      if (targetHostname.endsWith(`.${entry.hostname.slice(2)}`)) return true;
      continue;
    }
    if (entry.hostname.startsWith('.')) {
      const suffix = entry.hostname.slice(1);
      if (targetHostname === suffix || targetHostname.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (targetHostname === entry.hostname) return true;
  }
  return false;
}

function explicitProxyForTarget(target, proxyEnvironment) {
  if (bypassesProxy(target, proxyEnvironment.NO_PROXY)) return null;
  const value = target.protocol === 'https:'
    ? proxyEnvironment.HTTPS_PROXY
    : proxyEnvironment.HTTP_PROXY;
  return value ? new URL(value) : null;
}

function headersForRequest(state, target, { throughForwardProxy = false } = {}) {
  const headers = Object.fromEntries(state.headers.entries());
  if (throughForwardProxy && !Object.prototype.hasOwnProperty.call(headers, 'host')) {
    headers.host = target.host;
  }
  return headers;
}

function requestDirect(target, state) {
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = transport.request(target, {
        method: state.method,
        headers: headersForRequest(state, target),
        signal: state.signal,
        agent: false,
      }, resolve);
    } catch (error) {
      reject(error);
      return;
    }
    request.once('error', reject);
    request.end(state.body || undefined);
  });
}

function absoluteProxyTarget(target) {
  const result = new URL(target);
  result.hash = '';
  return result.href;
}

function requestThroughForwardProxy(proxy, target, state) {
  const transport = proxy.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = transport.request(proxy, {
        method: state.method,
        path: absoluteProxyTarget(target),
        headers: headersForRequest(state, target, { throughForwardProxy: true }),
        signal: state.signal,
        agent: false,
      }, resolve);
    } catch (error) {
      reject(error);
      return;
    }
    request.once('error', reject);
    request.end(state.body || undefined);
  });
}

function proxyTunnelAuthority(target) {
  return `${target.hostname}:${effectivePort(target)}`;
}

function openProxyTunnel(proxy, target, signal) {
  const transport = proxy.protocol === 'https:' ? https : http;
  const authority = proxyTunnelAuthority(target);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, socket) => {
      if (settled) {
        if (socket) socket.destroy();
        return;
      }
      settled = true;
      if (error) reject(error);
      else resolve(socket);
    };
    let request;
    try {
      request = transport.request(proxy, {
        method: 'CONNECT',
        path: authority,
        headers: { host: authority },
        signal,
        agent: false,
      });
    } catch (error) {
      finish(error);
      return;
    }
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`Provider proxy CONNECT failed with status ${response.statusCode || 500}`));
        return;
      }
      if (head.length > 0) socket.unshift(head);
      finish(null, socket);
    });
    request.once('response', (response) => {
      response.resume();
      finish(new Error(`Provider proxy CONNECT failed with status ${response.statusCode || 500}`));
    });
    request.once('error', (error) => finish(error));
    request.end();
  });
}

function connectTlsTunnel(socket, target, signal, overrides = {}) {
  const connect = overrides.tlsConnect || tls.connect;
  const targetHostname = hostnameWithoutBrackets(target.hostname);
  return new Promise((resolve, reject) => {
    let secureSocket;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) {
        secureSocket?.destroy();
        socket.destroy();
        reject(error);
      } else {
        resolve(secureSocket);
      }
    };
    const abort = () => finish(signal?.reason instanceof Error
      ? signal.reason
      : new Error('Provider proxy request aborted'));
    try {
      secureSocket = connect({
        socket,
        servername: isIP(targetHostname) ? undefined : targetHostname,
        ALPNProtocols: ['http/1.1'],
      });
    } catch (error) {
      finish(error);
      return;
    }
    secureSocket.once('secureConnect', () => finish(null));
    secureSocket.once('error', (error) => finish(error));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function requestThroughTunnel(proxy, target, state, overrides = {}) {
  const tunnelSocket = await openProxyTunnel(proxy, target, state.signal);
  const secureSocket = await connectTlsTunnel(tunnelSocket, target, state.signal, overrides);
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => secureSocket;
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = https.request(target, {
        method: state.method,
        headers: headersForRequest(state, target),
        signal: state.signal,
        agent,
      }, (message) => {
        const cleanup = () => agent.destroy();
        message.once('end', cleanup);
        message.once('close', cleanup);
        resolve(message);
      });
    } catch (error) {
      agent.destroy();
      reject(error);
      return;
    }
    request.once('error', (error) => {
      agent.destroy();
      reject(error);
    });
    request.end(state.body || undefined);
  });
}

function requestOnceWithoutProxyEnvironment(target, state, proxyEnvironment, overrides = {}) {
  const proxy = explicitProxyForTarget(target, proxyEnvironment);
  if (!proxy) return requestDirect(target, state);
  if (target.protocol === 'http:') return requestThroughForwardProxy(proxy, target, state);
  return requestThroughTunnel(proxy, target, state, overrides);
}

async function requestState(input, init) {
  let requestInit = init;
  if (init?.body && typeof init.body === 'object') {
    requestInit = { ...init, duplex: init.duplex || 'half' };
  }
  const request = new Request(input, requestInit);
  const headers = new Headers(request.headers);
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
  return {
    body: request.body ? Buffer.from(await request.arrayBuffer()) : null,
    headers,
    method: request.method,
    redirect: request.redirect,
    signal: request.signal,
    target: validateTargetUrl(request.url),
  };
}

function isSameOrigin(left, right) {
  return left.protocol === right.protocol && left.host === right.host;
}

function applyRedirect(state, status, nextTarget) {
  const headers = new Headers(state.headers);
  let method = state.method;
  let body = state.body;
  if (status === 303 && method !== 'HEAD'
    || ((status === 301 || status === 302) && method === 'POST')) {
    method = 'GET';
    body = null;
    headers.delete('content-length');
    headers.delete('content-type');
  }
  if (!isSameOrigin(state.target, nextTarget)) {
    for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name);
  }
  headers.delete('host');
  return { ...state, body, headers, method, target: nextTarget };
}

function toFetchResponse(message, target, redirected, method) {
  const status = message.statusCode || 500;
  const body = method === 'HEAD' || NULL_BODY_STATUS.has(status) ? null : message;
  const response = new Response(body, {
    headers: responseHeaders(message),
    status,
    statusText: message.statusMessage || '',
  });
  Object.defineProperties(response, {
    redirected: { configurable: true, value: redirected },
    url: { configurable: true, value: target.href },
  });
  return response;
}

async function nodeFetchWithProviderProxy(input, init, proxySettings, overrides = {}) {
  const nodeVersion = nodeVersionParts(overrides);
  if (nodeVersion.major < 22) {
    throw new Error('Provider proxy discovery requires Node.js 22 or newer');
  }
  let state = await requestState(input, init);
  let redirects = 0;
  while (true) {
    state.signal.throwIfAborted();
    const proxyEnvironment = await resolveProxyEnvironment(state.target, proxySettings, {
      ...overrides,
      signal: state.signal,
    });
    const message = supportsProxyEnvironmentAgents(overrides)
      ? await requestOnceWithProxyEnvironment(state.target, state, proxyEnvironment)
      : await requestOnceWithoutProxyEnvironment(
        state.target,
        state,
        proxyEnvironment,
        overrides,
      );
    const status = message.statusCode || 0;
    const location = message.headers.location;
    if (!REDIRECT_STATUS.has(status) || !location || state.redirect === 'manual') {
      return toFetchResponse(message, state.target, redirects > 0, state.method);
    }
    if (state.redirect === 'error') {
      message.resume();
      throw new TypeError('Redirect encountered while redirect mode is error');
    }
    redirects += 1;
    if (redirects > 20) {
      message.resume();
      throw new TypeError('Too many redirects');
    }
    let nextTarget;
    try {
      nextTarget = validateTargetUrl(new URL(location, state.target));
    } catch {
      message.resume();
      throw new TypeError('Invalid redirect URL');
    }
    message.resume();
    state = applyRedirect(state, status, nextTarget);
  }
}

async function fetchWithProviderProxy(input, init = {}, value = { mode: 'direct' }, overrides = {}) {
  const proxySettings = normalizeProxySettings(value);
  const fetchImpl = overrides.fetchImpl || globalThis.fetch;
  if (proxySettings.mode === 'direct') {
    if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable');
    return fetchImpl(input, init);
  }

  validateTargetUrl(input);
  const bunFetch = Object.prototype.hasOwnProperty.call(overrides, 'bunFetch')
    ? overrides.bunFetch
    : globalThis.Bun?.fetch;
  if (typeof bunFetch === 'function') {
    if (proxySettings.mode === 'manual') {
      return bunFetch(input, { ...init, proxy: proxySettings.url });
    }
    const target = validateTargetUrl(input);
    const platform = overrides.platform || process.platform;
    if (platform !== 'win32') {
      getEnvironmentProxy(target, overrides);
      return bunFetch(input, init);
    }
    const resolved = await resolveWindowsSystemProxy(target, {
      ...overrides,
      signal: init?.signal,
    });
    if (resolved === 'DIRECT') return bunFetch(input, init);
    return bunFetch(input, { ...init, proxy: resolved });
  }

  return nodeFetchWithProviderProxy(input, init, proxySettings, overrides);
}

export {
  ensureConfiguredProviderProxyPlugin,
  ensureProviderProxyPlugin,
  fetchWithProviderProxy,
  readProviderProxies,
  readProviderProxy,
  removeProviderProxy,
  writeProviderProxy,
};
