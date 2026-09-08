import { describe, expect, it } from 'bun:test';

type ServiceHealth = { code: string; service: string; version: string; ready: boolean; retryable: boolean; restartCount: number };

function supervise(input: { service: string; expected: string; actual: string; ready: boolean; restartCount: number }): ServiceHealth {
  if (input.expected !== input.actual) return { code: 'IDE_SERVICE_VERSION_MISMATCH', service: input.service, version: input.actual, ready: false, retryable: false, restartCount: input.restartCount };
  if (!input.ready && input.restartCount >= 3) return { code: 'IDE_SERVICE_RESTART_EXHAUSTED', service: input.service, version: input.actual, ready: false, retryable: false, restartCount: input.restartCount };
  return { code: input.ready ? 'IDE_SERVICE_READY' : 'IDE_SERVICE_NOT_READY', service: input.service, version: input.actual, ready: input.ready, retryable: !input.ready, restartCount: input.restartCount };
}

describe('ServiceSupervisor contract', () => {
  it('reports a compatible ready service', () => expect(supervise({ service: 'forgeax-server', expected: '1.0.0', actual: '1.0.0', ready: true, restartCount: 0 })).toMatchObject({ code: 'IDE_SERVICE_READY', ready: true }));
  it('reports version incompatibility structurally', () => expect(supervise({ service: 'forgeax-server', expected: '1.0.0', actual: '0.9.0', ready: true, restartCount: 0 })).toMatchObject({ code: 'IDE_SERVICE_VERSION_MISMATCH', retryable: false }));
  it('stops bounded restarts and reports exhaustion', () => expect(supervise({ service: 'forgeax-server', expected: '1.0.0', actual: '1.0.0', ready: false, restartCount: 3 })).toMatchObject({ code: 'IDE_SERVICE_RESTART_EXHAUSTED', restartCount: 3 }));
});
