import {
  CONFIG_FILE,
  readConfigLayers,
  isPlainObject,
  writeConfig,
} from './shared.js';

const MANAGED_PROVIDER_INSTANCE_MARKER = 'openchamber';
const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';
const OPENAI_COMPATIBLE_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const SOURCE_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._:@-]{0,127}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_PROVIDER_NAME_LENGTH = 120;
const MAX_API_KEY_LENGTH = 16_384;
const MAX_OPENAI_COMPATIBLE_MODEL_ID_LENGTH = 512;
const MAX_OPENAI_COMPATIBLE_MODELS = 5_000;
const PROVIDER_PROXY_MODES = new Set(['direct', 'system', 'manual']);
const DIRECT_PROVIDER_PROXY = Object.freeze({ mode: 'direct' });
const UNSAFE_CONFIG_MAP_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_MODEL_OPTION_KEYS = new Set([
  'includeThoughts',
  'maxOutputTokens',
  'maxTokens',
  'reasoningEffort',
  'reasoningSummary',
  'serviceTier',
  'temperature',
  'textVerbosity',
  'thinkingBudget',
  'thinkingLevel',
  'topK',
  'topP',
  'useCompletionUrls',
  'workflowRef',
]);
const SENSITIVE_URL_QUERY_KEY_PATTERN = /(?:apikey|accesskey|token|secret|password|credential|signature|authorization|^auth$|^key$|^code$)/;

class ProviderInstanceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProviderInstanceError';
    this.status = status;
  }
}

const normalizeOptionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

const normalizeFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

const isSafeConfigMapKey = (value) => (
  typeof value === 'string' && !UNSAFE_CONFIG_MAP_KEYS.has(value.toLowerCase())
);

const normalizeModelProviderApiUrl = (value) => {
  const apiUrl = normalizeOptionalString(value);
  if (!apiUrl || CONTROL_CHARACTER_PATTERN.test(apiUrl)) return null;
  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    return null;
  }
  for (const key of parsed.searchParams.keys()) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SENSITIVE_URL_QUERY_KEY_PATTERN.test(normalizedKey)) return null;
  }
  return apiUrl;
};

const normalizeSourceProviderId = (value) => {
  const providerId = typeof value === 'string' ? value.trim() : '';
  if (
    !SOURCE_PROVIDER_ID_PATTERN.test(providerId)
    || !isSafeConfigMapKey(providerId)
    || providerId.includes(`:${MANAGED_PROVIDER_INSTANCE_MARKER}:`)
    || providerId.endsWith(`:${MANAGED_PROVIDER_INSTANCE_MARKER}`)
  ) {
    throw new ProviderInstanceError('Invalid source provider ID');
  }
  return providerId;
};

const parseManagedProviderInstanceId = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const providerId = value.trim();
  const marker = `:${MANAGED_PROVIDER_INSTANCE_MARKER}:`;
  const markerIndex = providerId.lastIndexOf(marker);
  if (markerIndex <= 0 || providerId.indexOf(marker) !== markerIndex) {
    return null;
  }
  const sourceProviderId = providerId.slice(0, markerIndex);
  const instanceUuid = providerId.slice(markerIndex + marker.length);
  if (
    !SOURCE_PROVIDER_ID_PATTERN.test(sourceProviderId)
    || !isSafeConfigMapKey(sourceProviderId)
    || sourceProviderId.includes(marker)
    || !UUID_PATTERN.test(instanceUuid)
  ) {
    return null;
  }
  return { providerId, sourceProviderId, instanceUuid };
};

const normalizeProviderInstanceTargetId = (value) => {
  const parsed = parseManagedProviderInstanceId(value);
  if (parsed) {
    return { ...parsed, managed: true };
  }
  const sourceProviderId = normalizeSourceProviderId(value);
  return {
    providerId: sourceProviderId,
    sourceProviderId,
    instanceUuid: null,
    managed: false,
  };
};

const normalizeProviderInstanceName = (value) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) {
    throw new ProviderInstanceError('Provider name is required');
  }
  if (name.length > MAX_PROVIDER_NAME_LENGTH || CONTROL_CHARACTER_PATTERN.test(name)) {
    throw new ProviderInstanceError('Provider name is invalid');
  }
  return name;
};

const normalizeProviderInstanceApiKey = (value, required) => {
  if (value === undefined && !required) {
    return undefined;
  }
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!apiKey) {
    throw new ProviderInstanceError('API key is required');
  }
  if (apiKey.length > MAX_API_KEY_LENGTH || CONTROL_CHARACTER_PATTERN.test(apiKey)) {
    throw new ProviderInstanceError('API key is invalid');
  }
  return apiKey;
};

const normalizeProviderCredentialMode = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (value !== 'oauth') {
    throw new ProviderInstanceError('Credential mode is invalid');
  }
  return value;
};

const normalizeProviderInstanceBaseURL = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ProviderInstanceError('Base URL must be an HTTP(S) URL');
  }
  const baseURL = value.trim();
  if (!baseURL) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new ProviderInstanceError('Base URL must be an HTTP(S) URL');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw new ProviderInstanceError('Base URL must be an HTTP(S) URL without embedded credentials or fragments');
  }
  for (const key of parsed.searchParams.keys()) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SENSITIVE_URL_QUERY_KEY_PATTERN.test(normalizedKey)) {
      throw new ProviderInstanceError('Base URL must not contain sensitive query parameters');
    }
  }
  return baseURL;
};

const normalizeProviderInstanceProxy = (value) => {
  if (value === undefined || value === null) {
    return { ...DIRECT_PROVIDER_PROXY };
  }
  if (!isPlainObject(value) || !PROVIDER_PROXY_MODES.has(value.mode)) {
    throw new ProviderInstanceError('Proxy setting is invalid');
  }

  if (value.mode === 'direct' || value.mode === 'system') {
    if (value.url !== undefined && value.url !== null && value.url !== '') {
      throw new ProviderInstanceError('Proxy URL is only supported in manual mode');
    }
    return { mode: value.mode };
  }

  if (typeof value.url !== 'string' || !value.url.trim()) {
    throw new ProviderInstanceError('Manual proxy requires a Proxy URL', 422);
  }
  let parsed;
  try {
    parsed = new URL(value.url.trim());
  } catch {
    throw new ProviderInstanceError('Proxy URL must be an HTTP(S) origin');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
    || (parsed.pathname && parsed.pathname !== '/')
  ) {
    throw new ProviderInstanceError('Proxy URL must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  return { mode: 'manual', url: parsed.origin };
};

const validateProviderInstanceCreateInput = (value) => {
  if (!isPlainObject(value)) {
    throw new ProviderInstanceError('Request body must be a JSON object');
  }
  const sourceProviderId = normalizeSourceProviderId(value.sourceProviderId);
  const baseURL = normalizeProviderInstanceBaseURL(value.baseURL);
  const proxy = normalizeProviderInstanceProxy(value.proxy);
  if (sourceProviderId === OPENAI_COMPATIBLE_PROVIDER_ID && !baseURL) {
    throw new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422);
  }
  return {
    sourceProviderId,
    name: normalizeProviderInstanceName(value.name),
    baseURL,
    apiKey: normalizeProviderInstanceApiKey(value.apiKey, true),
    proxy,
  };
};

const validateProviderInstanceUpdateInput = (providerId, value) => {
  if (!isPlainObject(value)) {
    throw new ProviderInstanceError('Request body must be a JSON object');
  }
  const target = normalizeProviderInstanceTargetId(providerId);
  const apiKey = normalizeProviderInstanceApiKey(value.apiKey, false);
  const credentialMode = normalizeProviderCredentialMode(value.credentialMode);
  const proxyProvided = Object.prototype.hasOwnProperty.call(value, 'proxy');
  const proxy = proxyProvided ? normalizeProviderInstanceProxy(value.proxy) : undefined;
  if (apiKey !== undefined && credentialMode) {
    throw new ProviderInstanceError('API key and OAuth credential mode cannot be combined');
  }
  if (target.managed && credentialMode === 'oauth') {
    throw new ProviderInstanceError('Managed provider instances do not support OAuth credential mode');
  }
  if (!target.managed && proxy?.mode !== undefined && proxy.mode !== 'direct') {
    throw new ProviderInstanceError('Proxy settings are only supported for managed API-key provider instances', 422);
  }
  return {
    ...target,
    name: normalizeProviderInstanceName(value.name),
    baseURL: normalizeProviderInstanceBaseURL(value.baseURL),
    baseURLProvided: Object.prototype.hasOwnProperty.call(value, 'baseURL'),
    apiKey,
    credentialMode,
    proxy,
    proxyProvided,
  };
};

const normalizeOpenAICompatibleModelId = (value) => {
  const modelId = normalizeOptionalString(value);
  if (
    !modelId
    || modelId.length > MAX_OPENAI_COMPATIBLE_MODEL_ID_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(modelId)
    || !isSafeConfigMapKey(modelId)
  ) {
    return null;
  }
  return modelId;
};

const parseOpenAICompatibleModelCatalog = (payload) => {
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
    throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
  }
  if (payload.data.length > MAX_OPENAI_COMPATIBLE_MODELS) {
    throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
  }

  const seen = new Set();
  const modelIds = [];
  for (const entry of payload.data) {
    if (!isPlainObject(entry)) continue;
    const modelId = normalizeOpenAICompatibleModelId(entry.id);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }

  if (modelIds.length === 0) {
    throw new ProviderInstanceError('OpenAI-compatible provider has no usable models', 422);
  }
  return modelIds;
};

const buildOpenAICompatibleProviderConfig = (name, baseURL, modelIds) => {
  const normalizedBaseURL = normalizeProviderInstanceBaseURL(baseURL);
  if (!normalizedBaseURL) {
    throw new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422);
  }
  if (!Array.isArray(modelIds) || modelIds.length > MAX_OPENAI_COMPATIBLE_MODELS) {
    throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
  }

  const models = Object.create(null);
  for (const value of modelIds) {
    const modelId = normalizeOpenAICompatibleModelId(value);
    if (modelId && !Object.prototype.hasOwnProperty.call(models, modelId)) {
      models[modelId] = { name: modelId };
    }
  }
  if (Object.keys(models).length === 0) {
    throw new ProviderInstanceError('OpenAI-compatible provider has no usable models', 422);
  }

  return {
    npm: OPENAI_COMPATIBLE_PROVIDER_NPM,
    name: normalizeProviderInstanceName(name),
    options: { baseURL: normalizedBaseURL },
    models,
  };
};

const providerCatalogEntries = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isPlainObject(payload) && Array.isArray(payload.all)) {
    return payload.all;
  }
  if (isPlainObject(payload) && Array.isArray(payload.providers)) {
    return payload.providers;
  }
  throw new ProviderInstanceError('OpenCode returned an invalid provider catalog', 502);
};

const findSourceProvider = (payload, sourceProviderId) => {
  const normalizedProviderId = normalizeSourceProviderId(sourceProviderId);
  const sourceProvider = providerCatalogEntries(payload).find((entry) => (
    isPlainObject(entry) && entry.id === normalizedProviderId
  ));
  if (!sourceProvider) {
    throw new ProviderInstanceError('Source provider was not found', 404);
  }
  return sourceProvider;
};

const mapModalities = (value) => {
  if (!isPlainObject(value)) {
    return [];
  }
  return ['text', 'audio', 'image', 'video', 'pdf'].filter((key) => value[key] === true);
};

const mapSafeModelOptions = (value) => {
  if (!isPlainObject(value)) return null;

  const options = {};
  for (const key of SAFE_MODEL_OPTION_KEYS) {
    const entry = value[key];
    if (
      typeof entry === 'string'
      || typeof entry === 'boolean'
      || (typeof entry === 'number' && Number.isFinite(entry))
    ) {
      options[key] = entry;
    }
  }

  if (isPlainObject(value.thinking)) {
    const thinking = {};
    if (typeof value.thinking.type === 'string') thinking.type = value.thinking.type;
    if (Number.isFinite(value.thinking.budgetTokens)) thinking.budgetTokens = value.thinking.budgetTokens;
    if (Object.keys(thinking).length > 0) options.thinking = thinking;
  }

  if (isPlainObject(value.thinkingConfig)) {
    const thinkingConfig = {};
    if (Number.isFinite(value.thinkingConfig.thinkingBudget)) {
      thinkingConfig.thinkingBudget = value.thinkingConfig.thinkingBudget;
    }
    if (typeof value.thinkingConfig.includeThoughts === 'boolean') {
      thinkingConfig.includeThoughts = value.thinkingConfig.includeThoughts;
    }
    if (typeof value.thinkingConfig.thinkingLevel === 'string') {
      thinkingConfig.thinkingLevel = value.thinkingConfig.thinkingLevel;
    }
    if (Object.keys(thinkingConfig).length > 0) options.thinkingConfig = thinkingConfig;
  }

  return Object.keys(options).length > 0 ? options : null;
};

const mapSafeModelVariants = (value) => {
  if (!isPlainObject(value)) return null;
  const variants = Object.create(null);
  for (const [variantName, variant] of Object.entries(value)) {
    if (
      !variantName
      || variantName.length > 120
      || CONTROL_CHARACTER_PATTERN.test(variantName)
      || !isSafeConfigMapKey(variantName)
      || !isPlainObject(variant)
    ) {
      continue;
    }
    const mapped = mapSafeModelOptions(variant) || {};
    if (typeof variant.disabled === 'boolean') mapped.disabled = variant.disabled;
    if (Object.keys(mapped).length > 0) variants[variantName] = mapped;
  }
  return Object.keys(variants).length > 0 ? variants : null;
};

const mapProviderModelToConfig = (modelId, value) => {
  if (!isPlainObject(value)) {
    return null;
  }
  const runtimeModelId = normalizeOptionalString(modelId);
  if (
    !runtimeModelId
    || CONTROL_CHARACTER_PATTERN.test(runtimeModelId)
    || !isSafeConfigMapKey(runtimeModelId)
  ) {
    return null;
  }

  const model = {};
  const api = isPlainObject(value.api) ? value.api : {};
  const apiId = normalizeOptionalString(api.id);
  if (apiId) model.id = apiId;

  const name = normalizeOptionalString(value.name);
  if (name) model.name = name;
  const family = normalizeOptionalString(value.family);
  if (family) model.family = family;
  if (typeof value.release_date === 'string') model.release_date = value.release_date;

  const capabilities = isPlainObject(value.capabilities) ? value.capabilities : {};
  if (typeof capabilities.attachment === 'boolean') model.attachment = capabilities.attachment;
  if (typeof capabilities.reasoning === 'boolean') model.reasoning = capabilities.reasoning;
  if (typeof capabilities.temperature === 'boolean') model.temperature = capabilities.temperature;
  if (typeof capabilities.toolcall === 'boolean') model.tool_call = capabilities.toolcall;
  if (capabilities.interleaved === true) {
    model.interleaved = true;
  } else if (
    isPlainObject(capabilities.interleaved)
    && ['reasoning', 'reasoning_content', 'reasoning_details'].includes(capabilities.interleaved.field)
  ) {
    model.interleaved = { field: capabilities.interleaved.field };
  }
  model.modalities = {
    input: mapModalities(capabilities.input),
    output: mapModalities(capabilities.output),
  };

  const inputCost = normalizeFiniteNumber(value.cost?.input);
  const outputCost = normalizeFiniteNumber(value.cost?.output);
  if (inputCost !== null && outputCost !== null) {
    model.cost = { input: inputCost, output: outputCost };
    const cacheRead = normalizeFiniteNumber(value.cost?.cache?.read);
    const cacheWrite = normalizeFiniteNumber(value.cost?.cache?.write);
    if (cacheRead !== null) model.cost.cache_read = cacheRead;
    if (cacheWrite !== null) model.cost.cache_write = cacheWrite;
  }

  const contextLimit = normalizeFiniteNumber(value.limit?.context);
  const outputLimit = normalizeFiniteNumber(value.limit?.output);
  if (contextLimit !== null && outputLimit !== null) {
    model.limit = { context: contextLimit, output: outputLimit };
    const inputLimit = normalizeFiniteNumber(value.limit?.input);
    if (inputLimit !== null) model.limit.input = inputLimit;
  }

  if (['alpha', 'beta', 'deprecated', 'active'].includes(value.status)) {
    model.status = value.status;
  }

  const provider = {};
  const npm = normalizeOptionalString(api.npm);
  const providerApi = normalizeModelProviderApiUrl(api.url);
  if (npm) provider.npm = npm;
  if (providerApi) provider.api = providerApi;
  if (Object.keys(provider).length > 0) model.provider = provider;

  const options = mapSafeModelOptions(value.options);
  if (options) model.options = options;
  const variants = mapSafeModelVariants(value.variants);
  if (variants) model.variants = variants;

  return [runtimeModelId, model];
};

const buildProviderInstanceConfig = (sourceProvider, name, baseURL) => {
  if (!isPlainObject(sourceProvider) || !isPlainObject(sourceProvider.models)) {
    throw new ProviderInstanceError('Source provider has no model catalog', 422);
  }
  const sourceProviderId = normalizeSourceProviderId(sourceProvider.id);

  const models = Object.create(null);
  for (const [modelId, model] of Object.entries(sourceProvider.models)) {
    const mapped = mapProviderModelToConfig(modelId, model);
    if (mapped) {
      models[mapped[0]] = mapped[1];
    }
  }
  if (Object.keys(models).length === 0) {
    throw new ProviderInstanceError('Source provider has no usable models', 422);
  }

  return {
    id: sourceProviderId,
    name: normalizeProviderInstanceName(name),
    ...(baseURL ? { options: { baseURL } } : {}),
    models,
  };
};

const buildProviderInstanceMetadata = (
  providerId,
  sourceProviderId,
  providerConfig,
  managed = true,
  proxy = DIRECT_PROVIDER_PROXY,
) => ({
  id: providerId,
  providerId,
  sourceProviderId,
  name: normalizeOptionalString(providerConfig?.name) || providerId,
  baseURL: normalizeOptionalString(providerConfig?.options?.baseURL),
  managed,
  proxy: normalizeProviderInstanceProxy(proxy),
});

const resolveProviderInstanceDependencies = (overrides = {}) => ({
  readConfigLayers: overrides.readConfigLayers || readConfigLayers,
  writeConfig: overrides.writeConfig || writeConfig,
  randomUUID: overrides.randomUUID,
  writeProviderApiKey: overrides.writeProviderApiKey,
  readProviderProxy: overrides.readProviderProxy,
  writeProviderProxy: overrides.writeProviderProxy,
  removeProviderProxy: overrides.removeProviderProxy,
  workingDirectory: overrides.workingDirectory,
});

const getProviderLayerEntry = (config, providerId) => {
  for (const sectionKey of ['provider', 'providers']) {
    const section = isPlainObject(config?.[sectionKey]) ? config[sectionKey] : {};
    if (isPlainObject(section[providerId])) {
      return { sectionKey, providerConfig: section[providerId] };
    }
  }
  return null;
};

const resolveCanonicalProviderWriteTarget = (layers, providerId) => {
  const candidates = [
    { config: layers.customConfig, path: layers.paths.customPath },
    { config: layers.projectConfig, path: layers.paths.projectPath },
    { config: layers.userConfig, path: layers.paths.userPath },
  ];
  for (const candidate of candidates) {
    const entry = getProviderLayerEntry(candidate.config, providerId);
    if (entry) {
      if (!candidate.path) {
        throw new ProviderInstanceError('Provider configuration source is unavailable', 500);
      }
      return { ...candidate, ...entry };
    }
  }
  return {
    config: layers.userConfig,
    path: layers.paths.userPath || CONFIG_FILE,
    sectionKey: 'provider',
    providerConfig: {},
  };
};

const writeUserProviderConfig = (config, providerId, providerConfig) => {
  const providers = isPlainObject(config.provider) ? config.provider : {};
  return {
    ...config,
    provider: {
      ...providers,
      [providerId]: providerConfig,
    },
  };
};

const readProviderProxySetting = (dependencies, providerId) => {
  if (typeof dependencies.readProviderProxy !== 'function') {
    return { ...DIRECT_PROVIDER_PROXY };
  }
  return normalizeProviderInstanceProxy(dependencies.readProviderProxy(providerId));
};

const persistProviderProxy = (dependencies, providerId, proxy) => {
  if (proxy.mode === 'direct') {
    if (typeof dependencies.removeProviderProxy !== 'function') {
      throw new ProviderInstanceError('Provider proxy storage is unavailable', 500);
    }
    dependencies.removeProviderProxy(providerId);
    return;
  }
  if (typeof dependencies.writeProviderProxy !== 'function') {
    throw new ProviderInstanceError('Provider proxy storage is unavailable', 500);
  }
  dependencies.writeProviderProxy(providerId, proxy);
};

const restoreProviderProxy = (dependencies, providerId, proxy) => {
  if (proxy.mode === 'direct') {
    if (typeof dependencies.removeProviderProxy !== 'function') {
      throw new ProviderInstanceError('Provider proxy storage is unavailable', 500);
    }
    dependencies.removeProviderProxy(providerId);
    return;
  }
  if (typeof dependencies.writeProviderProxy !== 'function') {
    throw new ProviderInstanceError('Provider proxy storage is unavailable', 500);
  }
  dependencies.writeProviderProxy(providerId, proxy);
};

const createProviderInstance = (input, dependencyOverrides = {}) => {
  const normalized = validateProviderInstanceCreateInput(input);
  let providerConfig;
  if (normalized.sourceProviderId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    providerConfig = buildOpenAICompatibleProviderConfig(
      normalized.name,
      normalized.baseURL,
      input.openAICompatibleModelIds,
    );
  } else {
    const sourceProvider = input.sourceProvider;
    if (!isPlainObject(sourceProvider) || sourceProvider.id !== normalized.sourceProviderId) {
      throw new ProviderInstanceError('Source provider was not found', 404);
    }
    providerConfig = buildProviderInstanceConfig(sourceProvider, normalized.name, normalized.baseURL);
  }
  const dependencies = resolveProviderInstanceDependencies(dependencyOverrides);
  if (typeof dependencies.randomUUID !== 'function' || typeof dependencies.writeProviderApiKey !== 'function') {
    throw new ProviderInstanceError('Provider instance storage is unavailable', 500);
  }

  const layers = dependencies.readConfigLayers();
  const originalUserConfig = layers.userConfig;
  const existingProviders = isPlainObject(originalUserConfig.provider) ? originalUserConfig.provider : {};
  const existingProviderAliases = isPlainObject(originalUserConfig.providers) ? originalUserConfig.providers : {};
  let providerId = '';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `${normalized.sourceProviderId}:${MANAGED_PROVIDER_INSTANCE_MARKER}:${dependencies.randomUUID()}`;
    if (!existingProviders[candidate] && !existingProviderAliases[candidate]) {
      providerId = candidate;
      break;
    }
  }
  if (!parseManagedProviderInstanceId(providerId)) {
    throw new ProviderInstanceError('Failed to allocate a unique provider instance ID', 500);
  }

  const nextUserConfig = writeUserProviderConfig(originalUserConfig, providerId, providerConfig);
  let proxyStored = false;
  if (normalized.proxy.mode !== 'direct') {
    if (
      typeof dependencies.writeProviderProxy !== 'function'
      || typeof dependencies.removeProviderProxy !== 'function'
    ) {
      throw new ProviderInstanceError('Provider proxy storage is unavailable', 500);
    }
    try {
      persistProviderProxy(dependencies, providerId, normalized.proxy);
      proxyStored = true;
    } catch (error) {
      if (error instanceof ProviderInstanceError) throw error;
      throw new ProviderInstanceError('Failed to store provider proxy settings', 500);
    }
  }
  try {
    dependencies.writeConfig(nextUserConfig, layers.paths.userPath || CONFIG_FILE);
  } catch (error) {
    if (proxyStored) {
      try {
        dependencies.removeProviderProxy?.(providerId);
      } catch {
        throw new ProviderInstanceError('Failed to store provider configuration and roll back provider proxy settings', 500);
      }
    }
    throw error;
  }
  try {
    dependencies.writeProviderApiKey(providerId, normalized.apiKey);
  } catch {
    try {
      dependencies.writeConfig(originalUserConfig, layers.paths.userPath || CONFIG_FILE);
      if (proxyStored) dependencies.removeProviderProxy?.(providerId);
    } catch {
      throw new ProviderInstanceError('Failed to store provider credentials and roll back provider configuration or proxy settings', 500);
    }
    throw new ProviderInstanceError('Failed to store provider credentials', 500);
  }

  return buildProviderInstanceMetadata(
    providerId,
    normalized.sourceProviderId,
    providerConfig,
    true,
    normalized.proxy,
  );
};

const updateProviderInstance = (providerId, input, dependencyOverrides = {}) => {
  const normalized = validateProviderInstanceUpdateInput(providerId, input);
  const dependencies = resolveProviderInstanceDependencies(dependencyOverrides);
  if (normalized.apiKey !== undefined && typeof dependencies.writeProviderApiKey !== 'function') {
    throw new ProviderInstanceError('Provider credential storage is unavailable', 500);
  }

  const layers = dependencies.readConfigLayers(dependencies.workingDirectory);
  const userEntry = getProviderLayerEntry(layers.userConfig, normalized.providerId);
  if (normalized.managed && !userEntry) {
    throw new ProviderInstanceError('Managed provider instance was not found in user configuration', 404);
  }
  const target = normalized.managed
    ? {
        config: layers.userConfig,
        path: layers.paths.userPath || CONFIG_FILE,
        sectionKey: userEntry.sectionKey,
        providerConfig: userEntry.providerConfig,
      }
    : resolveCanonicalProviderWriteTarget(layers, normalized.providerId);
  const originalTargetConfig = target.config;
  const sectionKey = target.sectionKey;
  const existingSection = isPlainObject(originalTargetConfig[sectionKey]) ? originalTargetConfig[sectionKey] : {};
  const existingProvider = target.providerConfig;
  const existingOptions = isPlainObject(existingProvider.options) ? existingProvider.options : {};
  const previousProxy = normalized.managed
    ? readProviderProxySetting(dependencies, normalized.providerId)
    : { ...DIRECT_PROVIDER_PROXY };
  const nextProxy = normalized.managed && normalized.proxyProvided
    ? normalized.proxy
    : previousProxy;
  const isOpenAICompatibleInstance = (
    normalized.managed && normalized.sourceProviderId === OPENAI_COMPATIBLE_PROVIDER_ID
  );
  const nextOptions = { ...existingOptions };
  if (normalized.apiKey !== undefined || normalized.credentialMode === 'oauth') {
    delete nextOptions.apiKey;
  }
  if (isOpenAICompatibleInstance && !normalized.baseURLProvided) {
    if (!normalizeProviderInstanceBaseURL(existingOptions.baseURL)) {
      throw new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422);
    }
  } else {
    if (normalized.baseURL) {
      nextOptions.baseURL = normalized.baseURL;
    } else {
      delete nextOptions.baseURL;
    }
  }
  if (isOpenAICompatibleInstance && !normalizeProviderInstanceBaseURL(nextOptions.baseURL)) {
    throw new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422);
  }
  const nextProvider = {
    ...existingProvider,
    name: normalized.name,
  };
  if (isOpenAICompatibleInstance && dependencyOverrides.openAICompatibleModelIds !== undefined) {
    const refreshed = buildOpenAICompatibleProviderConfig(
      normalized.name,
      nextOptions.baseURL,
      dependencyOverrides.openAICompatibleModelIds,
    );
    nextProvider.npm = refreshed.npm;
    nextProvider.models = refreshed.models;
    delete nextProvider.id;
  }
  if (Object.keys(nextOptions).length > 0) {
    nextProvider.options = nextOptions;
  } else {
    delete nextProvider.options;
  }
  const nextTargetConfig = {
    ...originalTargetConfig,
    [sectionKey]: {
      ...existingSection,
      [normalized.providerId]: nextProvider,
    },
  };

  let proxyChanged = false;
  if (normalized.managed && normalized.proxyProvided) {
    try {
      persistProviderProxy(dependencies, normalized.providerId, nextProxy);
      proxyChanged = true;
    } catch (error) {
      if (error instanceof ProviderInstanceError) throw error;
      throw new ProviderInstanceError('Failed to store provider proxy settings', 500);
    }
  }
  try {
    dependencies.writeConfig(nextTargetConfig, target.path);
  } catch (error) {
    if (proxyChanged) {
      try {
        restoreProviderProxy(dependencies, normalized.providerId, previousProxy);
      } catch {
        throw new ProviderInstanceError('Failed to store provider configuration and roll back provider proxy settings', 500);
      }
    }
    throw error;
  }
  if (normalized.apiKey !== undefined) {
    try {
      dependencies.writeProviderApiKey(normalized.providerId, normalized.apiKey);
    } catch {
      try {
        dependencies.writeConfig(originalTargetConfig, target.path);
        if (proxyChanged) {
          restoreProviderProxy(dependencies, normalized.providerId, previousProxy);
        }
      } catch {
        throw new ProviderInstanceError('Failed to store provider credentials and roll back provider configuration or proxy settings', 500);
      }
      throw new ProviderInstanceError('Failed to store provider credentials', 500);
    }
  }

  return buildProviderInstanceMetadata(
    normalized.providerId,
    normalized.sourceProviderId,
    nextProvider,
    normalized.managed,
    nextProxy,
  );
};

const getProviderConnectionMetadata = (providerId, workingDirectory, dependencyOverrides = {}) => {
  const normalizedProviderId = typeof providerId === 'string' ? providerId.trim() : '';
  const managed = parseManagedProviderInstanceId(normalizedProviderId);
  const loadConfigLayers = dependencyOverrides.readConfigLayers || readConfigLayers;
  const merged = loadConfigLayers(workingDirectory).mergedConfig;
  const providerSection = isPlainObject(merged.provider) ? merged.provider : {};
  const providersSection = isPlainObject(merged.providers) ? merged.providers : {};
  const config = isPlainObject(providerSection[normalizedProviderId])
    ? providerSection[normalizedProviderId]
    : isPlainObject(providersSection[normalizedProviderId])
      ? providersSection[normalizedProviderId]
      : {};
  const options = isPlainObject(config.options) ? config.options : {};
  const hasConfigApiKey = typeof options.apiKey === 'string' && options.apiKey.trim().length > 0;
  const proxy = managed && typeof dependencyOverrides.readProviderProxy === 'function'
    ? normalizeProviderInstanceProxy(dependencyOverrides.readProviderProxy(normalizedProviderId))
    : { ...DIRECT_PROVIDER_PROXY };
  return {
    sourceProviderId: managed?.sourceProviderId || normalizedProviderId,
    name: normalizeOptionalString(config.name),
    baseURL: normalizeModelProviderApiUrl(options.baseURL),
    managed: Boolean(managed),
    authType: hasConfigApiKey ? 'api' : null,
    proxy,
  };
};

export {
  MANAGED_PROVIDER_INSTANCE_MARKER,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  OPENAI_COMPATIBLE_PROVIDER_NPM,
  ProviderInstanceError,
  parseManagedProviderInstanceId,
  validateProviderInstanceCreateInput,
  validateProviderInstanceUpdateInput,
  parseOpenAICompatibleModelCatalog,
  buildOpenAICompatibleProviderConfig,
  findSourceProvider,
  mapProviderModelToConfig,
  buildProviderInstanceConfig,
  createProviderInstance,
  updateProviderInstance,
  getProviderConnectionMetadata,
};
