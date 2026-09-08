import { describe, expect, test } from 'bun:test';
import idePackage from '../package.json';

describe('BGM npm dependency', () => {
  test('pins the independent extension release as optional product capability', () => {
    expect(idePackage.optionalDependencies['@forgeax-extension/bgm']).toBe('0.6.0');
  });

  test('does not reach back into Marketplace source', () => {
    const spec = idePackage.optionalDependencies['@forgeax-extension/bgm'];
    expect(spec).not.toContain('workspace:');
    expect(spec).not.toContain('file:');
    expect(spec).not.toContain('packages/marketplace');
  });
});
