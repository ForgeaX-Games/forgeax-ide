import { describe, expect, test } from 'bun:test';
import { createIdeCarrierActivation } from '../src/product/start-product';

describe('IDE gameplay carrier selection contract', () => {
  test('discovers the selected game, identity, capabilities, schemas, and recovery actions', () => {
    const carrier = createIdeCarrierActivation(['gta-route-dev']);
    const selection = carrier.select('gta-route-dev');

    expect(selection.ok).toBe(true);
    expect(selection.discovery).toMatchObject({
      productId: 'forgeax-ide',
      selectedGame: 'gta-route-dev',
      readiness: 'ready',
      directEngine: false,
      identity: {
        runtimeId: 'runtime:gta-route-dev',
        scope: { projectId: 'forgeax-ide', gameId: 'gta-route-dev' },
      },
    });
    expect(selection.discovery.capabilities).toEqual(expect.arrayContaining(['gameplay.viewport', 'carrier.identity']));
    expect(selection.discovery.schemas).toEqual(expect.arrayContaining(['editor-carrier/v1', 'server-game-carrier/v1', 'GameplayOperationResult/v1']));
    expect(selection.discovery.recoveryActions).toEqual(expect.arrayContaining(['carrier.discover', 'request.retry']));
  });

  test('rejects absent selections without mutating the current binding', () => {
    const carrier = createIdeCarrierActivation(['gta-route-dev']);
    expect(carrier.select('gta-route-dev').ok).toBe(true);

    expect(carrier.select('wrong-game')).toMatchObject({ ok: false, error: { code: 'game-not-found', retryable: false } });
    expect(carrier.discover()).toMatchObject({ selectedGame: 'gta-route-dev', readiness: 'ready' });
  });

  test('rejects ambiguous selections without guessing a candidate', () => {
    const carrier = createIdeCarrierActivation(['gta-route-dev', 'gta-route-dev']);

    expect(carrier.select('gta-route-dev')).toMatchObject({ ok: false, error: { code: 'game-selection-ambiguous' } });
    expect(carrier.discover()).toMatchObject({ selectedGame: null, readiness: 'unselected' });
  });
});
