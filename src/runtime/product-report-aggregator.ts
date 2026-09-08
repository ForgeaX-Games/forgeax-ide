import { buildProductRuntimeReport, type ProductRuntimeReportV1, type RuntimeComponent } from './product-runtime-report';

export function aggregateProductRuntimeReport(
  extensionComponents: readonly RuntimeComponent[],
  serviceComponents: readonly RuntimeComponent[],
): ProductRuntimeReportV1 {
  return buildProductRuntimeReport([...extensionComponents, ...serviceComponents]);
}
