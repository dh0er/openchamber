import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAuthFile } from '../opencode/auth.js';
import { readConfigLayers } from '../opencode/shared.js';
import {
  getModelCatalog,
  getProviderDescriptor,
  getProviderModelDescriptor,
  isManagedProviderInstanceID,
} from './catalog.js';
import { resolveSmallModel, parseModelRef, isUsableAuthEntry, getAuthEntryForProvider } from './resolve.js';
import { callSmallModel } from './call.js';

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

// OpenChamber's own settings: when the user unchecks "use default small model"
// their explicit override outranks every other resolution step.
const readSmallModelSettingsOverride = () => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object') return null;
    if (settings.smallModelUseDefault !== false) return null;
    const override = typeof settings.smallModelOverride === 'string' ? settings.smallModelOverride.trim() : '';
    return override || null;
  } catch {
    return null;
  }
};

// Rough safety clamp so a huge input never blows the model's context window.
// Token estimate is ~4 chars/token; when the catalog has no limit for the
// model (Copilot/codex utility models are not listed) a conservative default
// applies.
const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;

const clampPromptToModelLimit = ({ prompt, catalog, providerConfigs, providerID, modelID }) => {
  const providerConfig = providerConfigs?.[providerID];
  const { provider } = getProviderDescriptor(catalog, providerID, providerConfig);
  const limit = getProviderModelDescriptor(provider, modelID)?.model?.limit;
  const contextTokens = Number(limit?.context) > 0 ? Number(limit.context) : DEFAULT_CONTEXT_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - OUTPUT_RESERVE_TOKENS);
  const maxChars = inputBudgetTokens * 4;
  if (prompt.length <= maxChars) {
    return { prompt, truncated: false };
  }
  return { prompt: `${prompt.slice(0, maxChars)}…`, truncated: true };
};

const readSmallModelConfiguration = (workingDirectory) => {
  try {
    const { mergedConfig } = readConfigLayers(workingDirectory);
    const value = mergedConfig?.small_model;
    const providers = mergedConfig?.provider;
    return {
      smallModel: typeof value === 'string' ? value : null,
      providerConfigs: providers && typeof providers === 'object' && !Array.isArray(providers)
        ? providers
        : {},
    };
  } catch {
    return { smallModel: null, providerConfigs: {} };
  }
};

/**
 * Generates text with the user's small model, resolved and authenticated
 * entirely server-side from the OpenCode config and auth store.
 */
export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID, restrictToPreferredProvider = false }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }

  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));
  const configuration = readSmallModelConfiguration(directory);

  const explicit = parseModelRef(model);
  const resolved = explicit
    ? { ...explicit, source: 'request' }
    : resolveSmallModel({
      auth,
      catalog,
      providerConfigs: configuration.providerConfigs,
      settingsSmallModel: readSmallModelSettingsOverride(),
      configSmallModel: configuration.smallModel,
      preferredProviderID,
      preferredModelID,
    });

  if (!resolved) {
    throw Object.assign(
      new Error('No small model available — no authenticated provider has a suitable model'),
      { statusCode: 404 },
    );
  }

  // Callers with a session context can forbid silently switching providers:
  // an explicit user choice (settings override, opencode config, request
  // model) is always allowed, anything else must stay on the session's
  // provider.
  if (restrictToPreferredProvider
    && !['settings', 'config', 'request'].includes(resolved.source)
    && resolved.providerID !== preferredProviderID) {
    throw Object.assign(
      new Error('No small model available within the session provider'),
      { statusCode: 404 },
    );
  }

  const clamped = clampPromptToModelLimit({
    prompt: prompt.trim(),
    catalog,
    providerConfigs: configuration.providerConfigs,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
  });

  const text = await callSmallModel({
    auth,
    catalog,
    workingDirectory: directory,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    prompt: clamped.prompt,
    system: typeof system === 'string' && system.trim() ? system.trim() : undefined,
    maxOutputTokens,
  });

  return {
    text: text.trim(),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
    ...(clamped.truncated ? { inputTruncated: true } : {}),
  };
}

/**
 * Provider ids with a usable OpenCode login — the set the small model can
 * actually call. Used by the settings override picker to hide providers that
 * would only ever fail (e.g. opencode free models without a token).
 */
export function listAuthenticatedProviders() {
  try {
    const auth = readAuthFile();
    const ids = new Set(
      Object.keys(auth || {}).filter((providerID) =>
        isUsableAuthEntry(auth[providerID])
        && (!isManagedProviderInstanceID(providerID) || auth[providerID].type === 'api')),
    );
    // The catalog id is github-copilot while legacy auth entries may sit
    // under the copilot alias.
    if (isUsableAuthEntry(getAuthEntryForProvider(auth, 'github-copilot'))) {
      ids.add('github-copilot');
    }
    return Array.from(ids);
  } catch {
    return [];
  }
}

/**
 * Reports which model would be used, without calling it.
 */
export async function describeSmallModel({ directory, preferredProviderID, preferredModelID } = {}) {
  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));
  const configuration = readSmallModelConfiguration(directory);
  const resolved = resolveSmallModel({
    auth,
    catalog,
    providerConfigs: configuration.providerConfigs,
    settingsSmallModel: readSmallModelSettingsOverride(),
    configSmallModel: configuration.smallModel,
    preferredProviderID,
    preferredModelID,
  });
  return resolved;
}
