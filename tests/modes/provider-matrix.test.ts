import { describe, expect, it } from 'bun:test';
import { createProductProviders, type ProductMode } from '../../src/runtime/providers';

const modes: ProductMode[] = ['web-dev', 'desktop-dev', 'desktop-prod'];

describe('product provider matrix', () => {
  it('uses one manifest contract with mode-specific providers', () => {
    const providers = modes.map((mode) => createProductProviders(mode));

    expect(providers.map((provider) => provider.productId)).toEqual(['forgeax-ide', 'forgeax-ide', 'forgeax-ide']);
    expect(providers.map((provider) => provider.artifactSource.kind)).toEqual(['release', 'release', 'embedded']);
    expect(providers.map((provider) => provider.serviceLauncher.kind)).toEqual(['process', 'tauri-sidecar', 'tauri-sidecar']);
    expect(providers.map((provider) => provider.webAssetSource.kind)).toEqual(['vite', 'tauri-dev-url', 'embedded-dist']);
  });

  it('rejects source adapters in a formal mode', () => {
    expect(() => createProductProviders('desktop-prod', { sourceAdapter: 'development-link' })).toThrow(
      'IDE_RELEASE_SOURCE_FORBIDDEN',
    );
  });

  it('allows an explicit development source adapter only in development modes', () => {
    expect(createProductProviders('web-dev', { sourceAdapter: 'development-link' }).artifactSource.kind).toBe('development-link');
    expect(createProductProviders('desktop-dev', { sourceAdapter: 'development-link' }).artifactSource.kind).toBe('development-link');
  });
});
