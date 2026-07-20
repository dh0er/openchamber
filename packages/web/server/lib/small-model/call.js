import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAuthFile, writeAuthFile } from '../opencode/auth.js';
import { fetchWithProviderProxy, readProviderProxy } from '../opencode/provider-proxy.js';
import { readConfig, readConfigLayers } from '../opencode/shared.js';
import {
  getProviderDescriptor,
  getProviderModelDescriptor,
  isManagedProviderInstanceID,
} from './catalog.js';
import { getAuthEntryForProvider } from './resolve.js';

// Direct, non-streaming text generation against the provider APIs, replicating
// how OpenCode authenticates each of them (see the plugin auth loaders in the
// opencode repo). auth.json credentials never leave this process.

const REQUEST_TIMEOUT_MS = 60_000;
// Generous default: thinking models that can't be switched off (DeepSeek,
// Qwen, …) spend part of this budget on reasoning before the actual answer.
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;

const USER_AGENT = 'opencode/1.0 openchamber';

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const httpError = async (response, provider) => {
  const body = await response.text().catch(() => '');
  const snippet = body ? `: ${body.slice(0, 300)}` : '';
  return new Error(`${provider} request failed with ${response.status}${snippet}`);
};

// ---------------------------------------------------------------------------
// OpenAI OAuth (ChatGPT plan / codex) token refresh — single-flight, with the
// refreshed token written back to auth.json exactly like OpenCode does.
// ---------------------------------------------------------------------------

let openaiRefreshPromise = null;

const decodeJwtClaims = (token) => {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const extractChatgptAccountId = (accessToken) => {
  const claims = decodeJwtClaims(accessToken);
  const auth = claims?.['https://api.openai.com/auth'];
  const value = auth?.chatgpt_account_id;
  return typeof value === 'string' && value ? value : null;
};

const refreshOpenaiOauth = async (entry) => {
  if (!openaiRefreshPromise) {
    openaiRefreshPromise = (async () => {
      const response = await fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: entry.refresh,
          client_id: CODEX_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw await httpError(response, 'OpenAI token refresh');
      }
      const payload = await response.json();
      const access = typeof payload?.access_token === 'string' ? payload.access_token : '';
      if (!access) {
        throw new Error('OpenAI token refresh returned no access token');
      }
      const refreshed = {
        ...entry,
        type: 'oauth',
        access,
        refresh: typeof payload?.refresh_token === 'string' && payload.refresh_token
          ? payload.refresh_token
          : entry.refresh,
        expires: Date.now() + (Number(payload?.expires_in) > 0 ? Number(payload.expires_in) : 3600) * 1000,
      };
      const auth = readAuthFile();
      auth.openai = refreshed;
      writeAuthFile(auth);
      return refreshed;
    })().finally(() => {
      openaiRefreshPromise = null;
    });
  }
  return openaiRefreshPromise;
};

const ensureFreshOpenaiOauth = async (entry) => {
  if (entry.access && Number(entry.expires) > Date.now()) {
    return entry;
  }
  if (!entry.refresh) {
    throw new Error('OpenAI OAuth entry has no refresh token');
  }
  return refreshOpenaiOauth(entry);
};

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

const callOpenaiCompatible = async ({ requestFetch = fetch, baseURL, headers, modelID, prompt, system, maxOutputTokens, providerLabel, extraBody }) => {
  const trimmedBase = baseURL.replace(/\/+$/, '');
  console.log('[small-model:diagnostic] request', {
    provider: providerLabel,
    model: modelID,
    maxOutputTokens,
    thinkingDisabled: extraBody?.thinking?.type === 'disabled',
    promptChars: prompt.length,
    systemChars: system?.length ?? 0,
    inputChars: prompt.length + (system?.length ?? 0),
  });
  const response = await requestFetch(`${trimmedBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      model: modelID,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      max_tokens: maxOutputTokens,
      stream: false,
      ...(extraBody || {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  console.log('[small-model:diagnostic] response', {
    provider: providerLabel,
    model: modelID,
    httpStatus: response.status,
    ok: response.ok,
  });
  if (!response.ok) {
    throw await httpError(response, providerLabel);
  }
  const payload = await response.json();
  const message = payload?.choices?.[0]?.message;
  console.log('[small-model:diagnostic] completion', {
    provider: providerLabel,
    model: modelID,
    finishReason: payload?.choices?.[0]?.finish_reason ?? null,
    contentType: Array.isArray(message?.content) ? 'parts' : typeof message?.content,
    contentChars: typeof message?.content === 'string'
      ? message.content.length
      : Array.isArray(message?.content)
        ? message.content.reduce((total, part) => total + (typeof part?.text === 'string' ? part.text.length : 0), 0)
        : 0,
    reasoningChars: typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0,
  });

  // Providers disagree on the content shape: plain string, an array of
  // typed parts, or (thinking models) an empty content with the budget spent
  // on reasoning_content.
  let text = '';
  if (typeof message?.content === 'string') {
    text = message.content;
  } else if (Array.isArray(message?.content)) {
    text = message.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  if (!text.trim() && typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()) {
    const finishReason = payload?.choices?.[0]?.finish_reason;
    throw new Error(
      `${providerLabel} spent the output budget on reasoning and returned no answer`
      + (finishReason ? ` (finish_reason: ${finishReason})` : ''),
    );
  }
  if (!text.trim()) {
    throw new Error(`${providerLabel} returned no message content`);
  }
  return text;
};

const getAnthropicMessagesURL = (baseURL) => {
  const trimmedBase = baseURL.replace(/\/+$/, '');
  if (/\/v1\/messages$/i.test(trimmedBase)) return trimmedBase;
  if (/\/v1$/i.test(trimmedBase)) return `${trimmedBase}/messages`;
  return `${trimmedBase}/v1/messages`;
};

const callAnthropic = async ({ requestFetch = fetch, apiKey, baseURL, modelID, prompt, system, maxOutputTokens }) => {
  const response = await requestFetch(getAnthropicMessagesURL(baseURL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelID,
      max_tokens: maxOutputTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await httpError(response, 'Anthropic');
  }
  const payload = await response.json();
  const text = (payload?.content || [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (!text) {
    throw new Error('Anthropic returned no text content');
  }
  return text;
};

const callGoogle = async ({ requestFetch = fetch, apiKey, baseURL, modelID, prompt, system, maxOutputTokens }) => {
  const trimmedBase = baseURL.replace(/\/+$/, '');
  const url = `${trimmedBase}/models/${encodeURIComponent(modelID)}:generateContent`;
  const thinkingConfig = modelID.toLowerCase().startsWith('gemini-3')
    ? { thinkingLevel: modelID.toLowerCase().includes('flash') ? 'minimal' : 'low' }
    : { thinkingBudget: 0 };
  const response = await requestFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens, thinkingConfig },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await httpError(response, 'Google');
  }
  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
  if (!text) {
    throw new Error('Google returned no text content');
  }
  return text;
};

// ChatGPT-plan traffic goes to the codex backend, which only speaks the
// streaming Responses API — collect the output_text deltas from the SSE body.
const callCodexResponses = async ({ accessToken, accountId, modelID, prompt, system }) => {
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      originator: 'opencode',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      model: modelID,
      ...(system ? { instructions: system } : {}),
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
      // The codex backend rejects max_output_tokens (OpenCode forces it to
      // undefined for this provider too).
      stream: true,
      store: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await httpError(response, 'OpenAI (ChatGPT plan)');
  }

  const raw = await response.text();
  let text = '';
  let completedText = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
    }
    if (event?.type === 'response.output_text.done' && typeof event.text === 'string') {
      completedText = event.text;
    }
    if (event?.type === 'response.failed' || event?.type === 'error') {
      const message = event?.response?.error?.message || event?.message || 'response failed';
      throw new Error(`OpenAI (ChatGPT plan) stream error: ${message}`);
    }
  }
  const result = completedText || text;
  if (!result) {
    throw new Error('OpenAI (ChatGPT plan) returned no text output');
  }
  return result;
};

// ---------------------------------------------------------------------------
// Custom provider configuration support
// ---------------------------------------------------------------------------

const resolveConfigApiKey = (value, workingDirectory, providerID) => {
  const envMatch = value.match(/^\{env:([^}]+)\}$/i);
  if (envMatch) {
    return process.env[envMatch[1].trim()]?.trim() || null;
  }

  const fileMatch = value.match(/^\{file:(.+)\}$/i);
  if (!fileMatch) return value;

  const configuredPath = fileMatch[1].trim();
  let resolvedPath;
  if (configuredPath === '~' || configuredPath.startsWith('~/') || configuredPath.startsWith('~\\')) {
    resolvedPath = path.join(os.homedir(), configuredPath.slice(2));
  } else if (path.isAbsolute(configuredPath)) {
    resolvedPath = configuredPath;
  } else {
    const layers = readConfigLayers(workingDirectory);
    const source = [
      { config: layers.customConfig, filePath: layers.paths.customPath },
      { config: layers.projectConfig, filePath: layers.paths.projectPath },
      { config: layers.userConfig, filePath: layers.paths.userPath },
    ].find(({ config }) => config?.provider?.[providerID]?.options?.apiKey === value);
    resolvedPath = path.resolve(source?.filePath ? path.dirname(source.filePath) : workingDirectory || process.cwd(), configuredPath);
  }

  try {
    const key = fs.readFileSync(resolvedPath, 'utf8').trim();
    if (!key) throw new Error('empty file');
    return key;
  } catch {
    throw new Error(`Failed to resolve configured apiKey file for provider "${providerID}"`);
  }
};

const readProviderConfig = (workingDirectory, providerID) => {
  try {
    const config = readConfig(workingDirectory);
    const providerCfg = config?.provider?.[providerID];
    if (!providerCfg || typeof providerCfg !== 'object') return null;
    const baseURL = typeof providerCfg?.options?.baseURL === 'string' ? providerCfg.options.baseURL.trim() : null;
    const rawApiKey = typeof providerCfg?.options?.apiKey === 'string' ? providerCfg.options.apiKey.trim() : null;
    const apiKey = rawApiKey ? resolveConfigApiKey(rawApiKey, workingDirectory, providerID) : null;
    return {
      definition: providerCfg,
      baseURL,
      // Shape the config-supplied key as a regular api-key auth entry so it
      // can win the precedence check below and flow through the dispatch's
      // `entry.type === 'api' ? entry.key : ...` branch unchanged.
      auth: apiKey ? { type: 'api', key: apiKey } : null,
    };
  } catch {
    // Provider config is non-essential — continue with catalog-only resolution.
    return null;
  }
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function callSmallModel({
  auth,
  catalog,
  workingDirectory,
  providerID,
  modelID,
  prompt,
  system,
  maxOutputTokens,
  providerProxyRuntime,
}) {
  const tokens = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS;
  const providerConfig = readProviderConfig(workingDirectory, providerID);
  const { sourceID, isManaged, provider } = getProviderDescriptor(
    catalog,
    providerID,
    providerConfig?.definition,
  );
  const requestModelID = isManaged
    ? getProviderModelDescriptor(provider, modelID)?.apiID || modelID
    : modelID;
  const requestFetch = isManaged
    ? (input, init) => (
        providerProxyRuntime?.fetchWithProviderProxy || fetchWithProviderProxy
      )(
        input,
        init,
        (providerProxyRuntime?.readProviderProxy || readProviderProxy)(providerID),
      )
    : (providerProxyRuntime?.fetch || fetch);
  // Match OpenCode's resolveSDK precedence:
  // config provider.<id>.options.apiKey (providerConfig.auth) wins; the
  // auth.json entry is only a fallback.
  const entry = providerConfig?.auth || getAuthEntryForProvider(auth, providerID);
  if (!entry) {
    throw new Error(`No OpenCode login found for provider "${providerID}"`);
  }

  if (isManagedProviderInstanceID(providerID) && entry.type !== 'api') {
    throw new Error(`Managed provider instance "${providerID}" requires an API key`);
  }

  if (sourceID === 'github-copilot') {
    // OpenCode uses the stored device-OAuth token directly as the bearer —
    // access === refresh, no exchange, no expiry.
    const token = entry.refresh || entry.access || entry.key;
    if (!token) {
      throw new Error('GitHub Copilot login has no token');
    }
    const baseURL = entry.enterpriseUrl
      ? `https://copilot-api.${String(entry.enterpriseUrl).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
      : 'https://api.githubcopilot.com';
    return callOpenaiCompatible({
      requestFetch,
      baseURL,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'Openai-Intent': 'conversation-edits',
        'x-initiator': 'agent',
        'X-GitHub-Api-Version': '2026-06-01',
      },
      modelID: requestModelID,
      prompt,
      system,
      maxOutputTokens: tokens,
      providerLabel: 'GitHub Copilot',
    });
  }

  if (sourceID === 'openai' && !isManaged && entry.type === 'oauth') {
    const fresh = await ensureFreshOpenaiOauth(entry);
    return callCodexResponses({
      accessToken: fresh.access,
      accountId: fresh.accountId || extractChatgptAccountId(fresh.access),
      modelID: requestModelID,
      prompt,
      system,
    });
  }

  const apiKey = entry.type === 'api' ? entry.key
    : entry.type === 'wellknown' ? entry.token
      : entry.access;
  if (!apiKey) {
    throw new Error(`OpenCode login for "${providerID}" has no usable credential`);
  }

  if (sourceID === 'anthropic') {
    return callAnthropic({
      requestFetch,
      apiKey,
      baseURL: providerConfig?.baseURL || ANTHROPIC_BASE_URL,
      modelID: requestModelID,
      prompt,
      system,
      maxOutputTokens: tokens,
    });
  }
  if (sourceID === 'google') {
    return callGoogle({
      requestFetch,
      apiKey,
      baseURL: providerConfig?.baseURL || GOOGLE_BASE_URL,
      modelID: requestModelID,
      prompt,
      system,
      maxOutputTokens: tokens,
    });
  }

  // Everything else: OpenAI-compatible chat completions against the catalog's
  // base URL for that provider (openai itself included). When a custom provider
  // is not in the catalog (e.g. a user-configured OpenAI-compatible proxy),
  // fall back to its baseURL from the OpenCode provider config. The openai
  // provider also respects provider.openai.options.baseURL — OpenCode itself
  // uses the same config for all providers including openai.
  const providerConfigUrl = providerConfig?.baseURL;
  const defaultOpenaiUrl = 'https://api.openai.com/v1';
  const baseURL = typeof providerConfigUrl === 'string' && providerConfigUrl
    ? providerConfigUrl
    : sourceID === 'openai'
      ? defaultOpenaiUrl
      : typeof provider?.api === 'string' && provider.api
        ? provider.api
        : null;
  if (!baseURL) {
    throw new Error(`Provider "${providerID}" has no known API base URL`);
  }

  // Thinking models burn the output budget on reasoning and leave content
  // empty — disable thinking where a wire-format switch exists (mirrors
  // OpenCode's smallOptions/variants special cases). There is NO universal
  // parameter: unknown body fields 400 on some providers, so this stays an
  // explicit allowlist. Models without a switch (DeepSeek, Qwen, Kimi, …)
  // just get the generous output budget.
  const lowerModel = requestModelID.toLowerCase();
  const supportsThinkingToggle = sourceID.includes('zai')
    || sourceID.includes('zhipu')
    || lowerModel.includes('glm')
    || lowerModel.includes('minimax-m3');
  const extraBody = supportsThinkingToggle ? { thinking: { type: 'disabled' } } : undefined;

  return callOpenaiCompatible({
    requestFetch,
    baseURL,
    headers: { Authorization: `Bearer ${apiKey}` },
    modelID: requestModelID,
    prompt,
    system,
    maxOutputTokens: tokens,
    providerLabel: provider?.name || providerID,
    extraBody,
  });
}
