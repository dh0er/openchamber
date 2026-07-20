import { describe, expect, mock, test } from 'bun:test';
import {
  OPENAI_COMPATIBLE_PROVIDER_NPM,
  buildOpenAICompatibleProviderConfig,
  buildProviderInstanceConfig,
  createProviderInstance,
  getProviderConnectionMetadata,
  mapProviderModelToConfig,
  parseOpenAICompatibleModelCatalog,
  parseManagedProviderInstanceId,
  updateProviderInstance,
  validateProviderInstanceCreateInput,
  validateProviderInstanceUpdateInput,
} from './providerInstances';

const UUID = '11111111-1111-4111-8111-111111111111';
const sourceProvider = {
  id: 'custom:provider',
  key: 'source-secret',
  options: { apiKey: 'source-secret' },
  models: {
    model: {
      api: { id: 'upstream-model', url: 'https://api.example.test', npm: '@ai-sdk/openai-compatible' },
      name: 'Model',
      family: 'custom',
      capabilities: {
        attachment: true,
        reasoning: true,
        temperature: true,
        toolcall: true,
        input: { text: true, image: true },
        output: { text: true },
      },
      cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
      limit: { context: 10_000, output: 1_000 },
      status: 'active',
      options: {
        reasoningEffort: 'medium',
        mode: 'chat',
        apiKey: 'nested-secret',
        awsSecretAccessKey: 'aws-secret',
        credentials: { password: 'credential-secret' },
      },
      headers: {
        'x-routing-mode': 'fast',
        Authorization: 'Bearer source-secret',
        Cookie: 'session=cookie-secret',
        'x-auth-token': 'header-secret',
      },
      release_date: '2026-01-01',
      variants: { high: { reasoningEffort: 'high', credentials: { token: 'variant-secret' } } },
    },
  },
};

const memoryStorage = (initial = {}) => {
  let current = structuredClone(initial);
  return {
    readConfigLayers: () => ({ userConfig: structuredClone(current), paths: { userPath: '/virtual/config.json' } }),
    writeConfig: (next) => { current = structuredClone(next); },
    get current() { return current; },
  };
};

describe('VS Code provider-instance config parity', () => {
  test('parses and snapshots bounded OpenAI-compatible model catalogs safely', () => {
    const modelIds = parseOpenAICompatibleModelCatalog({
      data: [
        { id: ' model-a ' },
        { id: 'model-a' },
        { id: 'MODEL-A' },
        { id: 'constructor' },
        { id: 'bad\u0000model' },
        { id: '' },
        null,
      ],
    });
    expect(modelIds).toEqual(['model-a', 'MODEL-A']);

    const config = buildOpenAICompatibleProviderConfig(
      'Frugal Relay',
      'https://relay.example.test/v1',
      modelIds,
    );
    expect(config).toEqual({
      npm: OPENAI_COMPATIBLE_PROVIDER_NPM,
      name: 'Frugal Relay',
      options: { baseURL: 'https://relay.example.test/v1' },
      models: {
        'model-a': { name: 'model-a' },
        'MODEL-A': { name: 'MODEL-A' },
      },
    });
    expect(config).not.toHaveProperty('id');
    expect(Object.getPrototypeOf(config.models)).toBeNull();

    expect(() => parseOpenAICompatibleModelCatalog({ models: [] }))
      .toThrow('Failed to load the OpenAI-compatible model catalog');
    expect(() => parseOpenAICompatibleModelCatalog({ data: [] }))
      .toThrow('OpenAI-compatible provider has no usable models');
    expect(() => parseOpenAICompatibleModelCatalog({
      data: Array.from({ length: 5_001 }, (_, index) => ({ id: `model-${index}` })),
    })).toThrow('Failed to load the OpenAI-compatible model catalog');
  });

  test('requires a base URL for OpenAI-compatible instances', () => {
    expect(() => validateProviderInstanceCreateInput({
      sourceProviderId: 'openai-compatible',
      name: 'Frugal Relay',
      apiKey: 'key',
    })).toThrow('OpenAI-compatible provider requires a Base URL');
  });

  test('validates managed proxy settings without forcing built-in provider base URLs', () => {
    const manual = validateProviderInstanceCreateInput({
      sourceProviderId: 'custom:provider',
      name: 'Corporate route',
      apiKey: 'key',
      proxy: { mode: 'manual', url: 'http://localhost:9000/' },
    });
    expect(manual).toMatchObject({
      baseURL: null,
      proxy: { mode: 'manual', url: 'http://localhost:9000' },
    });
    expect(validateProviderInstanceCreateInput({
      sourceProviderId: 'custom:provider',
      name: 'System route',
      apiKey: 'key',
      proxy: { mode: 'system' },
    }).proxy).toEqual({ mode: 'system' });

    for (const proxy of [
      { mode: 'manual', url: 'http://user:secret@localhost:9000' },
      { mode: 'manual', url: 'http://localhost:9000/path' },
      { mode: 'direct', url: 'http://localhost:9000' },
      { mode: 'unknown' },
    ]) {
      expect(() => validateProviderInstanceCreateInput({
        sourceProviderId: 'custom:provider',
        name: 'Invalid proxy',
        apiKey: 'key',
        proxy,
      })).toThrow();
    }

    expect(() => validateProviderInstanceUpdateInput('openai', {
      name: 'Canonical provider',
      proxy: { mode: 'manual', url: 'http://localhost:9000' },
    })).toThrow('supported only for managed API-key provider instances');
  });

  test('persists the canonical source id and allowlisted non-secret model metadata', () => {
    const config = buildProviderInstanceConfig(sourceProvider, 'Gateway', 'https://gateway.example.test');
    expect(config).toMatchObject({
      id: 'custom:provider',
      name: 'Gateway',
      options: { baseURL: 'https://gateway.example.test' },
      models: {
        model: {
          id: 'upstream-model',
          provider: { api: 'https://api.example.test', npm: '@ai-sdk/openai-compatible' },
          modalities: { input: ['text', 'image'], output: ['text'] },
          cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
          limit: { context: 10_000, output: 1_000 },
          options: { reasoningEffort: 'medium' },
          variants: { high: { reasoningEffort: 'high' } },
        },
      },
    });
    expect(config.models.model).not.toHaveProperty('headers');
    expect(JSON.stringify(config)).not.toContain('source-secret');
    expect(JSON.stringify(config)).not.toContain('nested-secret');
    expect(JSON.stringify(config)).not.toContain('aws-secret');
    expect(JSON.stringify(config)).not.toContain('credential-secret');
    expect(JSON.stringify(config)).not.toContain('cookie-secret');
    expect(JSON.stringify(config)).not.toContain('header-secret');
    expect(JSON.stringify(config)).not.toContain('variant-secret');

    const credentialedUrlModel = mapProviderModelToConfig('credentialed-url', {
      api: {
        id: 'credentialed-url',
        npm: '@ai-sdk/openai-compatible',
        url: 'https://user:embedded-secret@gateway.example.test/v1',
      },
    })[1];
    const signedUrlModel = mapProviderModelToConfig('signed-url', {
      api: {
        id: 'signed-url',
        npm: '@ai-sdk/openai-compatible',
        url: 'https://gateway.example.test/v1?x-auth-token=query-secret',
      },
    })[1];
    expect(credentialedUrlModel.provider).toEqual({ npm: '@ai-sdk/openai-compatible' });
    expect(signedUrlModel.provider).toEqual({ npm: '@ai-sdk/openai-compatible' });
    expect(JSON.stringify([credentialedUrlModel, signedUrlModel])).not.toContain('embedded-secret');
    expect(JSON.stringify([credentialedUrlModel, signedUrlModel])).not.toContain('query-secret');
  });

  test('rejects prototype-pollution keys in provider, model, and variant maps', () => {
    expect(() => validateProviderInstanceCreateInput({
      sourceProviderId: 'constructor',
      name: 'Unsafe provider',
      apiKey: 'key',
    })).toThrow('Invalid source provider ID');
    expect(mapProviderModelToConfig('__proto__', {})).toBeNull();
    expect(mapProviderModelToConfig('prototype', {})).toBeNull();
    expect(mapProviderModelToConfig('constructor', {})).toBeNull();

    const mapped = mapProviderModelToConfig('safe-model', {
      variants: {
        ['__proto__']: { reasoningEffort: 'high' },
        prototype: { reasoningEffort: 'high' },
        constructor: { reasoningEffort: 'high' },
        safe: { reasoningEffort: 'high' },
      },
    });
    expect(mapped[1].variants).toEqual({ safe: { reasoningEffort: 'high' } });
    expect(Object.getPrototypeOf(mapped[1].variants)).toBeNull();
  });

  test('rejects provider base URLs with fragments or sensitive query keys', () => {
    expect(validateProviderInstanceCreateInput({
      sourceProviderId: 'custom:provider',
      name: 'Versioned gateway',
      baseURL: 'https://gateway.example.test/v1?api-version=2026-01-01',
      apiKey: 'key',
    }).baseURL).toBe('https://gateway.example.test/v1?api-version=2026-01-01');

    for (const baseURL of [
      'https://gateway.example.test/v1#credential',
      'https://gateway.example.test/v1?api_key=secret',
      'https://gateway.example.test/v1?ACCESS-TOKEN=secret',
    ]) {
      expect(() => validateProviderInstanceCreateInput({
        sourceProviderId: 'custom:provider',
        name: 'Unsafe gateway',
        baseURL,
        apiKey: 'key',
      })).toThrow();
    }
  });

  test('redacts unsafe existing base URLs from connection metadata', () => {
    const readMetadata = (baseURL) => getProviderConnectionMetadata('custom:provider', undefined, {
      readConfigLayers: () => ({
        mergedConfig: { provider: { 'custom:provider': { options: { baseURL } } } },
      }),
    }).baseURL;

    expect(readMetadata('https://gateway.example.test/v1?api-version=2026-01-01'))
      .toBe('https://gateway.example.test/v1?api-version=2026-01-01');
    expect(readMetadata('https://gateway.example.test/v1#credential')).toBeNull();
    expect(readMetadata('https://gateway.example.test/v1?api_key=secret')).toBeNull();
    expect(getProviderConnectionMetadata('openai', undefined, {
      readConfigLayers: () => ({ mergedConfig: { provider: { openai: { name: 'Subscription' } } } }),
      getProviderProxy: () => ({ mode: 'manual', url: 'http://localhost:9000' }),
    }).proxy).toEqual({ mode: 'direct' });
  });

  test('creates marker aliases for colon-containing sources and stores the exact key id', () => {
    const storage = memoryStorage();
    const writeProviderApiKey = mock(() => {});
    const instance = createProviderInstance({
      sourceProviderId: 'custom:provider',
      name: 'Gateway',
      baseURL: null,
      apiKey: 'alias-key',
      sourceProvider,
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      randomUUID: () => UUID,
      writeProviderApiKey,
    });
    expect(instance.providerId).toBe(`custom:provider:openchamber:${UUID}`);
    expect(parseManagedProviderInstanceId(instance.providerId)?.sourceProviderId).toBe('custom:provider');
    expect(parseManagedProviderInstanceId(`custom:openchamber:openchamber:${UUID}`)).toBeNull();
    expect(storage.current.provider[instance.providerId].id).toBe('custom:provider');
    expect(writeProviderApiKey).toHaveBeenCalledWith(instance.providerId, 'alias-key');
  });

  test('persists a managed proxy before credentials and rolls all settings back on failure', () => {
    const storage = memoryStorage();
    const writeProviderProxy = mock(() => {});
    const instance = createProviderInstance({
      sourceProviderId: 'custom:provider',
      name: 'Gateway',
      baseURL: null,
      apiKey: 'alias-key',
      proxy: { mode: 'manual', url: 'http://localhost:9000/' },
      sourceProvider,
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      randomUUID: () => UUID,
      writeProviderApiKey: () => {},
      writeProviderProxy,
    });
    expect(instance.proxy).toEqual({ mode: 'manual', url: 'http://localhost:9000' });
    expect(writeProviderProxy).toHaveBeenCalledWith(
      instance.providerId,
      { mode: 'manual', url: 'http://localhost:9000' },
    );

    const failingStorage = memoryStorage();
    const rollbackProxy = mock(() => {});
    expect(() => createProviderInstance({
      sourceProviderId: 'custom:provider',
      name: 'Gateway',
      apiKey: 'alias-key',
      proxy: { mode: 'manual', url: 'http://localhost:9000' },
      sourceProvider,
    }, {
      readConfigLayers: failingStorage.readConfigLayers,
      writeConfig: failingStorage.writeConfig,
      randomUUID: () => UUID,
      writeProviderApiKey: () => { throw new Error('auth write failed'); },
      writeProviderProxy: rollbackProxy,
    })).toThrow('Failed to store provider credentials');
    expect(failingStorage.current).toEqual({});
    expect(rollbackProxy.mock.calls.map((call) => call[1])).toEqual([
      { mode: 'manual', url: 'http://localhost:9000' },
      { mode: 'direct' },
    ]);

    const proxyFailingStorage = memoryStorage();
    const writeProviderApiKey = mock(() => {});
    expect(() => createProviderInstance({
      sourceProviderId: 'custom:provider',
      name: 'Gateway',
      apiKey: 'alias-key',
      proxy: { mode: 'manual', url: 'http://localhost:9000' },
      sourceProvider,
    }, {
      readConfigLayers: proxyFailingStorage.readConfigLayers,
      writeConfig: proxyFailingStorage.writeConfig,
      randomUUID: () => UUID,
      writeProviderApiKey,
      writeProviderProxy: () => { throw new Error('proxy write failed'); },
    })).toThrow('Failed to store provider proxy configuration');
    expect(proxyFailingStorage.current).toEqual({});
    expect(writeProviderApiKey).not.toHaveBeenCalled();
  });

  test('creates OpenAI-compatible aliases with the dedicated adapter and exact auth id', () => {
    const storage = memoryStorage();
    const writeProviderApiKey = mock(() => {});
    const instance = createProviderInstance({
      sourceProviderId: 'openai-compatible',
      name: 'Frugal Relay',
      baseURL: 'https://relay.example.test/v1',
      apiKey: 'relay-key',
      openAICompatibleModelIds: ['relay-model'],
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      randomUUID: () => UUID,
      writeProviderApiKey,
    });

    expect(storage.current.provider[instance.providerId]).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'Frugal Relay',
      options: { baseURL: 'https://relay.example.test/v1' },
      models: { 'relay-model': { name: 'relay-model' } },
    });
    expect(storage.current.provider[instance.providerId]).not.toHaveProperty('id');
    expect(writeProviderApiKey).toHaveBeenCalledWith(instance.providerId, 'relay-key');
  });

  test('preserves compatible catalog state on name-only updates and atomically refreshes it', () => {
    const managedId = `openai-compatible:openchamber:${UUID}`;
    const initial = {
      provider: {
        [managedId]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Old Relay',
          options: { baseURL: 'https://old.example.test/v1', timeout: 50 },
          models: { old: { name: 'old' } },
        },
      },
    };
    const storage = memoryStorage(initial);
    updateProviderInstance(managedId, { name: 'Renamed Relay' }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
    });
    expect(storage.current.provider[managedId]).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'Renamed Relay',
      options: { baseURL: 'https://old.example.test/v1', timeout: 50 },
      models: { old: { name: 'old' } },
    });

    updateProviderInstance(managedId, {
      name: 'New Relay',
      baseURL: 'https://new.example.test/v1',
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      openAICompatibleModelIds: ['new-a', 'new-b'],
    });
    expect(storage.current.provider[managedId]).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'New Relay',
      options: { baseURL: 'https://new.example.test/v1', timeout: 50 },
      models: {
        'new-a': { name: 'new-a' },
        'new-b': { name: 'new-b' },
      },
    });

    const failingStorage = memoryStorage(initial);
    expect(() => updateProviderInstance(managedId, {
      name: 'Broken Relay',
      baseURL: 'https://broken.example.test/v1',
      apiKey: 'new-key',
    }, {
      readConfigLayers: failingStorage.readConfigLayers,
      writeConfig: failingStorage.writeConfig,
      writeProviderApiKey: () => { throw new Error('auth write failed'); },
      openAICompatibleModelIds: ['new-model'],
    })).toThrow('Failed to store provider credentials');
    expect(failingStorage.current).toEqual(initial);
  });

  test('updates managed proxy settings and restores the previous mapping when auth storage fails', () => {
    const managedId = `custom:provider:openchamber:${UUID}`;
    const initial = {
      provider: {
        [managedId]: {
          id: 'custom:provider',
          name: 'Old gateway',
          models: { model: { name: 'Model' } },
        },
      },
    };
    const storage = memoryStorage(initial);
    const writeProviderProxy = mock(() => {});
    const updated = updateProviderInstance(managedId, {
      name: 'Manual gateway',
      proxy: { mode: 'manual', url: 'http://localhost:9000/' },
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      getProviderProxy: () => ({ mode: 'system' }),
      writeProviderProxy,
    });
    expect(updated.proxy).toEqual({ mode: 'manual', url: 'http://localhost:9000' });
    expect(writeProviderProxy).toHaveBeenCalledWith(
      managedId,
      { mode: 'manual', url: 'http://localhost:9000' },
    );

    const failingStorage = memoryStorage(initial);
    const rollbackProxy = mock(() => {});
    expect(() => updateProviderInstance(managedId, {
      name: 'Broken gateway',
      apiKey: 'replacement-key',
      proxy: { mode: 'manual', url: 'http://localhost:9001' },
    }, {
      readConfigLayers: failingStorage.readConfigLayers,
      writeConfig: failingStorage.writeConfig,
      getProviderProxy: () => ({ mode: 'system' }),
      writeProviderProxy: rollbackProxy,
      writeProviderApiKey: () => { throw new Error('auth write failed'); },
    })).toThrow('Failed to store provider credentials');
    expect(failingStorage.current).toEqual(initial);
    expect(rollbackProxy.mock.calls.map((call) => call[1])).toEqual([
      { mode: 'manual', url: 'http://localhost:9001' },
      { mode: 'system' },
    ]);
  });

  test('clears managed baseURL only and leaves canonical OAuth auth untouched when no key is supplied', () => {
    const managedId = `custom:provider:openchamber:${UUID}`;
    const storage = memoryStorage({
      provider: {
        [managedId]: {
          id: 'custom:provider',
          name: 'Old',
          options: { baseURL: 'https://old.example.test', timeout: 50 },
          models: { model: { name: 'Model' } },
        },
      },
    });
    const writeProviderApiKey = mock(() => {});
    updateProviderInstance(managedId, { name: 'Renamed' }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      writeProviderApiKey,
    });
    expect(storage.current.provider[managedId]).toMatchObject({
      name: 'Renamed',
      options: { timeout: 50 },
      models: { model: { name: 'Model' } },
    });

    const canonical = updateProviderInstance('openai', { name: 'ChatGPT Subscription' }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      writeProviderApiKey,
    });
    expect(canonical).toMatchObject({ providerId: 'openai', sourceProviderId: 'openai', managed: false, baseURL: null });
    expect(storage.current.provider.openai).toEqual({ name: 'ChatGPT Subscription' });
    expect(writeProviderApiKey).not.toHaveBeenCalled();
  });

  test('updates a canonical provider in its effective project layer', () => {
    const layers = {
      userConfig: { provider: { openai: { name: 'User OpenAI' } } },
      projectConfig: {
        provider: {
          openai: {
            name: 'Project OpenAI',
            options: { baseURL: 'https://old.project.example.test', timeout: 30 },
            models: { projectModel: { name: 'Project model' } },
          },
        },
      },
      customConfig: {},
      paths: {
        userPath: '/virtual/user/opencode.json',
        projectPath: '/virtual/project/opencode.json',
        customPath: null,
      },
    };
    const readConfigLayers = mock((workingDirectory) => {
      expect(workingDirectory).toBe('/workspace/project');
      return structuredClone(layers);
    });
    const writeConfig = mock((config, targetPath) => {
      expect(targetPath).toBe('/virtual/project/opencode.json');
      layers.projectConfig = structuredClone(config);
    });

    const updated = updateProviderInstance('openai', {
      name: 'Project Gateway',
      baseURL: 'https://gateway.project.example.test',
    }, {
      readConfigLayers,
      writeConfig,
      workingDirectory: '/workspace/project',
    });

    expect(writeConfig).toHaveBeenCalledTimes(1);
    expect(layers.userConfig.provider.openai.name).toBe('User OpenAI');
    expect(layers.projectConfig.provider.openai).toEqual({
      name: 'Project Gateway',
      options: { baseURL: 'https://gateway.project.example.test', timeout: 30 },
      models: { projectModel: { name: 'Project model' } },
    });
    expect(updated.proxy).toEqual({ mode: 'direct' });
  });

  test('treats config apiKey as effective API auth until explicit OAuth replacement', () => {
    const storage = memoryStorage({
      provider: {
        openai: {
          name: 'Config API',
          options: {
            apiKey: 'config-secret',
            baseURL: 'https://gateway.example.test/openai',
            timeout: 45,
          },
        },
      },
    });
    const auth = { openai: { type: 'oauth', access: 'oauth-secret' } };
    const writeProviderApiKey = mock((providerId, apiKey) => {
      auth[providerId] = { type: 'api', key: apiKey };
    });
    const readMetadataLayers = () => ({ mergedConfig: structuredClone(storage.current) });

    expect(getProviderConnectionMetadata('openai', undefined, {
      readConfigLayers: readMetadataLayers,
    })).toMatchObject({ authType: 'api' });

    updateProviderInstance('openai', {
      name: 'Config API renamed',
      baseURL: 'https://gateway.example.test/openai-v2',
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      writeProviderApiKey,
    });
    expect(storage.current.provider.openai.options).toEqual({
      apiKey: 'config-secret',
      baseURL: 'https://gateway.example.test/openai-v2',
      timeout: 45,
    });

    updateProviderInstance('openai', {
      name: 'ChatGPT Subscription',
      baseURL: 'https://gateway.example.test/openai-v2',
      credentialMode: 'oauth',
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      writeProviderApiKey,
    });
    expect(storage.current.provider.openai).toEqual({
      name: 'ChatGPT Subscription',
      options: { baseURL: 'https://gateway.example.test/openai-v2', timeout: 45 },
    });
    expect(auth.openai).toEqual({ type: 'oauth', access: 'oauth-secret' });
    expect(writeProviderApiKey).not.toHaveBeenCalled();
    expect(getProviderConnectionMetadata('openai', undefined, {
      readConfigLayers: readMetadataLayers,
    })).toMatchObject({ authType: null });
    expect(() => updateProviderInstance(`openai:openchamber:${UUID}`, {
      name: 'Managed OAuth',
      credentialMode: 'oauth',
    })).toThrow('Managed provider instances do not support OAuth credential mode');
  });

  test('moves an explicit PUT apiKey out of config and rolls config back if auth persistence fails', () => {
    const initial = {
      provider: {
        openai: {
          name: 'Old',
          options: { apiKey: 'old-config-secret', timeout: 30 },
        },
      },
    };
    const storage = memoryStorage(initial);
    const writeProviderApiKey = mock(() => {});
    updateProviderInstance('openai', {
      name: 'New API',
      apiKey: 'new-auth-secret',
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      writeProviderApiKey,
    });
    expect(storage.current.provider.openai).toEqual({
      name: 'New API',
      options: { timeout: 30 },
    });
    expect(writeProviderApiKey).toHaveBeenCalledWith('openai', 'new-auth-secret');

    const failingStorage = memoryStorage(initial);
    expect(() => updateProviderInstance('openai', {
      name: 'Broken API',
      apiKey: 'failed-auth-secret',
    }, {
      readConfigLayers: failingStorage.readConfigLayers,
      writeConfig: failingStorage.writeConfig,
      writeProviderApiKey: () => { throw new Error('atomic rename failed'); },
    })).toThrow('Failed to store provider credentials');
    expect(failingStorage.current).toEqual(initial);
  });
});
