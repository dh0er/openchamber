import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../opencode/auth.js', () => ({
  readAuthFile: vi.fn(),
}));

vi.mock('../opencode/shared.js', () => ({
  readConfigLayers: vi.fn(),
}));

vi.mock('./catalog.js', async () => {
  const actual = await vi.importActual('./catalog.js');
  return {
    ...actual,
    getModelCatalog: vi.fn(),
  };
});

vi.mock('./call.js', () => ({
  callSmallModel: vi.fn(),
}));

const { generateSmallModelText, listAuthenticatedProviders } = await import('./index.js');
const { readAuthFile } = await import('../opencode/auth.js');
const { readConfigLayers } = await import('../opencode/shared.js');
const { getModelCatalog } = await import('./catalog.js');
const { callSmallModel } = await import('./call.js');

const INSTANCE_ID = 'anthropic:openchamber:4a132b87-d17b-47a7-a68d-65ba68f2510b';

describe('generateSmallModelText - managed provider instances', () => {
  beforeEach(() => {
    readAuthFile.mockReset();
    readConfigLayers.mockReset();
    getModelCatalog.mockReset();
    callSmallModel.mockReset();

    readAuthFile.mockReturnValue({
      [INSTANCE_ID]: { type: 'api', key: 'alias-key' },
    });
    getModelCatalog.mockResolvedValue({
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-haiku-instance': {
            id: 'claude-haiku-instance',
            limit: { context: 200_000 },
          },
        },
      },
    });
    readConfigLayers.mockReturnValue({
      mergedConfig: {
        provider: {
          [INSTANCE_ID]: {
            id: 'anthropic',
            models: {
              'claude-haiku-instance': {
                id: 'claude-haiku-upstream',
                limit: { context: 5_000 },
              },
            },
          },
        },
      },
    });
    callSmallModel.mockResolvedValue('generated');
  });

  it('clamps input using the alias model copy rather than the canonical catalog', async () => {
    const prompt = 'x'.repeat(5_000);
    const result = await generateSmallModelText({
      prompt,
      model: `${INSTANCE_ID}/claude-haiku-instance`,
      directory: '/proj',
    });

    expect(result).toEqual({
      text: 'generated',
      providerID: INSTANCE_ID,
      modelID: 'claude-haiku-instance',
      source: 'request',
      inputTruncated: true,
    });
    expect(callSmallModel).toHaveBeenCalledWith(expect.objectContaining({
      providerID: INSTANCE_ID,
      modelID: 'claude-haiku-instance',
      prompt: `${'x'.repeat(4_000)}…`,
    }));
  });

  it('does not advertise an alias that only has OAuth credentials', () => {
    readAuthFile.mockReturnValue({
      [INSTANCE_ID]: { type: 'oauth', access: 'alias-oauth' },
      anthropic: { type: 'api', key: 'canonical-key' },
    });

    expect(listAuthenticatedProviders()).toEqual(['anthropic']);
  });
});
