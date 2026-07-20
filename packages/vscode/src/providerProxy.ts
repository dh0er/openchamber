import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProviderProxySetting =
  | { mode: 'direct' }
  | { mode: 'system' }
  | { mode: 'manual'; url: string };

type StoredProviderProxySetting = Exclude<ProviderProxySetting, { mode: 'direct' }>;
type ProviderProxyFile = {
  version: 1;
  providers: Record<string, StoredProviderProxySetting>;
};

export type ProviderProxyStorageOverrides = {
  sidecarPath?: string;
  pluginPath?: string;
  fs?: typeof fs;
  randomUUID?: () => string;
  platform?: NodeJS.Platform;
};

const PROVIDER_PROXY_FILE = path.join(os.homedir(), '.config', 'openchamber', 'provider-proxies.json');
const PROVIDER_PROXY_PLUGIN_FILE = path.join(
  os.homedir(),
  '.config',
  'opencode',
  'plugins',
  'openchamber-provider-proxy.js',
);
const MAX_PROVIDER_PROXY_FILE_BYTES = 256 * 1024;
const MAX_PROVIDER_PROXY_PROCESS_BYTES = 2 * 1024 * 1024;
const PROVIDER_PROXY_PROCESS_TIMEOUT_MS = 20_000;
const UNSAFE_PROVIDER_PROXY_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
};

const assertSafeProviderId = (providerId: string): void => {
  if (
    typeof providerId !== 'string'
    || !providerId.trim()
    || providerId.length > 512
    || hasControlCharacters(providerId)
    || UNSAFE_PROVIDER_PROXY_KEYS.has(providerId.toLowerCase())
  ) {
    throw new Error('Provider ID is invalid');
  }
};

export const normalizeManualProviderProxyUrl = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Manual proxy requires a proxy URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Proxy URL must be an HTTP(S) origin');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('Proxy URL must be an HTTP(S) origin without credentials');
  }
  return parsed.origin;
};

const normalizeStoredProviderProxy = (value: unknown): StoredProviderProxySetting => {
  if (!isPlainObject(value)) throw new Error('Invalid provider proxy configuration');
  if (value.mode === 'system') return { mode: 'system' };
  if (value.mode === 'manual') {
    return { mode: 'manual', url: normalizeManualProviderProxyUrl(value.url) };
  }
  throw new Error('Invalid provider proxy configuration');
};

const emptyProviderProxyFile = (): ProviderProxyFile => ({
  version: 1,
  providers: Object.create(null) as Record<string, StoredProviderProxySetting>,
});

const resolveStorage = (overrides: ProviderProxyStorageOverrides = {}) => ({
  sidecarPath: overrides.sidecarPath || PROVIDER_PROXY_FILE,
  pluginPath: overrides.pluginPath || PROVIDER_PROXY_PLUGIN_FILE,
  fileSystem: overrides.fs || fs,
  randomUUID: overrides.randomUUID || randomUUID,
  platform: overrides.platform || process.platform,
});

const chmodPrivate = (
  storage: ReturnType<typeof resolveStorage>,
  filePath: string,
  mode: number,
): void => {
  try {
    storage.fileSystem.chmodSync(filePath, mode);
  } catch (error) {
    if (storage.platform !== 'win32') throw error;
  }
};

const assertRegularTarget = (
  storage: ReturnType<typeof resolveStorage>,
  targetPath: string,
): void => {
  if (!storage.fileSystem.existsSync(targetPath)) return;
  const stat = storage.fileSystem.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Unsafe provider proxy storage target');
  }
};

const readFileBounded = (
  storage: ReturnType<typeof resolveStorage>,
  filePath: string,
): string => {
  const stat = storage.fileSystem.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_PROVIDER_PROXY_FILE_BYTES) {
    throw new Error('Provider proxy configuration is invalid');
  }
  return storage.fileSystem.readFileSync(filePath, 'utf8');
};

export const readProviderProxyFile = (
  storageOverrides: ProviderProxyStorageOverrides = {},
): ProviderProxyFile => {
  const storage = resolveStorage(storageOverrides);
  if (!storage.fileSystem.existsSync(storage.sidecarPath)) return emptyProviderProxyFile();

  try {
    assertRegularTarget(storage, storage.sidecarPath);
    const parsed = JSON.parse(readFileBounded(storage, storage.sidecarPath)) as unknown;
    if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.providers)) {
      throw new Error('invalid shape');
    }
    const providers = Object.create(null) as Record<string, StoredProviderProxySetting>;
    for (const [providerId, value] of Object.entries(parsed.providers)) {
      assertSafeProviderId(providerId);
      providers[providerId] = normalizeStoredProviderProxy(value);
    }
    return { version: 1, providers };
  } catch {
    throw new Error('Failed to read provider proxy configuration');
  }
};

const writeFileAtomic = (
  storage: ReturnType<typeof resolveStorage>,
  targetPath: string,
  content: string,
): void => {
  const directory = path.dirname(targetPath);
  const temporaryFile = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${storage.randomUUID()}.tmp`,
  );
  try {
    storage.fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodPrivate(storage, directory, 0o700);
    assertRegularTarget(storage, targetPath);
    if (storage.fileSystem.existsSync(targetPath)) chmodPrivate(storage, targetPath, 0o600);
    storage.fileSystem.writeFileSync(temporaryFile, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    chmodPrivate(storage, temporaryFile, 0o600);
    storage.fileSystem.renameSync(temporaryFile, targetPath);
    chmodPrivate(storage, targetPath, 0o600);
  } catch {
    try {
      if (storage.fileSystem.existsSync(temporaryFile)) storage.fileSystem.unlinkSync(temporaryFile);
    } catch {
      // Preserve the original write failure.
    }
    throw new Error('Failed to write provider proxy configuration');
  }
};

const writeProviderProxyFile = (
  value: ProviderProxyFile,
  storageOverrides: ProviderProxyStorageOverrides = {},
): void => {
  const storage = resolveStorage(storageOverrides);
  writeFileAtomic(storage, storage.sidecarPath, `${JSON.stringify(value, null, 2)}\n`);
};

const removeProviderProxyFile = (
  storageOverrides: ProviderProxyStorageOverrides = {},
): void => {
  const storage = resolveStorage(storageOverrides);
  if (!storage.fileSystem.existsSync(storage.sidecarPath)) return;
  try {
    assertRegularTarget(storage, storage.sidecarPath);
    storage.fileSystem.unlinkSync(storage.sidecarPath);
  } catch {
    throw new Error('Failed to write provider proxy configuration');
  }
};

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

const buildProviderProxyPluginSource = (sidecarPath: string): string => (
  PROVIDER_PROXY_PLUGIN_SOURCE_TEMPLATE.replace('__SIDECAR_FILE__', JSON.stringify(sidecarPath))
);

export const ensureProviderProxyPluginInstalled = (
  storageOverrides: ProviderProxyStorageOverrides = {},
): boolean => {
  const sidecar = readProviderProxyFile(storageOverrides);
  if (Object.keys(sidecar.providers).length === 0) return false;
  const storage = resolveStorage(storageOverrides);
  const pluginSource = buildProviderProxyPluginSource(storage.sidecarPath);
  let existing = '';
  try {
    assertRegularTarget(storage, storage.pluginPath);
    existing = storage.fileSystem.readFileSync(storage.pluginPath, 'utf8');
  } catch {
    existing = '';
  }
  if (existing === pluginSource) return true;
  try {
    writeFileAtomic(storage, storage.pluginPath, pluginSource);
  } catch {
    throw new Error('Failed to install the OpenCode provider proxy plugin');
  }
  return true;
};

export const getProviderProxy = (
  providerId: string,
  storageOverrides: ProviderProxyStorageOverrides = {},
): ProviderProxySetting => {
  assertSafeProviderId(providerId);
  return readProviderProxyFile(storageOverrides).providers[providerId] || { mode: 'direct' };
};

export const writeProviderProxy = (
  providerId: string,
  proxy: ProviderProxySetting,
  storageOverrides: ProviderProxyStorageOverrides = {},
): void => {
  assertSafeProviderId(providerId);
  const original = readProviderProxyFile(storageOverrides);
  const next: ProviderProxyFile = {
    version: 1,
    providers: Object.assign(Object.create(null), original.providers),
  };
  if (proxy.mode === 'direct') {
    delete next.providers[providerId];
  } else if (proxy.mode === 'system') {
    next.providers[providerId] = { mode: 'system' };
  } else {
    next.providers[providerId] = { mode: 'manual', url: normalizeManualProviderProxyUrl(proxy.url) };
  }

  if (Object.keys(next.providers).length === 0) removeProviderProxyFile(storageOverrides);
  else writeProviderProxyFile(next, storageOverrides);
  if (proxy.mode === 'direct') return;
  try {
    ensureProviderProxyPluginInstalled(storageOverrides);
  } catch (error) {
    try {
      if (Object.keys(original.providers).length === 0) removeProviderProxyFile(storageOverrides);
      else writeProviderProxyFile(original, storageOverrides);
    } catch {
      throw new Error('Failed to install the provider proxy plugin and roll back proxy configuration');
    }
    throw error;
  }
};

type SpawnResult = { exitCode: number; stdout: Buffer };

const spawnWithStdin = async (
  command: string,
  args: string[],
  stdin: string,
  options: {
    maxStdoutBytes?: number;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<SpawnResult> => new Promise((resolve, reject) => {
  const maxStdoutBytes = options.maxStdoutBytes || MAX_PROVIDER_PROXY_PROCESS_BYTES;
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: options.environment || process.env,
  });
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let settled = false;
  const finish = (error?: Error, result?: SpawnResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(result!);
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(new Error('Provider proxy request timed out'));
  }, PROVIDER_PROXY_PROCESS_TIMEOUT_MS);

  child.once('error', () => finish(new Error('Provider proxy helper is unavailable')));
  child.stdin?.on('error', () => {
    // A helper can exit before consuming stdin; its exit status remains authoritative.
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) {
      child.kill();
      finish(new Error('Provider proxy response exceeded the size limit'));
      return;
    }
    stdoutChunks.push(chunk);
  });
  child.stderr?.on('data', () => {
    // Drain without exposing helper output, request URLs, or credentials.
  });
  child.once('close', (exitCode) => finish(undefined, {
    exitCode: typeof exitCode === 'number' ? exitCode : -1,
    stdout: Buffer.concat(stdoutChunks),
  }));
  child.stdin?.end(stdin);
});

const POWERSHELL_DISCOVERY_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Net.Http
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
if ($payload.mode -eq 'manual') {
  $handler.UseProxy = $true
  $handler.Proxy = [System.Net.WebProxy]::new([Uri]$payload.proxyUrl)
} elseif ($payload.mode -eq 'system') {
  $handler.UseProxy = $true
  $handler.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
  $handler.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
} else {
  $handler.UseProxy = $false
}
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(15)
$request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, [Uri]$payload.url)
$null = $request.Headers.TryAddWithoutValidation('Accept', 'application/json')
$null = $request.Headers.TryAddWithoutValidation('Authorization', ('Bearer ' + [string]$payload.apiKey))
$response = $client.SendAsync($request).GetAwaiter().GetResult()
$bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
if ($bytes.Length -gt 1048576) { throw 'response too large' }
@{ status = [int]$response.StatusCode; body = [Convert]::ToBase64String($bytes) } | ConvertTo-Json -Compress
`;

const fetchViaWindowsProxy = async (
  requestUrl: string,
  apiKey: string,
  proxy: StoredProviderProxySetting,
): Promise<Response> => {
  const encodedScript = Buffer.from(POWERSHELL_DISCOVERY_SCRIPT, 'utf16le').toString('base64');
  const payload = JSON.stringify({
    url: requestUrl,
    apiKey,
    mode: proxy.mode,
    ...(proxy.mode === 'manual' ? { proxyUrl: proxy.url } : {}),
  });
  const result = await spawnWithStdin('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    encodedScript,
  ], payload);
  if (result.exitCode !== 0) throw new Error('Provider proxy request failed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString('utf8')) as unknown;
  } catch {
    throw new Error('Provider proxy returned an invalid response');
  }
  if (
    !isPlainObject(parsed)
    || typeof parsed.status !== 'number'
    || !Number.isInteger(parsed.status)
    || parsed.status < 100
    || parsed.status > 599
    || typeof parsed.body !== 'string'
  ) {
    throw new Error('Provider proxy returned an invalid response');
  }
  const body = Buffer.from(parsed.body, 'base64');
  if (body.length > 1024 * 1024) throw new Error('Provider proxy response exceeded the size limit');
  return new Response(body, { status: parsed.status });
};

const quoteCurlConfig = (value: string): string => (
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
);

const fetchViaCurlProxy = async (
  requestUrl: string,
  apiKey: string,
  proxyUrl?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Response> => {
  const marker = 'OPENCHAMBER_HTTP_STATUS:';
  const config = [
    `url = ${quoteCurlConfig(requestUrl)}`,
    ...(proxyUrl ? [`proxy = ${quoteCurlConfig(proxyUrl)}`] : []),
    'request = "GET"',
    'silent',
    'show-error',
    'max-time = 15',
    'max-filesize = 1048576',
    `header = ${quoteCurlConfig('Accept: application/json')}`,
    `header = ${quoteCurlConfig(`Authorization: Bearer ${apiKey}`)}`,
    `write-out = ${quoteCurlConfig(`${marker}%{http_code}`)}`,
  ].join('\n');
  const result = await spawnWithStdin('curl', ['--config', '-'], config, { environment });
  if (result.exitCode !== 0) throw new Error('Provider proxy request failed');
  const markerBytes = Buffer.from(marker, 'utf8');
  const markerIndex = result.stdout.lastIndexOf(markerBytes);
  if (markerIndex < 0) throw new Error('Provider proxy returned an invalid response');
  const status = Number(result.stdout.subarray(markerIndex + markerBytes.length).toString('ascii'));
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('Provider proxy returned an invalid response');
  }
  const body = result.stdout.subarray(0, markerIndex);
  if (body.length > 1024 * 1024) throw new Error('Provider proxy response exceeded the size limit');
  return new Response(body, { status });
};

export const fetchWithProviderProxy = async (
  requestUrl: string,
  apiKey: string,
  proxy: ProviderProxySetting,
  runtimeOverrides: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<Response> => {
  if (proxy.mode === 'direct') {
    return fetch(requestUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  }
  const platform = runtimeOverrides.platform || process.platform;
  const environment = runtimeOverrides.environment || process.env;
  if (platform === 'win32') {
    return fetchViaWindowsProxy(requestUrl, apiKey, proxy);
  }
  if (proxy.mode === 'system') {
    const protocol = new URL(requestUrl).protocol;
    const environmentProxy = protocol === 'https:'
      ? (environment.https_proxy || environment.HTTPS_PROXY)
      : (environment.http_proxy || environment.HTTP_PROXY);
    if (!environmentProxy) {
      throw new Error('No system proxy is configured for this provider URL');
    }
    const normalizedProxy = normalizeManualProviderProxyUrl(environmentProxy);
    const noProxy = environment.no_proxy || environment.NO_PROXY || '';
    const curlEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      no_proxy: noProxy,
      NO_PROXY: noProxy,
      ...(protocol === 'https:'
        ? { https_proxy: normalizedProxy, HTTPS_PROXY: normalizedProxy }
        : { http_proxy: normalizedProxy, HTTP_PROXY: normalizedProxy }),
    };
    return fetchViaCurlProxy(requestUrl, apiKey, undefined, curlEnvironment);
  }
  return fetchViaCurlProxy(requestUrl, apiKey, proxy.url, environment);
};
