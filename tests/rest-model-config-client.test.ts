import { describe, expect, mock, test } from 'bun:test';
import {
  createRestModelConfigClient,
} from '../src/integration/rest-model-config-client';

function response(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe('IDE REST model config integration', () => {
  test('owns its transport contract without importing Interface', async () => {
    const source = await Bun.file(
      new URL('../src/integration/rest-model-config-client.ts', import.meta.url),
    ).text();

    expect(source).not.toContain('@forgeax/interface');
    expect(source).toContain('export interface RestModelConfigClient');
  });

  test('lists the gateway or provider-scoped catalog through list_models', async () => {
    const request = mock((_input: string, _init?: RequestInit) => response({
      result: {
        ok: true,
        data: {
          models: [
            { id: 'model-a', source: 'live', live: true },
          ],
        },
      },
    }));
    const client = createRestModelConfigClient(request as unknown as typeof fetch);

    expect(await client.listModels()).toEqual([
      { id: 'model-a', source: 'live', live: true },
    ]);
    expect(await client.listModels('codex')).toEqual([
      { id: 'model-a', source: 'live', live: true },
    ]);
    expect(request.mock.calls).toEqual([
      ['/api/commands/list_models/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      }],
      ['/api/commands/list_models/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['codex'] }),
      }],
    ]);
  });

  test('gets and sets the selected agent model through canonical command routes', async () => {
    const request = mock((input: string, _init?: RequestInit) => response({
      result: input.endsWith('/query')
        ? {
            ok: true,
            data: {
              sid: 'session/one',
              agentPath: 'agents/forge',
              selected: 'model-a',
              chain: ['model-a'],
              raw: ['model-a'],
            },
          }
        : {
            ok: true,
            data: {
              selected: 'model-b',
              chain: ['model-b', 'model-c'],
              restarted: true,
            },
          },
    }));
    const client = createRestModelConfigClient(request as unknown as typeof fetch);

    expect(await client.getAgentModel('session/one', 'agents/forge')).toEqual({
      sid: 'session/one',
      agentPath: 'agents/forge',
      selected: 'model-a',
      chain: ['model-a'],
      raw: ['model-a'],
    });
    expect(await client.setAgentModels('session/one', 'agents/forge', ['model-b', 'model-c'])).toEqual({
      selected: 'model-b',
      chain: ['model-b', 'model-c'],
      restarted: true,
    });
    expect(request.mock.calls).toEqual([
      ['/api/commands/get_agent_model/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['session/one', 'agents/forge'] }),
      }],
      ['/api/commands/set_agent_models/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: ['session/one', 'agents/forge', 'model-b', 'model-c'] }),
      }],
    ]);
  });

  test('preserves validation and command-envelope error behavior', async () => {
    const failedRequest = mock(() => response(
      { result: { ok: false, error: 'catalog unavailable' } },
      503,
    ));
    const failed = createRestModelConfigClient(failedRequest as unknown as typeof fetch);
    const fallback = createRestModelConfigClient(
      mock(() => response({}, 502)) as unknown as typeof fetch,
    );
    const request = mock(() => response({ result: { ok: true, data: {} } }));
    const valid = createRestModelConfigClient(request as unknown as typeof fetch);

    expect(failed.listModels()).rejects.toThrow('catalog unavailable');
    expect(fallback.getAgentModel('sid', 'agent')).rejects.toThrow(
      'get_agent_model failed (HTTP 502)',
    );
    expect(valid.setAgentModels('sid', 'agent', [])).rejects.toThrow(
      'setAgentModels: at least one model required',
    );
    expect(request).not.toHaveBeenCalled();
  });
});
