import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildProductRuntimeReport, type RuntimeComponent } from '../src/runtime/product-runtime-report';
import { collectDiagnostics } from '../src/diagnostics';
import { selectBuiltinExtensions } from '../src/product/extension-selection';

const root = join(import.meta.dir, '..');
const product = JSON.parse(readFileSync(join(root, 'product/forgeax-product.json'), 'utf8')) as { services: { id: string; version: string; required: boolean }[] };
const requireFromProduct = createRequire(join(root, 'package.json'));

export function buildDiagnosticComponents(
  resolvePackage: (specifier: string) => string = requireFromProduct.resolve,
): RuntimeComponent[] {
  return [
    ...selectBuiltinExtensions().map((extension) => ({
      kind: 'extension' as const,
      id: extension.id,
      version: extension.version,
      required: extension.required,
      status: (() => {
        try {
          resolvePackage(extension.id);
          return 'ready' as const;
        } catch {
          return 'failed' as const;
        }
      })(),
      phase: 'resolve-package',
    })),
    ...product.services.map((service) => ({
      kind: 'service' as const,
      id: service.id,
      version: service.version,
      required: service.required,
      status: 'ready' as const,
      phase: 'service-ready',
    })),
  ];
}

if (import.meta.main) {
  const report = buildProductRuntimeReport(buildDiagnosticComponents());
  if (Bun.argv.includes('--json')) console.log(JSON.stringify({ ...report, diagnostics: collectDiagnostics(report) }, null, 2));
  else console.log(`${report.status}: ${report.components.length} components`);
}
