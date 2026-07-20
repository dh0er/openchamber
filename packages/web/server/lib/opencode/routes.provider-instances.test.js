import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerOpenCodeRoutes } from './routes.js';
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ProviderInstanceError,
  findSourceProvider,
  parseOpenAICompatibleModelCatalog,
  validateProviderInstanceCreateInput,
  validateProviderInstanceUpdateInput,
} from './providers.js';

const SOURCE_PROVIDER = {
  id: 'anthropic',
  name: 'Anthropic',
  models: {
    claude: {
      id: 'claude',
      api: { id: 'claude', url: 'https://api.anthropic.com', npm: '@ai-sdk/anthropic' },
      name: 'Claude',
      capabilities: {
        attachment: true,
        reasoning: true,
        temperature: true,
        toolcall: true,
        input: { text: true },
        output: { text: true },
      },
      cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      limit: { context: 1000, output: 100 },
      status: 'active',
      options: {},
      headers: {},
      release_date: '',
      variants: {},
    },
  },
};

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  registerOpenCodeRoutes(app, {
    crypto,
    clientReloadDelayMs: 800,
    getOpenCodeResolutionSnapshot: vi.fn(),
    formatSettingsResponse: (value) => value,
    readSettingsFromDisk: vi.fn(async () => ({})),
    readSettingsFromDiskMigrated: vi.fn(async () => ({})),
    persistSettings: vi.fn(async () => ({})),
    sanitizeProjects: (value) => value,
    validateDirectoryPath: vi.fn(),
    resolveProjectDirectory: vi.fn(async () => ({ directory: null })),
    getProviderSources: vi.fn(() => ({
      sources: {
        auth: { exists: false },
        user: { exists: true, path: '/virtual/opencode.json' },
        project: { exists: false, path: null },
        custom: { exists: false, path: null },
      },
    })),
    getProviderConnectionMetadata: vi.fn(() => ({
      sourceProviderId: 'anthropic',
      name: 'Work Anthropic',
      baseURL: null,
      managed: true,
    })),
    removeProviderConfig: vi.fn(),
    OPENAI_COMPATIBLE_PROVIDER_ID,
    ProviderInstanceError,
    parseOpenAICompatibleModelCatalog,
    validateProviderInstanceCreateInput,
    validateProviderInstanceUpdateInput,
    findSourceProvider,
    createProviderInstance: vi.fn(),
    updateProviderInstance: vi.fn(),
    refreshOpenCodeAfterConfigChange: vi.fn(),
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer upstream-token' }),
    readProviderProxy: vi.fn(() => ({ mode: 'direct' })),
    writeProviderProxy: vi.fn(),
    removeProviderProxy: vi.fn(() => false),
    fetchWithProviderProxy: vi.fn((url, init) => fetch(url, init)),
    loadProviderAuthLibrary: vi.fn(async () => ({
      getProviderAuth: vi.fn(() => null),
      writeProviderApiKey: vi.fn(),
      removeProviderAuth: vi.fn(),
    })),
    ...overrides,
  });
  return app;
};

describe('provider instance routes', () => {
  it('creates an alias from the authenticated upstream catalog without echoing the API key', async () => {
    const originalFetch = globalThis.fetch;
    const writeProviderApiKey = vi.fn();
    const resolveProjectDirectory = vi.fn(async () => ({ directory: '/workspace/project' }));
    const createProviderInstance = vi.fn((input, dependencies) => {
      dependencies.writeProviderApiKey('anthropic:openchamber:11111111-1111-4111-8111-111111111111', input.apiKey);
      return {
        id: 'anthropic:openchamber:11111111-1111-4111-8111-111111111111',
        providerId: 'anthropic:openchamber:11111111-1111-4111-8111-111111111111',
        sourceProviderId: 'anthropic',
        name: input.name,
        baseURL: input.baseURL,
        managed: true,
      };
    });
    try {
      globalThis.fetch = vi.fn(async (url, init) => {
        expect(url).toBe('http://opencode.test/provider?directory=%2Fworkspace%2Fproject');
        expect(init.headers.Authorization).toBe('Bearer upstream-token');
        return new Response(JSON.stringify({ all: [SOURCE_PROVIDER] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const app = createApp({
        createProviderInstance,
        resolveProjectDirectory,
        loadProviderAuthLibrary: vi.fn(async () => ({ writeProviderApiKey })),
      });

      const response = await request(app)
        .post('/api/provider/instances')
        .set('x-opencode-directory', encodeURIComponent('/workspace/project'))
        .set('x-opencode-directory-encoding', 'uri')
        .send({
          sourceProviderId: 'anthropic',
          name: 'Work Anthropic',
          baseURL: 'https://gateway.example.test',
          apiKey: 'request-secret',
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        success: true,
        requiresReload: true,
        restarted: false,
        instance: {
          sourceProviderId: 'anthropic',
          name: 'Work Anthropic',
          baseURL: 'https://gateway.example.test',
          managed: true,
        },
      });
      expect(JSON.stringify(response.body)).not.toContain('request-secret');
      expect(writeProviderApiKey).toHaveBeenCalledWith(
        'anthropic:openchamber:11111111-1111-4111-8111-111111111111',
        'request-secret',
      );
      expect(resolveProjectDirectory).toHaveBeenCalledTimes(1);
      expect(createProviderInstance.mock.calls[0][0].sourceProvider).toEqual(SOURCE_PROVIDER);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('discovers OpenAI-compatible models with bearer auth and preserves the base path and safe query', async () => {
    const originalFetch = globalThis.fetch;
    const writeProviderApiKey = vi.fn();
    const createProviderInstance = vi.fn((input, dependencies) => {
      const providerId = `${OPENAI_COMPATIBLE_PROVIDER_ID}:openchamber:11111111-1111-4111-8111-111111111111`;
      dependencies.writeProviderApiKey(providerId, input.apiKey);
      return {
        id: providerId,
        providerId,
        sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
        name: input.name,
        baseURL: input.baseURL,
        managed: true,
      };
    });
    try {
      globalThis.fetch = vi.fn(async (url, init) => {
        expect(url).toBe('https://gateway.example.test/v1/models?api-version=2026-01-01');
        expect(init).toMatchObject({
          method: 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer request-secret',
          },
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return new Response(JSON.stringify({
          data: [
            { id: 'gpt-5.5' },
            { id: 'gpt-5.5' },
            { id: 'anthropic/claude-sonnet-4-6' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      const app = createApp({
        createProviderInstance,
        loadProviderAuthLibrary: vi.fn(async () => ({ writeProviderApiKey })),
      });

      const response = await request(app)
        .post('/api/provider/instances')
        .send({
          sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
          name: 'Frugal Relay',
          baseURL: 'https://gateway.example.test/v1?api-version=2026-01-01',
          apiKey: 'request-secret',
        });

      expect(response.status).toBe(201);
      expect(response.body.instance).toMatchObject({
        sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
        name: 'Frugal Relay',
      });
      expect(JSON.stringify(response.body)).not.toContain('request-secret');
      expect(createProviderInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
          openAICompatibleModelIds: ['gpt-5.5', 'anthropic/claude-sonnet-4-6'],
        }),
        expect.any(Object),
      );
      expect(createProviderInstance.mock.calls[0][0]).not.toHaveProperty('sourceProvider');
      expect(writeProviderApiKey).toHaveBeenCalledWith(
        `${OPENAI_COMPATIBLE_PROVIDER_ID}:openchamber:11111111-1111-4111-8111-111111111111`,
        'request-secret',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the selected per-instance proxy for discovery and persistence', async () => {
    const providerId = `${OPENAI_COMPATIBLE_PROVIDER_ID}:openchamber:11111111-1111-4111-8111-111111111111`;
    const fetchWithProviderProxy = vi.fn(async (_url, _init, proxy) => {
      expect(proxy).toEqual({ mode: 'system' });
      return new Response(JSON.stringify({ data: [{ id: 'proxied-model' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const writeProviderProxy = vi.fn();
    const removeProviderProxy = vi.fn();
    const createProviderInstance = vi.fn((input, dependencies) => {
      dependencies.writeProviderProxy(providerId, input.proxy);
      return {
        id: providerId,
        providerId,
        sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
        name: input.name,
        baseURL: input.baseURL,
        managed: true,
        proxy: input.proxy,
      };
    });
    const app = createApp({
      fetchWithProviderProxy,
      writeProviderProxy,
      removeProviderProxy,
      createProviderInstance,
    });

    const response = await request(app)
      .post('/api/provider/instances')
      .send({
        sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
        name: 'Synapse via system PAC',
        baseURL: 'https://llm.synapse.thalescloud.io/v1',
        apiKey: 'request-secret',
        proxy: { mode: 'system' },
      });

    expect(response.status).toBe(201);
    expect(response.body.instance.proxy).toEqual({ mode: 'system' });
    expect(JSON.stringify(response.body)).not.toContain('request-secret');
    expect(fetchWithProviderProxy).toHaveBeenCalledWith(
      'https://llm.synapse.thalescloud.io/v1/models',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
      { mode: 'system' },
    );
    expect(createProviderInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: { mode: 'system' },
        openAICompatibleModelIds: ['proxied-model'],
      }),
      expect.objectContaining({
        writeProviderProxy,
        removeProviderProxy,
      }),
    );
    expect(writeProviderProxy).toHaveBeenCalledWith(providerId, { mode: 'system' });
  });

  it('fails closed when proxy discovery runtime wiring is missing', async () => {
    const createProviderInstance = vi.fn();
    const app = createApp({
      createProviderInstance,
      fetchWithProviderProxy: undefined,
    });

    const response = await request(app)
      .post('/api/provider/instances')
      .send({
        sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
        name: 'Missing proxy runtime',
        baseURL: 'https://gateway.example.test/v1',
        apiKey: 'request-secret',
        proxy: { mode: 'system' },
      });

    expect(response.status).toBe(502);
    expect(createProviderInstance).not.toHaveBeenCalled();
  });

  it('does not write config or auth when OpenAI-compatible discovery fails or exceeds the response cap', async () => {
    const originalFetch = globalThis.fetch;
    const createProviderInstance = vi.fn();
    const writeProviderApiKey = vi.fn();
    try {
      globalThis.fetch = vi.fn(async () => new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String((1024 * 1024) + 1) },
      }));
      const app = createApp({
        createProviderInstance,
        loadProviderAuthLibrary: vi.fn(async () => ({ writeProviderApiKey })),
      });

      const response = await request(app)
        .post('/api/provider/instances')
        .send({
          sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
          name: 'Oversized Gateway',
          baseURL: 'https://gateway.example.test/v1',
          apiKey: 'request-secret',
        });

      expect(response.status).toBe(502);
      expect(response.body).toEqual({ error: 'Failed to load the OpenAI-compatible model catalog' });
      expect(JSON.stringify(response.body)).not.toContain('request-secret');
      expect(createProviderInstance).not.toHaveBeenCalled();
      expect(writeProviderApiKey).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns validation status without contacting upstream for an invalid URL', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    try {
      const response = await request(createApp())
        .post('/api/provider/instances')
        .send({
          sourceProviderId: 'anthropic',
          name: 'Invalid',
          baseURL: 'https://user:password@gateway.example.test',
          apiKey: 'secret',
        });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('without embedded credentials');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires a Base URL for OpenAI-compatible instances before discovery', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    try {
      const response = await request(createApp())
        .post('/api/provider/instances')
        .send({
          sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
          name: 'Missing Base URL',
          apiKey: 'secret',
        });
      expect(response.status).toBe(422);
      expect(response.body).toEqual({ error: 'OpenAI-compatible provider requires a Base URL' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an unresolved explicit directory before loading the provider catalog', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    try {
      const response = await request(createApp({
        resolveProjectDirectory: vi.fn(async () => ({
          directory: null,
          error: 'Directory does not exist',
        })),
      }))
        .post('/api/provider/instances')
        .set('x-opencode-directory', encodeURIComponent('/missing/project'))
        .set('x-opencode-directory-encoding', 'uri')
        .send({
          sourceProviderId: 'anthropic',
          name: 'Missing directory',
          apiKey: 'secret',
        });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Directory does not exist' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('updates canonical provider overrides without restarting and exposes non-secret source metadata', async () => {
    const updateProviderInstance = vi.fn(() => ({
      id: 'openai',
      providerId: 'openai',
      sourceProviderId: 'openai',
      name: 'ChatGPT Subscription',
      baseURL: null,
      managed: false,
    }));
    const refreshOpenCodeAfterConfigChange = vi.fn();
    const resolveProjectDirectory = vi.fn(async () => ({ directory: '/workspace/project' }));
    const app = createApp({
      updateProviderInstance,
      refreshOpenCodeAfterConfigChange,
      resolveProjectDirectory,
    });

    const update = await request(app)
      .put('/api/provider/openai/instance')
      .set('x-opencode-directory', encodeURIComponent('/workspace/project'))
      .set('x-opencode-directory-encoding', 'uri')
      .send({ name: 'ChatGPT Subscription' });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ restarted: false, requiresReload: true, instance: { managed: false } });
    expect(updateProviderInstance).toHaveBeenCalledWith(
      'openai',
      { name: 'ChatGPT Subscription' },
      expect.objectContaining({
        writeProviderApiKey: expect.any(Function),
        workingDirectory: '/workspace/project',
      }),
    );
    expect(resolveProjectDirectory).toHaveBeenCalledTimes(1);
    expect(refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();

    const source = await request(app).get('/api/provider/anthropic/source');
    expect(source.status).toBe(200);
    expect(source.body.connection).toEqual({
      sourceProviderId: 'anthropic',
      name: 'Work Anthropic',
      baseURL: null,
      managed: true,
      authType: null,
    });
    expect(source.body.sources.auth).toEqual({ exists: false, type: null });
    expect(source.body).not.toHaveProperty('apiKey');
  });

  it('keeps OpenAI-compatible name-only updates offline and preserves the local connection path', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const providerId = `${OPENAI_COMPATIBLE_PROVIDER_ID}:openchamber:11111111-1111-4111-8111-111111111111`;
    const updateProviderInstance = vi.fn(() => ({
      id: providerId,
      providerId,
      sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
      name: 'Renamed Gateway',
      baseURL: 'https://gateway.example.test/v1',
      managed: true,
    }));
    try {
      const app = createApp({
        updateProviderInstance,
        getProviderSources: vi.fn(() => ({
          sources: {
            auth: { exists: true },
            user: { exists: true, path: '/virtual/opencode.json' },
            project: { exists: false, path: null },
            custom: { exists: false, path: null },
          },
        })),
        getProviderConnectionMetadata: vi.fn(() => ({
          sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
          name: 'Old Gateway',
          baseURL: 'https://gateway.example.test/v1',
          managed: true,
        })),
      });

      const response = await request(app)
        .put(`/api/provider/${encodeURIComponent(providerId)}/instance`)
        .send({ name: 'Renamed Gateway' });

      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(updateProviderInstance).toHaveBeenCalledWith(
        providerId,
        { name: 'Renamed Gateway' },
        expect.not.objectContaining({ openAICompatibleModelIds: expect.anything() }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rediscovers managed OpenAI-compatible models before a base URL update using exact-ID auth', async () => {
    const originalFetch = globalThis.fetch;
    const providerId = `${OPENAI_COMPATIBLE_PROVIDER_ID}:openchamber:11111111-1111-4111-8111-111111111111`;
    const getProviderAuth = vi.fn((requestedProviderId) => {
      expect(requestedProviderId).toBe(providerId);
      return { type: 'api', key: 'stored-secret' };
    });
    const writeProviderApiKey = vi.fn();
    const updateProviderInstance = vi.fn(() => ({
      id: providerId,
      providerId,
      sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
      name: 'New Gateway',
      baseURL: 'https://new.example.test/v1',
      managed: true,
    }));
    try {
      globalThis.fetch = vi.fn(async (url, init) => {
        expect(url).toBe('https://new.example.test/v1/models');
        expect(init.headers.Authorization).toBe('Bearer stored-secret');
        return new Response(JSON.stringify({ data: [{ id: 'new/model' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const app = createApp({
        updateProviderInstance,
        getProviderSources: vi.fn(() => ({
          sources: {
            auth: { exists: true },
            user: { exists: true, path: '/virtual/opencode.json' },
            project: { exists: false, path: null },
            custom: { exists: false, path: null },
          },
        })),
        getProviderConnectionMetadata: vi.fn(() => ({
          sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
          name: 'Old Gateway',
          baseURL: 'https://old.example.test/v1',
          managed: true,
        })),
        loadProviderAuthLibrary: vi.fn(async () => ({ getProviderAuth, writeProviderApiKey })),
      });

      const response = await request(app)
        .put(`/api/provider/${encodeURIComponent(providerId)}/instance`)
        .send({ name: 'New Gateway', baseURL: 'https://new.example.test/v1' });

      expect(response.status).toBe(200);
      expect(getProviderAuth).toHaveBeenCalledTimes(1);
      expect(updateProviderInstance).toHaveBeenCalledWith(
        providerId,
        { name: 'New Gateway', baseURL: 'https://new.example.test/v1' },
        expect.objectContaining({ openAICompatibleModelIds: ['new/model'] }),
      );
      expect(writeProviderApiKey).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('leaves OpenAI-compatible config and auth untouched when update rediscovery fails', async () => {
    const originalFetch = globalThis.fetch;
    const providerId = `${OPENAI_COMPATIBLE_PROVIDER_ID}:openchamber:11111111-1111-4111-8111-111111111111`;
    const updateProviderInstance = vi.fn();
    const writeProviderApiKey = vi.fn();
    const getProviderAuth = vi.fn(() => ({ type: 'api', key: 'stored-secret' }));
    try {
      globalThis.fetch = vi.fn(async (_url, options) => {
        expect(options.headers.Authorization).toBe('Bearer new-secret');
        return new Response('', { status: 503 });
      });
      const app = createApp({
        updateProviderInstance,
        getProviderSources: vi.fn(() => ({
          sources: {
            auth: { exists: true },
            user: { exists: true, path: '/virtual/opencode.json' },
            project: { exists: false, path: null },
            custom: { exists: false, path: null },
          },
        })),
        getProviderConnectionMetadata: vi.fn(() => ({
          sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
          name: 'Old Gateway',
          baseURL: 'https://old.example.test/v1',
          managed: true,
        })),
        loadProviderAuthLibrary: vi.fn(async () => ({ getProviderAuth, writeProviderApiKey })),
      });

      const response = await request(app)
        .put(`/api/provider/${encodeURIComponent(providerId)}/instance`)
        .send({
          name: 'Broken Gateway',
          baseURL: 'https://broken.example.test/v1',
          apiKey: 'new-secret',
        });

      expect(response.status).toBe(502);
      expect(response.body).toEqual({ error: 'Failed to load the OpenAI-compatible model catalog' });
      expect(JSON.stringify(response.body)).not.toContain('new-secret');
      expect(getProviderAuth).not.toHaveBeenCalled();
      expect(updateProviderInstance).not.toHaveBeenCalled();
      expect(writeProviderApiKey).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves the same request directory for source reads and config deletion', async () => {
    const resolveProjectDirectory = vi.fn(async () => ({ directory: '/workspace/current' }));
    const getProviderSources = vi.fn(() => ({
      sources: {
        auth: { exists: false },
        user: { exists: true, path: '/virtual/opencode.json' },
        project: { exists: true, path: '/workspace/current/opencode.json' },
        custom: { exists: false, path: null },
      },
    }));
    const getProviderConnectionMetadata = vi.fn(() => ({
      sourceProviderId: 'anthropic',
      name: 'Project Anthropic',
      baseURL: null,
      managed: false,
    }));
    const removeProviderConfig = vi.fn(() => true);
    const app = createApp({
      resolveProjectDirectory,
      getProviderSources,
      getProviderConnectionMetadata,
      removeProviderConfig,
    });

    const source = await request(app)
      .get('/api/provider/anthropic/source')
      .query({ directory: '/workspace/current' });
    expect(source.status).toBe(200);
    expect(getProviderSources).toHaveBeenCalledWith('anthropic', '/workspace/current');
    expect(getProviderConnectionMetadata).toHaveBeenCalledWith(
      'anthropic',
      '/workspace/current',
      { readProviderProxy: expect.any(Function) },
    );

    const removal = await request(app)
      .delete('/api/provider/anthropic/auth')
      .query({ scope: 'project', directory: '/workspace/current' });
    expect(removal.status).toBe(200);
    expect(removeProviderConfig).toHaveBeenCalledWith('anthropic', '/workspace/current', 'project');
    expect(resolveProjectDirectory).toHaveBeenCalledTimes(2);
  });

  it('cleans up managed proxy metadata on full disconnect', async () => {
    const providerId = `anthropic:openchamber:11111111-1111-4111-8111-111111111111`;
    const removeProviderProxy = vi.fn(() => true);
    const refreshOpenCodeAfterConfigChange = vi.fn(async () => ({ reloaded: true }));
    const app = createApp({
      removeProviderProxy,
      removeProviderConfig: vi.fn(() => false),
      refreshOpenCodeAfterConfigChange,
      loadProviderAuthLibrary: vi.fn(async () => ({
        getProviderAuth: vi.fn(() => null),
        writeProviderApiKey: vi.fn(),
        removeProviderAuth: vi.fn(() => false),
      })),
    });

    const response = await request(app)
      .delete(`/api/provider/${encodeURIComponent(providerId)}/auth`)
      .query({ scope: 'all' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, removed: true, requiresReload: true });
    expect(removeProviderProxy).toHaveBeenCalledWith(providerId);
    expect(refreshOpenCodeAfterConfigChange).toHaveBeenCalledTimes(1);
  });

  it('reports effective config apiKey auth ahead of stored OAuth without loading its secret', async () => {
    const getProviderAuth = vi.fn(() => ({ type: 'oauth', access: 'oauth-secret-must-not-leak' }));
    const loadProviderAuthLibrary = vi.fn(async () => ({
      getProviderAuth,
      writeProviderApiKey: vi.fn(),
      removeProviderAuth: vi.fn(),
    }));
    const app = createApp({
      getProviderConnectionMetadata: vi.fn(() => ({
        sourceProviderId: 'openai',
        name: 'Config API',
        baseURL: null,
        managed: false,
        authType: 'api',
      })),
      loadProviderAuthLibrary,
    });

    const source = await request(app).get('/api/provider/openai/source');

    expect(source.status).toBe(200);
    expect(source.body.connection.authType).toBe('api');
    expect(source.body.sources.auth).toEqual({ exists: true, type: 'api' });
    expect(loadProviderAuthLibrary).not.toHaveBeenCalled();
    expect(getProviderAuth).not.toHaveBeenCalled();
    expect(JSON.stringify(source.body)).not.toContain('oauth-secret-must-not-leak');
  });
});
