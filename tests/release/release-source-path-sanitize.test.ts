import { describe, expect, it } from 'bun:test';
import { sanitizeReleaseSourceCode, sanitizeReleaseSourcePaths } from '../../scripts/release-source-path-sanitize';

describe('release source path sanitizer', () => {
  it('normalizes final shader manifest source paths to stable product-relative paths', () => {
    const integrationRoot = '/home/you/work/forgeax-ide/forgeax-ide/forgeax-studio';
    const manifest = JSON.stringify({
      materialShaders: [{
        identifier: 'forgeax::custom',
        sourcePath: `${integrationRoot}/packages/editor/packages/engine/packages/render/src/custom.wgsl`,
      }],
    });

    const sanitized = sanitizeReleaseSourcePaths(manifest, integrationRoot);

    expect(JSON.parse(sanitized)).toEqual({
      materialShaders: [{
        identifier: 'forgeax::custom',
        sourcePath: 'editor/packages/engine/packages/render/src/custom.wgsl',
      }],
    });
    expect(sanitized).not.toContain(integrationRoot);
    expect(sanitized).not.toContain('packages/editor');
  });

  it('does not rewrite Vite module ids during source transformation', () => {
    const moduleId = '\0/home/you/work/forgeax-ide/forgeax-ide/forgeax-studio/packages/ide/node_modules/react/jsx-runtime.js';
    expect(sanitizeReleaseSourceCode(moduleId)).toBe(moduleId);
  });
});
