export function sanitizeReleaseSourceCode(text: string): string {
  return text
    .replaceAll('packages/marketplace/extensions/', 'marketplace/extensions/')
    .replaceAll('packages/marketplace/plugins/', 'marketplace/plugins/')
    .replaceAll('packages/marketplace/src/', 'marketplace/src/');
}

export function sanitizeReleaseSourcePaths(text: string, integrationRoot: string): string {
  const normalizedRoot = integrationRoot.replaceAll('\\', '/').replace(/\/$/, '');
  return sanitizeReleaseSourceCode(text)
    .replaceAll(`${normalizedRoot}/packages/editor/`, 'editor/')
    .replaceAll(`${normalizedRoot}/packages/`, '')
    .replaceAll('forgeax-studio/packages/', '')
    .replaceAll('packages/editor/', 'editor/');
}
