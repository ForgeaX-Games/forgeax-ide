import { describe, expect, it } from 'bun:test';
import { createIdeCarrierActivation } from '../src/product/start-product';

describe('IDE public gameplay carrier fail-closed boundary', () => {
  it('does not expose direct engine authority or private dispatch methods', () => {
    const carrier = createIdeCarrierActivation(['gta-route-dev']);
    const discovery = carrier.discover();

    expect(discovery.directEngine).toBe(false);
    expect('dispatch' in carrier).toBe(false);
    expect(JSON.stringify(discovery)).not.toContain('15173');
  });

  it('keeps the current explicit binding after an invalid selection', () => {
    const carrier = createIdeCarrierActivation(['gta-route-dev']);
    expect(carrier.select('gta-route-dev')).toMatchObject({ ok: true });

    expect(carrier.select('shadow-game')).toMatchObject({ ok: false, error: { code: 'game-not-found' } });
    expect(carrier.discover()).toMatchObject({ selectedGame: 'gta-route-dev', readiness: 'ready' });
  });
});
