export const providerInstanceErrorStatus = (message: string): number => {
  const lower = message.toLowerCase();
  if (lower.includes('api is unavailable')) return 503;
  if (
    lower.includes('provider catalog')
    || lower === 'failed to load the openai-compatible model catalog'
  ) return 502;
  if (lower.includes('not found')) return 404;
  if (
    lower.includes('no model')
    || lower.includes('no usable models')
    || lower === 'openai-compatible provider requires a base url'
    || lower.includes('supported only for managed api-key provider instances')
  ) return 422;
  if (lower.includes('required') || lower.includes('invalid') || lower.includes('must be')) return 400;
  return 500;
};
