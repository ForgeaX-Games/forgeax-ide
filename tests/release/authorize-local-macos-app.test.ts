import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAuthorizedAppTarget } from '../../scripts/authorize-local-macos-app';

describe('local macOS app authorization target', () => {
  test('accepts only one concrete ForgeaX-shaped app bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-authorize-'));
    const app = join(root, 'ForgeaX Studio.app');
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents/Info.plist'), 'fixture');
    writeFileSync(join(app, 'Contents/MacOS/bun'), 'fixture');
    expect(resolveAuthorizedAppTarget(app)).toBe(app);
    expect(() => resolveAuthorizedAppTarget(root)).toThrow('one existing .app bundle');
    expect(() => resolveAuthorizedAppTarget(join(root, 'Missing.app'))).toThrow('one existing .app bundle');
    rmSync(root, { recursive: true, force: true });
  });

  test('rejects unrelated app bundles before any quarantine mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-authorize-'));
    const app = join(root, 'Other.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    writeFileSync(join(app, 'Contents/Info.plist'), 'fixture');
    expect(() => resolveAuthorizedAppTarget(app)).toThrow('missing Contents/MacOS/bun');
    rmSync(root, { recursive: true, force: true });
  });
});
