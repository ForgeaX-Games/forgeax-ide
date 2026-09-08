import { describe, expect, it } from 'bun:test';
import ready from '../fixtures/services/ready.json';
import mismatch from '../fixtures/services/version-mismatch.json';
import notReady from '../fixtures/services/not-ready.json';
import { adaptServiceHealth } from '../../src/runtime/services/service-health-adapter';

describe('service lifecycle health contract', () => {
  it('reports a released service as ready', () => {
    expect(adaptServiceHealth('forgeax-server', '0.1.0', ready)).toMatchObject({
      kind: 'service',
      id: 'forgeax-server',
      status: 'ready',
      required: true,
    });
  });

  it('reports version mismatch with recovery metadata', () => {
    const result = adaptServiceHealth('forgeax-server', '0.1.0', mismatch);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'IDE_SERVICE_VERSION_MISMATCH' } });
    expect(result.error?.recoveryActions.length).toBeGreaterThan(0);
  });

  it('does not turn a required failed sidecar into product-ready', () => {
    const result = adaptServiceHealth('forgeax-server', '0.1.0', notReady);
    expect(result).toMatchObject({ status: 'failed', required: true, error: { code: 'IDE_SERVICE_NOT_READY' } });
  });
});
