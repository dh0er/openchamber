import { getModelsMetadata } from '../opencode/models-metadata.js';

const PROVIDER_INSTANCE_MARKER = ':openchamber:';
const PROVIDER_SOURCE_ID = /^[a-z0-9][a-z0-9._:@-]{0,127}$/i;
const PROVIDER_INSTANCE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);

// The models.dev catalog is shared with the /api/openchamber/models-metadata
// route through one in-process cache — no extra fetches, no cache files.
export async function getModelCatalog() {
  const { metadata } = await getModelsMetadata();
  return metadata;
}

export function getCatalogProvider(catalog, providerID) {
  const entry = catalog?.[providerID];
  return entry && typeof entry === 'object' ? entry : null;
}

export function isManagedProviderInstanceID(providerID) {
  if (typeof providerID !== 'string') return false;
  const markerIndex = providerID.lastIndexOf(PROVIDER_INSTANCE_MARKER);
  if (markerIndex <= 0) return false;
  const sourceID = providerID.slice(0, markerIndex);
  const instanceUUID = providerID.slice(markerIndex + PROVIDER_INSTANCE_MARKER.length);
  return PROVIDER_SOURCE_ID.test(sourceID) && PROVIDER_INSTANCE_UUID.test(instanceUUID);
}

// OpenChamber-managed instances intentionally keep their own provider/auth id,
// while their config's `id` points at the provider whose models and wire format
// were cloned. Require both signals to agree before treating an arbitrary
// config entry as a managed instance.
export function getProviderDescriptor(catalog, providerID, providerConfig) {
  const markerIndex = typeof providerID === 'string'
    ? providerID.lastIndexOf(PROVIDER_INSTANCE_MARKER)
    : -1;
  const idSource = isManagedProviderInstanceID(providerID)
    ? providerID.slice(0, markerIndex)
    : null;
  const configSource = isRecord(providerConfig) && typeof providerConfig.id === 'string'
    ? providerConfig.id.trim()
    : '';
  const isManaged = Boolean(idSource && configSource === idSource);
  const sourceID = isManaged ? idSource : providerID;
  const source = getCatalogProvider(catalog, sourceID);

  if (!isManaged) {
    return { sourceID, isManaged: false, provider: source };
  }

  const configuredModels = isRecord(providerConfig.models) ? providerConfig.models : null;
  if (!source && !configuredModels) {
    return { sourceID, isManaged: true, provider: null };
  }

  const configuredName = typeof providerConfig.name === 'string' ? providerConfig.name.trim() : '';
  return {
    sourceID,
    isManaged: true,
    provider: {
      ...(source || {}),
      id: providerID,
      ...(configuredName ? { name: configuredName } : {}),
      models: configuredModels || (isRecord(source?.models) ? source.models : {}),
    },
  };
}

export function getProviderModelDescriptor(provider, modelID) {
  const models = isRecord(provider?.models) ? provider.models : null;
  if (!models || typeof modelID !== 'string' || !modelID) return null;

  const direct = models[modelID];
  if (isRecord(direct)) {
    const apiID = typeof direct.id === 'string' && direct.id.trim() ? direct.id.trim() : modelID;
    return { configID: modelID, apiID, model: direct };
  }

  for (const [configID, model] of Object.entries(models)) {
    if (!isRecord(model) || typeof model.id !== 'string' || model.id.trim() !== modelID) continue;
    return { configID, apiID: modelID, model };
  }
  return null;
}
