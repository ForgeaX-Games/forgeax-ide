import { describe, expect, test } from 'bun:test';

describe('@forgeax/extension-gallery package boundary', () => {
  test('owns discovery presentation and App Shell navigation without Interface adapters', async () => {
    const source = await Bun.file(new URL('../packages/extension-gallery/src/index.tsx', import.meta.url)).text();
    const runtimeSource = await Bun.file(new URL('../packages/extension-gallery/src/runtime.ts', import.meta.url)).text();
    const manifest = await Bun.file(new URL('../packages/extension-gallery/package.json', import.meta.url)).json();
    const productManifest = await Bun.file(new URL('../package.json', import.meta.url)).json();
    const productComposition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const tsconfig = await Bun.file(new URL('../tsconfig.json', import.meta.url)).json();

    expect(manifest.name).toBe('@forgeax/extension-gallery');
    expect(productManifest.workspaces).toBeUndefined();
    expect(productManifest.dependencies?.['lucide-react']).toBe('0.460.0');
    expect(manifest.dependencies?.['@forgeax/interface']).toBeUndefined();
    expect(manifest.peerDependencies?.['@forgeax/app-shell']).toBe('^0.83.0');
    expect(manifest.peerDependencies?.['@forgeax/interface']).toBeUndefined();
    expect(manifest.peerDependenciesMeta?.['@forgeax/interface']).toBeUndefined();
    expect(tsconfig.include).toContain('packages');
    expect(source).not.toContain('@forgeax/interface');
    expect(source).toContain('export interface ExtensionGalleryRuntime');
    expect(source).toContain('createExtensionGalleryContribution');
    expect(source).toContain('runtime.listExtensions()');
    expect(source).not.toContain('runtime.pickLang');
    expect(runtimeSource).toContain('extensionGalleryText');
    expect(source).toContain('item.contributes?.pages');
    expect(runtimeSource).toContain("from 'lucide-react'");
    expect(source).toContain('setup(context)');
    expect(source).toContain('context.host');
    expect(source).not.toContain('runtime.lucideIconOrBox');
    expect(source).not.toContain('runtime.openExtensionPage');
    expect(productComposition).toContain('extensionGalleryRuntime');
    expect(productComposition).toContain('createExtensionGalleryContribution(extensionGalleryRuntime)');
    expect(productComposition).not.toContain('openExtensionPage');
    expect(productComposition).not.toContain("from '@forgeax/interface/lib/lucide-icon'");
    expect(source).not.toContain('@forgeax/ai-page');
    expect(source).not.toContain('@forgeax/interface/store');
    expect(source).not.toContain('file-preview');
  });
});
