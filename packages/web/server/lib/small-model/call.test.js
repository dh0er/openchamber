import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// readConfig reads merged opencode config layers from disk; mock it so each
// test controls the provider config without touching the filesystem. call.js
// imports only readConfig from shared.js, so the rest of that module is left
// untouched for this file.
vi.mock('../opencode/shared.js', () => ({
  readConfig: vi.fn(),
  readConfigLayers: vi.fn(),
}));

const { callSmallModel } = await import('./call.js');
const { readConfig, readConfigLayers } = await import('../opencode/shared.js');

// Minimal catalog fragment used by the catalog-based base URL resolution case.
const CATALOG = {
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    api: 'https://api.mistral.ai/v1',
    models: {
      'mistral-small-latest': { id: 'mistral-small-latest' },
    },
  },
};

const ANTHROPIC_INSTANCE_ID = 'anthropic:openchamber:4a132b87-d17b-47a7-a68d-65ba68f2510b';
const GOOGLE_INSTANCE_ID = 'google:openchamber:5b243c98-e28c-48b8-b79e-76cb79e3621c';
const OPENAI_INSTANCE_ID = 'openai:openchamber:6c354da9-f39d-49c9-8a0f-87dc8af4732d';

const ok = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content }, finish_reason: 'stop' }],
  }),
  text: async () => JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
  }),
});

const lastCall = (mock) => {
  const [url, init] = mock.mock.calls.at(-1);
  return { url: String(url), init };
};

// Regression coverage for the small-model dispatch to custom OpenAI-compatible
// providers — credential and endpoint resolution, precedence, and non-leakage.
describe('callSmallModel — custom provider config', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    readConfig.mockReset();
    readConfigLayers.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.OPENCHAMBER_TEST_PROVIDER_KEY;
  });

  describe('config-supplied credentials (no auth.json entry)', () => {
    it('resolves an OpenCode file variable before sending the API key', async () => {
      const secretPath = path.join(os.homedir(), '.secret');
      const originalReadFileSync = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
        if (filePath === secretPath) return 'sk-file-key\n';
        return originalReadFileSync(filePath, ...args);
      });
      readConfig.mockReturnValue({
        provider: {
          custom: {
            options: { apiKey: '{file:~/.secret}', baseURL: 'https://proxy.example.test/v1' },
          },
        },
      });
      fetchMock.mockResolvedValue(ok('hello'));

      await callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'model',
        prompt: 'hi',
      });

      expect(lastCall(fetchMock).init.headers.Authorization).toBe('Bearer sk-file-key');
      expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain('{file:');
    });

    it('resolves an OpenCode environment variable before sending the API key', async () => {
      process.env.OPENCHAMBER_TEST_PROVIDER_KEY = 'sk-env-key';
      readConfig.mockReturnValue({
        provider: {
          custom: {
            options: { apiKey: '{env:OPENCHAMBER_TEST_PROVIDER_KEY}', baseURL: 'https://proxy.example.test/v1' },
          },
        },
      });
      fetchMock.mockResolvedValue(ok('hello'));

      await callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'model',
        prompt: 'hi',
      });

      expect(lastCall(fetchMock).init.headers.Authorization).toBe('Bearer sk-env-key');
    });

    it('uses apiKey and baseURL from provider config when no auth.json entry exists', async () => {
      readConfig.mockReturnValue({
        provider: {
          custom: {
            options: { apiKey: 'test-key', baseURL: 'https://proxy.example.test/v1' },
          },
        },
      });
      fetchMock.mockResolvedValue(ok('hello'));

      const text = await callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      });

      expect(text).toBe('hello');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const { url, init } = lastCall(fetchMock);
      // Config baseURL is used, never the hardcoded OpenAI endpoint.
      expect(url).toBe('https://proxy.example.test/v1/chat/completions');
      expect(url).not.toContain('api.openai.com');
      // Config apiKey becomes the bearer credential.
      expect(init.headers.Authorization).toBe('Bearer test-key');
    });

    it('trims a trailing slash from the configured baseURL', async () => {
      readConfig.mockReturnValue({
        provider: {
          custom: { options: { apiKey: 'k', baseURL: 'https://proxy.example.test/v1/' } },
        },
      });
      fetchMock.mockResolvedValue(ok('ok'));

      await callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      });

      expect(lastCall(fetchMock).url).toBe('https://proxy.example.test/v1/chat/completions');
    });

    it('throws "No OpenCode login found for provider" when neither auth.json nor config apiKey exists', async () => {
      readConfig.mockReturnValue({
        provider: { custom: { options: { baseURL: 'https://proxy.example.test/v1' } } },
      });

      await expect(callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      })).rejects.toThrow('No OpenCode login found for provider "custom"');

      // The credential gate fires before any network call.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats a blank/whitespace apiKey in config as absent', async () => {
      readConfig.mockReturnValue({
        provider: {
          custom: { options: { apiKey: '   ', baseURL: 'https://proxy.example.test/v1' } },
        },
      });

      await expect(callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      })).rejects.toThrow('No OpenCode login found for provider "custom"');
    });
  });

  describe('resolution order when auth.json is also present', () => {
    it('uses the auth.json credential with the config baseURL', async () => {
      readConfig.mockReturnValue({
        provider: { custom: { options: { baseURL: 'https://proxy.example.test/v1' } } },
      });
      fetchMock.mockResolvedValue(ok('done'));

      const text = await callSmallModel({
        auth: { custom: { type: 'api', key: 'authjson-key' } },
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      });

      expect(text).toBe('done');
      const { url, init } = lastCall(fetchMock);
      expect(url).toBe('https://proxy.example.test/v1/chat/completions');
      expect(init.headers.Authorization).toBe('Bearer authjson-key');
    });

    it('prefers the config apiKey over an auth.json credential when both are present (matches OpenCode)', async () => {
      readConfig.mockReturnValue({
        provider: {
          custom: { options: { apiKey: 'config-key', baseURL: 'https://proxy.example.test/v1' } },
        },
      });
      fetchMock.mockResolvedValue(ok('done'));

      await callSmallModel({
        auth: { custom: { type: 'api', key: 'authjson-key' } },
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      });

      // OpenCode's resolveSDK reads options.apiKey first and only falls back to
      // auth.json's key when config has none — so the config key wins and the
      // auth.json credential must never be sent.
      expect(lastCall(fetchMock).init.headers.Authorization).toBe('Bearer config-key');
      expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain('authjson-key');
    });
  });

  describe('openai provider custom baseURL override', () => {
    it('respects provider.openai.options.baseURL over the hardcoded OpenAI endpoint', async () => {
      readConfig.mockReturnValue({
        provider: { openai: { options: { baseURL: 'https://gateway.example.test/v1' } } },
      });
      fetchMock.mockResolvedValue(ok('ok'));

      await callSmallModel({
        auth: { openai: { type: 'api', key: 'sk-openai' } },
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'openai',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      });

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe('https://gateway.example.test/v1/chat/completions');
      expect(url).not.toContain('api.openai.com');
      expect(init.headers.Authorization).toBe('Bearer sk-openai');
    });

    it('falls back to https://api.openai.com/v1 when no openai baseURL override is configured', async () => {
      readConfig.mockReturnValue({});
      fetchMock.mockResolvedValue(ok('ok'));

      await callSmallModel({
        auth: { openai: { type: 'api', key: 'sk-openai' } },
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'openai',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      });

      expect(lastCall(fetchMock).url).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('still requires a credential: a baseURL alone does not authenticate openai', async () => {
      readConfig.mockReturnValue({
        provider: { openai: { options: { baseURL: 'https://gateway.example.test/v1' } } },
      });

      await expect(callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'openai',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      })).rejects.toThrow('No OpenCode login found for provider "openai"');
    });
  });

  describe('catalog-based base URL (no config override)', () => {
    it('uses the catalog api field when no config baseURL is set', async () => {
      readConfig.mockReturnValue({});
      fetchMock.mockResolvedValue(ok('ok'));

      await callSmallModel({
        auth: { mistral: { type: 'api', key: 'mistral-key' } },
        catalog: CATALOG,
        workingDirectory: '/proj',
        providerID: 'mistral',
        modelID: 'mistral-small-latest',
        prompt: 'hi',
      });

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe('https://api.mistral.ai/v1/chat/completions');
      expect(init.headers.Authorization).toBe('Bearer mistral-key');
    });

    it('throws when a non-openai provider has no catalog api and no config baseURL', async () => {
      readConfig.mockReturnValue({});

      await expect(callSmallModel({
        auth: { custom: { type: 'api', key: 'k' } },
        catalog: {},
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      })).rejects.toThrow('Provider "custom" has no known API base URL');
    });
  });

  describe('config-supplied key does not leak', () => {
    // The config-supplied key must stay in-memory: never copied into catalog
    // metadata, the response, or the request body.
    it('does not mutate the catalog or echo the key in the request/response', async () => {
      const catalog = { custom: { id: 'custom', models: {} } };
      const catalogBefore = JSON.parse(JSON.stringify(catalog));
      readConfig.mockReturnValue({
        provider: {
          custom: { options: { apiKey: 'test-key', baseURL: 'https://proxy.example.test/v1' } },
        },
      });
      fetchMock.mockResolvedValue(ok('the answer'));

      const text = await callSmallModel({
        auth: {},
        catalog,
        workingDirectory: '/proj',
        providerID: 'custom',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      });

      // Response text is exactly the model output — no credential echoed back.
      expect(text).toBe('the answer');
      // Catalog object left untouched (key stays in-memory only).
      expect(catalog).toEqual(catalogBefore);

      const { url, init } = lastCall(fetchMock);
      // The key rides only in the Authorization header.
      expect(url).not.toContain('test-key');
      const body = JSON.parse(init.body);
      expect(JSON.stringify(body)).not.toContain('test-key');
    });
  });

  describe('merged config layers', () => {
    it('reads the provider config for the supplied working directory', async () => {
      readConfig.mockReturnValue({
        provider: {
          custom: { options: { apiKey: 'test-key', baseURL: 'https://proxy.example.test/v1' } },
        },
      });
      fetchMock.mockResolvedValue(ok('ok'));

      await callSmallModel({
        auth: {},
        catalog: {},
        workingDirectory: '/path/to/project',
        providerID: 'custom',
        modelID: 'gpt-4o-mini',
        prompt: 'hi',
      });

      // readConfig merges global + project-scoped layers for this directory;
      // confirm callSmallModel passes the working directory straight through.
      expect(readConfig).toHaveBeenCalledWith('/path/to/project');
    });
  });
});

describe('callSmallModel — Google thinking configuration', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    readConfig.mockReset();
    readConfig.mockReturnValue({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const googleResponse = (text) => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  });

  it('uses thinkingLevel for Gemini 3 Flash models', async () => {
    fetchMock.mockResolvedValue(googleResponse('generated commit'));

    const text = await callSmallModel({
      auth: { google: { type: 'api', key: 'google-key' } },
      catalog: {},
      workingDirectory: '/proj',
      providerID: 'google',
      modelID: 'gemini-3.1-flash-lite-preview',
      prompt: 'generate',
    });

    expect(text).toBe('generated commit');
    const body = JSON.parse(lastCall(fetchMock).init.body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('keeps thinkingBudget disabled for Gemini 2.5 Flash models', async () => {
    fetchMock.mockResolvedValue(googleResponse('generated commit'));

    await callSmallModel({
      auth: { google: { type: 'api', key: 'google-key' } },
      catalog: {},
      workingDirectory: '/proj',
      providerID: 'google',
      modelID: 'gemini-2.5-flash-lite',
      prompt: 'generate',
    });

    const body = JSON.parse(lastCall(fetchMock).init.body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});

describe('callSmallModel - managed provider instances', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    readConfig.mockReset();
    readConfigLayers.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses Anthropic wire format, the alias key, and the alias baseURL', async () => {
    readConfig.mockReturnValue({
      provider: {
        [ANTHROPIC_INSTANCE_ID]: {
          id: 'anthropic',
          name: 'Anthropic Work',
          models: { 'claude-haiku-4-5': { id: 'claude-haiku-upstream' } },
          options: { baseURL: 'https://anthropic-gateway.example.test/v1/' },
        },
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'anthropic answer' }] }),
    });

    const text = await callSmallModel({
      auth: {
        anthropic: { type: 'api', key: 'canonical-key' },
        [ANTHROPIC_INSTANCE_ID]: { type: 'api', key: 'alias-key' },
      },
      catalog: CATALOG,
      workingDirectory: '/proj',
      providerID: ANTHROPIC_INSTANCE_ID,
      modelID: 'claude-haiku-4-5',
      prompt: 'hi',
    });

    expect(text).toBe('anthropic answer');
    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('https://anthropic-gateway.example.test/v1/messages');
    expect(init.headers['x-api-key']).toBe('alias-key');
    expect(JSON.stringify(init)).not.toContain('canonical-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-haiku-upstream');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('routes managed instance requests through the stored provider proxy', async () => {
    readConfig.mockReturnValue({
      provider: {
        [ANTHROPIC_INSTANCE_ID]: {
          id: 'anthropic',
          models: { 'claude-haiku-4-5': { id: 'claude-haiku-upstream' } },
          options: { baseURL: 'https://anthropic-gateway.example.test/v1' },
        },
      },
    });
    const proxy = { mode: 'manual', url: 'http://127.0.0.1:9000' };
    const readProviderProxy = vi.fn(() => proxy);
    const fetchWithProviderProxy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'proxied answer' }] }),
    }));

    const text = await callSmallModel({
      auth: { [ANTHROPIC_INSTANCE_ID]: { type: 'api', key: 'alias-key' } },
      catalog: {},
      workingDirectory: '/proj',
      providerID: ANTHROPIC_INSTANCE_ID,
      modelID: 'claude-haiku-4-5',
      prompt: 'hi',
      providerProxyRuntime: { readProviderProxy, fetchWithProviderProxy },
    });

    expect(text).toBe('proxied answer');
    expect(readProviderProxy).toHaveBeenCalledWith(ANTHROPIC_INSTANCE_ID);
    expect(fetchWithProviderProxy).toHaveBeenCalledWith(
      'https://anthropic-gateway.example.test/v1/messages',
      expect.objectContaining({ method: 'POST' }),
      proxy,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses Google wire format and appends the model path to the alias baseURL', async () => {
    readConfig.mockReturnValue({
      provider: {
        [GOOGLE_INSTANCE_ID]: {
          id: 'google',
          models: { 'gemini-2.5-flash': { id: 'gemini-2.5-flash-upstream' } },
          options: { baseURL: 'https://google-gateway.example.test/gemini/v1beta/' },
        },
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'google answer' }] } }] }),
    });

    await callSmallModel({
      auth: { [GOOGLE_INSTANCE_ID]: { type: 'api', key: 'google-alias-key' } },
      catalog: {},
      workingDirectory: '/proj',
      providerID: GOOGLE_INSTANCE_ID,
      modelID: 'gemini-2.5-flash',
      prompt: 'hi',
    });

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('https://google-gateway.example.test/gemini/v1beta/models/gemini-2.5-flash-upstream:generateContent');
    expect(init.headers['x-goog-api-key']).toBe('google-alias-key');
    expect(JSON.parse(init.body).contents).toBeDefined();
  });

  it('keeps an OpenAI API-key alias off the canonical ChatGPT OAuth endpoint', async () => {
    readConfig.mockReturnValue({
      provider: {
        [OPENAI_INSTANCE_ID]: {
          id: 'openai',
          name: 'OpenAI Gateway',
          models: { 'gpt-4o-mini': { id: 'gpt-4o-mini-upstream' } },
          options: { baseURL: 'https://openai-gateway.example.test/v1' },
        },
      },
    });
    fetchMock.mockResolvedValue(ok('openai alias answer'));

    await callSmallModel({
      auth: {
        openai: { type: 'oauth', access: 'canonical-oauth', expires: Date.now() + 60_000 },
        [OPENAI_INSTANCE_ID]: { type: 'api', key: 'openai-alias-key' },
      },
      catalog: {},
      workingDirectory: '/proj',
      providerID: OPENAI_INSTANCE_ID,
      modelID: 'gpt-4o-mini',
      prompt: 'hi',
    });

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('https://openai-gateway.example.test/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer openai-alias-key');
    expect(url).not.toContain('chatgpt.com');
    expect(JSON.stringify(init)).not.toContain('canonical-oauth');
    expect(JSON.parse(init.body).model).toBe('gpt-4o-mini-upstream');
  });

  it('rejects OAuth credentials stored under an alias id before any request', async () => {
    readConfig.mockReturnValue({
      provider: {
        [OPENAI_INSTANCE_ID]: {
          id: 'openai',
          models: { 'gpt-4o-mini': { id: 'gpt-4o-mini' } },
        },
      },
    });

    await expect(callSmallModel({
      auth: { [OPENAI_INSTANCE_ID]: { type: 'oauth', access: 'alias-oauth' } },
      catalog: {},
      workingDirectory: '/proj',
      providerID: OPENAI_INSTANCE_ID,
      modelID: 'gpt-4o-mini',
      prompt: 'hi',
    })).rejects.toThrow(`Managed provider instance "${OPENAI_INSTANCE_ID}" requires an API key`);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
