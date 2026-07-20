import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

const writeProviderApiKey = mock(() => {});
const createProviderInstance = mock((input, dependencies) => {
  const providerId = `${input.sourceProviderId}:openchamber:11111111-1111-4111-8111-111111111111`;
  dependencies.writeProviderApiKey(providerId, input.apiKey);
  return {
    id: providerId,
    providerId,
    sourceProviderId: input.sourceProviderId,
    name: input.name,
    baseURL: input.baseURL,
    proxy: input.proxy || { mode: 'direct' },
    managed: true,
  };
});
const updateProviderInstance = mock((providerId, body) => ({
  id: providerId,
  providerId,
  sourceProviderId: providerId.split(':openchamber:')[0],
  name: body.name,
  baseURL: null,
  proxy: body.proxy || { mode: 'direct' },
  managed: false,
}));
const getProviderSources = mock(() => ({
  auth: { exists: false },
  user: { exists: true, path: '/virtual/opencode.json' },
  project: { exists: false, path: null },
  custom: { exists: false, path: null },
}));
const getProviderConnectionMetadata = mock((providerId) => ({
  sourceProviderId: providerId.split(':openchamber:')[0],
  name: providerId === 'config-api' ? 'Config API' : 'Custom Provider',
  baseURL: providerId.startsWith('openai-compatible:openchamber:')
    ? 'https://old-relay.example.test/v1'
    : null,
  managed: providerId !== 'config-api',
  proxy: { mode: 'direct' },
  authType: providerId === 'config-api' ? 'api' : null,
}));
const removeProviderConfig = mock(() => false);
const getProviderProxy = mock(() => ({ mode: 'direct' }));
const writeProviderProxy = mock(() => {});
const fetchWithProviderProxy = mock((url, apiKey) => globalThis.fetch(url, {
  method: 'GET',
  headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
  redirect: 'error',
  signal: AbortSignal.timeout(15_000),
}));
const getProviderAuth = mock((providerId) => providerId.startsWith('openai-compatible:openchamber:')
  ? { type: 'api', key: 'stored-relay-secret' }
  : { type: 'oauth', access: 'must-not-leak' });

mock.module('vscode', () => ({
  workspace: { workspaceFolders: [] },
  window: {},
  commands: {},
  Uri: {},
  Position: class {},
  Range: class {},
  Selection: class {},
  TextEditorRevealType: {},
}));

let handleSystemBridgeMessage;

beforeAll(async () => {
  ({ handleSystemBridgeMessage } = await import('./bridge-system-runtime'));
});

afterAll(() => {
  mock.restore();
});

const deps = {
  resolveUserPath: (value) => value,
  fetchModelsMetadata: async () => ({}),
  updateCheckUrl: 'https://updates.example.test',
  clientReloadDelayMs: 800,
  providerRuntime: {
    validateProviderInstanceCreateInput: (payload) => {
      if (!payload?.sourceProviderId || !payload?.name || !payload?.apiKey) {
        throw new Error('Provider fields are required');
      }
      return {
        sourceProviderId: payload.sourceProviderId,
        name: payload.name,
        baseURL: payload.baseURL ?? null,
        apiKey: payload.apiKey,
        proxy: payload.proxy || { mode: 'direct' },
      };
    },
    findSourceProvider: (payload, sourceProviderId) => {
      const providers = Array.isArray(payload?.all) ? payload.all : payload;
      const source = providers.find((entry) => entry.id === sourceProviderId);
      if (!source) throw new Error('Source provider was not found');
      return source;
    },
    createProviderInstance,
    updateProviderInstance,
    getProviderSources,
    getProviderConnectionMetadata,
    removeProviderConfig,
    writeProviderApiKey,
    fetchWithProviderProxy,
    getProviderProxy,
    writeProviderProxy,
    getProviderAuth,
    removeProviderAuth: () => false,
  },
};

const ctx = {
  manager: {
    getApiUrl: () => 'http://127.0.0.1:4096',
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer upstream-token' }),
    getWorkingDirectory: () => '/workspace',
    restart: mock(async () => {}),
  },
};

describe('VS Code provider-instance bridge parity', () => {
  test('creates through the extension host catalog and never returns the key', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = mock(async (url, init) => {
        expect(url).toBe('http://127.0.0.1:4096/provider?directory=%2Fworkspace');
        expect(init.headers.Authorization).toBe('Bearer upstream-token');
        return new Response(JSON.stringify({ all: [{ id: 'custom:provider', models: { model: {} } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const response = await handleSystemBridgeMessage({
        id: 'create',
        type: 'api:provider/instance:create',
        payload: {
          sourceProviderId: 'custom:provider',
          name: 'Custom Provider',
          baseURL: 'https://gateway.example.test',
          apiKey: 'request-secret',
          directory: '/workspace',
        },
      }, ctx, deps);

      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({ restarted: false, requiresReload: true });
      expect(JSON.stringify(response)).not.toContain('request-secret');
      expect(writeProviderApiKey).toHaveBeenCalledWith(
        'custom:provider:openchamber:11111111-1111-4111-8111-111111111111',
        'request-secret',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('updates canonical providers without restarting and exposes only the auth type', async () => {
    const update = await handleSystemBridgeMessage({
      id: 'update',
      type: 'api:provider/instance:update',
      payload: {
        providerId: 'openai',
        body: { name: 'ChatGPT Subscription' },
        directory: '/workspace',
      },
    }, ctx, deps);
    expect(update).toMatchObject({
      success: true,
      data: { restarted: false, instance: { providerId: 'openai', managed: false } },
    });
    expect(updateProviderInstance).toHaveBeenCalledWith(
      'openai',
      { name: 'ChatGPT Subscription' },
      expect.objectContaining({ workingDirectory: '/workspace' }),
    );

    const source = await handleSystemBridgeMessage({
      id: 'source',
      type: 'api:provider/source:get',
      payload: { providerId: 'custom:provider', directory: '/workspace/source' },
    }, ctx, deps);
    expect(source.data.connection.authType).toBe('oauth');
    expect(source.data.sources.auth).toEqual({ exists: true, type: 'oauth' });
    expect(JSON.stringify(source)).not.toContain('must-not-leak');
    expect(getProviderSources).toHaveBeenLastCalledWith('custom:provider', '/workspace/source');
    expect(getProviderConnectionMetadata).toHaveBeenLastCalledWith('custom:provider', '/workspace/source');

    const removal = await handleSystemBridgeMessage({
      id: 'remove',
      type: 'api:provider/auth:delete',
      payload: { providerId: 'custom:provider', scope: 'project', directory: '/workspace/remove' },
    }, ctx, deps);
    expect(removal.success).toBe(true);
    expect(removeProviderConfig).toHaveBeenLastCalledWith('custom:provider', '/workspace/remove', 'project');
  });

  test('reports config apiKey auth ahead of stored OAuth without reading its secret', async () => {
    const authReadsBefore = getProviderAuth.mock.calls.length;
    const source = await handleSystemBridgeMessage({
      id: 'config-source',
      type: 'api:provider/source:get',
      payload: { providerId: 'config-api', directory: '/workspace' },
    }, ctx, deps);

    expect(source.data.connection.authType).toBe('api');
    expect(source.data.sources.auth).toEqual({ exists: true, type: 'api' });
    expect(getProviderAuth.mock.calls.length).toBe(authReadsBefore);
    expect(JSON.stringify(source)).not.toContain('must-not-leak');
  });

  test('removes managed proxy metadata when the user-owned provider instance is deleted', async () => {
    const providerId = 'anthropic:openchamber:11111111-1111-4111-8111-111111111111';
    removeProviderConfig.mockImplementationOnce(() => true);
    getProviderProxy.mockImplementationOnce(() => ({ mode: 'manual', url: 'http://localhost:9000' }));

    const response = await handleSystemBridgeMessage({
      id: 'remove-managed-proxy',
      type: 'api:provider/auth:delete',
      payload: { providerId, scope: 'user', directory: '/workspace' },
    }, ctx, deps);

    expect(response.success).toBe(true);
    expect(writeProviderProxy).toHaveBeenLastCalledWith(providerId, { mode: 'direct' });
  });

  test('does not read or mutate proxy mappings for canonical providers', async () => {
    const proxyReadsBefore = getProviderProxy.mock.calls.length;
    const proxyWritesBefore = writeProviderProxy.mock.calls.length;
    removeProviderConfig.mockImplementationOnce(() => true);

    const response = await handleSystemBridgeMessage({
      id: 'remove-canonical',
      type: 'api:provider/auth:delete',
      payload: { providerId: 'openai', scope: 'user', directory: '/workspace' },
    }, ctx, deps);

    expect(response.success).toBe(true);
    expect(getProviderProxy.mock.calls.length).toBe(proxyReadsBefore);
    expect(writeProviderProxy.mock.calls.length).toBe(proxyWritesBefore);
  });

  test('discovers OpenAI-compatible models in the extension host before creating an alias', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = mock(async (url, init) => {
        expect(url).toBe('https://relay.example.test/v1/models');
        expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
        expect(init.headers).toEqual({
          Accept: 'application/json',
          Authorization: 'Bearer relay-request-secret',
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return new Response(JSON.stringify({
          data: [{ id: 'relay-model' }, { id: ' relay-model ' }, { id: 'relay-model-2' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });

      const response = await handleSystemBridgeMessage({
        id: 'create-compatible',
        type: 'api:provider/instance:create',
        payload: {
          sourceProviderId: 'openai-compatible',
          name: 'Frugal Relay',
          baseURL: 'https://relay.example.test/v1',
          apiKey: 'relay-request-secret',
          directory: '/workspace',
        },
      }, ctx, deps);

      expect(response.success).toBe(true);
      expect(createProviderInstance).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sourceProviderId: 'openai-compatible',
          openAICompatibleModelIds: ['relay-model', 'relay-model-2'],
        }),
        expect.objectContaining({ writeProviderApiKey }),
      );
      expect(JSON.stringify(response)).not.toContain('relay-request-secret');
      expect(writeProviderApiKey).toHaveBeenLastCalledWith(
        'openai-compatible:openchamber:11111111-1111-4111-8111-111111111111',
        'relay-request-secret',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('routes compatible discovery through the selected per-instance proxy without returning secrets', async () => {
    const callsBefore = fetchWithProviderProxy.mock.calls.length;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = mock(async () => new Response(JSON.stringify({
        data: [{ id: 'proxied-model' }],
      }), { status: 200 }));
      const response = await handleSystemBridgeMessage({
        id: 'create-compatible-proxy',
        type: 'api:provider/instance:create',
        payload: {
          sourceProviderId: 'openai-compatible',
          name: 'Corporate Relay',
          baseURL: 'https://relay.example.test/v1',
          apiKey: 'proxy-discovery-secret',
          proxy: { mode: 'manual', url: 'http://localhost:9000' },
          directory: '/workspace',
        },
      }, ctx, deps);

      expect(response.success).toBe(true);
      expect(response.data.restarted).toBe(true);
      expect(fetchWithProviderProxy.mock.calls[callsBefore]).toEqual([
        'https://relay.example.test/v1/models',
        'proxy-discovery-secret',
        { mode: 'manual', url: 'http://localhost:9000' },
      ]);
      expect(createProviderInstance).toHaveBeenLastCalledWith(
        expect.objectContaining({
          proxy: { mode: 'manual', url: 'http://localhost:9000' },
          openAICompatibleModelIds: ['proxied-model'],
        }),
        expect.anything(),
      );
      expect(JSON.stringify(response)).not.toContain('proxy-discovery-secret');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects invalid, empty, and oversized compatible catalogs before persistence', async () => {
    const originalFetch = globalThis.fetch;
    const createsBefore = createProviderInstance.mock.calls.length;
    const payload = {
      sourceProviderId: 'openai-compatible',
      name: 'Frugal Relay',
      baseURL: 'https://relay.example.test/v1',
      apiKey: 'relay-request-secret',
    };
    try {
      for (const responseFactory of [
        () => new Response('{broken', { status: 200 }),
        () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
        () => new Response('{}', { status: 200, headers: { 'Content-Length': String(1024 * 1024 + 1) } }),
      ]) {
        globalThis.fetch = mock(async () => responseFactory());
        const response = await handleSystemBridgeMessage({
          id: 'create-compatible-failure',
          type: 'api:provider/instance:create',
          payload,
        }, ctx, deps);
        expect(response.success).toBe(false);
        expect(response.error).toMatch(/OpenAI-compatible (?:model catalog|provider has no usable models)/);
      }

      globalThis.fetch = mock(async () => { throw new Error('connection refused'); });
      const unreachable = await handleSystemBridgeMessage({
        id: 'create-compatible-unreachable',
        type: 'api:provider/instance:create',
        payload,
      }, ctx, deps);
      expect(unreachable).toMatchObject({
        success: false,
        error: 'Failed to load the OpenAI-compatible model catalog',
      });
      expect(JSON.stringify(unreachable)).not.toContain('connection refused');
      expect(createProviderInstance.mock.calls.length).toBe(createsBefore);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refreshes compatible models only when connection settings change', async () => {
    const originalFetch = globalThis.fetch;
    const providerId = 'openai-compatible:openchamber:11111111-1111-4111-8111-111111111111';
    const updatesBefore = updateProviderInstance.mock.calls.length;
    const authReadsBefore = getProviderAuth.mock.calls.length;
    try {
      const discoveryFetch = mock(async (url, init) => {
        expect(url).toBe('https://new-relay.example.test/v2/models?api-version=2026-01-01');
        expect(init.headers.Authorization).toBe('Bearer stored-relay-secret');
        return new Response(JSON.stringify({ data: [{ id: 'new-model' }] }), { status: 200 });
      });
      globalThis.fetch = discoveryFetch;

      const nameOnly = await handleSystemBridgeMessage({
        id: 'rename-compatible',
        type: 'api:provider/instance:update',
        payload: { providerId, body: { name: 'Renamed Relay' }, directory: '/workspace' },
      }, ctx, deps);
      expect(nameOnly.success).toBe(true);
      expect(discoveryFetch).not.toHaveBeenCalled();
      expect(getProviderAuth.mock.calls.length).toBe(authReadsBefore);
      expect(updateProviderInstance.mock.calls[updatesBefore][2]).not.toHaveProperty('openAICompatibleModelIds');

      const refreshed = await handleSystemBridgeMessage({
        id: 'refresh-compatible',
        type: 'api:provider/instance:update',
        payload: {
          providerId,
          body: {
            name: 'New Relay',
            baseURL: 'https://new-relay.example.test/v2?api-version=2026-01-01',
          },
          directory: '/workspace',
        },
      }, ctx, deps);
      expect(refreshed.success).toBe(true);
      expect(discoveryFetch).toHaveBeenCalledTimes(1);
      expect(getProviderAuth).toHaveBeenLastCalledWith(providerId);
      expect(updateProviderInstance).toHaveBeenLastCalledWith(
        providerId,
        expect.objectContaining({ name: 'New Relay' }),
        expect.objectContaining({
          workingDirectory: '/workspace',
          openAICompatibleModelIds: ['new-model'],
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('uses a new exact-id key for discovery and does not persist when discovery fails', async () => {
    const originalFetch = globalThis.fetch;
    const providerId = 'openai-compatible:openchamber:11111111-1111-4111-8111-111111111111';
    const authReadsBefore = getProviderAuth.mock.calls.length;
    try {
      globalThis.fetch = mock(async (_url, init) => {
        expect(init.headers.Authorization).toBe('Bearer replacement-secret');
        return new Response(JSON.stringify({ data: [{ id: 'replacement-model' }] }), { status: 200 });
      });
      const success = await handleSystemBridgeMessage({
        id: 'replace-compatible-key',
        type: 'api:provider/instance:update',
        payload: {
          providerId,
          body: { name: 'Relay', apiKey: 'replacement-secret' },
          directory: '/workspace',
        },
      }, ctx, deps);
      expect(success.success).toBe(true);
      expect(getProviderAuth.mock.calls.length).toBe(authReadsBefore);

      const updatesBeforeFailure = updateProviderInstance.mock.calls.length;
      globalThis.fetch = mock(async () => new Response('upstream unavailable', { status: 503 }));
      const failure = await handleSystemBridgeMessage({
        id: 'failed-compatible-refresh',
        type: 'api:provider/instance:update',
        payload: {
          providerId,
          body: { name: 'Relay', apiKey: 'must-not-persist' },
          directory: '/workspace',
        },
      }, ctx, deps);
      expect(failure).toMatchObject({
        success: false,
        error: 'Failed to load the OpenAI-compatible model catalog',
      });
      expect(updateProviderInstance.mock.calls.length).toBe(updatesBeforeFailure);
      expect(JSON.stringify(failure)).not.toContain('must-not-persist');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
