import { getProviderDescriptor, isManagedProviderInstanceID } from './catalog.js';

// Mirrors OpenCode's getSmallModel fallback chain:
// 1. `small_model` from the merged config layers ("provider/model").
// 2. GitHub Copilot's hidden utility models when Copilot is logged in.
// 3. Family-priority scan of the authenticated providers' catalog models.
const FAMILY_PRIORITY = ['gemini-flash', 'gpt-nano', 'claude-haiku'];
const COPILOT_UTILITY_MODELS = ['gpt-5.4-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'];
// The ChatGPT-plan codex backend only accepts a small allowlist of models
// (nano/API-key models are rejected with 400) — this is its cheapest one.
const OPENAI_OAUTH_SMALL_MODEL = 'gpt-5.4-mini';

const AUTH_PROVIDER_ALIASES = {
  'github-copilot': ['github-copilot', 'copilot'],
};

export function getAuthEntryForProvider(auth, providerID) {
  const aliases = AUTH_PROVIDER_ALIASES[providerID] || [providerID];
  for (const alias of aliases) {
    const entry = auth?.[alias];
    if (entry && typeof entry === 'object') {
      return entry;
    }
  }
  return null;
}

export function isUsableAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'api') return typeof entry.key === 'string' && entry.key.length > 0;
  if (entry.type === 'oauth') {
    return (typeof entry.access === 'string' && entry.access.length > 0)
      || (typeof entry.refresh === 'string' && entry.refresh.length > 0);
  }
  if (entry.type === 'wellknown') return typeof entry.token === 'string' && entry.token.length > 0;
  return false;
}

export function parseModelRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

const pickByFamily = (models, family) => {
  const matches = Object.entries(models)
    .filter(([, model]) => model && typeof model === 'object' && model.family === family)
    .map(([configID, model]) => ({ configID, model }));
  if (matches.length === 0) return null;
  matches.sort((a, b) => String(b.model.release_date || '').localeCompare(String(a.model.release_date || '')));
  return matches[0];
};

const getProviderConfig = (providerConfigs, providerID) => {
  const entry = providerConfigs?.[providerID];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
};

const isUsableProviderAuth = (auth, providerID) => {
  const entry = getAuthEntryForProvider(auth, providerID);
  if (!isUsableAuthEntry(entry)) return false;
  // Managed instances are intentionally API-key identities. In particular,
  // never let an alias OAuth entry inherit the canonical provider's OAuth
  // dispatch (for example the ChatGPT subscription endpoint).
  return !isManagedProviderInstanceID(providerID) || entry.type === 'api';
};

// Small-model candidates within ONE provider, by family priority. Copilot and
// ChatGPT-plan OpenAI have fixed small models that never appear in the
// catalog; everyone else is scanned through the catalog families.
const pickWithinProvider = (providerID, auth, catalog, providerConfigs, family) => {
  if (providerID === 'openai' && auth.openai?.type === 'oauth') {
    return family === 'gpt-nano'
      ? { providerID, modelID: OPENAI_OAUTH_SMALL_MODEL, source: 'codex-small' }
      : null;
  }
  if (providerID === 'github-copilot') {
    return family === 'gpt-nano'
      ? { providerID, modelID: COPILOT_UTILITY_MODELS[0], source: 'copilot-utility' }
      : null;
  }
  const { isManaged, provider } = getProviderDescriptor(
    catalog,
    providerID,
    getProviderConfig(providerConfigs, providerID),
  );
  if (!provider || !provider.models || typeof provider.models !== 'object') return null;
  const match = pickByFamily(provider.models, family);
  if (!match) return null;
  const modelID = isManaged ? match.configID : match.model.id;
  return typeof modelID === 'string' && modelID
    ? { providerID, modelID, source: 'family-scan' }
    : null;
};

export function resolveSmallModel({ auth, catalog, providerConfigs, settingsSmallModel, configSmallModel, preferredProviderID, preferredModelID }) {
  // OpenChamber's own setting (Settings → Sessions → Small Model override)
  // outranks everything, including the OpenCode config.
  const fromSettings = parseModelRef(settingsSmallModel);
  if (fromSettings) {
    return { ...fromSettings, source: 'settings' };
  }

  const explicit = parseModelRef(configSmallModel);
  if (explicit) {
    return { ...explicit, source: 'config' };
  }

  // Like OpenCode: when the caller has a session context, the utility call
  // stays on the session's provider. Scan its families for a small model,
  // otherwise run on the session's own model — never silently switch to a
  // different provider's subscription.
  const preferred = typeof preferredProviderID === 'string' && preferredProviderID
    ? preferredProviderID
    : null;
  if (preferred && isUsableProviderAuth(auth, preferred)) {
    for (const family of FAMILY_PRIORITY) {
      const match = pickWithinProvider(preferred, auth, catalog, providerConfigs, family);
      if (match) return match;
    }
    if (typeof preferredModelID === 'string' && preferredModelID) {
      return { providerID: preferred, modelID: preferredModelID, source: 'session-model' };
    }
  }

  // No session context (or its provider has no usable login): scan all
  // authenticated providers by family priority.
  const authedProviders = Object.keys(auth || {}).filter((providerID) =>
    providerID !== preferred && isUsableProviderAuth(auth, providerID));

  for (const family of FAMILY_PRIORITY) {
    for (const providerID of authedProviders) {
      const match = pickWithinProvider(providerID, auth, catalog, providerConfigs, family);
      if (match) return match;
    }
  }

  // Copilot's utility fallback for legacy auth aliases the loop above missed.
  const copilotEntry = getAuthEntryForProvider(auth, 'github-copilot');
  if (isUsableAuthEntry(copilotEntry)) {
    return {
      providerID: 'github-copilot',
      modelID: COPILOT_UTILITY_MODELS[0],
      source: 'copilot-utility',
    };
  }

  return null;
}
