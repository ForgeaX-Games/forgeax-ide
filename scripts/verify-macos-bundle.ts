#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REQUIRED_ENTITLEMENT = 'com.apple.security.cs.disable-library-validation';
const REQUIRED_BUNDLE_IDENTIFIER = 'com.forgeax.ide';

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function codesign(args: string[]): string {
  const result = spawnSync('codesign', args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) throw new Error(`codesign ${args.join(' ')} failed:\n${output}`);
  return output;
}

export function hasRequiredLibraryValidationEntitlement(output: string): boolean {
  return output.includes(`<key>${REQUIRED_ENTITLEMENT}</key>`)
    && /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/.test(output);
}

function verifySignedExecutable(path: string, label: string, identifier?: string): void {
  const details = codesign(['-dvvv', path]);
  if (!details.includes('Signature=adhoc')) throw new Error(`${label} is not ad-hoc signed`);
  if (identifier && !details.includes(`Identifier=${identifier}`)) {
    throw new Error(`${label} does not have the expected identifier ${identifier}`);
  }
  const entitlements = codesign(['-d', '--entitlements', ':-', path]);
  if (!hasRequiredLibraryValidationEntitlement(entitlements)) {
    throw new Error(`${label} is missing ${REQUIRED_ENTITLEMENT}`);
  }
}

if (import.meta.main) {
  if (process.platform !== 'darwin') throw new Error('macOS bundle verification requires macOS');
  const app = resolve(argument('--app') ?? '');
  if (!app.endsWith('.app') || !existsSync(app)) throw new Error('--app must point to an existing .app bundle');
  const bun = join(app, 'Contents/MacOS/bun');
  if (!existsSync(bun)) throw new Error('bundled Bun executable is missing');

  codesign(['--verify', '--deep', '--strict', '--verbose=4', app]);
  verifySignedExecutable(app, 'application bundle', REQUIRED_BUNDLE_IDENTIFIER);
  verifySignedExecutable(bun, 'bundled Bun runtime');
  console.log(JSON.stringify({ code: 'IDE_MACOS_BUNDLE_VALID', app, entitlement: REQUIRED_ENTITLEMENT }));
}
