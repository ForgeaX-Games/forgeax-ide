import { describe, expect, mock, test } from 'bun:test';
import { createModelReadinessCheck } from '../src/integration/model-readiness';

type SettingsResponse = Pick<Response, 'ok' | 'json'>;

function response(body: unknown, ok = true): Promise<SettingsResponse> {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
  });
}

describe('IDE model readiness policy', () => {
  test('accepts a truthy non-native provider without touching settings', async () => {
    const request = mock(() => response({ env: {} }));
    const checkModelReady = createModelReadinessCheck({
      getProviderOverride: () => 'claude-code',
      request,
    });

    expect(await checkModelReady()).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  test('reads settings afresh for every null, empty, or forgeax submission', async () => {
    for (const providerOverride of [null, '', 'forgeax'] as const) {
      const request = mock(() => response({ env: {} }));
      const checkModelReady = createModelReadinessCheck({
        getProviderOverride: () => providerOverride,
        request,
      });

      expect(await checkModelReady()).toBe(false);
      expect(await checkModelReady()).toBe(false);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, '/api/settings');
      expect(request).toHaveBeenNthCalledWith(2, '/api/settings');
    }
  });

  test('accepts every raw truthy credential and a trimmed nonempty model', async () => {
    for (const key of [
      'LITELLM_PROXY_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
    ] as const) {
      const checkModelReady = createModelReadinessCheck({
        getProviderOverride: () => null,
        request: () => response({ env: { [key]: ' ' } }),
      });
      expect(await checkModelReady()).toBe(true);
    }

    const configuredModel = createModelReadinessCheck({
      getProviderOverride: () => null,
      request: () => response({ env: { FORGEAX_MODEL: '  vendor/model  ' } }),
    });
    expect(await configuredModel()).toBe(true);
  });

  test('returns false only for a successful empty native configuration', async () => {
    for (const body of [
      {},
      { env: {} },
      {
        env: {
          LITELLM_PROXY_KEY: '',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: '',
          FORGEAX_MODEL: '   ',
        },
      },
    ]) {
      const checkModelReady = createModelReadinessCheck({
        getProviderOverride: () => 'forgeax',
        request: () => response(body),
      });
      expect(await checkModelReady()).toBe(false);
    }
  });

  test('fails open for request, response, JSON, and malformed-payload exceptions', async () => {
    const checks = [
      createModelReadinessCheck({
        getProviderOverride: () => null,
        request: () => Promise.reject(new Error('network unavailable')),
      }),
      createModelReadinessCheck({
        getProviderOverride: () => null,
        request: () => response({}, false),
      }),
      createModelReadinessCheck({
        getProviderOverride: () => null,
        request: () => Promise.resolve({
          ok: true,
          json: () => Promise.reject(new SyntaxError('invalid JSON')),
        }),
      }),
      createModelReadinessCheck({
        getProviderOverride: () => null,
        request: () => response(null),
      }),
      createModelReadinessCheck({
        getProviderOverride: () => null,
        request: () => response({ env: { FORGEAX_MODEL: 42 } }),
      }),
    ];

    for (const checkModelReady of checks) {
      expect(await checkModelReady()).toBe(true);
    }
  });

  test('keeps the provider-store read outside fail-open transport handling', async () => {
    const request = mock(() => response({ env: {} }));
    const checkModelReady = createModelReadinessCheck({
      getProviderOverride: () => {
        throw new Error('store unavailable');
      },
      request,
    });

    expect(checkModelReady()).rejects.toThrow('store unavailable');
    expect(request).not.toHaveBeenCalled();
  });
});
