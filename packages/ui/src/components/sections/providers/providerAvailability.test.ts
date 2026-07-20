import { describe, expect, test } from 'bun:test';
import {
  OPENAI_COMPATIBLE_PROVIDER_TEMPLATE,
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
} from './providerAvailability';

describe('provider availability', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });

  test('keeps canonical providers selectable while hiding managed instances', () => {
    const providers = [
      { id: 'openai', name: 'OpenAI' },
      { id: 'openai:openchamber:4a132b87-d17b-47a7-a68d-65ba68f2510b', name: 'OpenAI Work' },
      { id: 'custom:provider', name: 'Custom provider' },
    ];

    expect(getSelectableProviderTemplates(providers)).toEqual([
      { id: 'openai', name: 'OpenAI' },
      { id: 'custom:provider', name: 'Custom provider' },
      OPENAI_COMPATIBLE_PROVIDER_TEMPLATE,
    ]);
  });

  test('always exposes one repeatable OpenAI Compatible template', () => {
    expect(getSelectableProviderTemplates([])).toEqual([OPENAI_COMPATIBLE_PROVIDER_TEMPLATE]);
    expect(getSelectableProviderTemplates([
      { id: 'openai-compatible', name: 'Runtime-provided name' },
      { id: 'openai-compatible:openchamber:4a132b87-d17b-47a7-a68d-65ba68f2510b', name: 'Gateway' },
    ])).toEqual([OPENAI_COMPATIBLE_PROVIDER_TEMPLATE]);
  });

  test('resolves only explicit OpenChamber instance IDs to their source provider', () => {
    const instanceId = 'anthropic:openchamber:4a132b87-d17b-47a7-a68d-65ba68f2510b';

    expect(isManagedProviderInstanceId(instanceId)).toBe(true);
    expect(getProviderSourceId(instanceId)).toBe('anthropic');
    expect(getProviderSourceId('custom:provider')).toBe('custom:provider');
  });

  test('recognizes canonical and managed OpenAI Compatible provider IDs', () => {
    expect(isOpenAICompatibleProviderId('openai-compatible')).toBe(true);
    expect(isOpenAICompatibleProviderId(
      'openai-compatible:openchamber:4a132b87-d17b-47a7-a68d-65ba68f2510b',
    )).toBe(true);
    expect(isOpenAICompatibleProviderId('openai')).toBe(false);
  });

  test('requires a Base URL only for OpenAI Compatible providers', () => {
    expect(isProviderBaseUrlRequired('openai-compatible')).toBe(true);
    expect(isProviderBaseUrlRequired(
      'openai-compatible:openchamber:4a132b87-d17b-47a7-a68d-65ba68f2510b',
    )).toBe(true);
    expect(isProviderBaseUrlRequired('openai')).toBe(false);
  });

  test('localizes only safe OpenAI Compatible discovery statuses', () => {
    expect(isOpenAICompatibleModelDiscoveryFailure('openai-compatible', 422)).toBe(true);
    expect(isOpenAICompatibleModelDiscoveryFailure('openai-compatible', 502)).toBe(true);
    expect(isOpenAICompatibleModelDiscoveryFailure('openai-compatible', 500)).toBe(false);
    expect(isOpenAICompatibleModelDiscoveryFailure('openai', 502)).toBe(false);
  });

  test('suggests a numbered display name without coupling it to the instance ID', () => {
    expect(getSuggestedProviderInstanceName(
      { id: 'openai', name: 'OpenAI' },
      ['openai', 'openai:openchamber:4a132b87-d17b-47a7-a68d-65ba68f2510b'],
    )).toBe('OpenAI 3');
  });

  test('accepts only non-secret optional HTTP(S) base URLs', () => {
    expect(isValidProviderBaseUrl('')).toBe(true);
    expect(isValidProviderBaseUrl('https://gateway.example.com/anthropic')).toBe(true);
    expect(isValidProviderBaseUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isValidProviderBaseUrl('https://gateway.example.com/v1?api-version=2026-01-01')).toBe(true);
    expect(isValidProviderBaseUrl('ftp://gateway.example.com')).toBe(false);
    expect(isValidProviderBaseUrl('https://user:secret@gateway.example.com')).toBe(false);
    expect(isValidProviderBaseUrl('https://gateway.example.com/v1#api-key')).toBe(false);
    expect(isValidProviderBaseUrl('https://gateway.example.com/v1?api_key=secret')).toBe(false);
    expect(isValidProviderBaseUrl('https://gateway.example.com/v1?ACCESS-TOKEN=secret')).toBe(false);
    expect(isValidProviderBaseUrl('not a url')).toBe(false);
  });

  test('normalizes provider proxy metadata with direct as the compatibility default', () => {
    expect(createDefaultProviderProxy()).toEqual({ mode: 'direct', url: '' });
    expect(normalizeProviderProxy(undefined)).toEqual({ mode: 'direct', url: '' });
    expect(normalizeProviderProxy({ mode: 'system', url: 'http://ignored.example' })).toEqual({
      mode: 'system',
      url: '',
    });
    expect(normalizeProviderProxy({ mode: 'manual', url: 'http://127.0.0.1:9000' })).toEqual({
      mode: 'manual',
      url: 'http://127.0.0.1:9000',
    });
    expect(normalizeProviderProxy({ mode: 'unsupported', url: 'http://127.0.0.1:9000' })).toEqual({
      mode: 'direct',
      url: '',
    });
  });

  test('serializes only a manual provider proxy URL', () => {
    expect(toProviderProxyPayload({ mode: 'direct', url: 'http://ignored.example' })).toEqual({
      mode: 'direct',
      url: null,
    });
    expect(toProviderProxyPayload({ mode: 'system', url: 'http://ignored.example' })).toEqual({
      mode: 'system',
      url: null,
    });
    expect(toProviderProxyPayload({ mode: 'manual', url: '  http://127.0.0.1:9000/  ' })).toEqual({
      mode: 'manual',
      url: 'http://127.0.0.1:9000',
    });
  });

  test('accepts only non-secret HTTP(S) manual proxy URLs', () => {
    expect(isValidProviderProxyUrl('http://127.0.0.1:9000')).toBe(true);
    expect(isValidProviderProxyUrl('https://proxy.example.com:8443')).toBe(true);
    expect(isValidProviderProxyUrl('')).toBe(false);
    expect(isValidProviderProxyUrl('socks5://127.0.0.1:1080')).toBe(false);
    expect(isValidProviderProxyUrl('http://user:secret@proxy.example.com')).toBe(false);
    expect(isValidProviderProxyUrl('http://proxy.example.com/forward')).toBe(false);
    expect(isValidProviderProxyUrl('http://proxy.example.com/?region=eu')).toBe(false);
    expect(isValidProviderProxyUrl('http://proxy.example.com/#credentials')).toBe(false);
    expect(isValidProviderProxyUrl('http://proxy.example.com/?access_token=secret')).toBe(false);
    expect(isValidProviderProxyUrl('not a url')).toBe(false);
  });

  test('derives subscription availability from authoritative auth metadata', () => {
    expect(getProviderSubscriptionState(null)).toBe('available');
    expect(getProviderSubscriptionState('api')).toBe('replaces-api-key');
    expect(getProviderSubscriptionState(' OAuth ')).toBe('connected');
    expect(getProviderSubscriptionState('wellknown')).toBe('connected');
  });
});
