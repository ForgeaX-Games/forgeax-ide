import { resolveProductService, type ProductService } from './product-service-resolver';

export type ServiceHealthV1 = { code: string; service: string; version: string; ready: boolean; retryable: boolean; restartCount: number };
export type ServiceLauncher = { start: (service: ProductService) => Promise<{ version: string }>; stop: (service: ProductService) => Promise<void> };

export class ServiceSupervisor {
  private readonly restartLimit: number;
  private restartCount = 0;
  private active?: ProductService;

  constructor(private readonly launcher: ServiceLauncher, restartLimit = 3) {
    this.restartLimit = restartLimit;
  }

  async start(serviceId: string): Promise<ServiceHealthV1> {
    const service = resolveProductService(serviceId);
    this.active = service;
    const result = await this.launcher.start(service);
    if (result.version !== service.version) return { code: 'IDE_SERVICE_VERSION_MISMATCH', service: service.id, version: result.version, ready: false, retryable: false, restartCount: this.restartCount };
    return { code: 'IDE_SERVICE_READY', service: service.id, version: result.version, ready: true, retryable: false, restartCount: this.restartCount };
  }

  async restart(): Promise<ServiceHealthV1> {
    if (!this.active) throw new Error('IDE_SERVICE_NOT_STARTED');
    if (this.restartCount >= this.restartLimit) return { code: 'IDE_SERVICE_RESTART_EXHAUSTED', service: this.active.id, version: this.active.version, ready: false, retryable: false, restartCount: this.restartCount };
    this.restartCount += 1;
    await this.launcher.stop(this.active);
    return this.start(this.active.id);
  }

  async stop(): Promise<void> {
    if (this.active) await this.launcher.stop(this.active);
    this.active = undefined;
    this.restartCount = 0;
  }
}
