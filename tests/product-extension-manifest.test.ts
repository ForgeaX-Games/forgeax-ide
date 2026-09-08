import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import idePackage from '../package.json';
import productManifest from '../product/forgeax-product.json';
import { selectBuiltinExtensions } from '../src/product/extension-selection';
import { buildDiagnosticComponents } from '../scripts/diagnostics';
import { buildProductRuntimeReport } from '../src/runtime/product-runtime-report';

const expectedExtensions = [
  { id: '@forgeax-extension/scene-generator', required: false },
  { id: '@forgeax-extension/video-game', required: false },
  { id: '@forgeax-extension/bgm', required: false },
  { id: '@forgeax-extension/agent-monitor', required: false },
  { id: '@forgeax-extension/diffusion-renderer', required: false },
  { id: '@forgeax-extension/plugin-author', required: false },
  { id: '@forgeax-extension/model-anthropic-text', required: false },
  { id: '@forgeax-extension/skill-author-plugin', required: false },
  { id: '@forgeax-extension/skill-make-game-design', required: false },
  { id: '@forgeax-extension/team-forge', required: false },
  { id: '@forgeax-extension/tool-balance-resim', required: false },
  { id: '@forgeax-extension/ai-asset', required: false },
  { id: '@forgeax-extension/character-3d', required: false },
  { id: '@forgeax-extension/animation', required: false },
  { id: '@forgeax-extension/skill-effects', required: false },
  { id: '@forgeax-extension/system-configuration', required: false },
  { id: '@forgeax-extension/agent-persona', required: false },
  { id: '@forgeax-extension/game-balance', required: false },
  { id: '@forgeax-extension/source-navigation', required: false },
  { id: '@forgeax-extension/color-grading', required: false },
];

describe('IDE product extension manifest', () => {
  test('is the explicit authority for built-in product extensions', () => {
    expect(productManifest.extensions).toEqual(expectedExtensions);
    expect(new Set(productManifest.extensions.map(({ id }) => id)).size).toBe(productManifest.extensions.length);
  });

  test('pins every optional extension as an exact optional npm dependency', () => {
    for (const extension of productManifest.extensions) {
      const version = (idePackage.optionalDependencies as Record<string, string>)[extension.id];
      expect(version, `${extension.id} must be optional in @forgeax/ide`).toMatch(/^\d+\.\d+\.\d+$/);
      expect((idePackage.dependencies as Record<string, string>)[extension.id]).toBeUndefined();
    }
  });

  test('derives runtime selection from the product manifest', () => {
    expect(selectBuiltinExtensions()).toEqual(expectedExtensions.map(({ id, required }) => ({
      id,
      required,
      version: (idePackage.optionalDependencies as Record<string, string>)[id],
    })));
  });

  test('propagates declared optionality into product diagnostics', () => {
    expect(buildDiagnosticComponents().filter(({ kind }) => kind === 'extension'))
      .toEqual(expect.arrayContaining(expectedExtensions.map(({ id, required }) => expect.objectContaining({ id, required }))));
  });

  test('reports a missing optional package as degraded without throwing', () => {
    const missingId = '@forgeax-extension/bgm';
    const components = buildDiagnosticComponents((id) => {
      if (id === missingId) throw new Error('package unavailable');
      return `/packages/${id}`;
    });
    const report = buildProductRuntimeReport(components);

    expect(report.status).toBe('degraded');
    expect(report.components).toContainEqual(expect.objectContaining({
      id: missingId,
      required: false,
      status: 'failed',
      phase: 'resolve-package',
    }));
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'IDE_OPTIONAL_COMPONENT_FAILED',
      component: missingId,
      retryable: true,
    }));
  });

  test('keeps product intent in one manifest without legacy artifact locks', () => {
    expect(productManifest.services).toEqual([
      { id: 'forgeax-server', version: '0.1.0', source: 'released-service', required: true },
    ]);
    expect(existsSync(join(import.meta.dir, '../product/builtin-extensions.lock.json'))).toBe(false);
    expect(existsSync(join(import.meta.dir, '../product/services.lock.json'))).toBe(false);
    expect(existsSync(join(import.meta.dir, '../release/ide-release.lock.json'))).toBe(false);
  });
});
