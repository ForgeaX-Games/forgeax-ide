import type { ProductRuntimeDiagnostic, RuntimeComponent } from '../product-runtime-report';

export type ServiceHealth = {
  version: number;
  serviceId: string;
  serviceVersion: string;
  status: string;
  protocol: { min: string; max: string };
  ready: boolean;
  restartable: boolean;
};

export type ServiceRuntimeComponent = RuntimeComponent & { kind: 'service'; error?: ProductRuntimeDiagnostic };

function diagnostic(code: string, expected: string, actual: string): ProductRuntimeDiagnostic {
  return {
    code,
    phase: 'service-ready',
    component: 'forgeax-server',
    hint: 'Restore the locked service release and retry product startup.',
    expected,
    actual,
    retryable: code === 'IDE_SERVICE_NOT_READY',
    recoveryActions: ['restore-locked-service', 'retry-service-start'],
  };
}

export function adaptServiceHealth(serviceId: string, expectedVersion: string, health: ServiceHealth): ServiceRuntimeComponent {
  const versionMatches = health.serviceVersion === expectedVersion;
  const ready = versionMatches && health.ready && health.status === 'ready';
  const error = !versionMatches
    ? diagnostic('IDE_SERVICE_VERSION_MISMATCH', expectedVersion, health.serviceVersion)
    : !ready
      ? diagnostic('IDE_SERVICE_NOT_READY', 'ready', health.status)
      : undefined;
  return {
    kind: 'service',
    id: serviceId,
    version: health.serviceVersion,
    required: true,
    status: ready ? 'ready' : 'failed',
    phase: 'service-ready',
    ...(error ? { error } : {}),
  };
}
