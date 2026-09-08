import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractRawShaderDefault,
  verifyShaderViteContract,
} from '../scripts/verify-shader-vite-contract';

const ideRoot = resolve(import.meta.dir, '..');
const integrationRoot = process.env.FORGEAX_INTEGRATION_ROOT
  ? resolve(process.env.FORGEAX_INTEGRATION_ROOT)
  : resolve(ideRoot, '../..');
const integratedShaderInputsAvailable = [
  resolve(integrationRoot, 'packages/editor/packages/edit-runtime/src/viewport/shaders/infinite-grid.wgsl'),
  resolve(integrationRoot, 'packages/editor/packages/engine/packages/vite-plugin-shader/dist/index.mjs'),
  resolve(integrationRoot, 'packages/editor/packages/engine/packages/wgpu-wasm/pkg/wgpu_wasm.js'),
  resolve(integrationRoot, 'packages/interface/node_modules/@forgeax/app-shell/dist/window.js'),
].every(existsSync);

describe('IDE shader Vite contract', () => {
  test('accepts a Vite raw-string module and preserves the Engine directive as data', () => {
    const source = '#define_import_path editor::infinite-grid\nfn main() {}\n';

    expect(extractRawShaderDefault(`export default ${JSON.stringify(source)};`, 'fixture')).toBe(source);
  });

  test('keeps long raw modules filesystem-safe during contract validation', async () => {
    const source = `#define_import_path editor::infinite-grid\n${'fn main() {}\n'.repeat(20_000)}`;
    const verifier = await Bun.file(new URL('../scripts/verify-shader-vite-contract.ts', import.meta.url)).text();

    expect(extractRawShaderDefault(`export default ${JSON.stringify(source)};`, 'long-fixture')).toBe(source);
    expect(verifier).not.toContain('data:text/javascript');
  });

  test('rejects WGSL that escaped the JavaScript module wrapper', () => {
    expect(() => extractRawShaderDefault('#define_import_path editor::infinite-grid\n', 'fixture'))
      .toThrow('top-level #define_import_path');
  });

  test('rejects an artifact object or a raw string without the directive', () => {
    expect(() => extractRawShaderDefault('export default { wgsl: "..." };', 'fixture'))
      .toThrow('export default string');
    expect(() => extractRawShaderDefault('export default "fn main() {}";', 'fixture'))
      .toThrow('lost the shader directive');
  });

  test.skipIf(!integratedShaderInputsAvailable)('verifies the mounted IDE Vite config', async () => {
    const result = await verifyShaderViteContract();

    expect(result.queries).toEqual(['?raw', '?raw&import', '?import&raw']);
    expect(result.sourceLength).toBeGreaterThan(0);
  }, 15_000);
});
