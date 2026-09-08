import { describe, expect, mock, test } from 'bun:test';
import {
  createRestExtensionCatalogClient,
  type SharedCapabilityListResponse,
} from '../src/integration/rest-extension-catalog-client';

function response(body: unknown, options?: { status?: number; contentType?: string }): Promise<Response> {
  const status = options?.status ?? 200;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': options?.contentType ?? 'application/json' }),
    json: () => Promise.resolve(body),
  } as Response);
}

describe('IDE REST extension catalog integration', () => {
  test('owns its transport contract without importing Interface', async () => {
    const source = await Bun.file(new URL('../src/integration/rest-extension-catalog-client.ts', import.meta.url)).text();

    expect(source).not.toContain('@forgeax/interface');
    expect(source).toContain('export interface RestExtensionCatalogClient');
  });

  test('lists a filtered extension catalog through the canonical server route', async () => {
    const request = mock(() => response({
      kind: 'cli provider',
      count: 1,
      generation: 7,
      items: [{ id: '@forgeax-extension/model-cli' }],
    }));
    const client = createRestExtensionCatalogClient(request as unknown as typeof fetch);

    const result = await client.listExtensions('cli provider');

    expect(request).toHaveBeenCalledWith('/api/extensions/list?kind=cli%20provider');
    expect(result).toEqual({
      kind: 'cli provider',
      count: 1,
      generation: 7,
      items: [{ id: '@forgeax-extension/model-cli' }],
    });
  });

  test('fails soft for unavailable, non-JSON, and malformed extension catalogs', async () => {
    const unavailable = createRestExtensionCatalogClient(
      mock(() => response({ error: 'missing' }, { status: 404 })) as unknown as typeof fetch,
    );
    const html = createRestExtensionCatalogClient(
      mock(() => response('<html />', { contentType: 'text/html' })) as unknown as typeof fetch,
    );
    const malformed = createRestExtensionCatalogClient(
      mock(() => response({ kind: 'skill', count: 9, items: null })) as unknown as typeof fetch,
    );

    expect(await unavailable.listExtensions('skill')).toEqual({ kind: 'skill', count: 0, items: [] });
    expect(await html.listExtensions()).toEqual({ kind: null, count: 0, items: [] });
    expect(await malformed.listExtensions('skill')).toEqual({ kind: 'skill', count: 0, items: [] });
  });

  test('reads shared capabilities and preserves the empty fallback contract', async () => {
    const payload: SharedCapabilityListResponse = {
      generation: 4,
      loadedAt: 123,
      capabilities: [{
        capabilityId: 'builtin:command/open',
        kind: 'command',
        extensionId: '@forgeax/builtin',
        extensionVersion: '1.0.0',
        origin: 'builtin',
        localId: 'open',
        lifecycle: { requiresRestart: false },
      }],
      issues: [],
    };
    const request = mock(() => response(payload));
    const client = createRestExtensionCatalogClient(request as unknown as typeof fetch);

    expect(await client.listSharedCapabilities()).toEqual(payload);
    expect(request).toHaveBeenCalledWith('/api/extensions/capabilities');

    const missing = createRestExtensionCatalogClient(
      mock(() => response({}, { status: 503 })) as unknown as typeof fetch,
    );
    expect(await missing.listSharedCapabilities()).toEqual({
      generation: 0,
      loadedAt: 0,
      capabilities: [],
      issues: [],
    });
  });
});
