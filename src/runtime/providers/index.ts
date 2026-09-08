export type ProductMode = 'web-dev' | 'desktop-dev' | 'desktop-prod';
export type SourceAdapter = 'development-link' | 'registry-release';
export type ArtifactSourceKind = 'release' | 'embedded' | 'development-link';
export type ServiceLauncherKind = 'process' | 'tauri-sidecar';
export type WebAssetSourceKind = 'vite' | 'tauri-dev-url' | 'embedded-dist';

export type ProductProviders = {
  mode: ProductMode;
  productId: 'forgeax-ide';
  artifactSource: { kind: ArtifactSourceKind; adapter: SourceAdapter | 'embedded' };
  serviceLauncher: { kind: ServiceLauncherKind };
  webAssetSource: { kind: WebAssetSourceKind };
};

export type ProductProviderOptions = {
  sourceAdapter?: SourceAdapter;
};

const modeDefaults: Record<ProductMode, Omit<ProductProviders, 'mode' | 'productId' | 'artifactSource'>> = {
  'web-dev': {
    serviceLauncher: { kind: 'process' },
    webAssetSource: { kind: 'vite' },
  },
  'desktop-dev': {
    serviceLauncher: { kind: 'tauri-sidecar' },
    webAssetSource: { kind: 'tauri-dev-url' },
  },
  'desktop-prod': {
    serviceLauncher: { kind: 'tauri-sidecar' },
    webAssetSource: { kind: 'embedded-dist' },
  },
};

function getArtifactSource(mode: ProductMode, sourceAdapter?: SourceAdapter): ProductProviders['artifactSource'] {
  if (mode === 'desktop-prod') {
    if (sourceAdapter) throw new Error('IDE_RELEASE_SOURCE_FORBIDDEN');
    return { kind: 'embedded', adapter: 'embedded' };
  }
  if (sourceAdapter === 'development-link') return { kind: 'development-link', adapter: sourceAdapter };
  return { kind: 'release', adapter: sourceAdapter ?? 'registry-release' };
}

export function createProductProviders(mode: ProductMode, options: ProductProviderOptions = {}): ProductProviders {
  return {
    mode,
    productId: 'forgeax-ide',
    artifactSource: getArtifactSource(mode, options.sourceAdapter),
    ...modeDefaults[mode],
  };
}
