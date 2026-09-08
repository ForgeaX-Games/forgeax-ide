import { describe, expect, test } from 'bun:test';
import idePackage from '../../package.json';
import productManifest from '../../product/forgeax-product.json';
import { readFileSync } from 'node:fs';

import tauriConfig from '../../src-tauri/tauri.conf.json';
import releaseContract from '../../release/contract.json';
import transportContract from '../../release/transport-contract.v1.json';
import { validateNativeBundleConfig, validateProductRelease, validateReleaseOwnerContract, validateTransportContract } from '../../scripts/release-preflight';

describe('product release preflight', () => {
  test('accepts the npm-backed product manifest and IDE-owned release target', () => {
    expect(validateProductRelease(productManifest, idePackage)).toEqual([]);
    expect(validateReleaseOwnerContract(releaseContract)).toEqual([]);
    expect(validateTransportContract(transportContract)).toEqual([]);
    expect(validateNativeBundleConfig(tauriConfig)).toEqual([]);
  });

  test('requires a complete ad-hoc signature for unsigned macOS bundles', () => {
    expect(validateNativeBundleConfig({ bundle: { macOS: { signingIdentity: null } } }))
      .toEqual(expect.arrayContaining([
        'macos-adhoc-signing-identity',
        'macos-entitlements-file',
      ]));
  });

  test('requires the library-validation entitlement for the bundled Bun runtime', () => {
    expect(validateNativeBundleConfig({
      bundle: { macOS: { signingIdentity: '-', entitlements: null } },
    })).toContain('macos-entitlements-file');
    const entitlements = readFileSync(
      new URL('../../src-tauri/Entitlements.plist', import.meta.url),
      'utf8',
    );
    expect(entitlements).toContain('com.apple.security.cs.disable-library-validation');
    expect(entitlements).toMatch(/<true\s*\/>/);
  });

  test('keeps the native client name aligned with the product display name', () => {
    const macInfoPlist = readFileSync(new URL('../../src-tauri/Info.plist', import.meta.url), 'utf8');
    const macDisplayName = macInfoPlist.match(
      /<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1];

    expect(productManifest.displayName).toBe('ForgeaX Studio');
    expect(tauriConfig.productName).toBe(productManifest.displayName);
    expect(tauriConfig.app.windows[0]?.title).toBe(productManifest.displayName);
    expect(macDisplayName).toBe(productManifest.displayName);
  });

  test('rejects an unversioned or legacy extension declaration schema', () => {
    expect(validateProductRelease({ ...productManifest, schemaVersion: 1 }, idePackage))
      .toContain('product-schema-version');
  });

  test('rejects duplicate, unpinned, and undeclared extensions', () => {
    const manifest = {
      ...productManifest,
      schemaVersion: 2,
      extensions: [
        { id: '@forgeax-extension/bgm', required: false },
        { id: '@forgeax-extension/bgm', required: false },
        { id: '@forgeax-extension/missing', required: false },
      ],
    };
    const packageJson = {
      ...idePackage,
      optionalDependencies: { ...idePackage.optionalDependencies, '@forgeax-extension/bgm': '^0.5.3' },
    };

    expect(validateProductRelease(manifest, packageJson)).toEqual(expect.arrayContaining([
      'duplicate-extension:@forgeax-extension/bgm',
      'extension-version-not-exact:@forgeax-extension/bgm',
      'extension-dependency-missing:@forgeax-extension/missing',
    ]));
  });

  test('rejects a required extension declared in optionalDependencies', () => {
    expect(validateProductRelease({
      ...productManifest,
      extensions: [{ id: '@forgeax-extension/bgm', required: true }],
    }, idePackage)).toContain('extension-dependency-class-mismatch:@forgeax-extension/bgm');
  });

  test('rejects a platform version that differs from the installed dependency', () => {
    expect(validateProductRelease({
      ...productManifest,
      runtime: { ...productManifest.runtime, platform: '@forgeax/extension-platform@9.9.9' },
    }, idePackage)).toContain('platform-dependency-mismatch');
  });

  test('rejects ambiguous duplicate services', () => {
    expect(validateProductRelease({
      ...productManifest,
      services: [...productManifest.services, ...productManifest.services],
    }, idePackage)).toContain('duplicate-service:forgeax-server');
  });

  test('rejects a product Release target outside the Studio repository', () => {
    expect(validateReleaseOwnerContract({ ...releaseContract, releaseRepository: 'ForgeaX-Games/forgeax-ide' }))
      .toContain('release-target-owner');
  });
});
