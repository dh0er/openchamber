const PROVIDER_INSTANCE_MARKER = ':openchamber:';
const SENSITIVE_URL_QUERY_KEY_PATTERN = /(?:apikey|accesskey|token|secret|password|credential|signature|authorization|^auth$|^key$|^code$)/;

const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

export const OPENAI_COMPATIBLE_PROVIDER_TEMPLATE = {
  id: OPENAI_COMPATIBLE_PROVIDER_ID,
  name: 'OpenAI Compatible',
} as const;

interface ProviderTemplate {
  id: string;
  name?: string;
}

type ProviderSubscriptionState = 'available' | 'replaces-api-key' | 'connected';

export type ProviderProxyMode = 'direct' | 'system' | 'manual';

export interface ProviderProxySettings {
  mode: ProviderProxyMode;
  url: string;
}

interface ProviderProxyPayload {
  mode: ProviderProxyMode;
  url: string | null;
}

export const createDefaultProviderProxy = (): ProviderProxySettings => ({
  mode: 'direct',
  url: '',
});

export const normalizeProviderProxy = (value: unknown): ProviderProxySettings => {
  if (!value || typeof value !== 'object') return createDefaultProviderProxy();

  const candidate = value as Record<string, unknown>;
  const mode = candidate.mode === 'system' || candidate.mode === 'manual'
    ? candidate.mode
    : 'direct';

  return {
    mode,
    url: mode === 'manual' && typeof candidate.url === 'string' ? candidate.url : '',
  };
};

export const toProviderProxyPayload = (proxy: ProviderProxySettings): ProviderProxyPayload => ({
  mode: proxy.mode,
  url: proxy.mode === 'manual' ? new URL(proxy.url.trim()).origin : null,
});

export const shouldLoadAvailableProviders = (isAddMode: boolean): boolean => isAddMode;

export const isManagedProviderInstanceId = (providerId: string): boolean => {
  const markerIndex = providerId.lastIndexOf(PROVIDER_INSTANCE_MARKER);
  if (markerIndex <= 0) return false;

  const suffix = providerId.slice(markerIndex + PROVIDER_INSTANCE_MARKER.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suffix);
};

export const getProviderSourceId = (providerId: string): string => {
  if (!isManagedProviderInstanceId(providerId)) return providerId;
  return providerId.slice(0, providerId.lastIndexOf(PROVIDER_INSTANCE_MARKER));
};

export const getSelectableProviderTemplates = <T extends ProviderTemplate>(providers: T[]): Array<T | typeof OPENAI_COMPATIBLE_PROVIDER_TEMPLATE> => [
  ...providers.filter((provider) => (
    !isManagedProviderInstanceId(provider.id)
    && provider.id !== OPENAI_COMPATIBLE_PROVIDER_ID
  )),
  OPENAI_COMPATIBLE_PROVIDER_TEMPLATE,
];

export const isOpenAICompatibleProviderId = (providerId: string): boolean =>
  getProviderSourceId(providerId) === OPENAI_COMPATIBLE_PROVIDER_ID;

export const isProviderBaseUrlRequired = (providerId: string): boolean =>
  isOpenAICompatibleProviderId(providerId);

export const isOpenAICompatibleModelDiscoveryFailure = (
  providerId: string,
  status: number,
): boolean => isOpenAICompatibleProviderId(providerId) && (status === 422 || status === 502);

export const getProviderSubscriptionState = (authType?: string | null): ProviderSubscriptionState => {
  const normalized = authType?.trim().toLowerCase();
  if (normalized === 'api') return 'replaces-api-key';
  if (normalized) return 'connected';
  return 'available';
};

export const getSuggestedProviderInstanceName = (
  template: ProviderTemplate,
  connectedProviderIds: string[],
): string => {
  const displayName = template.name?.trim() || template.id;
  const instanceCount = connectedProviderIds.filter(
    (providerId) => getProviderSourceId(providerId) === template.id,
  ).length;

  return instanceCount === 0 ? displayName : `${displayName} ${instanceCount + 1}`;
};

export const isValidProviderBaseUrl = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return true;

  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash) {
      return false;
    }
    for (const key of url.searchParams.keys()) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (SENSITIVE_URL_QUERY_KEY_PATTERN.test(normalizedKey)) return false;
    }
    return true;
  } catch {
    return false;
  }
};

export const isValidProviderProxyUrl = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;

  try {
    const url = new URL(trimmed);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && url.pathname === '/'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
};
