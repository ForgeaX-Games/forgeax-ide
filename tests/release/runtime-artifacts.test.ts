import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharpNativePackageNames } from '../../scripts/runtime-artifacts';

const artifactsSource = readFileSync(join(import.meta.dir, '../../scripts/runtime-artifacts.ts'), 'utf8');
const sidecarSource = readFileSync(join(import.meta.dir, '../../scripts/stage-release-sidecar.ts'), 'utf8');

describe('Desktop Runtime artifact split', () => {
  test('builds one portable common payload from the verified Web and Engine inputs', () => {
    expect(artifactsSource).toContain("'ide-desktop-runtime-common/v1'");
    expect(artifactsSource).toContain('materializeWebArtifact(webCommon');
    expect(artifactsSource).toContain('composeEngineCommonArtifacts(engineCommon');
    expect(artifactsSource).toContain("'runtime/local-runtime.mjs'");
    expect(artifactsSource).toContain("'server-runtime/agent-host.mjs'");
    expect(artifactsSource).toContain('normalizePortableArtifactFiles(payload)');
    expect(artifactsSource).toContain("descriptor('common')");
  });

  test('keeps native Engine, Bun, Server, and Sharp resources in the target artifact', () => {
    expect(artifactsSource).toContain("'ide-desktop-runtime-target/v1'");
    expect(artifactsSource).toContain('composeEngineTargetArtifact(engineTarget, platform');
    expect(artifactsSource).toContain('copyFileSync(process.execPath, bunSidecar)');
    expect(artifactsSource).toContain('server-candidate-manifest-sha256');
    expect(artifactsSource).toContain("descriptor('target', platform, context)");
    expect(sharpNativePackageNames({
      '@img/sharp-darwin-arm64': '1',
      '@img/sharp-libvips-darwin-arm64': '1',
      '@img/sharp-darwin-x64': '1',
      '@img/sharp-win32-x64': '1',
    }, 'macos-arm64')).toEqual(['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64']);
  });

  test('stages the verified Server candidate outside final Tauri resources', () => {
    expect(sidecarSource).toContain("value('--output')");
    expect(sidecarSource).not.toContain("'../src-tauri/resources/sidecars'");
  });
});
