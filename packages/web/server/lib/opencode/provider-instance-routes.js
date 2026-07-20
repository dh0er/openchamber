const OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_OPENAI_COMPATIBLE_CATALOG_BYTES = 1024 * 1024;

const unavailable = () => {
  throw new Error('Provider instance runtime is unavailable');
};

export const createProviderInstanceRoutesRuntime = (dependencies) => {
  const {
    crypto,
    resolveProjectDirectory,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getProviderSources,
    getProviderConnectionMetadata,
    OPENAI_COMPATIBLE_PROVIDER_ID,
    ProviderInstanceError,
    validateProviderInstanceCreateInput,
    validateProviderInstanceUpdateInput,
    parseOpenAICompatibleModelCatalog,
    findSourceProvider,
    createProviderInstance,
    updateProviderInstance,
    readProviderProxy = unavailable,
    writeProviderProxy = unavailable,
    removeProviderProxy = unavailable,
    fetchWithProviderProxy = unavailable,
    loadProviderAuthLibrary = () => import('./auth.js'),
  } = dependencies;

  let authLibrary = null;
  const getAuthLibrary = async () => {
    if (!authLibrary) authLibrary = await loadProviderAuthLibrary();
    return authLibrary;
  };

  const errorResponse = (res, error, fallbackMessage) => {
    if (ProviderInstanceError && error instanceof ProviderInstanceError) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: fallbackMessage });
  };

  const resolveRequestDirectory = async (req) => {
    const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const queryDirectory = Array.isArray(req.query?.directory) ? req.query.directory[0] : req.query?.directory;
    const requestedDirectory = headerDirectory || queryDirectory || null;
    const resolved = await resolveProjectDirectory(req);
    if (resolved.directory) return resolved.directory;
    if (requestedDirectory) {
      throw new ProviderInstanceError(resolved.error || 'Invalid provider catalog directory', 400);
    }
    return null;
  };

  const fetchProviderCatalog = async (directory) => {
    const providerPath = directory ? `/provider?directory=${encodeURIComponent(directory)}` : '/provider';
    let response;
    try {
      response = await fetch(buildOpenCodeUrl(providerPath, ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
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

  const buildOpenAICompatibleModelsUrl = (baseURL) => {
    const parsed = new URL(baseURL);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/models`;
    return parsed.toString();
  };

  const normalizeStoredDiscoveryApiKey = (value) => {
    const apiKey = typeof value === 'string' ? value.trim() : '';
    return apiKey && apiKey.length <= 16_384 && !/[\u0000-\u001f\u007f]/.test(apiKey) ? apiKey : '';
  };

  const readBoundedJsonResponse = async (response) => {
    const contentLength = response.headers.get('content-length');
    if (contentLength && /^\d+$/.test(contentLength.trim())) {
      const declaredBytes = Number(contentLength);
      if (declaredBytes > MAX_OPENAI_COMPATIBLE_CATALOG_BYTES) {
        throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
      }
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_OPENAI_COMPATIBLE_CATALOG_BYTES) {
        throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
      }
      return JSON.parse(text);
    }

    const reader = response.body.getReader();
    const chunks = [];
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
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  const fetchOpenAICompatibleModelIds = async (baseURL, apiKey, proxy = { mode: 'direct' }) => {
    let response;
    try {
      response = await fetchWithProviderProxy(buildOpenAICompatibleModelsUrl(baseURL), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(OPENAI_COMPATIBLE_DISCOVERY_TIMEOUT_MS),
      }, proxy);
    } catch {
      throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
    }
    if (!response.ok) {
      throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
    }
    try {
      return parseOpenAICompatibleModelCatalog(await readBoundedJsonResponse(response));
    } catch (error) {
      if (error instanceof ProviderInstanceError) throw error;
      throw new ProviderInstanceError('Failed to load the OpenAI-compatible model catalog', 502);
    }
  };

  const providerProxiesEqual = (left, right) => (
    left?.mode === right?.mode && (left?.mode !== 'manual' || left?.url === right?.url)
  );

  const registerMutationRoutes = (app) => {
    app.post('/api/provider/instances', async (req, res) => {
      try {
        const input = validateProviderInstanceCreateInput(req.body);
        const directory = await resolveRequestDirectory(req);
        const { writeProviderApiKey } = await getAuthLibrary();
        let instance;
        if (input.sourceProviderId === OPENAI_COMPATIBLE_PROVIDER_ID) {
          const openAICompatibleModelIds = await fetchOpenAICompatibleModelIds(input.baseURL, input.apiKey, input.proxy);
          instance = createProviderInstance(
            { ...input, openAICompatibleModelIds },
            { randomUUID: () => crypto.randomUUID(), writeProviderApiKey, readProviderProxy, writeProviderProxy, removeProviderProxy },
          );
        } else {
          const sourceProvider = findSourceProvider(await fetchProviderCatalog(directory), input.sourceProviderId);
          instance = createProviderInstance(
            { ...input, sourceProvider },
            { randomUUID: () => crypto.randomUUID(), writeProviderApiKey, readProviderProxy, writeProviderProxy, removeProviderProxy },
          );
        }
        return res.status(201).json({ success: true, instance, requiresReload: true, restarted: false });
      } catch (error) {
        console.error('Failed to create managed provider instance');
        return errorResponse(res, error, 'Failed to create provider instance');
      }
    });

    app.put('/api/provider/:providerId/instance', async (req, res) => {
      try {
        const directory = await resolveRequestDirectory(req);
        const input = validateProviderInstanceUpdateInput(req.params.providerId, req.body);
        let openAICompatibleModelIds;
        if (input.managed && input.sourceProviderId === OPENAI_COMPATIBLE_PROVIDER_ID) {
          const providerSources = getProviderSources(input.providerId, directory);
          if (!providerSources?.sources?.user?.exists) {
            throw new ProviderInstanceError('Managed provider instance was not found in user configuration', 404);
          }
          const connection = getProviderConnectionMetadata(input.providerId, directory, { readProviderProxy });
          const effectiveBaseURL = input.baseURLProvided ? input.baseURL : connection.baseURL;
          const effectiveProxy = input.proxyProvided ? input.proxy : connection.proxy;
          if (!effectiveBaseURL) {
            throw new ProviderInstanceError('OpenAI-compatible provider requires a Base URL', 422);
          }
          const shouldRediscover = input.apiKey !== undefined
            || (input.baseURLProvided && input.baseURL !== connection.baseURL)
            || (input.proxyProvided && !providerProxiesEqual(input.proxy, connection.proxy));
          if (shouldRediscover) {
            let discoveryApiKey = input.apiKey;
            if (!discoveryApiKey) {
              const { getProviderAuth } = await getAuthLibrary();
              const storedAuth = getProviderAuth(input.providerId);
              discoveryApiKey = storedAuth?.type === 'api' ? normalizeStoredDiscoveryApiKey(storedAuth.key) : '';
            }
            if (!discoveryApiKey) {
              throw new ProviderInstanceError('API key is required to refresh the OpenAI-compatible model catalog');
            }
            openAICompatibleModelIds = await fetchOpenAICompatibleModelIds(effectiveBaseURL, discoveryApiKey, effectiveProxy);
          }
        }

        const { writeProviderApiKey } = await getAuthLibrary();
        const instance = updateProviderInstance(req.params.providerId, req.body, {
          writeProviderApiKey,
          readProviderProxy,
          writeProviderProxy,
          removeProviderProxy,
          workingDirectory: directory || undefined,
          ...(openAICompatibleModelIds ? { openAICompatibleModelIds } : {}),
        });
        return res.json({ success: true, instance, requiresReload: true, restarted: false });
      } catch (error) {
        console.error('Failed to update managed provider instance');
        return errorResponse(res, error, 'Failed to update provider instance');
      }
    });
  };

  return { errorResponse, getAuthLibrary, registerMutationRoutes, resolveRequestDirectory };
};
