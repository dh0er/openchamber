import { describe, expect, test } from 'bun:test';
import { providerInstanceErrorStatus } from './providerInstanceErrorStatus';

describe('VS Code provider-instance error status parity', () => {
  test('maps OpenAI-compatible discovery failures to stable HTTP statuses', () => {
    expect(providerInstanceErrorStatus('Failed to load the OpenAI-compatible model catalog')).toBe(502);
    expect(providerInstanceErrorStatus('OpenAI-compatible provider has no usable models')).toBe(422);
    expect(providerInstanceErrorStatus('OpenAI-compatible provider requires a Base URL')).toBe(422);
    expect(providerInstanceErrorStatus('Proxy settings are supported only for managed API-key provider instances')).toBe(422);
  });

  test('preserves existing provider-instance mappings', () => {
    expect(providerInstanceErrorStatus('OpenCode API is unavailable')).toBe(503);
    expect(providerInstanceErrorStatus('Source provider was not found')).toBe(404);
    expect(providerInstanceErrorStatus('API key is required')).toBe(400);
    expect(providerInstanceErrorStatus('Unexpected provider failure')).toBe(500);
  });
});
