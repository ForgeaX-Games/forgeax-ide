import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ReleaseSourceInput = {
  packageText: string;
  lockText: string;
  productText: string;
  bundleText: string;
};

export type ReleaseSourceViolation = { token: string; field: keyof ReleaseSourceInput };
export type ReleaseSourceScan = { valid: boolean; violations: ReleaseSourceViolation[] };

const rules: Array<{ token: string; fields: Array<keyof ReleaseSourceInput>; pattern: RegExp }> = [
  { token: 'workspace:', fields: ['packageText', 'lockText'], pattern: /workspace:/i },
  { token: 'file:', fields: ['packageText', 'lockText'], pattern: /file:/i },
  { token: 'link:', fields: ['packageText', 'lockText'], pattern: /link:/i },
  {
    token: 'non-canonical npm tarball',
    fields: ['lockText'],
    pattern: /https?:\/\/(?!registry\.npmjs\.org\/)[^"'\s]+\.tgz/i,
  },
  { token: 'source adapter', fields: ['productText', 'bundleText'], pattern: /sourceAdapter|development-link|source adapter/i },
  { token: '/Users/', fields: ['packageText', 'lockText', 'productText', 'bundleText'], pattern: /\/Users\// },
  { token: '/private/', fields: ['packageText', 'lockText', 'productText', 'bundleText'], pattern: /\/private\// },
  { token: 'forgeax-studio/packages', fields: ['packageText', 'lockText', 'productText', 'bundleText'], pattern: /forgeax-studio\/packages/i },
  { token: 'packages/editor', fields: ['packageText', 'lockText', 'productText', 'bundleText'], pattern: /packages\/editor/i },
  { token: 'packages/marketplace', fields: ['packageText', 'lockText', 'productText', 'bundleText'], pattern: /packages\/marketplace/i },
];

export function scanReleaseSources(input: ReleaseSourceInput): ReleaseSourceScan {
  const violations: ReleaseSourceViolation[] = [];
  for (const rule of rules) {
    for (const field of rule.fields) {
      if (rule.pattern.test(input[field])) violations.push({ token: rule.token, field });
    }
  }
  return { valid: violations.length === 0, violations };
}

function readOptional(path: string): string {
  if (!existsSync(path)) return '';
  try {
    if (statSync(path).isDirectory()) {
      return readdirSync(path).map((entry) => readOptional(join(path, entry))).join('\n');
    }
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function readReleaseSourceInputs(root: string): ReleaseSourceInput {
  return {
    packageText: readFileSync(join(root, 'package.json'), 'utf8'),
    lockText: readFileSync(join(root, 'bun.lock'), 'utf8'),
    productText: readFileSync(join(root, 'product/forgeax-product.json'), 'utf8'),
    bundleText: `${readOptional(join(root, 'dist'))}\n${readOptional(join(root, 'src-tauri/tauri.conf.json'))}`,
  };
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const result = scanReleaseSources(readReleaseSourceInputs(root));
  if (!result.valid) {
    console.error(JSON.stringify({ code: 'IDE_RELEASE_SOURCE_FORBIDDEN', phase: 'release-source-scan', violations: result.violations }));
    process.exit(1);
  }
  console.log(JSON.stringify({ code: 'IDE_RELEASE_SOURCES_VALID', phase: 'release-source-scan', package: '@forgeax/ide', platform: '@forgeax/extension-platform@0.4.0' }));
}
