import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_NPM,
  ProviderInstanceError,
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
} from './providers.js';

const SOURCE_PROVIDER = {
  id: 'anthropic',
  name: 'Anthropic',
  key: 'source-secret-must-not-be-copied',
  options: {
    apiKey: 'source-secret-must-not-be-copied',
    baseURL: 'https://source.example.test',
  },
  env: ['ANTHROPIC_API_KEY'],
  models: {
    'claude-sonnet': {
      id: 'claude-sonnet',
      providerID: 'anthropic',
      api: {
        id: 'claude-sonnet-2026',
        url: 'https://api.anthropic.com/v1',
        npm: '@ai-sdk/anthropic',
      },
      name: 'Claude Sonnet',
      family: 'claude-sonnet',
      capabilities: {
        attachment: true,
        reasoning: true,
        temperature: true,
        toolcall: true,
        interleaved: { field: 'reasoning_content' },
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
      },
      cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      limit: { context: 200_000, input: 190_000, output: 64_000 },
      status: 'active',
      options: {
        thinking: { budgetTokens: 8_000 },
        apiKey: 'nested-secret-must-not-be-copied',
        awsSecretAccessKey: 'aws-secret-must-not-be-copied',
        credentials: { password: 'credential-secret-must-not-be-copied' },
      },
      headers: {
        'anthropic-beta': 'interleaved-thinking',
        Authorization: 'Bearer source-secret-must-not-be-copied',
        Cookie: 'session=cookie-secret-must-not-be-copied',
        'x-auth-token': 'header-secret-must-not-be-copied',
      },
      release_date: '2026-01-01',
      variants: {
        high: {
          reasoningEffort: 'high',
          credentials: { token: 'variant-secret-must-not-be-copied' },
        },
      },
    },
  },
};

const UUIDS = {
  first: '11111111-1111-4111-8111-111111111111',
  second: '22222222-2222-4222-8222-222222222222',
  third: '33333333-3333-4333-8333-333333333333',
};

const createMemoryStorage = (initialUserConfig = {}) => {
  let userConfig = structuredClone(initialUserConfig);
  const writes = [];
  return {
    readConfigLayers: () => ({
      userConfig: structuredClone(userConfig),
      paths: { userPath: '/virtual/opencode.json' },
    }),
    writeConfig: (next) => {
      userConfig = structuredClone(next);
      writes.push(structuredClone(next));
    },
    get userConfig() {
      return userConfig;
    },
    writes,
  };
};

const createLayeredMemoryStorage = ({ userConfig = {}, projectConfig = {}, customConfig = {} } = {}) => {
  const layers = {
    userConfig: structuredClone(userConfig),
    projectConfig: structuredClone(projectConfig),
    customConfig: structuredClone(customConfig),
  };
  const paths = {
    userPath: '/virtual/user/opencode.json',
    projectPath: '/virtual/project/opencode.json',
    customPath: null,
  };
  const reads = [];
  const writes = [];
  return {
    readConfigLayers: (workingDirectory) => {
      reads.push(workingDirectory);
      return { ...structuredClone(layers), paths };
    },
    writeConfig: (next, targetPath) => {
      writes.push({ config: structuredClone(next), path: targetPath });
      if (targetPath === paths.projectPath) layers.projectConfig = structuredClone(next);
      else if (targetPath === paths.userPath) layers.userConfig = structuredClone(next);
      else throw new Error(`Unexpected target path: ${targetPath}`);
    },
    layers,
    reads,
    writes,
  };
};

const createMemoryProxyStorage = () => {
  const entries = new Map();
  return {
    readProviderProxy: (providerId) => entries.get(providerId) ?? { mode: 'direct' },
    writeProviderProxy: (providerId, proxy) => entries.set(providerId, structuredClone(proxy)),
    removeProviderProxy: (providerId) => entries.delete(providerId),
    entries,
  };
};

describe('managed provider instances', () => {
  it('builds a minimal OpenAI-compatible provider from the authenticated model catalog', () => {
    const modelIds = parseOpenAICompatibleModelCatalog({
      data: [
        { id: 'gpt-5.5' },
        { id: ' gpt-5.5 ' },
        { id: 'anthropic/claude-sonnet-4-6' },
        { id: 'constructor' },
        { id: 'bad\nmodel' },
        { id: '' },
        null,
      ],
    });

    expect(modelIds).toEqual(['gpt-5.5', 'anthropic/claude-sonnet-4-6']);
    const config = buildOpenAICompatibleProviderConfig(
      'Frugal Relay',
      'https://frugalrelay.me/v1',
      modelIds,
    );

    expect(config).toEqual({
      npm: OPENAI_COMPATIBLE_PROVIDER_NPM,
      name: 'Frugal Relay',
      options: { baseURL: 'https://frugalrelay.me/v1' },
      models: {
        'gpt-5.5': { name: 'gpt-5.5' },
        'anthropic/claude-sonnet-4-6': { name: 'anthropic/claude-sonnet-4-6' },
      },
    });
    expect(config).not.toHaveProperty('id');
    expect(Object.getPrototypeOf(config.models)).toBeNull();
  });

  it('rejects missing base URLs and invalid or empty OpenAI-compatible catalogs', () => {
    expect(() => validateProviderInstanceCreateInput({
      sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
      name: 'Custom gateway',
      apiKey: 'key',
    })).toThrowError(new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422));

    expect(() => parseOpenAICompatibleModelCatalog({ models: [{ id: 'model' }] }))
      .toThrowError(new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502));
    expect(() => parseOpenAICompatibleModelCatalog({ data: [{ id: '' }, { id: '__proto__' }] }))
      .toThrowError(new ProviderInstanceError('OpenAI-compatible provider has no usable models', 422));
    expect(() => parseOpenAICompatibleModelCatalog({
      data: Array.from({ length: 5_001 }, (_, index) => ({ id: `model-${index}` })),
    })).toThrowError(new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502));
  });

  it('maps the authoritative model snapshot into config schema without provider secrets', () => {
    const config = buildProviderInstanceConfig(
      SOURCE_PROVIDER,
      'Work Anthropic',
      'https://gateway.example.test/anthropic',
    );

    expect(config.id).toBe('anthropic');
    expect(config.name).toBe('Work Anthropic');
    expect(config.options).toEqual({ baseURL: 'https://gateway.example.test/anthropic' });
    expect(config).not.toHaveProperty('key');
    expect(config).not.toHaveProperty('env');
    const model = config.models['claude-sonnet'];
    expect(model).toMatchObject({
      id: 'claude-sonnet-2026',
      name: 'Claude Sonnet',
      family: 'claude-sonnet',
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      interleaved: { field: 'reasoning_content' },
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      limit: { context: 200_000, input: 190_000, output: 64_000 },
      status: 'active',
      provider: { npm: '@ai-sdk/anthropic', api: 'https://api.anthropic.com/v1' },
      release_date: '2026-01-01',
      variants: { high: { reasoningEffort: 'high' } },
    });
    expect(model.options).toEqual({ thinking: { budgetTokens: 8_000 } });
    expect(model).not.toHaveProperty('headers');
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
        url: 'https://gateway.example.test/v1?api_key=query-secret&api-version=2026-01-01',
      },
    })[1];
    const benignQueryModel = mapProviderModelToConfig('versioned-url', {
      api: { id: 'versioned-url', url: 'https://gateway.example.test/v1?api-version=2026-01-01' },
    })[1];
    expect(credentialedUrlModel.provider).toEqual({ npm: '@ai-sdk/openai-compatible' });
    expect(signedUrlModel.provider).toEqual({ npm: '@ai-sdk/openai-compatible' });
    expect(benignQueryModel.provider.api).toBe('https://gateway.example.test/v1?api-version=2026-01-01');
    expect(JSON.stringify([credentialedUrlModel, signedUrlModel])).not.toContain('embedded-secret');
    expect(JSON.stringify([credentialedUrlModel, signedUrlModel])).not.toContain('query-secret');
  });

  it('rejects prototype-pollution keys in provider, model, and variant maps', () => {
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

  it('rejects provider base URLs with fragments or sensitive query keys', () => {
    expect(validateProviderInstanceCreateInput({
      sourceProviderId: 'anthropic',
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
        sourceProviderId: 'anthropic',
        name: 'Unsafe gateway',
        baseURL,
        apiKey: 'key',
      })).toThrow();
    }
  });

  it('validates direct, system, and manual per-instance proxy settings', () => {
    expect(validateProviderInstanceCreateInput({
      sourceProviderId: 'anthropic',
      name: 'Direct',
      apiKey: 'key',
    }).proxy).toEqual({ mode: 'direct' });

    expect(validateProviderInstanceCreateInput({
      sourceProviderId: 'anthropic',
      name: 'System PAC',
      apiKey: 'key',
      proxy: { mode: 'system' },
    })).toMatchObject({ baseURL: null, proxy: { mode: 'system' } });

    expect(validateProviderInstanceCreateInput({
      sourceProviderId: 'anthropic',
      name: 'Manual',
      baseURL: 'https://gateway.example.test',
      apiKey: 'key',
      proxy: { mode: 'manual', url: 'http://localhost:9000/' },
    }).proxy).toEqual({ mode: 'manual', url: 'http://localhost:9000' });

    expect(() => validateProviderInstanceCreateInput({
      sourceProviderId: 'anthropic',
      name: 'Credentialed proxy',
      baseURL: 'https://gateway.example.test',
      apiKey: 'key',
      proxy: { mode: 'manual', url: 'http://user:secret@localhost:9000' },
    })).toThrow('Proxy URL must be an HTTP(S) origin without credentials');
    expect(() => validateProviderInstanceUpdateInput('openai', {
      name: 'Subscription via PAC',
      proxy: { mode: 'system' },
    })).toThrow('managed API-key provider instances');
  });

  it('redacts unsafe existing base URLs from connection metadata', () => {
    const readMetadata = (baseURL) => getProviderConnectionMetadata('anthropic', undefined, {
      readConfigLayers: () => ({
        mergedConfig: { provider: { anthropic: { options: { baseURL } } } },
      }),
    }).baseURL;

    expect(readMetadata('https://gateway.example.test/v1?api-version=2026-01-01'))
      .toBe('https://gateway.example.test/v1?api-version=2026-01-01');
    expect(readMetadata('https://gateway.example.test/v1#credential')).toBeNull();
    expect(readMetadata('https://gateway.example.test/v1?api_key=secret')).toBeNull();
  });

  it('allocates unique marker IDs and stores each API key under the exact alias', () => {
    const occupiedId = `anthropic:openchamber:${UUIDS.first}`;
    const storage = createMemoryStorage({ provider: { [occupiedId]: { name: 'Existing' } } });
    const auth = {};
    const randomUUID = vi.fn()
      .mockReturnValueOnce(UUIDS.first)
      .mockReturnValueOnce(UUIDS.second)
      .mockReturnValueOnce(UUIDS.third);
    const dependencies = {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      randomUUID,
      writeProviderApiKey: (providerId, apiKey) => {
        auth[providerId] = { type: 'api', key: apiKey };
      },
    };

    const first = createProviderInstance(
      { sourceProviderId: 'anthropic', name: 'First', baseURL: null, apiKey: 'key-one', sourceProvider: SOURCE_PROVIDER },
      dependencies,
    );
    const second = createProviderInstance(
      { sourceProviderId: 'anthropic', name: 'Second', baseURL: '', apiKey: 'key-two', sourceProvider: SOURCE_PROVIDER },
      dependencies,
    );

    expect(first.providerId).toBe(`anthropic:openchamber:${UUIDS.second}`);
    expect(second.providerId).toBe(`anthropic:openchamber:${UUIDS.third}`);
    expect(first.providerId).not.toBe(second.providerId);
    expect(parseManagedProviderInstanceId(first.providerId)?.sourceProviderId).toBe('anthropic');
    expect(parseManagedProviderInstanceId(`custom:provider:openchamber:${UUIDS.first}`)?.sourceProviderId)
      .toBe('custom:provider');
    expect(parseManagedProviderInstanceId(`custom:openchamber:openchamber:${UUIDS.first}`)).toBeNull();
    expect(auth).toEqual({
      [first.providerId]: { type: 'api', key: 'key-one' },
      [second.providerId]: { type: 'api', key: 'key-two' },
    });
    expect(storage.userConfig.provider[first.providerId]).toMatchObject({ id: 'anthropic', name: 'First' });
    expect(storage.userConfig.provider[second.providerId]).toMatchObject({ id: 'anthropic', name: 'Second' });
  });

  it('stores proxy settings independently for duplicate provider instances', () => {
    const storage = createMemoryStorage();
    const proxyStorage = createMemoryProxyStorage();
    const dependencies = {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      randomUUID: vi.fn().mockReturnValueOnce(UUIDS.first).mockReturnValueOnce(UUIDS.second),
      writeProviderApiKey: vi.fn(),
      ...proxyStorage,
    };

    const system = createProviderInstance({
      sourceProviderId: 'anthropic',
      name: 'Corporate PAC',
      baseURL: 'https://gateway.example.test',
      apiKey: 'key-one',
      proxy: { mode: 'system' },
      sourceProvider: SOURCE_PROVIDER,
    }, dependencies);
    const manual = createProviderInstance({
      sourceProviderId: 'anthropic',
      name: 'Local proxy',
      baseURL: 'https://gateway.example.test',
      apiKey: 'key-two',
      proxy: { mode: 'manual', url: 'http://localhost:9000' },
      sourceProvider: SOURCE_PROVIDER,
    }, dependencies);

    expect(system.proxy).toEqual({ mode: 'system' });
    expect(manual.proxy).toEqual({ mode: 'manual', url: 'http://localhost:9000' });
    expect(proxyStorage.entries.get(system.providerId)).toEqual({ mode: 'system' });
    expect(proxyStorage.entries.get(manual.providerId)).toEqual({
      mode: 'manual',
      url: 'http://localhost:9000',
    });
  });

  it('creates OpenAI-compatible aliases with minimal models and exact-ID auth', () => {
    const storage = createMemoryStorage();
    const auth = {};
    const instance = createProviderInstance({
      sourceProviderId: OPENAI_COMPATIBLE_PROVIDER_ID,
      name: 'Frugal Relay',
      baseURL: 'https://frugalrelay.me/v1',
      apiKey: 'fr-secret',
      openAICompatibleModelIds: ['gpt-5.5', 'claude-sonnet-4-6'],
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      randomUUID: () => UUIDS.first,
      writeProviderApiKey: (providerId, apiKey) => {
        auth[providerId] = { type: 'api', key: apiKey };
      },
    });

    expect(instance.providerId).toBe(`${OPENAI_COMPATIBLE_PROVIDER_ID}:openchamber:${UUIDS.first}`);
    expect(auth[instance.providerId]).toEqual({ type: 'api', key: 'fr-secret' });
    expect(storage.userConfig.provider[instance.providerId]).toEqual({
      npm: OPENAI_COMPATIBLE_PROVIDER_NPM,
      name: 'Frugal Relay',
      options: { baseURL: 'https://frugalrelay.me/v1' },
      models: {
        'gpt-5.5': { name: 'gpt-5.5' },
        'claude-sonnet-4-6': { name: 'claude-sonnet-4-6' },
      },
    });
    expect(storage.userConfig.provider[instance.providerId]).not.toHaveProperty('id');
  });

  it('keeps OpenAI-compatible name-only updates offline-safe and atomically replaces refreshed models', () => {
    const providerId = `${OPENAI_COMPATIBLE_PROVIDER_ID}:openchamber:${UUIDS.first}`;
    const initial = {
      provider: {
        [providerId]: {
          npm: OPENAI_COMPATIBLE_PROVIDER_NPM,
          name: 'Old Gateway',
          options: { baseURL: 'https://old.example.test/v1', timeout: 30 },
          models: { old: { name: 'old' } },
        },
      },
    };
    const storage = createMemoryStorage(initial);
    const writeProviderApiKey = vi.fn();

    updateProviderInstance(providerId, { name: 'Renamed Gateway' }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      writeProviderApiKey,
    });
    expect(storage.userConfig.provider[providerId]).toEqual({
      npm: OPENAI_COMPATIBLE_PROVIDER_NPM,
      name: 'Renamed Gateway',
      options: { baseURL: 'https://old.example.test/v1', timeout: 30 },
      models: { old: { name: 'old' } },
    });
    expect(writeProviderApiKey).not.toHaveBeenCalled();

    updateProviderInstance(providerId, {
      name: 'New Gateway',
      baseURL: 'https://new.example.test/v1',
      apiKey: 'new-secret',
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      writeProviderApiKey,
      openAICompatibleModelIds: ['new/model', 'other-model'],
    });
    expect(storage.userConfig.provider[providerId]).toEqual({
      npm: OPENAI_COMPATIBLE_PROVIDER_NPM,
      name: 'New Gateway',
      options: { baseURL: 'https://new.example.test/v1', timeout: 30 },
      models: {
        'new/model': { name: 'new/model' },
        'other-model': { name: 'other-model' },
      },
    });
    expect(storage.userConfig.provider[providerId]).not.toHaveProperty('id');
    expect(writeProviderApiKey).toHaveBeenCalledWith(providerId, 'new-secret');

    const failingStorage = createMemoryStorage(initial);
    expect(() => updateProviderInstance(providerId, {
      name: 'Broken Gateway',
      baseURL: 'https://broken.example.test/v1',
      apiKey: 'failed-secret',
    }, {
      readConfigLayers: failingStorage.readConfigLayers,
      writeConfig: failingStorage.writeConfig,
      writeProviderApiKey: () => { throw new Error('auth write failed'); },
      openAICompatibleModelIds: ['replacement'],
    })).toThrow('Failed to store provider credentials');
    expect(failingStorage.userConfig).toEqual(initial);
  });

  it('rolls back the user config when credential persistence fails', () => {
    const initial = { $schema: 'https://opencode.ai/config.json', provider: { keep: { name: 'Keep me' } } };
    const storage = createMemoryStorage(initial);

    expect(() => createProviderInstance(
      { sourceProviderId: 'anthropic', name: 'Broken', apiKey: 'not-logged', sourceProvider: SOURCE_PROVIDER },
      {
        readConfigLayers: storage.readConfigLayers,
        writeConfig: storage.writeConfig,
        randomUUID: () => UUIDS.first,
        writeProviderApiKey: () => { throw new Error('disk full'); },
      },
    )).toThrowError(new ProviderInstanceError('Failed to store provider credentials', 500));
    expect(storage.userConfig).toEqual(initial);
    expect(storage.writes).toHaveLength(2);
  });

  it('preserves model fields, clears only baseURL, and supports canonical OAuth overrides', () => {
    const managedId = `anthropic:openchamber:${UUIDS.first}`;
    const storage = createMemoryStorage({
      provider: {
        [managedId]: {
          id: 'anthropic',
          name: 'Old',
          npm: '@ai-sdk/anthropic',
          options: { baseURL: 'https://old.example.test', timeout: 42 },
          models: { model: { name: 'Model' } },
        },
      },
    });
    const writeProviderApiKey = vi.fn();

    const managed = updateProviderInstance(
      managedId,
      { name: 'Renamed' },
      { readConfigLayers: storage.readConfigLayers, writeConfig: storage.writeConfig, writeProviderApiKey },
    );
    expect(managed).toMatchObject({ managed: true, name: 'Renamed', baseURL: null });
    expect(storage.userConfig.provider[managedId]).toEqual({
      id: 'anthropic',
      name: 'Renamed',
      npm: '@ai-sdk/anthropic',
      options: { timeout: 42 },
      models: { model: { name: 'Model' } },
    });
    expect(writeProviderApiKey).not.toHaveBeenCalled();

    const canonical = updateProviderInstance(
      'openai',
      { name: 'ChatGPT Subscription', baseURL: 'https://gateway.example.test/openai' },
      { readConfigLayers: storage.readConfigLayers, writeConfig: storage.writeConfig, writeProviderApiKey },
    );
    expect(canonical).toEqual({
      id: 'openai',
      providerId: 'openai',
      sourceProviderId: 'openai',
      name: 'ChatGPT Subscription',
      baseURL: 'https://gateway.example.test/openai',
      managed: false,
      proxy: { mode: 'direct' },
    });
    expect(storage.userConfig.provider.openai).toEqual({
      name: 'ChatGPT Subscription',
      options: { baseURL: 'https://gateway.example.test/openai' },
    });
    expect(writeProviderApiKey).not.toHaveBeenCalled();
  });

  it('updates a canonical provider in its effective project layer', () => {
    const storage = createLayeredMemoryStorage({
      userConfig: {
        provider: { openai: { name: 'User OpenAI', options: { timeout: 10 } } },
      },
      projectConfig: {
        provider: {
          openai: {
            name: 'Project OpenAI',
            options: { baseURL: 'https://old.project.example.test', timeout: 30 },
            models: { projectModel: { name: 'Project model' } },
          },
        },
      },
    });

    const instance = updateProviderInstance(
      'openai',
      { name: 'Project Gateway', baseURL: 'https://gateway.project.example.test' },
      {
        readConfigLayers: storage.readConfigLayers,
        writeConfig: storage.writeConfig,
        workingDirectory: '/workspace/project',
      },
    );

    expect(instance).toMatchObject({ name: 'Project Gateway', managed: false });
    expect(storage.reads).toEqual(['/workspace/project']);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0].path).toBe('/virtual/project/opencode.json');
    expect(storage.layers.userConfig.provider.openai.name).toBe('User OpenAI');
    expect(storage.layers.projectConfig.provider.openai).toEqual({
      name: 'Project Gateway',
      options: { baseURL: 'https://gateway.project.example.test', timeout: 30 },
      models: { projectModel: { name: 'Project model' } },
    });
  });

  it('treats config apiKey as effective API auth until explicit OAuth replacement', () => {
    const storage = createMemoryStorage({
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
    const writeProviderApiKey = vi.fn((providerId, apiKey) => {
      auth[providerId] = { type: 'api', key: apiKey };
    });
    const readMetadataLayers = () => ({ mergedConfig: structuredClone(storage.userConfig) });

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
    expect(storage.userConfig.provider.openai.options).toEqual({
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
    expect(storage.userConfig.provider.openai).toEqual({
      name: 'ChatGPT Subscription',
      options: { baseURL: 'https://gateway.example.test/openai-v2', timeout: 45 },
    });
    expect(auth.openai).toEqual({ type: 'oauth', access: 'oauth-secret' });
    expect(writeProviderApiKey).not.toHaveBeenCalled();
    expect(getProviderConnectionMetadata('openai', undefined, {
      readConfigLayers: readMetadataLayers,
    })).toMatchObject({ authType: null });

    const managedId = `openai:openchamber:${UUIDS.first}`;
    expect(() => updateProviderInstance(managedId, {
      name: 'Managed OAuth',
      credentialMode: 'oauth',
    })).toThrow('Managed provider instances do not support OAuth credential mode');
  });

  it('moves an explicit PUT apiKey out of config and rolls config back if auth persistence fails', () => {
    const initial = {
      provider: {
        openai: {
          name: 'Old',
          options: { apiKey: 'old-config-secret', timeout: 30 },
        },
      },
    };
    const storage = createMemoryStorage(initial);
    const auth = { openai: { type: 'oauth', access: 'oauth-secret' } };
    const writeProviderApiKey = vi.fn((providerId, apiKey) => {
      auth[providerId] = { type: 'api', key: apiKey };
    });

    updateProviderInstance('openai', {
      name: 'New API',
      apiKey: 'new-auth-secret',
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      writeProviderApiKey,
    });
    expect(storage.userConfig.provider.openai).toEqual({
      name: 'New API',
      options: { timeout: 30 },
    });
    expect(auth.openai).toEqual({ type: 'api', key: 'new-auth-secret' });

    const failingStorage = createMemoryStorage(initial);
    expect(() => updateProviderInstance('openai', {
      name: 'Broken API',
      apiKey: 'failed-auth-secret',
    }, {
      readConfigLayers: failingStorage.readConfigLayers,
      writeConfig: failingStorage.writeConfig,
      writeProviderApiKey: () => { throw new Error('atomic rename failed'); },
    })).toThrow('Failed to store provider credentials');
    expect(failingStorage.userConfig).toEqual(initial);
  });

  it('updates, reads, clears, and rolls back managed proxy settings', () => {
    const providerId = `anthropic:openchamber:${UUIDS.first}`;
    const initial = {
      provider: {
        [providerId]: {
          id: 'anthropic',
          name: 'Gateway',
          options: { baseURL: 'https://gateway.example.test' },
          models: { model: { name: 'Model' } },
        },
      },
    };
    const storage = createMemoryStorage(initial);
    const proxyStorage = createMemoryProxyStorage();

    const updated = updateProviderInstance(providerId, {
      name: 'Gateway via PAC',
      baseURL: 'https://gateway.example.test',
      proxy: { mode: 'system' },
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      ...proxyStorage,
    });
    expect(updated.proxy).toEqual({ mode: 'system' });
    expect(getProviderConnectionMetadata(providerId, undefined, {
      readConfigLayers: () => ({ mergedConfig: structuredClone(storage.userConfig) }),
      readProviderProxy: proxyStorage.readProviderProxy,
    }).proxy).toEqual({ mode: 'system' });

    updateProviderInstance(providerId, {
      name: 'Gateway direct',
      baseURL: 'https://gateway.example.test',
      proxy: { mode: 'direct' },
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: storage.writeConfig,
      ...proxyStorage,
    });
    expect(proxyStorage.entries.has(providerId)).toBe(false);

    proxyStorage.writeProviderProxy(providerId, { mode: 'system' });
    expect(() => updateProviderInstance(providerId, {
      name: 'Broken update',
      baseURL: 'https://gateway.example.test',
      proxy: { mode: 'manual', url: 'http://localhost:9000' },
    }, {
      readConfigLayers: storage.readConfigLayers,
      writeConfig: () => { throw new Error('config write failed'); },
      ...proxyStorage,
    })).toThrow('config write failed');
    expect(proxyStorage.entries.get(providerId)).toEqual({ mode: 'system' });
  });

  it('rejects malformed IDs, empty keys, and non-HTTP or credentialed base URLs', () => {
    expect(validateProviderInstanceCreateInput({
      sourceProviderId: 'custom:provider',
      name: 'Custom',
      apiKey: 'key',
    }).sourceProviderId).toBe('custom:provider');
    expect(() => validateProviderInstanceCreateInput({
      sourceProviderId: '../anthropic',
      name: 'Bad',
      apiKey: 'key',
    })).toThrow('Invalid source provider ID');
    expect(() => validateProviderInstanceCreateInput({
      sourceProviderId: 'custom:openchamber',
      name: 'Ambiguous',
      apiKey: 'key',
    })).toThrow('Invalid source provider ID');
    expect(() => validateProviderInstanceCreateInput({
      sourceProviderId: 'anthropic',
      name: 'Bad',
      apiKey: '   ',
    })).toThrow('API key is required');
    expect(() => validateProviderInstanceCreateInput({
      sourceProviderId: 'anthropic',
      name: 'Bad',
      apiKey: 'key',
      baseURL: 'file:///tmp/gateway',
    })).toThrow('Base URL must be an HTTP(S) URL without embedded credentials');
    expect(() => validateProviderInstanceCreateInput({
      sourceProviderId: 'anthropic',
      name: 'Bad',
      apiKey: 'key',
      baseURL: 'https://user:password@gateway.example.test',
    })).toThrow('Base URL must be an HTTP(S) URL without embedded credentials');
  });
});
