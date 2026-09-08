type SettingsResponse = Pick<Response, 'ok' | 'json'>;
type RequestSettings = (input: string) => Promise<SettingsResponse>;

export interface ModelReadinessDependencies {
  getProviderOverride(): string | null;
  request?: RequestSettings;
}

/**
 * Creates the product's precise first-send readiness check. Chat owns when to
 * ask and how to retain/retry a draft; IDE owns what counts as a usable model
 * route for this product and reads that state afresh for every submission.
 */
export function createModelReadinessCheck({
  getProviderOverride,
  request = (input) => fetch(input),
}: ModelReadinessDependencies): () => Promise<boolean> {
  return async function checkModelReady(): Promise<boolean> {
    // Keep product-store failures visible to the caller. Only settings
    // transport/parsing is fail-open.
    const providerOverride = getProviderOverride();
    if (providerOverride && providerOverride !== 'forgeax') return true;

    try {
      const response = await request('/api/settings');
      if (!response.ok) return true;
      const payload = (await response.json()) as { env?: Record<string, string | null> };
      const env = payload.env ?? {};
      const hasKey = !!(
        env.LITELLM_PROXY_KEY
        || env.OPENAI_API_KEY
        || env.ANTHROPIC_API_KEY
        || env.ANTHROPIC_AUTH_TOKEN
      );
      if (hasKey) return true;
      return (env.FORGEAX_MODEL ?? '').trim().length > 0;
    } catch {
      return true;
    }
  };
}
