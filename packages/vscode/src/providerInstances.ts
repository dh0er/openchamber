import {
  providerInstanceConfigStorage,
} from './opencodeConfig';
import {
  getProviderProxy,
  normalizeManualProviderProxyUrl,
  writeProviderProxy,
  type ProviderProxySetting,
} from './providerProxy';

const {
  defaultConfigFile: CONFIG_FILE,
  getConfigForPath,
  readConfigLayers,
  writeConfig,
} = providerInstanceConfigStorage;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const MANAGED_PROVIDER_INSTANCE_MARKER = 'openchamber';
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';
export const OPENAI_COMPATIBLE_PROVIDER_NPM = '@ai-sdk/openai-compatible';
const SOURCE_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._:@-]{0,127}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OPENAI_COMPATIBLE_MODEL_ID_LENGTH = 512;
const MAX_OPENAI_COMPATIBLE_MODELS = 5_000;
const PROVIDER_INSTANCE_UNSAFE_CONFIG_MAP_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PROVIDER_INSTANCE_SAFE_MODEL_OPTION_KEYS = [
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
] as const;
const PROVIDER_INSTANCE_SENSITIVE_URL_QUERY_KEY_PATTERN = /(?:apikey|accesskey|token|secret|password|credential|signature|authorization|^auth$|^key$|^code$)/;

const hasProviderInstanceControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
};

export class ProviderInstanceError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ProviderInstanceError';
    this.status = status;
  }
}

export type ProviderInstanceMetadata = {
  id: string;
  providerId: string;
  sourceProviderId: string;
  name: string;
  baseURL: string | null;
  proxy: ProviderProxySetting;
  managed: boolean;
};

type ProviderInstanceCreateInput = {
  sourceProviderId: string;
  name: string;
  baseURL: string | null;
  apiKey: string;
  proxy: ProviderProxySetting;
};

type ProviderInstanceUpdateInput = {
  providerId: string;
  sourceProviderId: string;
  instanceUuid: string | null;
  managed: boolean;
  name: string;
  baseURL: string | null;
  baseURLProvided: boolean;
  proxy: ProviderProxySetting;
  proxyProvided: boolean;
  apiKey?: string;
  credentialMode: 'oauth' | null;
};

type ProviderInstanceStorageDependencies = {
  readConfigLayers?: typeof readConfigLayers;
  writeConfig?: typeof writeConfig;
  randomUUID?: () => string;
  writeProviderApiKey?: (providerId: string, apiKey: string) => void;
  workingDirectory?: string;
  openAICompatibleModelIds?: string[];
  getProviderProxy?: typeof getProviderProxy;
  writeProviderProxy?: typeof writeProviderProxy;
};

const normalizeProviderInstanceOptionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const normalizeProviderInstanceFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const isProviderInstanceSafeConfigMapKey = (value: unknown): value is string => (
  typeof value === 'string'
  && !PROVIDER_INSTANCE_UNSAFE_CONFIG_MAP_KEYS.has(value.toLowerCase())
);

const normalizeProviderInstanceModelApiUrl = (value: unknown): string | null => {
  const apiUrl = normalizeProviderInstanceOptionalString(value);
  if (!apiUrl || hasProviderInstanceControlCharacters(apiUrl)) return null;
  let parsed: URL;
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
  ) return null;
  for (const key of parsed.searchParams.keys()) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (PROVIDER_INSTANCE_SENSITIVE_URL_QUERY_KEY_PATTERN.test(normalizedKey)) return null;
  }
  return apiUrl;
};

const normalizeSourceProviderId = (value: unknown): string => {
  const providerId = typeof value === 'string' ? value.trim() : '';
  if (
    !SOURCE_PROVIDER_ID_PATTERN.test(providerId)
    || !isProviderInstanceSafeConfigMapKey(providerId)
    || providerId.includes(`:${MANAGED_PROVIDER_INSTANCE_MARKER}:`)
    || providerId.endsWith(`:${MANAGED_PROVIDER_INSTANCE_MARKER}`)
  ) {
    throw new ProviderInstanceError('Invalid source provider ID');
  }
  return providerId;
};

export const parseManagedProviderInstanceId = (
  value: unknown,
): { providerId: string; sourceProviderId: string; instanceUuid: string } | null => {
  if (typeof value !== 'string') return null;
  const providerId = value.trim();
  const marker = `:${MANAGED_PROVIDER_INSTANCE_MARKER}:`;
  const markerIndex = providerId.lastIndexOf(marker);
  if (markerIndex <= 0 || providerId.indexOf(marker) !== markerIndex) return null;
  const sourceProviderId = providerId.slice(0, markerIndex);
  const instanceUuid = providerId.slice(markerIndex + marker.length);
  if (
    !SOURCE_PROVIDER_ID_PATTERN.test(sourceProviderId)
    || !isProviderInstanceSafeConfigMapKey(sourceProviderId)
    || sourceProviderId.includes(marker)
    || !UUID_PATTERN.test(instanceUuid)
  ) return null;
  return { providerId, sourceProviderId, instanceUuid };
};

const normalizeProviderInstanceTargetId = (value: unknown) => {
  const parsed = parseManagedProviderInstanceId(value);
  if (parsed) return { ...parsed, managed: true };
  const sourceProviderId = normalizeSourceProviderId(value);
  return { providerId: sourceProviderId, sourceProviderId, instanceUuid: null, managed: false };
};

const normalizeProviderInstanceName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new ProviderInstanceError('Provider name is required');
  if (name.length > 120 || hasProviderInstanceControlCharacters(name)) {
    throw new ProviderInstanceError('Provider name is invalid');
  }
  return name;
};

const normalizeProviderInstanceApiKey = (value: unknown, required: boolean): string | undefined => {
  if (value === undefined && !required) return undefined;
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!apiKey) throw new ProviderInstanceError('API key is required');
  if (apiKey.length > 16_384 || hasProviderInstanceControlCharacters(apiKey)) {
    throw new ProviderInstanceError('API key is invalid');
  }
  return apiKey;
};

const normalizeProviderCredentialMode = (value: unknown): 'oauth' | null => {
  if (value === undefined || value === null || value === '') return null;
  if (value !== 'oauth') throw new ProviderInstanceError('Credential mode is invalid');
  return value;
};

const normalizeProviderInstanceProxy = (value: unknown): ProviderProxySetting => {
  if (value === undefined || value === null) return { mode: 'direct' };
  if (!isPlainObject(value)) throw new ProviderInstanceError('Proxy settings are invalid');
  if (value.mode === 'direct') {
    if (value.url !== undefined && value.url !== null && value.url !== '') {
      throw new ProviderInstanceError('Proxy URL is only supported for manual proxy mode');
    }
    return { mode: 'direct' };
  }
  if (value.mode === 'system') {
    if (value.url !== undefined && value.url !== null && value.url !== '') {
      throw new ProviderInstanceError('Proxy URL is only supported for manual proxy mode');
    }
    return { mode: 'system' };
  }
  if (value.mode === 'manual') {
    try {
      return { mode: 'manual', url: normalizeManualProviderProxyUrl(value.url) };
    } catch (error) {
      throw new ProviderInstanceError(error instanceof Error ? error.message : 'Proxy URL is invalid');
    }
  }
  throw new ProviderInstanceError('Proxy mode is invalid');
};

const normalizeProviderInstanceBaseURL = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ProviderInstanceError('Base URL must be an HTTP(S) URL');
  const baseURL = value.trim();
  if (!baseURL) return null;
  let parsed: URL;
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
    if (PROVIDER_INSTANCE_SENSITIVE_URL_QUERY_KEY_PATTERN.test(normalizedKey)) {
      throw new ProviderInstanceError('Base URL must not contain sensitive query parameters');
    }
  }
  return baseURL;
};

export const validateProviderInstanceCreateInput = (value: unknown): ProviderInstanceCreateInput => {
  if (!isPlainObject(value)) throw new ProviderInstanceError('Request body must be a JSON object');
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
    apiKey: normalizeProviderInstanceApiKey(value.apiKey, true)!,
    proxy,
  };
};

export const validateProviderInstanceUpdateInput = (
  providerId: unknown,
  value: unknown,
): ProviderInstanceUpdateInput => {
  if (!isPlainObject(value)) throw new ProviderInstanceError('Request body must be a JSON object');
  const target = normalizeProviderInstanceTargetId(providerId);
  const apiKey = normalizeProviderInstanceApiKey(value.apiKey, false);
  const credentialMode = normalizeProviderCredentialMode(value.credentialMode);
  const proxyProvided = Object.prototype.hasOwnProperty.call(value, 'proxy');
  const proxy = normalizeProviderInstanceProxy(value.proxy);
  if (apiKey !== undefined && credentialMode) {
    throw new ProviderInstanceError('API key and OAuth credential mode cannot be combined');
  }
  if (target.managed && credentialMode === 'oauth') {
    throw new ProviderInstanceError('Managed provider instances do not support OAuth credential mode');
  }
  if (!target.managed && proxyProvided && proxy.mode !== 'direct') {
    throw new ProviderInstanceError('Proxy settings are supported only for managed API-key provider instances', 422);
  }
  return {
    ...target,
    name: normalizeProviderInstanceName(value.name),
    baseURL: normalizeProviderInstanceBaseURL(value.baseURL),
    baseURLProvided: Object.prototype.hasOwnProperty.call(value, 'baseURL'),
    proxy,
    proxyProvided,
    apiKey,
    credentialMode,
  };
};

const normalizeOpenAICompatibleModelId = (value: unknown): string | null => {
  const modelId = normalizeProviderInstanceOptionalString(value);
  if (
    !modelId
    || modelId.length > MAX_OPENAI_COMPATIBLE_MODEL_ID_LENGTH
    || hasProviderInstanceControlCharacters(modelId)
    || !isProviderInstanceSafeConfigMapKey(modelId)
  ) return null;
  return modelId;
};

export const parseOpenAICompatibleModelCatalog = (payload: unknown): string[] => {
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
    throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
  }
  if (payload.data.length > MAX_OPENAI_COMPATIBLE_MODELS) {
    throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
  }

  const seen = new Set<string>();
  const modelIds: string[] = [];
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

export const buildOpenAICompatibleProviderConfig = (
  name: unknown,
  baseURL: unknown,
  modelIds: unknown,
): Record<string, unknown> => {
  const normalizedBaseURL = normalizeProviderInstanceBaseURL(baseURL);
  if (!normalizedBaseURL) {
    throw new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422);
  }
  if (!Array.isArray(modelIds) || modelIds.length > MAX_OPENAI_COMPATIBLE_MODELS) {
    throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
  }

  const models: Record<string, { name: string }> = Object.create(null) as Record<string, { name: string }>;
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

const providerCatalogEntries = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (isPlainObject(payload) && Array.isArray(payload.all)) return payload.all;
  if (isPlainObject(payload) && Array.isArray(payload.providers)) return payload.providers;
  throw new ProviderInstanceError('OpenCode returned an invalid provider catalog', 502);
};

export const findSourceProvider = (payload: unknown, sourceProviderId: unknown): Record<string, unknown> => {
  const normalizedProviderId = normalizeSourceProviderId(sourceProviderId);
  const sourceProvider = providerCatalogEntries(payload).find(
    (entry) => isPlainObject(entry) && entry.id === normalizedProviderId,
  );
  if (!isPlainObject(sourceProvider)) throw new ProviderInstanceError('Source provider was not found', 404);
  return sourceProvider;
};

const mapProviderInstanceModalities = (value: unknown): string[] => {
  if (!isPlainObject(value)) return [];
  return ['text', 'audio', 'image', 'video', 'pdf'].filter((key) => value[key] === true);
};

const mapProviderInstanceSafeModelOptions = (value: unknown): Record<string, unknown> | null => {
  if (!isPlainObject(value)) return null;
  const options: Record<string, unknown> = {};
  for (const key of PROVIDER_INSTANCE_SAFE_MODEL_OPTION_KEYS) {
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
    const thinking: Record<string, unknown> = {};
    if (typeof value.thinking.type === 'string') thinking.type = value.thinking.type;
    if (typeof value.thinking.budgetTokens === 'number' && Number.isFinite(value.thinking.budgetTokens)) {
      thinking.budgetTokens = value.thinking.budgetTokens;
    }
    if (Object.keys(thinking).length > 0) options.thinking = thinking;
  }

  if (isPlainObject(value.thinkingConfig)) {
    const thinkingConfig: Record<string, unknown> = {};
    if (
      typeof value.thinkingConfig.thinkingBudget === 'number'
      && Number.isFinite(value.thinkingConfig.thinkingBudget)
    ) {
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

const mapProviderInstanceSafeModelVariants = (value: unknown): Record<string, unknown> | null => {
  if (!isPlainObject(value)) return null;
  const variants: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [variantName, variant] of Object.entries(value)) {
    if (
      !variantName
      || variantName.length > 120
      || hasProviderInstanceControlCharacters(variantName)
      || !isProviderInstanceSafeConfigMapKey(variantName)
      || !isPlainObject(variant)
    ) {
      continue;
    }
    const mapped = mapProviderInstanceSafeModelOptions(variant) || {};
    if (typeof variant.disabled === 'boolean') mapped.disabled = variant.disabled;
    if (Object.keys(mapped).length > 0) variants[variantName] = mapped;
  }
  return Object.keys(variants).length > 0 ? variants : null;
};

export const mapProviderModelToConfig = (
  modelId: string,
  value: unknown,
): [string, Record<string, unknown>] | null => {
  if (!isPlainObject(value)) return null;
  const runtimeModelId = normalizeProviderInstanceOptionalString(modelId);
  if (
    !runtimeModelId
    || hasProviderInstanceControlCharacters(runtimeModelId)
    || !isProviderInstanceSafeConfigMapKey(runtimeModelId)
  ) return null;

  const model: Record<string, unknown> = {};
  const api = isPlainObject(value.api) ? value.api : {};
  const apiId = normalizeProviderInstanceOptionalString(api.id);
  if (apiId) model.id = apiId;
  const name = normalizeProviderInstanceOptionalString(value.name);
  if (name) model.name = name;
  const family = normalizeProviderInstanceOptionalString(value.family);
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
    && typeof capabilities.interleaved.field === 'string'
    && ['reasoning', 'reasoning_content', 'reasoning_details'].includes(capabilities.interleaved.field)
  ) {
    model.interleaved = { field: capabilities.interleaved.field };
  }
  model.modalities = {
    input: mapProviderInstanceModalities(capabilities.input),
    output: mapProviderInstanceModalities(capabilities.output),
  };

  const cost = isPlainObject(value.cost) ? value.cost : {};
  const inputCost = normalizeProviderInstanceFiniteNumber(cost.input);
  const outputCost = normalizeProviderInstanceFiniteNumber(cost.output);
  if (inputCost !== null && outputCost !== null) {
    const mappedCost: Record<string, number> = { input: inputCost, output: outputCost };
    const cache = isPlainObject(cost.cache) ? cost.cache : {};
    const cacheRead = normalizeProviderInstanceFiniteNumber(cache.read);
    const cacheWrite = normalizeProviderInstanceFiniteNumber(cache.write);
    if (cacheRead !== null) mappedCost.cache_read = cacheRead;
    if (cacheWrite !== null) mappedCost.cache_write = cacheWrite;
    model.cost = mappedCost;
  }

  const limit = isPlainObject(value.limit) ? value.limit : {};
  const contextLimit = normalizeProviderInstanceFiniteNumber(limit.context);
  const outputLimit = normalizeProviderInstanceFiniteNumber(limit.output);
  if (contextLimit !== null && outputLimit !== null) {
    const mappedLimit: Record<string, number> = { context: contextLimit, output: outputLimit };
    const inputLimit = normalizeProviderInstanceFiniteNumber(limit.input);
    if (inputLimit !== null) mappedLimit.input = inputLimit;
    model.limit = mappedLimit;
  }

  if (typeof value.status === 'string' && ['alpha', 'beta', 'deprecated', 'active'].includes(value.status)) {
    model.status = value.status;
  }

  const provider: Record<string, string> = {};
  const npm = normalizeProviderInstanceOptionalString(api.npm);
  const providerApi = normalizeProviderInstanceModelApiUrl(api.url);
  if (npm) provider.npm = npm;
  if (providerApi) provider.api = providerApi;
  if (Object.keys(provider).length > 0) model.provider = provider;

  const options = mapProviderInstanceSafeModelOptions(value.options);
  if (options) model.options = options;
  const variants = mapProviderInstanceSafeModelVariants(value.variants);
  if (variants) model.variants = variants;
  return [runtimeModelId, model];
};

export const buildProviderInstanceConfig = (
  sourceProvider: unknown,
  name: unknown,
  baseURL: string | null,
): Record<string, unknown> => {
  if (!isPlainObject(sourceProvider) || !isPlainObject(sourceProvider.models)) {
    throw new ProviderInstanceError('Source provider has no model catalog', 422);
  }
  const sourceProviderId = normalizeSourceProviderId(sourceProvider.id);
  const models: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [modelId, model] of Object.entries(sourceProvider.models)) {
    const mapped = mapProviderModelToConfig(modelId, model);
    if (mapped) models[mapped[0]] = mapped[1];
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
  providerId: string,
  sourceProviderId: string,
  providerConfig: Record<string, unknown>,
  proxy: ProviderProxySetting = { mode: 'direct' },
  managed = true,
): ProviderInstanceMetadata => {
  const options = isPlainObject(providerConfig.options) ? providerConfig.options : {};
  return {
    id: providerId,
    providerId,
    sourceProviderId,
    name: normalizeProviderInstanceOptionalString(providerConfig.name) || providerId,
    baseURL: normalizeProviderInstanceModelApiUrl(options.baseURL),
    proxy,
    managed,
  };
};

const providerInstanceStorageDependencies = (
  overrides: ProviderInstanceStorageDependencies,
): Required<Pick<ProviderInstanceStorageDependencies, 'readConfigLayers' | 'writeConfig'>>
  & Pick<
    ProviderInstanceStorageDependencies,
    | 'randomUUID'
    | 'writeProviderApiKey'
    | 'workingDirectory'
    | 'openAICompatibleModelIds'
    | 'getProviderProxy'
    | 'writeProviderProxy'
  > => ({
  readConfigLayers: overrides.readConfigLayers || readConfigLayers,
  writeConfig: overrides.writeConfig || writeConfig,
  randomUUID: overrides.randomUUID,
  writeProviderApiKey: overrides.writeProviderApiKey,
  workingDirectory: overrides.workingDirectory,
  openAICompatibleModelIds: overrides.openAICompatibleModelIds,
  getProviderProxy: overrides.getProviderProxy || getProviderProxy,
  writeProviderProxy: overrides.writeProviderProxy || writeProviderProxy,
});

type ProviderInstanceLayerEntry = {
  sectionKey: 'provider' | 'providers';
  providerConfig: Record<string, unknown>;
};

const getProviderInstanceLayerEntry = (
  config: Record<string, unknown> | undefined,
  providerId: string,
): ProviderInstanceLayerEntry | null => {
  for (const sectionKey of ['provider', 'providers'] as const) {
    const sectionValue = config?.[sectionKey];
    const section = isPlainObject(sectionValue) ? sectionValue : {};
    const providerConfig = section[providerId];
    if (isPlainObject(providerConfig)) return { sectionKey, providerConfig };
  }
  return null;
};

const resolveCanonicalProviderInstanceWriteTarget = (
  layers: ReturnType<typeof readConfigLayers>,
  providerId: string,
): ProviderInstanceLayerEntry & { config: Record<string, unknown>; path: string } => {
  const candidates = [
    { config: layers.customConfig, path: layers.paths.customPath },
    { config: layers.projectConfig, path: layers.paths.projectPath },
    { config: layers.userConfig, path: layers.paths.userPath },
  ];
  for (const candidate of candidates) {
    const entry = getProviderInstanceLayerEntry(candidate.config, providerId);
    if (entry) {
      if (!candidate.path) {
        throw new ProviderInstanceError('Provider configuration source is unavailable', 500);
      }
      return { config: candidate.config, path: candidate.path, ...entry };
    }
  }
  return {
    config: layers.userConfig,
    path: layers.paths.userPath || CONFIG_FILE,
    sectionKey: 'provider',
    providerConfig: {},
  };
};

export const createProviderInstance = (
  input: unknown,
  dependencyOverrides: ProviderInstanceStorageDependencies = {},
): ProviderInstanceMetadata => {
  const normalized = validateProviderInstanceCreateInput(input);
  if (!isPlainObject(input)) throw new ProviderInstanceError('Request body must be a JSON object');
  let providerConfig: Record<string, unknown>;
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
  const dependencies = providerInstanceStorageDependencies(dependencyOverrides);
  if (!dependencies.randomUUID || !dependencies.writeProviderApiKey) {
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

  const nextUserConfig: Record<string, unknown> = {
    ...originalUserConfig,
    provider: { ...existingProviders, [providerId]: providerConfig },
  };
  dependencies.writeConfig(nextUserConfig, layers.paths.userPath || CONFIG_FILE);
  let proxyWritten = false;
  if (normalized.proxy.mode !== 'direct') {
    try {
      dependencies.writeProviderProxy!(providerId, normalized.proxy);
      proxyWritten = true;
    } catch {
      try {
        dependencies.writeConfig(originalUserConfig, layers.paths.userPath || CONFIG_FILE);
      } catch {
        throw new ProviderInstanceError(
          'Failed to store provider proxy configuration and roll back provider configuration',
          500,
        );
      }
      throw new ProviderInstanceError('Failed to store provider proxy configuration', 500);
    }
  }
  try {
    dependencies.writeProviderApiKey(providerId, normalized.apiKey);
  } catch {
    let rollbackFailed = false;
    if (proxyWritten) {
      try {
        dependencies.writeProviderProxy!(providerId, { mode: 'direct' });
      } catch {
        rollbackFailed = true;
      }
    }
    try {
      dependencies.writeConfig(originalUserConfig, layers.paths.userPath || CONFIG_FILE);
    } catch {
      rollbackFailed = true;
    }
    if (rollbackFailed) {
      throw new ProviderInstanceError('Failed to store provider credentials and roll back provider settings', 500);
    }
    throw new ProviderInstanceError('Failed to store provider credentials', 500);
  }
  return buildProviderInstanceMetadata(
    providerId,
    normalized.sourceProviderId,
    providerConfig,
    normalized.proxy,
  );
};

export const updateProviderInstance = (
  providerId: unknown,
  input: unknown,
  dependencyOverrides: ProviderInstanceStorageDependencies = {},
): ProviderInstanceMetadata => {
  const normalized = validateProviderInstanceUpdateInput(providerId, input);
  const dependencies = providerInstanceStorageDependencies(dependencyOverrides);
  if (normalized.apiKey !== undefined && !dependencies.writeProviderApiKey) {
    throw new ProviderInstanceError('Provider credential storage is unavailable', 500);
  }

  const layers = dependencies.readConfigLayers(dependencies.workingDirectory);
  const userEntry = getProviderInstanceLayerEntry(layers.userConfig, normalized.providerId);
  if (normalized.managed && !userEntry) {
    throw new ProviderInstanceError('Managed provider instance was not found in user configuration', 404);
  }
  const target = normalized.managed
    ? {
        config: layers.userConfig,
        path: layers.paths.userPath || CONFIG_FILE,
        sectionKey: userEntry!.sectionKey,
        providerConfig: userEntry!.providerConfig,
      }
    : resolveCanonicalProviderInstanceWriteTarget(layers, normalized.providerId);
  const originalTargetConfig = target.config;
  const sectionKey = target.sectionKey;
  const existingSection = isPlainObject(originalTargetConfig[sectionKey])
    ? originalTargetConfig[sectionKey]
    : {};
  const existingProvider = target.providerConfig;
  const existingOptions = isPlainObject(existingProvider.options) ? existingProvider.options : {};
  const isOpenAICompatibleInstance = (
    normalized.managed && normalized.sourceProviderId === OPENAI_COMPATIBLE_PROVIDER_ID
  );
  const nextOptions: Record<string, unknown> = { ...existingOptions };
  if (normalized.apiKey !== undefined || normalized.credentialMode === 'oauth') {
    delete nextOptions.apiKey;
  }
  if (isOpenAICompatibleInstance && !normalized.baseURLProvided) {
    if (!normalizeProviderInstanceBaseURL(existingOptions.baseURL)) {
      throw new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422);
    }
  } else if (normalized.baseURL) {
    nextOptions.baseURL = normalized.baseURL;
  } else {
    delete nextOptions.baseURL;
  }
  if (isOpenAICompatibleInstance && !normalizeProviderInstanceBaseURL(nextOptions.baseURL)) {
    throw new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422);
  }
  const originalProxy = normalized.managed
    ? dependencies.getProviderProxy!(normalized.providerId)
    : { mode: 'direct' } as const;
  const effectiveProxy = normalized.managed && normalized.proxyProvided
    ? normalized.proxy
    : originalProxy;
  const nextProvider: Record<string, unknown> = { ...existingProvider, name: normalized.name };
  if (isOpenAICompatibleInstance && dependencies.openAICompatibleModelIds !== undefined) {
    const refreshed = buildOpenAICompatibleProviderConfig(
      normalized.name,
      nextOptions.baseURL,
      dependencies.openAICompatibleModelIds,
    );
    nextProvider.npm = refreshed.npm;
    nextProvider.models = refreshed.models;
    delete nextProvider.id;
  }
  if (Object.keys(nextOptions).length > 0) nextProvider.options = nextOptions;
  else delete nextProvider.options;
  const nextTargetConfig: Record<string, unknown> = {
    ...originalTargetConfig,
    [sectionKey]: { ...existingSection, [normalized.providerId]: nextProvider },
  };

  dependencies.writeConfig(nextTargetConfig, target.path);
  let proxyWritten = false;
  if (normalized.managed && normalized.proxyProvided) {
    try {
      dependencies.writeProviderProxy!(normalized.providerId, effectiveProxy);
      proxyWritten = true;
    } catch {
      try {
        dependencies.writeConfig(originalTargetConfig, target.path);
      } catch {
        throw new ProviderInstanceError(
          'Failed to store provider proxy configuration and roll back provider configuration',
          500,
        );
      }
      throw new ProviderInstanceError('Failed to store provider proxy configuration', 500);
    }
  }
  if (normalized.apiKey !== undefined) {
    try {
      dependencies.writeProviderApiKey!(normalized.providerId, normalized.apiKey);
    } catch {
      let rollbackFailed = false;
      if (proxyWritten) {
        try {
          dependencies.writeProviderProxy!(normalized.providerId, originalProxy);
        } catch {
          rollbackFailed = true;
        }
      }
      try {
        dependencies.writeConfig(originalTargetConfig, target.path);
      } catch {
        rollbackFailed = true;
      }
      if (rollbackFailed) {
        throw new ProviderInstanceError('Failed to store provider credentials and roll back provider settings', 500);
      }
      throw new ProviderInstanceError('Failed to store provider credentials', 500);
    }
  }
  return buildProviderInstanceMetadata(
    normalized.providerId,
    normalized.sourceProviderId,
    nextProvider,
    effectiveProxy,
    normalized.managed,
  );
};

export const getProviderConnectionMetadata = (
  providerId: string,
  workingDirectory?: string,
  dependencyOverrides: {
    readConfigLayers?: typeof readConfigLayers;
    getProviderProxy?: typeof getProviderProxy;
  } = {},
) => {
  const normalizedProviderId = providerId.trim();
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
  return {
    sourceProviderId: managed?.sourceProviderId || normalizedProviderId,
    name: normalizeProviderInstanceOptionalString(config.name),
    baseURL: normalizeProviderInstanceModelApiUrl(options.baseURL),
    proxy: managed
      ? (dependencyOverrides.getProviderProxy || getProviderProxy)(normalizedProviderId)
      : { mode: 'direct' } as const,
    managed: Boolean(managed),
    authType: typeof options.apiKey === 'string' && options.apiKey.trim().length > 0 ? 'api' : null,
  };
};

export const getProviderSources = (providerId: string, workingDirectory?: string) => {
  const layers = readConfigLayers(workingDirectory);
  const customProviders = isPlainObject((layers.customConfig as Record<string, unknown>)?.provider)
    ? (layers.customConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const customProvidersAlias = isPlainObject((layers.customConfig as Record<string, unknown>)?.providers)
    ? (layers.customConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};
  const projectProviders = isPlainObject((layers.projectConfig as Record<string, unknown>)?.provider)
    ? (layers.projectConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const projectProvidersAlias = isPlainObject((layers.projectConfig as Record<string, unknown>)?.providers)
    ? (layers.projectConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};
  const userProviders = isPlainObject((layers.userConfig as Record<string, unknown>)?.provider)
    ? (layers.userConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const userProvidersAlias = isPlainObject((layers.userConfig as Record<string, unknown>)?.providers)
    ? (layers.userConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};

  const customExists = Object.prototype.hasOwnProperty.call(customProviders, providerId)
    || Object.prototype.hasOwnProperty.call(customProvidersAlias, providerId);
  const projectExists = Object.prototype.hasOwnProperty.call(projectProviders, providerId)
    || Object.prototype.hasOwnProperty.call(projectProvidersAlias, providerId);
  const userExists = Object.prototype.hasOwnProperty.call(userProviders, providerId)
    || Object.prototype.hasOwnProperty.call(userProvidersAlias, providerId);

  return {
    auth: { exists: false },
    user: { exists: userExists, path: layers.paths.userPath },
    project: { exists: projectExists, path: layers.paths.projectPath ?? null },
    custom: { exists: customExists, path: layers.paths.customPath },
  };
};

export const removeProviderConfig = (providerId: string, workingDirectory?: string, scope: 'user' | 'project' | 'custom' = 'user') => {
  if (!providerId) throw new Error('Provider ID is required');

  const layers = readConfigLayers(workingDirectory);
  let targetPath: string | null | undefined = layers.paths.userPath;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath ?? targetPath;
  }

  if (scope === 'custom') {
    if (!layers.paths.customPath) {
      return false;
    }
    targetPath = layers.paths.customPath;
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const providerConfig = isPlainObject((targetConfig as Record<string, unknown>).provider)
    ? (targetConfig as Record<string, unknown>).provider as Record<string, unknown>
    : {};
  const providersConfig = isPlainObject((targetConfig as Record<string, unknown>).providers)
    ? (targetConfig as Record<string, unknown>).providers as Record<string, unknown>
    : {};

  const removedProvider = Object.prototype.hasOwnProperty.call(providerConfig, providerId);
  const removedProviders = Object.prototype.hasOwnProperty.call(providersConfig, providerId);

  if (!removedProvider && !removedProviders) {
    return false;
  }

  if (removedProvider) {
    delete providerConfig[providerId];
    if (Object.keys(providerConfig).length === 0) {
      delete (targetConfig as Record<string, unknown>).provider;
    } else {
      (targetConfig as Record<string, unknown>).provider = providerConfig;
    }
  }

  if (removedProviders) {
    delete providersConfig[providerId];
    if (Object.keys(providersConfig).length === 0) {
      delete (targetConfig as Record<string, unknown>).providers;
    } else {
      (targetConfig as Record<string, unknown>).providers = providersConfig;
    }
  }

  writeConfig(targetConfig as Record<string, unknown>, targetPath || CONFIG_FILE);
  return true;
};
