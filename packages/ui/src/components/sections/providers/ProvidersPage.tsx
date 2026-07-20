import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsTwoColumn,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import type { ModelMetadata } from '@/types';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import {
  createDefaultProviderProxy,
  getProviderSourceId,
  getProviderSubscriptionState,
  getSelectableProviderTemplates,
  getSuggestedProviderInstanceName,
  isManagedProviderInstanceId,
  isOpenAICompatibleModelDiscoveryFailure,
  isOpenAICompatibleProviderId,
  isProviderBaseUrlRequired,
  isValidProviderBaseUrl,
  isValidProviderProxyUrl,
  normalizeProviderProxy,
  shouldLoadAvailableProviders,
  toProviderProxyPayload,
  type ProviderProxySettings,
} from './providerAvailability';
import { ProviderConnectionForm, ProviderIdentityFields } from './ProviderConnectionForm';
import {
  getProviderBaseUrl,
  resolveAuthMethodIndex,
  type ProviderConnectionMetadata,
  type ProviderConnectionValues,
  type ProviderMetadataStatus,
} from './providerInstanceData';

const formatCompactNumber = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
}).format(value);

const formatTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (value === 0) {
    return '0';
  }
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const ADD_PROVIDER_ID = '__add_provider__';

const getCurrentProviderDirectory = (): string | null => {
  const directory = opencodeClient.getDirectory();
  return typeof directory === 'string' && directory.trim() ? directory.trim() : null;
};

interface AuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  [key: string]: unknown;
}

interface ProviderOption {
  id: string;
  name?: string;
}

interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

interface ProviderSources {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeAuthType = (method: AuthMethod) => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

const parseAuthPayload = (payload: unknown): Record<string, AuthMethod[]> => {
  if (!isRecord(payload)) {
    return {};
  }
  const result: Record<string, AuthMethod[]> = {};
  for (const [providerId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      result[providerId] = value.filter((entry) => isRecord(entry)) as AuthMethod[];
    }
  }
  return result;
};

const normalizeProviderEntry = (entry: unknown): ProviderOption | null => {
  if (typeof entry === 'string') {
    return { id: entry };
  }
  if (!isRecord(entry)) {
    return null;
  }
  const idCandidate =
    (typeof entry.id === 'string' && entry.id) ||
    (typeof entry.providerID === 'string' && entry.providerID) ||
    (typeof entry.slug === 'string' && entry.slug) ||
    (typeof entry.name === 'string' && entry.name);
  if (!idCandidate) {
    return null;
  }
  const nameCandidate = typeof entry.name === 'string' ? entry.name : undefined;
  return { id: idCandidate, name: nameCandidate };
};

const parseProvidersPayload = (payload: unknown): ProviderOption[] => {
  let entries: unknown[] = [];

  if (Array.isArray(payload)) {
    entries = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.all)) {
      entries = payload.all;
    } else if (Array.isArray(payload.providers)) {
      entries = payload.providers;
    }
  }

  const mapped = entries
    .map((entry) => normalizeProviderEntry(entry))
    .filter((entry): entry is ProviderOption => Boolean(entry));

  const seen = new Set<string>();
  return mapped.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
};

export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);

  const [authMethodsByProvider, setAuthMethodsByProvider] = React.useState<Record<string, AuthMethod[]>>({});
  const [authLoading, setAuthLoading] = React.useState(false);
  const [apiKeyInputs, setApiKeyInputs] = React.useState<Record<string, string>>({});
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [modelQuery, setModelQuery] = React.useState('');
  const [pendingOAuth, setPendingOAuth] = React.useState<{ providerId: string; methodIndex: number } | null>(null);
  const [oauthCodes, setOauthCodes] = React.useState<Record<string, string>>({});
  const [oauthDetails, setOauthDetails] = React.useState<Record<string, { url?: string; instructions?: string; userCode?: string }>>({});
  const [availableProviders, setAvailableProviders] = React.useState<ProviderOption[]>([]);
  const [availableLoading, setAvailableLoading] = React.useState(false);
  const [availableError, setAvailableError] = React.useState<string | null>(null);
  const [candidateProviderId, setCandidateProviderId] = React.useState('');
  const [providerSearchQuery, setProviderSearchQuery] = React.useState('');
  const [providerDropdownOpen, setProviderDropdownOpen] = React.useState(false);
  const [providerSources, setProviderSources] = React.useState<Record<string, ProviderSources>>({});
  const [providerConnections, setProviderConnections] = React.useState<Record<string, ProviderConnectionMetadata>>({});
  const [providerMetadataStatus, setProviderMetadataStatus] = React.useState<Record<string, ProviderMetadataStatus>>({});
  const [showAuthPanel, setShowAuthPanel] = React.useState(false);
  const [candidateProviderName, setCandidateProviderName] = React.useState('');
  const [candidateBaseUrl, setCandidateBaseUrl] = React.useState('');
  const [candidateProxy, setCandidateProxy] = React.useState<ProviderProxySettings>(createDefaultProviderProxy);
  const [candidateSubscriptionName, setCandidateSubscriptionName] = React.useState('');
  const [candidateSubscriptionBaseUrl, setCandidateSubscriptionBaseUrl] = React.useState('');
  const [connectionInputs, setConnectionInputs] = React.useState<Record<string, ProviderConnectionValues>>({});
  const isAddMode = selectedProviderId === ADD_PROVIDER_ID;
  const providerDirectory = React.useMemo(() => {
    // The directory lives in the runtime-aware client; the project id makes
    // this snapshot react to Settings project switches.
    void activeProjectId;
    return getCurrentProviderDirectory();
  }, [activeProjectId]);

  React.useEffect(() => {
    if (!selectedProviderId && providers.length > 0) {
      setSelectedProvider(providers[0].id);
    }
  }, [providers, selectedProviderId, setSelectedProvider]);

  React.useEffect(() => {
    let isMounted = true;

    const loadAuthMethods = async () => {
      setAuthLoading(true);
      try {
        const result = await opencodeClient.getSdkClient().provider.auth();
        if (result.error) {
          throw new Error(`provider.auth failed: ${String(result.error)}`);
        }
        if (!isMounted) return;
        setAuthMethodsByProvider(parseAuthPayload(result.data));
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load provider auth methods:', error);
        toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
      } finally {
        if (isMounted) {
          setAuthLoading(false);
        }
      }
    };

    loadAuthMethods();

    return () => {
      isMounted = false;
    };
  }, [t]);

  React.useEffect(() => {
    if (!shouldLoadAvailableProviders(isAddMode)) {
      return;
    }

    let isMounted = true;

    const loadAvailableProviders = async () => {
      setAvailableLoading(true);
      setAvailableError(null);
      try {
        const result = await opencodeClient.getSdkClient().provider.list();
        if (result.error) {
          throw new Error(`provider.list failed: ${String(result.error)}`);
        }
        if (!isMounted) return;
        setAvailableProviders(parseProvidersPayload(result.data));
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load available providers:', error);
        setAvailableError(t('settings.providers.page.state.unableToLoadProviderList'));
      } finally {
        if (isMounted) {
          setAvailableLoading(false);
        }
      }
    };

    loadAvailableProviders();

    return () => {
      isMounted = false;
    };
  }, [isAddMode, t]);

  const selectableProviders = React.useMemo(
    () =>
      getSelectableProviderTemplates(availableProviders)
        .sort((a, b) => {
          const labelA = (a.name || a.id).toLowerCase();
          const labelB = (b.name || b.id).toLowerCase();
          return labelA.localeCompare(labelB);
        }),
    [availableProviders]
  );

  React.useEffect(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) {
      setShowAuthPanel(true);
      return;
    }

    setShowAuthPanel(false);
  }, [selectedProviderId, t]);

  React.useEffect(() => {
    if (isAddMode) return;
    setCandidateProviderId('');
    setCandidateProviderName('');
    setCandidateBaseUrl('');
    setCandidateProxy(createDefaultProviderProxy());
    setCandidateSubscriptionName('');
    setCandidateSubscriptionBaseUrl('');
    setProviderSearchQuery('');
  }, [isAddMode]);

  React.useEffect(() => {
    // API keys are write-only input. Never retain an unsaved credential when
    // the user changes provider context or closes the add-provider flow.
    setApiKeyInputs({});
  }, [candidateProviderId, selectedProviderId]);

  const providerMetadataId = isAddMode ? candidateProviderId : selectedProviderId;

  React.useEffect(() => {
    if (!providerMetadataId || providerMetadataId === ADD_PROVIDER_ID) {
      return;
    }

    if (isAddMode && isOpenAICompatibleProviderId(providerMetadataId)) {
      setProviderMetadataStatus((previous) => ({ ...previous, [providerMetadataId]: 'loaded' }));
      return;
    }

    let cancelled = false;

    const loadSources = async () => {
      setProviderMetadataStatus((previous) => ({ ...previous, [providerMetadataId]: 'loading' }));
      try {
        // OpenChamber-only metadata endpoint: the SDK exposes provider data but
        // not local auth/source-file provenance used by this settings UI.
        const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerMetadataId)}/source`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          ...(providerDirectory ? { query: { directory: providerDirectory } } : {}),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || t('settings.providers.page.toast.providerSourcesLoadFailed'));
        }

        const sources = (payload?.sources ?? payload?.data?.sources) as ProviderSources | undefined;
        const connectionValue = payload?.connection ?? payload?.data?.connection;
        const connection: ProviderConnectionMetadata | undefined = isRecord(connectionValue)
          ? {
              sourceProviderId: typeof connectionValue.sourceProviderId === 'string' ? connectionValue.sourceProviderId : undefined,
              name: typeof connectionValue.name === 'string' ? connectionValue.name : null,
              baseURL: typeof connectionValue.baseURL === 'string' ? connectionValue.baseURL : null,
              proxy: isManagedProviderInstanceId(providerMetadataId)
                ? normalizeProviderProxy(connectionValue.proxy)
                : createDefaultProviderProxy(),
              managed: connectionValue.managed === true,
              authType: typeof connectionValue.authType === 'string' ? connectionValue.authType : null,
            }
          : undefined;
        if (!cancelled) {
          if (sources) {
            setProviderSources((prev) => ({
              ...prev,
              [providerMetadataId]: sources,
            }));
          }
          if (connection) {
            setProviderConnections((prev) => ({
              ...prev,
              [providerMetadataId]: connection,
            }));

            if (isAddMode) {
              const provider = availableProviders.find((entry) => entry.id === providerMetadataId);
              setCandidateSubscriptionName(connection.name || provider?.name || providerMetadataId);
              setCandidateSubscriptionBaseUrl(connection.baseURL || '');
            } else {
              const provider = providers.find((entry) => entry.id === providerMetadataId);
              setConnectionInputs((previous) => ({
                ...previous,
                [providerMetadataId]: {
                  name: connection.name || provider?.name || providerMetadataId,
                  baseUrl: connection.baseURL || '',
                  proxy: connection.proxy,
                },
              }));
            }
          }
          setProviderMetadataStatus((previous) => ({ ...previous, [providerMetadataId]: 'loaded' }));
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load provider sources:', error);
          setProviderMetadataStatus((previous) => ({ ...previous, [providerMetadataId]: 'error' }));
        }
      }
    };

    loadSources();

    return () => {
      cancelled = true;
    };
  }, [availableProviders, isAddMode, providerDirectory, providerMetadataId, providers, t]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedSources = selectedProviderId ? providerSources[selectedProviderId] : undefined;

  React.useEffect(() => {
    if (!selectedProvider) return;

    setConnectionInputs((previous) => {
      if (previous[selectedProvider.id]) return previous;
      return {
        ...previous,
        [selectedProvider.id]: {
          name: selectedProvider.name || selectedProvider.id,
          baseUrl: getProviderBaseUrl(selectedProvider),
          proxy: createDefaultProviderProxy(),
        },
      };
    });
  }, [selectedProvider]);

  const validateConnectionValues = (
    providerId: string,
    name: string,
    baseUrl: string,
    proxy: ProviderProxySettings,
    apiKey?: string,
  ) => {
    if (!name.trim()) {
      toast.error(t('settings.providers.page.toast.instanceNameRequired'));
      return false;
    }
    if (isProviderBaseUrlRequired(providerId) && !baseUrl.trim()) {
      toast.error(t('settings.providers.page.toast.baseUrlRequired'));
      return false;
    }
    if (!isValidProviderBaseUrl(baseUrl)) {
      toast.error(t('settings.providers.page.toast.baseUrlInvalid'));
      return false;
    }
    if (proxy.mode === 'manual' && !proxy.url.trim()) {
      toast.error(t('settings.providers.page.toast.proxyUrlRequired'));
      return false;
    }
    if (proxy.mode === 'manual' && !isValidProviderProxyUrl(proxy.url)) {
      toast.error(t('settings.providers.page.toast.proxyUrlInvalid'));
      return false;
    }
    if (apiKey !== undefined && !apiKey.trim()) {
      toast.error(t('settings.providers.page.toast.apiKeyRequired'));
      return false;
    }
    return true;
  };

  const parseProviderInstanceResponse = async (response: Response, providerId: string) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (isOpenAICompatibleModelDiscoveryFailure(providerId, response.status)) {
        throw new Error(t('settings.providers.page.toast.modelsLoadFailed'));
      }
      throw new Error(t('settings.providers.page.toast.connectionSaveFailed'));
    }
    return payload;
  };

  const reloadProvidersAfterMutation = async () => {
    try {
      await reloadOpenCodeConfiguration({ scopes: ['providers'], mode: 'active' });
      return true;
    } catch (error) {
      console.error('OpenCode provider reload failed:', error);
      return false;
    }
  };

  const saveProviderConnectionConfig = async (
    providerId: string,
    values: ProviderConnectionValues & { apiKey?: string; credentialMode?: 'oauth' },
  ) => {
    const directory = getCurrentProviderDirectory();
    const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/instance`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(directory ? { query: { directory } } : {}),
      body: JSON.stringify({
        name: values.name.trim(),
        baseURL: values.baseUrl.trim(),
        ...(isManagedProviderInstanceId(providerId)
          ? { proxy: toProviderProxyPayload(values.proxy) }
          : {}),
        ...(values.apiKey?.trim() ? { apiKey: values.apiKey.trim() } : {}),
        ...(values.credentialMode ? { credentialMode: values.credentialMode } : {}),
      }),
    });
    return parseProviderInstanceResponse(response, providerId);
  };

  const handleCreateApiKeyInstance = async (sourceProviderId: string) => {
    const apiKey = apiKeyInputs[sourceProviderId]?.trim() ?? '';
    if (!validateConnectionValues(
      sourceProviderId,
      candidateProviderName,
      candidateBaseUrl,
      candidateProxy,
      apiKey,
    )) return;

    const busyKey = `api:${sourceProviderId}`;
    setAuthBusyKey(busyKey);

    try {
      const directory = getCurrentProviderDirectory();
      const response = await runtimeFetch('/api/provider/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(directory ? { query: { directory } } : {}),
        body: JSON.stringify({
          sourceProviderId,
          name: candidateProviderName.trim(),
          baseURL: candidateBaseUrl.trim(),
          proxy: toProviderProxyPayload(candidateProxy),
          apiKey,
        }),
      });
      const payload = await parseProviderInstanceResponse(response, sourceProviderId);
      const instanceId = payload?.instance?.id
        ?? payload?.instance?.providerId
        ?? payload?.instanceId
        ?? payload?.id;
      if (typeof instanceId !== 'string' || !instanceId) {
        throw new Error(t('settings.providers.page.toast.connectionSaveFailed'));
      }

      setApiKeyInputs((previous) => ({ ...previous, [sourceProviderId]: '' }));
      const reloaded = await reloadProvidersAfterMutation();
      setSelectedProvider(instanceId);
      if (reloaded) {
        toast.success(t('settings.providers.page.toast.instanceConnected'));
      } else {
        toast.warning(t('settings.providers.page.toast.savedReloadFailed'));
      }
    } catch (error) {
      console.error('Failed to create provider instance:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.connectionSaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleSaveProviderConnection = async (providerId: string) => {
    const values = connectionInputs[providerId];
    if (
      providerMetadataStatus[providerId] !== 'loaded'
      || !providerConnections[providerId]
      || !values
    ) {
      toast.error(t('settings.providers.page.toast.providerSourcesLoadFailed'));
      return;
    }
    const apiKey = apiKeyInputs[providerId]?.trim() ?? '';
    if (!validateConnectionValues(providerId, values.name, values.baseUrl, values.proxy)) return;

    const busyKey = `api:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const payload = await saveProviderConnectionConfig(providerId, {
        ...values,
        ...(apiKey ? { apiKey } : {}),
      });
      const savedName = typeof payload?.instance?.name === 'string' ? payload.instance.name : values.name.trim();
      const savedBaseUrl = typeof payload?.instance?.baseURL === 'string'
        ? payload.instance.baseURL
        : payload?.instance?.baseURL === null
          ? ''
          : values.baseUrl.trim();
      const savedProxy = payload?.instance && Object.hasOwn(payload.instance, 'proxy')
        ? normalizeProviderProxy(payload.instance.proxy)
        : values.proxy;
      setConnectionInputs((previous) => ({
        ...previous,
        [providerId]: { name: savedName, baseUrl: savedBaseUrl, proxy: savedProxy },
      }));
      setApiKeyInputs((previous) => ({ ...previous, [providerId]: '' }));
      setProviderConnections((previous) => ({
        ...previous,
        [providerId]: {
          ...previous[providerId],
          proxy: savedProxy,
          ...(apiKey ? { authType: 'api' } : {}),
        },
      }));
      const reloaded = await reloadProvidersAfterMutation();
      setSelectedProvider(providerId);
      if (reloaded) {
        toast.success(t('settings.providers.page.toast.connectionSaved'));
      } else {
        toast.warning(t('settings.providers.page.toast.savedReloadFailed'));
      }
    } catch (error) {
      console.error('Failed to save provider connection:', error);
      toast.error(error instanceof Error ? error.message : t('settings.providers.page.toast.connectionSaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const getConnectionValuesForProvider = (providerId: string) => {
    if (isAddMode && candidateProviderId === providerId) {
      return {
        name: candidateSubscriptionName,
        baseUrl: candidateSubscriptionBaseUrl,
        proxy: createDefaultProviderProxy(),
      };
    }

    return connectionInputs[providerId] ?? {
      name: providers.find((provider) => provider.id === providerId)?.name || providerId,
      baseUrl: getProviderBaseUrl(providers.find((provider) => provider.id === providerId)),
      proxy: createDefaultProviderProxy(),
    };
  };

  const handleOAuthStart = async (providerId: string, methodIndex: number) => {
    const connectionValues = getConnectionValuesForProvider(providerId);
    if (!validateConnectionValues(
      providerId,
      connectionValues.name,
      connectionValues.baseUrl,
      connectionValues.proxy,
    )) return;

    const busyKey = `oauth:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);

    try {
      const result = await opencodeClient.getSdkClient().provider.oauth.authorize({
        providerID: providerId,
        method: methodIndex,
      });
      if (result.error) {
        throw new Error(t('settings.providers.page.toast.oauthStartFailed'));
      }

      const payloadRecord: Record<string, unknown> = isRecord(result.data) ? result.data : {};
      const nestedData = payloadRecord.data;
      const dataRecord: Record<string, unknown> = isRecord(nestedData) ? nestedData : payloadRecord;
      const urlCandidate =
        (typeof dataRecord.url === 'string' && dataRecord.url) ||
        (typeof dataRecord.verification_uri_complete === 'string' && dataRecord.verification_uri_complete) ||
        (typeof dataRecord.verification_uri === 'string' && dataRecord.verification_uri) ||
        undefined;
      const instructions =
        (typeof dataRecord.instructions === 'string' && dataRecord.instructions) ||
        (typeof dataRecord.message === 'string' && dataRecord.message) ||
        undefined;
      const userCode =
        (typeof dataRecord.user_code === 'string' && dataRecord.user_code) ||
        (typeof dataRecord.code === 'string' && dataRecord.code) ||
        (typeof dataRecord.userCode === 'string' && dataRecord.userCode) ||
        undefined;

      if (!urlCandidate && !instructions && !userCode) {
        throw new Error(t('settings.providers.page.toast.oauthDetailsMissing'));
      }

      const detailsKey = `${providerId}:${methodIndex}`;
      setOauthDetails((prev) => ({
        ...prev,
        [detailsKey]: {
          url: urlCandidate,
          instructions,
          userCode,
        },
      }));

      if (urlCandidate) {
        void openExternalUrl(urlCandidate);
      }
      setPendingOAuth({ providerId, methodIndex });
      toast.message(t('settings.providers.page.toast.completeOAuthInBrowser'));
    } catch (error) {
      console.error('Failed to start OAuth flow:', error);
      toast.error(t('settings.providers.page.toast.oauthStartFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleOAuthComplete = async (providerId: string, methodIndex: number) => {
    const codeKey = `${providerId}:${methodIndex}`;
    const code = oauthCodes[codeKey]?.trim();

    const busyKey = `oauth-complete:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);
    let oauthConnected = false;

    try {
      const requestBody: { method: number; code?: string } = { method: methodIndex };
      if (code) {
        requestBody.code = code;
      }

      const result = await opencodeClient.getSdkClient().provider.oauth.callback({
        providerID: providerId,
        method: requestBody.method,
        code: requestBody.code,
      });
      if (result.error) {
        throw new Error(t('settings.providers.page.toast.oauthCompleteFailed'));
      }

      oauthConnected = true;
      const connectionValues = getConnectionValuesForProvider(providerId);
      setProviderConnections((prev) => ({
        ...prev,
        [providerId]: {
          ...prev[providerId],
          proxy: connectionValues.proxy,
          authType: 'oauth',
        },
      }));
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      setOauthCodes((prev) => ({ ...prev, [codeKey]: '' }));
      setPendingOAuth(null);
      await saveProviderConnectionConfig(providerId, { ...connectionValues, credentialMode: 'oauth' });
      const reloaded = await reloadProvidersAfterMutation();
      setSelectedProvider(providerId);
      if (reloaded) {
        toast.success(t('settings.providers.page.toast.oauthCompleted'));
      } else {
        toast.warning(t('settings.providers.page.toast.savedReloadFailed'));
      }
    } catch (error) {
      console.error('Failed to complete OAuth flow:', error);
      if (oauthConnected) {
        await reloadProvidersAfterMutation();
        setSelectedProvider(providerId);
        toast.warning(t('settings.providers.page.toast.oauthConnectedSettingsSaveFailed'));
      } else {
        toast.error(t('settings.providers.page.toast.oauthCompleteFailed'));
      }
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleCopyOAuthLink = async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.oauthLinkCopied'));
      return;
    }
    console.error('Failed to copy OAuth link:', result.error);
    toast.error(t('settings.providers.page.toast.oauthLinkCopyFailed'));
  };

  const handleCopyOAuthCode = async (code: string) => {
    const result = await copyTextToClipboard(code);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.deviceCodeCopied'));
      return;
    }
    console.error('Failed to copy device code:', result.error);
    toast.error(t('settings.providers.page.toast.deviceCodeCopyFailed'));
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const busyKey = `disconnect:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const directory = getCurrentProviderDirectory();
      const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/auth?scope=all`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
        ...(directory ? { query: { directory } } : {}),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.providerDisconnectFailed'));
      }

      toast.success(t('settings.providers.page.toast.providerDisconnected'));
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      toast.error(t('settings.providers.page.toast.providerDisconnectFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  if (!isAddMode && providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.noProvidersDetected')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.checkOpenCodeConfiguration')}</p>
        </div>
      </div>
    );
  }

  if (isAddMode) {
    return (
      <SettingsPageLayout
        title={t('settings.providers.page.connect.title')}
        showSaveStatus={false}
      >
        <SettingsSection
          title={t('settings.providers.page.connect.selectProviderTitle')}
          divider={false}
          settingsItem="providers.connect"
        >
              <div className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="typography-ui-label text-foreground">{t('settings.providers.page.connect.providerField')}</span>
                  {availableLoading ? (
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.page.state.loading')}</p>
                  ) : availableError ? (
                    <p className="typography-meta text-muted-foreground">{availableError}</p>
                  ) : selectableProviders.length === 0 ? (
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersAvailable')}</p>
                  ) : (
                    <DropdownMenu open={providerDropdownOpen} onOpenChange={(open) => {
                      setProviderDropdownOpen(open);
                      if (!open) setProviderSearchQuery('');
                    }}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {candidateProviderId ? <ProviderLogo providerId={candidateProviderId} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                            <span className={cn("truncate typography-ui-label font-normal", candidateProviderId ? "text-foreground" : "text-muted-foreground")}>
                              {candidateProviderId
                                ? (selectableProviders.find(p => p.id === candidateProviderId)?.name || candidateProviderId)
                                : t('settings.providers.page.connect.selectProviderPlaceholder')}
                            </span>
                          </span>
                          <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="w-[280px] p-0"
                        onCloseAutoFocus={(e) => e.preventDefault()}
                      >
                        <div
                          className="flex items-center gap-2 border-b border-[var(--surface-subtle)] px-3 py-2"
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Icon name="search" className="h-4 w-4 text-muted-foreground" />
                          <input
                            type="text"
                            value={providerSearchQuery}
                            onChange={(e) => setProviderSearchQuery(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            placeholder={t('settings.providers.page.connect.searchProvidersPlaceholder')}
                            className="flex-1 bg-transparent typography-meta outline-none placeholder:text-muted-foreground"
                            autoFocus
                          />
                        </div>
                        <ScrollableOverlay outerClassName="max-h-[240px]" className="p-1">
                          {(() => {
                            const filtered = selectableProviders.filter(p => {
                              const query = providerSearchQuery.toLowerCase();
                              return (p.name || p.id).toLowerCase().includes(query) || p.id.toLowerCase().includes(query);
                            });
                            if (filtered.length === 0) {
                              return <p className="py-4 text-center typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersFound')}</p>;
                            }
                            return filtered.map((provider) => (
                              <DropdownMenuItem
                                key={provider.id}
                                onSelect={() => {
                                  setCandidateProviderId(provider.id);
                                  setCandidateProviderName(getSuggestedProviderInstanceName(
                                    provider,
                                    providers.map((connectedProvider) => connectedProvider.id),
                                  ));
                                  setCandidateBaseUrl('');
                                  setCandidateProxy(createDefaultProviderProxy());
                                  setCandidateSubscriptionName(provider.name || provider.id);
                                  setCandidateSubscriptionBaseUrl('');
                                  setProviderMetadataStatus((previous) => ({
                                    ...previous,
                                    [provider.id]: 'loading',
                                  }));
                                  setProviderDropdownOpen(false);
                                  setProviderSearchQuery('');
                                }}
                                className="flex items-center justify-between"
                              >
                                <span className="flex items-center gap-2 min-w-0">
                                  <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
                                  <span className="truncate">{provider.name || provider.id}</span>
                                </span>
                                {candidateProviderId === provider.id && (
                                  <Icon name="check" className="h-4 w-4 text-[var(--primary-base)]" />
                                )}
                              </DropdownMenuItem>
                            ));
                          })()}
                        </ScrollableOverlay>
                      </DropdownMenuContent>
                    </DropdownMenu>
                   )}
              </div>
        </SettingsSection>

          {candidateProviderId && (
            <SettingsSection
              title={t('settings.providers.page.auth.title')}
              settingsItem="providers.auth"
              contentClassName="space-y-4"
            >
              {authLoading ? (
                <p className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</p>
              ) : (
                <>
                  <ProviderConnectionForm
                    name={candidateProviderName}
                    apiKey={apiKeyInputs[candidateProviderId] ?? ''}
                    baseUrl={candidateBaseUrl}
                    proxy={candidateProxy}
                    baseUrlRequired={isProviderBaseUrlRequired(candidateProviderId)}
                    apiKeyRequired
                    busy={authBusyKey === `api:${candidateProviderId}`}
                    onNameChange={setCandidateProviderName}
                    onApiKeyChange={(value) => setApiKeyInputs((previous) => ({
                      ...previous,
                      [candidateProviderId]: value,
                    }))}
                    onBaseUrlChange={setCandidateBaseUrl}
                    onProxyChange={setCandidateProxy}
                    onSubmit={() => handleCreateApiKeyInstance(candidateProviderId)}
                  />

                  {(() => {
                    const candidateAuthMethods = authMethodsByProvider[candidateProviderId] ?? [];
                    const candidateOAuthMethods = candidateAuthMethods
                      .map((method, arrayIndex) => ({
                        method,
                        methodIndex: resolveAuthMethodIndex(method, arrayIndex),
                      }))
                      .filter(({ method }) => normalizeAuthType(method) === 'oauth');

                    if (candidateOAuthMethods.length === 0) {
                      return null;
                    }

                    const metadataStatus = providerMetadataStatus[candidateProviderId];
                    const connection = providerConnections[candidateProviderId];
                    if (!metadataStatus || metadataStatus === 'loading') {
                      return (
                        <p className="border-t border-[var(--surface-subtle)] pt-3 typography-meta text-muted-foreground">
                          {t('settings.providers.page.state.loading')}
                        </p>
                      );
                    }
                    if (metadataStatus === 'error' || !connection) {
                      return (
                        <p className="border-t border-[var(--surface-subtle)] pt-3 typography-meta text-muted-foreground">
                          {t('settings.providers.page.toast.providerSourcesLoadFailed')}
                        </p>
                      );
                    }

                    const subscriptionState = getProviderSubscriptionState(connection.authType);
                    if (subscriptionState === 'connected') {
                      return (
                        <p className="border-t border-[var(--surface-subtle)] pt-3 typography-meta text-muted-foreground">
                          {t('settings.providers.page.auth.subscriptionAlreadyConnected')}
                        </p>
                      );
                    }

                    return (
                      <div className="space-y-4 border-t border-[var(--surface-subtle)] pt-2">
                        {subscriptionState === 'replaces-api-key' && (
                          <p className="typography-meta text-muted-foreground">
                            {t('settings.providers.page.auth.apiKeyWillBeReplacedBySubscription')}
                          </p>
                        )}
                        <div className="typography-ui-label text-foreground">
                          {t('settings.providers.page.auth.subscriptionConnection')}
                        </div>
                        <SettingsTwoColumn className="gap-y-5">
                          <ProviderIdentityFields
                            name={candidateSubscriptionName}
                            baseUrl={candidateSubscriptionBaseUrl}
                            showProxy={false}
                            onNameChange={setCandidateSubscriptionName}
                            onBaseUrlChange={setCandidateSubscriptionBaseUrl}
                          />
                        </SettingsTwoColumn>
                        {candidateOAuthMethods.map(({ method, methodIndex }) => {
                          const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(methodIndex + 1) });
                          const codeKey = `${candidateProviderId}:${methodIndex}`;
                          const isPending =
                            pendingOAuth?.providerId === candidateProviderId && pendingOAuth?.methodIndex === methodIndex;

                          return (
                            <div key={`${candidateProviderId}-${methodLabel}`} className="space-y-3">
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <div className="typography-ui-label text-foreground">{methodLabel}</div>
                                  {(method.description || method.help) && (
                                    <div className="typography-meta text-muted-foreground">
                                      {String(method.description || method.help)}
                                    </div>
                                  )}
                                </div>
                                <Button
                                  variant="outline"
                                  size="xs"
                                  className="!font-normal"
                                  onClick={() => handleOAuthStart(candidateProviderId, methodIndex)}
                                  disabled={authBusyKey === `oauth:${candidateProviderId}:${methodIndex}`}
                                >
                                  {t('settings.providers.page.actions.connect')}
                                </Button>
                              </div>

                              {oauthDetails[codeKey]?.instructions && (
                                <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                                  {oauthDetails[codeKey]?.instructions}
                                </p>
                              )}

                              {oauthDetails[codeKey]?.userCode && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                                  <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                                </div>
                              )}

                              {oauthDetails[codeKey]?.url && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                                  <div className="flex gap-1 shrink-0">
                                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                                  </div>
                                </div>
                              )}

                              {isPending && (
                                <div className="flex items-center gap-2 mt-2">
                                  <Input
                                    value={oauthCodes[codeKey] ?? ''}
                                    onChange={(event) =>
                                      setOauthCodes((prev) => ({
                                        ...prev,
                                        [codeKey]: event.target.value,
                                      }))
                                    }
                                    placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                    className="font-mono text-xs"
                                  />
                                  <Button
                                    size="xs"
                                    className="!font-normal"
                                    onClick={() => handleOAuthComplete(candidateProviderId, methodIndex)}
                                    disabled={authBusyKey === `oauth-complete:${candidateProviderId}:${methodIndex}`}
                                  >
                                    {authBusyKey === `oauth-complete:${candidateProviderId}:${methodIndex}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                                  </Button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </>
              )}
            </SettingsSection>
          )}
      </SettingsPageLayout>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.selectProviderFromSidebar')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.reviewDetailsAndConfigureAuth')}</p>
        </div>
      </div>
    );
  }

  const providerModels = Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
  const selectedProviderSourceId = getProviderSourceId(selectedProvider.id);
  const selectedProviderIsManaged = isManagedProviderInstanceId(selectedProvider.id);
  const selectedSubscriptionState = getProviderSubscriptionState(
    providerConnections[selectedProvider.id]?.authType,
  );
  const selectedMetadataStatus = providerMetadataStatus[selectedProvider.id];
  const selectedMetadataReady = selectedMetadataStatus === 'loaded'
    && Boolean(providerConnections[selectedProvider.id]);
  const providerAuthMethods = selectedProviderIsManaged
    ? []
    : authMethodsByProvider[selectedProviderSourceId] ?? [];
  const oauthAuthMethods = providerAuthMethods
    .map((method, arrayIndex) => ({
      method,
      methodIndex: resolveAuthMethodIndex(method, arrayIndex),
    }))
    .filter(({ method }) => normalizeAuthType(method) === 'oauth');
  const selectedConnectionInput = connectionInputs[selectedProvider.id] ?? {
    name: selectedProvider.name || selectedProvider.id,
    baseUrl: getProviderBaseUrl(selectedProvider),
    proxy: createDefaultProviderProxy(),
  };

  const filteredModels = providerModels.filter((model) => {
    const name = typeof model?.name === 'string' ? model.name : '';
    const id = typeof model?.id === 'string' ? model.id : '';
    const query = modelQuery.trim().toLowerCase();
    if (!query) return true;
    return name.toLowerCase().includes(query) || id.toLowerCase().includes(query);
  });

  return (
    <SettingsPageLayout
      title={selectedProvider.name || selectedProvider.id}
      titleLeading={<ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />}
      description={<span className="font-mono typography-settings-description text-muted-foreground">{selectedProvider.id}</span>}
      showSaveStatus={false}
    >
      <SettingsSection
        title={t('settings.providers.page.auth.title')}
        divider={false}
        headerAction={(
          <Button
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => setShowAuthPanel((prev) => !prev)}
          >
            {showAuthPanel ? t('settings.providers.page.actions.hide') : t('settings.providers.page.actions.reconnect')}
          </Button>
        )}
        settingsItem="providers.auth"
      >
            {!showAuthPanel ? (
              <div className="flex items-center gap-1.5 py-1.5">
                <Icon name="check" className="w-4 h-4 text-[var(--status-success)] shrink-0" />
                <span className="typography-ui-label text-foreground">{t('settings.providers.page.auth.connected')}</span>
                <SettingsInfoHint>{t('settings.providers.page.auth.useReconnectHint')}</SettingsInfoHint>
              </div>
            ) : authLoading ? (
              <div className="py-1.5 typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</div>
            ) : (
              <div className="space-y-4">
                {!selectedMetadataReady ? (
                  <p className="border-t border-[var(--surface-subtle)] pt-3 typography-meta text-muted-foreground">
                    {selectedMetadataStatus === 'error'
                      ? t('settings.providers.page.toast.providerSourcesLoadFailed')
                      : t('settings.providers.page.state.loading')}
                  </p>
                ) : (
                  <ProviderConnectionForm
                    name={selectedConnectionInput.name}
                    apiKey={apiKeyInputs[selectedProvider.id] ?? ''}
                    baseUrl={selectedConnectionInput.baseUrl}
                    proxy={selectedConnectionInput.proxy}
                    baseUrlRequired={isProviderBaseUrlRequired(selectedProvider.id)}
                    showProxy={selectedProviderIsManaged}
                    apiKeyRequired={false}
                    showApiKey={selectedProviderIsManaged || selectedSubscriptionState !== 'connected'}
                    busy={authBusyKey === `api:${selectedProvider.id}`}
                    onNameChange={(value) => setConnectionInputs((previous) => ({
                      ...previous,
                      [selectedProvider.id]: { ...selectedConnectionInput, name: value },
                    }))}
                    onApiKeyChange={(value) => setApiKeyInputs((previous) => ({
                      ...previous,
                      [selectedProvider.id]: value,
                    }))}
                    onBaseUrlChange={(value) => setConnectionInputs((previous) => ({
                      ...previous,
                      [selectedProvider.id]: { ...selectedConnectionInput, baseUrl: value },
                    }))}
                    onProxyChange={(value) => setConnectionInputs((previous) => ({
                      ...previous,
                      [selectedProvider.id]: { ...selectedConnectionInput, proxy: value },
                    }))}
                    onSubmit={() => handleSaveProviderConnection(selectedProvider.id)}
                  />
                )}

                {selectedMetadataReady && oauthAuthMethods.length > 0 && (
                  <div className="space-y-4 border-t border-[var(--surface-subtle)] pt-2">
                    {selectedSubscriptionState === 'replaces-api-key' && (
                      <p className="typography-meta text-muted-foreground">
                        {t('settings.providers.page.auth.apiKeyWillBeReplacedBySubscription')}
                      </p>
                    )}
                    {oauthAuthMethods.map(({ method, methodIndex }) => {
                      const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(methodIndex + 1) });
                      const codeKey = `${selectedProvider.id}:${methodIndex}`;
                      const isPending =
                        pendingOAuth?.providerId === selectedProvider.id && pendingOAuth?.methodIndex === methodIndex;

                      return (
                        <div key={`${selectedProvider.id}-${methodLabel}`} className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="typography-ui-label text-foreground">{methodLabel}</div>
                              {(method.description || method.help) && (
                                <div className="typography-meta text-muted-foreground">
                                  {String(method.description || method.help)}
                                </div>
                              )}
                            </div>
                            <Button
                              variant="outline"
                              size="xs"
                              className="!font-normal"
                              onClick={() => handleOAuthStart(selectedProvider.id, methodIndex)}
                              disabled={authBusyKey === `oauth:${selectedProvider.id}:${methodIndex}`}
                            >
                              {t('settings.providers.page.actions.connect')}
                            </Button>
                          </div>

                          {oauthDetails[codeKey]?.instructions && (
                            <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                              {oauthDetails[codeKey]?.instructions}
                            </p>
                          )}

                          {oauthDetails[codeKey]?.userCode && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                              <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                            </div>
                          )}

                          {oauthDetails[codeKey]?.url && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                              <div className="flex gap-1 shrink-0">
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                              </div>
                            </div>
                          )}

                          {isPending && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input
                                value={oauthCodes[codeKey] ?? ''}
                                onChange={(event) =>
                                  setOauthCodes((prev) => ({
                                    ...prev,
                                    [codeKey]: event.target.value,
                                  }))
                                }
                                placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                className="font-mono text-xs"
                              />
                              <Button
                                size="xs"
                                className="!font-normal"
                                onClick={() => handleOAuthComplete(selectedProvider.id, methodIndex)}
                                disabled={authBusyKey === `oauth-complete:${selectedProvider.id}:${methodIndex}`}
                              >
                                {authBusyKey === `oauth-complete:${selectedProvider.id}:${methodIndex}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
      </SettingsSection>


      <SettingsSection
        title={t('settings.providers.page.connectionDetails.title')}
        settingsItem="providers.connection-details"
      >
            <div className="flex flex-col gap-2 py-1.5 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-8">
              <div className="flex min-w-0 flex-col">
                {selectedSources && (selectedSources.auth.exists || selectedSources.user.exists || selectedSources.project.exists || selectedSources.custom?.exists) ? (
                  <span className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.connectionDetails.configuredIn')}{' '}
                    {[
                      selectedSources.auth.exists ? t('settings.providers.page.connectionDetails.source.authCredentials') : null,
                      selectedSources.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
                      selectedSources.project.exists ? t('settings.providers.page.connectionDetails.source.projectConfig') : null,
                      selectedSources.custom?.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
                    ].filter(Boolean).join(', ')}
                  </span>
                ) : (
                  <span className="typography-meta text-muted-foreground">{t('settings.providers.page.connectionDetails.noActiveSource')}</span>
                )}
              </div>

              <Button
                variant="ghost"
                size="xs"
                className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                onClick={() => handleDisconnectProvider(selectedProvider.id)}
                disabled={authBusyKey === `disconnect:${selectedProvider.id}`}
              >
                {authBusyKey === `disconnect:${selectedProvider.id}` ? t('settings.providers.page.actions.disconnecting') : t('settings.providers.page.actions.disconnect')}
              </Button>
            </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.providers.page.models.title')}
        titleAccessory={
          providerModels.length > 0 ? (
            <span className="typography-micro text-muted-foreground font-normal">
              ({providerModels.length})
            </span>
          ) : null
        }
        headerAction={(
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => {
                const allIds = providerModels
                  .map((model) => (typeof model?.id === 'string' ? model.id : ''))
                  .filter((id) => id.length > 0);
                hideAllModels(selectedProvider.id, allIds);
              }}
            >
              {t('settings.providers.page.actions.hideAll')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => showAllModels(selectedProvider.id)}
            >
              {t('settings.providers.page.actions.showAll')}
            </Button>
          </div>
        )}
        settingsItem="providers.models"
      >
            <div className="relative mb-2">
              <Icon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={t('settings.providers.page.models.filterPlaceholder')}
                className="h-7 pl-8 w-full"
              />
            </div>

            {filteredModels.length === 0 ? (
              <p className="typography-meta text-muted-foreground py-4 text-center">{t('settings.providers.page.models.noModelsMatchFilter')}</p>
            ) : (
              <div className="divide-y divide-[var(--surface-subtle)]">
                {filteredModels.map((model) => {
                  const modelId = typeof model?.id === 'string' ? model.id : '';
                  const modelName = typeof model?.name === 'string' ? model.name : modelId;
                  const metadata = modelId ? getModelMetadata(selectedProvider.id, modelId) as ModelMetadata | undefined : undefined;
                  const isHidden = hiddenModels.some(
                    (item) => item.providerID === selectedProvider.id && item.modelID === modelId
                  );

                  const contextTokens = formatTokens(metadata?.limit?.context);
                  const outputTokens = formatTokens(metadata?.limit?.output);

                  const capabilityIcons: Array<{ key: string; icon: IconName; label: string }> = [];
                  if (metadata?.tool_call) capabilityIcons.push({ key: 'tools', icon: "tools", label: t('settings.providers.page.models.capability.toolCalling') });
                  if (metadata?.reasoning) capabilityIcons.push({ key: 'reasoning', icon: "brain-ai-3", label: t('settings.providers.page.models.capability.reasoning') });
                  if (metadata?.attachment) capabilityIcons.push({ key: 'image', icon: "file-image", label: t('settings.providers.page.models.capability.imageInput') });

                  return (
                    <div key={modelId} className="py-1.5">
                      <div
                        className={cn(
                          "flex items-center gap-3",
                          isHidden && 'opacity-50',
                        )}
                      >
                      <span className="typography-meta font-medium text-foreground truncate flex-1 min-w-0">
                        {modelName}
                      </span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {(contextTokens || outputTokens) && (
                          <span className="typography-micro text-muted-foreground flex-shrink-0 bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">
                            {contextTokens ? `${contextTokens} ${t('settings.providers.page.models.tokenBadge.context')}` : ''}
                            {contextTokens && outputTokens ? ' · ' : ''}
                            {outputTokens ? `${outputTokens} ${t('settings.providers.page.models.tokenBadge.output')}` : ''}
                          </span>
                        )}
                        {capabilityIcons.length > 0 && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {capabilityIcons.map(({ key, icon: iconName, label }) => (
                              <span
                                key={key}
                                className="flex h-5 w-5 rounded items-center justify-center text-muted-foreground bg-[var(--surface-muted)]"
                                title={label}
                                aria-label={label}
                              >
                                <Icon name={iconName} className="h-3 w-3" />
                              </span>
                            ))}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleHiddenModel(selectedProvider.id, modelId)}
                          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50"
                          title={isHidden ? t('settings.providers.page.models.actions.showModelInSelectors') : t('settings.providers.page.models.actions.hideModelFromSelectors')}
                          aria-label={isHidden ? t('settings.providers.page.models.actions.showModel') : t('settings.providers.page.models.actions.hideModel')}
                        >
                          {isHidden ? <Icon name="eye-off" className="h-3.5 w-3.5" /> : <Icon name="eye" className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
