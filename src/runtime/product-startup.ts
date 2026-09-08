import { buildProductRuntimeReport, type ProductRuntimeReportV1, type RuntimeComponent } from './product-runtime-report';
import { ServiceSupervisor } from './services/supervisor';

export async function startProduct(supervisor: ServiceSupervisor, extensionComponents: RuntimeComponent[]): Promise<ProductRuntimeReportV1> {
  const service = await supervisor.start('forgeax-server');
  const components: RuntimeComponent[] = [
    ...extensionComponents,
    { kind: 'service', id: service.service, version: service.version, required: true, status: service.ready ? 'ready' : 'failed', phase: 'service-ready' },
  ];
  return buildProductRuntimeReport(components);
}
