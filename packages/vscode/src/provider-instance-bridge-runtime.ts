import { randomUUID } from 'crypto';
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ProviderInstanceError,
  createProviderInstance,
  findSourceProvider,
  getProviderConnectionMetadata,
  getProviderSources,
  parseOpenAICompatibleModelCatalog,
  parseManagedProviderInstanceId,
  removeProviderConfig,
  updateProviderInstance,
  validateProviderInstanceCreateInput,
  validateProviderInstanceUpdateInput,
} from './providerInstances';
import { getProviderAuth, removeProviderAuth, writeProviderApiKey } from './opencodeAuth';
import {
  fetchWithProviderProxy,
  getProviderProxy,
  writeProviderProxy,
  type ProviderProxySetting,
} from './providerProxy';
import type { BridgeContext, BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

export type ProviderInstanceRuntimeOverrides = Partial<{
  validateProviderInstanceCreateInput: typeof validateProviderInstanceCreateInput;
  validateProviderInstanceUpdateInput: typeof validateProviderInstanceUpdateInput;
  parseOpenAICompatibleModelCatalog: typeof parseOpenAICompatibleModelCatalog;
  findSourceProvider: typeof findSourceProvider;
  createProviderInstance: typeof createProviderInstance;
  updateProviderInstance: typeof updateProviderInstance;
  getProviderSources: typeof getProviderSources;
  getProviderConnectionMetadata: typeof getProviderConnectionMetadata;
  removeProviderConfig: typeof removeProviderConfig;
  getProviderAuth: typeof getProviderAuth;
  removeProviderAuth: typeof removeProviderAuth;
  writeProviderApiKey: typeof writeProviderApiKey;
  fetchWithProviderProxy: typeof fetchWithProviderProxy;
  getProviderProxy: typeof getProviderProxy;
  writeProviderProxy: typeof writeProviderProxy;
}>;

type ProviderInstanceBridgeDeps = {
  clientReloadDelayMs: number;
  providerRuntime?: ProviderInstanceRuntimeOverrides;
};

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
};

const normalizeProviderCatalogDirectory = (value: unknown, ctx?: BridgeContext): string | undefined => {
  const requestedDirectory = typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const directory = requestedDirectory || ctx?.manager?.getWorkingDirectory();
  if (!directory) return undefined;
  if (directory.length > 4_096 || hasControlCharacters(directory)) {
    throw new ProviderInstanceError('Invalid provider catalog directory', 400);
  }
  return directory;
};

const fetchProviderCatalog = async (directory: string | undefined, ctx?: BridgeContext): Promise<unknown> => {
  const apiUrl = ctx?.manager?.getApiUrl();
  if (!apiUrl) {
    throw new ProviderInstanceError('OpenCode API is unavailable', 503);
  }
  const providerUrl = `${apiUrl.replace(/\/+$/, '')}/provider${
    directory ? `?directory=${encodeURIComponent(directory)}` : ''
  }`;
  let response: Response;
  try {
    response = await fetch(providerUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      },
    });
  } catch {
    throw new ProviderInstanceError('Failed to load the OpenCode provider catalog', 502);
  }
  if (!response.ok) {
    throw new ProviderInstanceError('Failed to load the OpenCode provider catalog', 502);
  }
  const payload = await response.json().catch(() => null);
  if (payload === null) {
    throw new ProviderInstanceError('OpenCode returned an invalid provider catalog', 502);
  }
  return payload;
};

const MAX_OPENAI_COMPATIBLE_CATALOG_BYTES = 1024 * 1024;

const buildOpenAICompatibleModelsUrl = (baseURL: string): string => {
  const parsed = new URL(baseURL);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/models`;
  return parsed.toString();
};

const normalizeStoredDiscoveryApiKey = (value: unknown): string => {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  return apiKey && apiKey.length <= 16_384 && !hasControlCharacters(apiKey) ? apiKey : '';
};

const readBoundedJsonResponse = async (response: Response): Promise<unknown> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength.trim())) {
    const declaredBytes = Number(contentLength);
    if (declaredBytes > MAX_OPENAI_COMPATIBLE_CATALOG_BYTES) {
      throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
    }
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const responseText = await response.text();
    if (new TextEncoder().encode(responseText).byteLength > MAX_OPENAI_COMPATIBLE_CATALOG_BYTES) {
      throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
    }
    return JSON.parse(responseText) as unknown;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_OPENAI_COMPATIBLE_CATALOG_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
};

const fetchOpenAICompatibleModelIds = async (
  baseURL: string,
  apiKey: string,
  parseCatalog: typeof parseOpenAICompatibleModelCatalog,
  proxy: ProviderProxySetting = { mode: 'direct' },
  fetchProxy: typeof fetchWithProviderProxy = fetchWithProviderProxy,
): Promise<string[]> => {
  let response: Response;
  try {
    response = await fetchProxy(buildOpenAICompatibleModelsUrl(baseURL), apiKey, proxy);
  } catch {
    throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
  }
  if (!response.ok) {
    throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
  }

  try {
    const payload = await readBoundedJsonResponse(response);
    return parseCatalog(payload);
  } catch (error) {
    if (error instanceof ProviderInstanceError) throw error;
    throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
  }
};


export async function handleProviderInstanceBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: ProviderInstanceBridgeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;
  const providerRuntime = {
    validateProviderInstanceCreateInput,
    validateProviderInstanceUpdateInput,
    parseOpenAICompatibleModelCatalog,
    findSourceProvider,
    createProviderInstance,
    updateProviderInstance,
    getProviderSources,
    getProviderConnectionMetadata,
    removeProviderConfig,
    getProviderAuth,
    removeProviderAuth,
    writeProviderApiKey,
    fetchWithProviderProxy,
    getProviderProxy,
    writeProviderProxy,
    ...deps.providerRuntime,
  };

  switch (type) {
    case 'api:provider/instance:create': {
      try {
        const input = providerRuntime.validateProviderInstanceCreateInput(payload);
        const directory = normalizeProviderCatalogDirectory(
          (payload as { directory?: unknown } | null)?.directory,
          ctx,
        );
        let instance;
        if (input.sourceProviderId === OPENAI_COMPATIBLE_PROVIDER_ID) {
          const openAICompatibleModelIds = await fetchOpenAICompatibleModelIds(
            input.baseURL!,
            input.apiKey,
            providerRuntime.parseOpenAICompatibleModelCatalog,
            input.proxy,
            providerRuntime.fetchWithProviderProxy,
          );
          instance = providerRuntime.createProviderInstance(
            { ...input, openAICompatibleModelIds },
            { randomUUID, writeProviderApiKey: providerRuntime.writeProviderApiKey },
          );
        } else {
          const sourceProvider = providerRuntime.findSourceProvider(
            await fetchProviderCatalog(directory, ctx),
            input.sourceProviderId,
          );
          instance = providerRuntime.createProviderInstance(
            { ...input, sourceProvider },
            { randomUUID, writeProviderApiKey: providerRuntime.writeProviderApiKey },
          );
        }
        let restarted = false;
        if (input.proxy.mode !== 'direct' && ctx?.manager?.restart) {
          try {
            await ctx.manager.restart();
            restarted = true;
          } catch {
            restarted = false;
          }
        }
        return {
          id,
          type,
          success: true,
          data: { success: true, instance, requiresReload: true, restarted },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create provider instance';
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/instance:update': {
      const { providerId, body, directory } = (payload || {}) as {
        providerId?: string;
        body?: unknown;
        directory?: unknown;
      };
      try {
        const workingDirectory = normalizeProviderCatalogDirectory(directory, ctx);
        const input = providerRuntime.validateProviderInstanceUpdateInput(providerId, body);
        const previousProxy = input.managed && input.proxyProvided
          ? providerRuntime.getProviderProxy(input.providerId)
          : { mode: 'direct' } as const;
        const proxyChanged = input.managed && input.proxyProvided
          && JSON.stringify(input.proxy) !== JSON.stringify(previousProxy);
        let openAICompatibleModelIds: string[] | undefined;
        if (input.managed && input.sourceProviderId === OPENAI_COMPATIBLE_PROVIDER_ID) {
          const providerSources = providerRuntime.getProviderSources(input.providerId, workingDirectory);
          if (!providerSources.user.exists) {
            throw new ProviderInstanceError('Managed provider instance was not found in user configuration', 404);
          }
          const connection = providerRuntime.getProviderConnectionMetadata(input.providerId, workingDirectory);
          const effectiveBaseURL = input.baseURLProvided ? input.baseURL : connection.baseURL;
          if (!effectiveBaseURL) {
            throw new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422);
          }
          const shouldRediscover = input.apiKey !== undefined
            || (input.baseURLProvided && input.baseURL !== connection.baseURL)
            || (
              input.proxyProvided
              && JSON.stringify(input.proxy) !== JSON.stringify(connection.proxy || { mode: 'direct' })
            );
          if (shouldRediscover) {
            let discoveryApiKey = input.apiKey;
            if (!discoveryApiKey) {
              const storedAuth = providerRuntime.getProviderAuth(input.providerId);
              discoveryApiKey = storedAuth?.type === 'api'
                ? normalizeStoredDiscoveryApiKey(storedAuth.key)
                : '';
            }
            if (!discoveryApiKey) {
              throw new ProviderInstanceError(
                'API key is required to refresh the OpenAI-compatible model catalog',
              );
            }
            openAICompatibleModelIds = await fetchOpenAICompatibleModelIds(
              effectiveBaseURL,
              discoveryApiKey,
              providerRuntime.parseOpenAICompatibleModelCatalog,
              input.proxyProvided ? input.proxy : (connection.proxy || { mode: 'direct' }),
              providerRuntime.fetchWithProviderProxy,
            );
          }
        }
        const instance = providerRuntime.updateProviderInstance(providerId, body, {
          writeProviderApiKey: providerRuntime.writeProviderApiKey,
          workingDirectory,
          ...(openAICompatibleModelIds ? { openAICompatibleModelIds } : {}),
        });
        let restarted = false;
        if (proxyChanged && ctx?.manager?.restart) {
          try {
            await ctx.manager.restart();
            restarted = true;
          } catch {
            restarted = false;
          }
        }
        return {
          id,
          type,
          success: true,
          data: { success: true, instance, requiresReload: true, restarted },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to update provider instance';
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/auth:delete': {
      const { providerId, scope, directory } = (payload || {}) as { providerId?: string; scope?: string; directory?: string };
      if (!providerId) {
        return { id, type, success: false, error: 'Provider ID is required' };
      }
      const normalizedScope = typeof scope === 'string' ? scope : 'auth';
      try {
        const workingDirectory = normalizeProviderCatalogDirectory(directory, ctx);
        if (normalizedScope === 'project' && !workingDirectory) {
          throw new ProviderInstanceError('Directory parameter or active project is required', 400);
        }
        let removed = false;
        if (normalizedScope === 'auth') {
          removed = providerRuntime.removeProviderAuth(providerId);
        } else if (normalizedScope === 'user' || normalizedScope === 'project' || normalizedScope === 'custom') {
          removed = providerRuntime.removeProviderConfig(providerId, workingDirectory, normalizedScope);
        } else if (normalizedScope === 'all') {
          const authRemoved = providerRuntime.removeProviderAuth(providerId);
          const userRemoved = providerRuntime.removeProviderConfig(providerId, workingDirectory, 'user');
          const projectRemoved = workingDirectory
            ? providerRuntime.removeProviderConfig(providerId, workingDirectory, 'project')
            : false;
          const customRemoved = providerRuntime.removeProviderConfig(providerId, workingDirectory, 'custom');
          removed = authRemoved || userRemoved || projectRemoved || customRemoved;
        } else {
          return { id, type, success: false, error: 'Invalid scope' };
        }

        if (
          (normalizedScope === 'user' || normalizedScope === 'all')
          && parseManagedProviderInstanceId(providerId)
        ) {
          const proxy = providerRuntime.getProviderProxy(providerId);
          if (proxy.mode !== 'direct') {
            providerRuntime.writeProviderProxy(providerId, { mode: 'direct' });
            removed = true;
          }
        }

        if (removed) {
          await ctx?.manager?.restart();
        }
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            removed,
            requiresReload: removed,
            message: removed
              ? `Provider ${providerId} disconnected successfully. Reloading interface…`
              : `Provider ${providerId} was not configured.`,
            reloadDelayMs: removed ? deps.clientReloadDelayMs : undefined,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/source:get': {
      const { providerId, directory } = (payload || {}) as { providerId?: string; directory?: string };
      if (!providerId) {
        return { id, type, success: false, error: 'Provider ID is required' };
      }
      try {
        const workingDirectory = normalizeProviderCatalogDirectory(directory, ctx);
        const sources = providerRuntime.getProviderSources(providerId, workingDirectory);
        const connection = providerRuntime.getProviderConnectionMetadata(providerId, workingDirectory);
        const configAuthType = connection.authType === 'api' ? 'api' : null;
        let auth: Record<string, unknown> | null = null;
        let storedAuthType: string | null = null;
        if (!configAuthType) {
          auth = providerRuntime.getProviderAuth(providerId);
          storedAuthType = typeof auth?.type === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(auth.type)
            ? auth.type
            : null;
        }
        const authType = configAuthType || storedAuthType;
        sources.auth.exists = Boolean(configAuthType || auth);
        (sources.auth as typeof sources.auth & { type?: string | null }).type = authType;
        return {
          id,
          type,
          success: true,
          data: {
            providerId,
            sources,
            connection: {
              ...connection,
              authType,
            },
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    default:
      return null;
  }
}
