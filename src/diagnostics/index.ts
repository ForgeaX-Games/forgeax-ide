import type { ProductRuntimeDiagnostic, ProductRuntimeReportV1 } from '../runtime/product-runtime-report';

export type IdeDiagnostic = ProductRuntimeDiagnostic & { source: 'ide-runtime' };

export function collectDiagnostics(report: ProductRuntimeReportV1): IdeDiagnostic[] {
  return report.diagnostics.map((diagnostic) => ({ ...diagnostic, source: 'ide-runtime' }));
}
