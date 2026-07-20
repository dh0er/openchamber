import type { ProviderProxySettings } from './providerAvailability';

export interface ProviderConnectionMetadata {
  sourceProviderId?: string;
  name?: string | null;
  baseURL?: string | null;
  proxy: ProviderProxySettings;
  managed?: boolean;
  authType?: string | null;
}

export interface ProviderConnectionValues {
  name: string;
  baseUrl: string;
  proxy: ProviderProxySettings;
}

export type ProviderMetadataStatus = 'loading' | 'loaded' | 'error';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const getProviderBaseUrl = (provider: unknown): string => {
  if (!isRecord(provider) || !isRecord(provider.options)) return '';
  return typeof provider.options.baseURL === 'string' ? provider.options.baseURL : '';
};

export const resolveAuthMethodIndex = (
  method: { method?: number },
  arrayIndex: number,
) => typeof method.method === 'number' && Number.isInteger(method.method)
  ? method.method
  : arrayIndex;
