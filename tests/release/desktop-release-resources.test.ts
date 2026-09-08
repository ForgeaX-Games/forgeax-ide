import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import transport from '../../release/transport-contract.v1.json';
import { validateDesktopResources } from '../../scripts/validate-desktop-resources';
import { fetchBounded, validateSidecar, validateTrustedReleaseUrl, type SidecarManifest } from '../../scripts/stage-release-sidecar';

const bytes = new Uint8Array(1_048_576).fill(7);
const digest = createHash('sha256').update(bytes).digest('hex');
const manifest: SidecarManifest = {
  schema: 'forgeax-server-release-candidate/v1', service: 'forgeax-server', version: '0.1.0',
  artifacts: transport.platforms.map((platform) => ({
    platform: platform.logicalId as 'macos-arm64' | 'macos-x64' | 'windows-x64', targetTriple: platform.targetTriple,
    url: `https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/server-${platform.logicalId}.bin`, sha256: digest, size: bytes.byteLength,
  })),
};

describe('production desktop resources', () => {
  test('consumes producer-owned Engine artifacts instead of copying producer internals', () => {
    const artifacts = readFileSync(join(import.meta.dir, '../../scripts/runtime-artifacts.ts'), 'utf8');
    expect(artifacts).toContain('composeEngineCommonArtifacts(engineCommon, engine)');
    expect(artifacts).toContain('composeEngineTargetArtifact(engineTarget, platform, engine)');
    expect(artifacts).not.toContain('stageEngineDependencyClosure');
  });

  test('materializes the verified common Web artifact without rebuilding it per target', () => {
    const artifacts = readFileSync(join(import.meta.dir, '../../scripts/runtime-artifacts.ts'), 'utf8');
    const baseConfig = JSON.parse(readFileSync(join(import.meta.dir, '../../src-tauri/tauri.conf.json'), 'utf8')) as any;
    const releaseConfig = JSON.parse(readFileSync(join(import.meta.dir, '../../src-tauri/tauri.release.conf.json'), 'utf8')) as any;
    expect(artifacts).toContain("argument('--web-common')");
    expect(artifacts).toContain('materializeWebArtifact(webCommon');
    expect(artifacts).not.toContain("run(['run', 'build:web'])");
    expect(baseConfig.build.beforeBuildCommand).toBe('bun run build:web');
    expect(releaseConfig.build).toEqual({ beforeBuildCommand: null, frontendDist: '../dist' });
  });

  test('stages every resource required to list, create, and scaffold games', () => {
    const artifacts = readFileSync(join(import.meta.dir, '../../scripts/runtime-artifacts.ts'), 'utf8');
    expect(artifacts).toContain("'editor/apps/standalone/template-catalog.ts'");
    expect(artifacts).toContain("'server/templates/game-minimal/forge.json'");
    expect(artifacts).toContain('composed Engine templates are missing');
    expect(artifacts).toContain('const templateEntry =');
    expect(artifacts).toContain("templateEntry.split('/').includes('..')");
    expect(artifacts).toContain('entryRelative');
    expect(artifacts).not.toContain("for (const file of ['forge.json', 'main.ts'])");
  });

  test('smokes the built bundle without loading the source Vite configuration', () => {
    const smoke = readFileSync(join(import.meta.dir, '../../scripts/smoke-production-bundle.ts'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts['smoke:production-bundle']).toBe('node --experimental-strip-types scripts/smoke-production-bundle.ts');
    expect(smoke).toContain('createServer(async');
    expect(smoke).toContain("resolve(distRoot, 'index.html')");
    expect(smoke).toContain("process.platform === 'win32'");
    expect(smoke).toContain("channel: 'msedge'");
    expect(smoke).not.toContain("'vite',");
    expect(smoke).not.toContain('Bun.spawn(');
  });

  test('prepares the host Bun target before ordinary Tauri desktop compilation', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    const build = readFileSync(join(import.meta.dir, '../../scripts/build-desktop.ts'), 'utf8');
    expect(manifest.scripts['build:desktop']).toBe(
      'bun run prepare:shader-build-inputs && bun run scripts/build-desktop.ts',
    );
    expect(build).toContain("triple: 'x86_64-unknown-linux-gnu'");
    expect(build.indexOf('copyFileSync(process.execPath')).toBeLessThan(build.indexOf("run('cargo'"));
  });

  test('loads the server preload relative to its cwd so app bundle spaces are safe', () => {
    const runtime = readFileSync(join(import.meta.dir, '../../scripts/desktop-runtime.ts'), 'utf8');
    const preload = readFileSync(join(import.meta.dir, '../../scripts/server-native-preload.ts'), 'utf8');
    expect(runtime).toContain("BUN_OPTIONS: '--preload=./native-preload.mjs'");
    expect(runtime).not.toContain('pathToFileURL(serverPreload)');
    expect(runtime).toContain("materializeNodeModules(join(source, 'node_modules'), join(destination, 'node_modules'))");
    expect(runtime).not.toContain("for (const entry of ['node_modules', 'forgeax-editor-assets'");
    expect(preload).toContain('delete process.env.BUN_OPTIONS');
  });

  test('ships and selects the forgeax-core serve entry for the compiled server', () => {
    const artifacts = readFileSync(join(import.meta.dir, '../../scripts/runtime-artifacts.ts'), 'utf8');
    const runtime = readFileSync(join(import.meta.dir, '../../scripts/desktop-runtime.ts'), 'utf8');
    expect(artifacts).toContain("join(CLI_ROOT, 'src/cli/main.ts')");
    expect(artifacts).toContain("'server-runtime/forgeax-core-serve.mjs'");
    expect(artifacts).toContain("'--packages=bundle'");
    expect(runtime).toContain("join(serverRuntime, 'forgeax-core-serve.mjs')");
    expect(runtime).toContain('FORGEAX_CORE_SERVE_ENTRY: coreServe');
  });

  test('binds every released server sidecar to service version, exact platform target, size, and digest', () => {
    expect(validateSidecar(manifest, 'macos-arm64', bytes, '0.1.0').sha256).toBe(digest);
    expect(() => validateSidecar(manifest, 'macos-arm64', bytes, '0.1.1')).toThrow('version mismatch');
    const changed = bytes.slice(); changed[0] = 8;
    expect(() => validateSidecar(manifest, 'macos-arm64', changed, '0.1.0')).toThrow('digest mismatch');
    const wrongTarget = structuredClone(manifest); wrongTarget.artifacts[0].targetTriple = 'x86_64-apple-darwin';
    expect(() => validateSidecar(wrongTarget, 'macos-arm64', bytes, '0.1.0')).toThrow('invalid sidecar artifact');
  });

  test('restricts source URLs to canonical versioned forgeax-server GitHub Release paths', () => {
    const valid = 'https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json';
    expect(validateTrustedReleaseUrl(valid, 'manifest', '0.1.0')).toBe(valid);
    for (const url of [
      'https://user:pass@github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json',
      'https://github.com.evil.test/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json',
      'https://github.com/ForgeaX-Games/other/releases/download/server-v0.1.0/candidate.json',
      'https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/%2e%2e.json',
      `${valid}?token=secret`, `${valid}#fragment`, `${valid}\nINJECTED=1`,
    ]) expect(() => validateTrustedReleaseUrl(url, 'manifest', '0.1.0')).toThrow();
  });

  test('allows GitHub release-asset redirects but rejects untrusted origins and oversized responses', async () => {
    const url = 'https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json';
    const allowed = async () => {
      const response = new Response(bytes);
      Object.defineProperty(response, 'url', { value: 'https://release-assets.githubusercontent.com/github-production-release-asset/file' });
      return response;
    };
    expect(await fetchBounded(url, digest, bytes.length, allowed as unknown as typeof fetch)).toEqual(bytes);
    const untrusted = async () => {
      const response = new Response(bytes);
      Object.defineProperty(response, 'url', { value: 'https://evil.test/file' });
      return response;
    };
    await expect(fetchBounded(url, digest, bytes.length, untrusted as unknown as typeof fetch)).rejects.toThrow('untrusted origin');
    const oversized = async () => {
      const response = new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } });
      Object.defineProperty(response, 'url', { value: url }); return response;
    };
    await expect(fetchBounded(url, digest, bytes.length, oversized as unknown as typeof fetch)).rejects.toThrow('byte limit');
  });

  test('rejects the repository placeholder and requires the target-specific binary', () => {
    const root = mkdtempSync(join(tmpdir(), 'ide-resources-'));
    mkdirSync(join(root, 'src-tauri/resources/sidecars'), { recursive: true }); mkdirSync(join(root, 'src-tauri/capabilities'), { recursive: true }); mkdirSync(join(root, 'src-tauri/src'), { recursive: true });
    writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ build: { frontendDist: '../dist' }, bundle: { active: true, externalBin: ['resources/sidecars/bun'], resources: ['resources'] } }));
    writeFileSync(join(root, 'src-tauri/capabilities/main.json'), '{}');
    writeFileSync(join(root, 'src-tauri/src/lib.rs'), 'app.shell().sidecar("bun")');
    expect(validateDesktopResources(root, 'windows-x64').map((error) => error.code)).toContain('production-sidecar-missing');
    writeFileSync(join(root, 'src-tauri/resources/sidecars/forgeax-server-x86_64-pc-windows-msvc.exe'), 'IDE_SIDECAR_PLACEHOLDER');
    expect(validateDesktopResources(root, 'windows-x64').map((error) => error.code)).toContain('production-sidecar-invalid');
    rmSync(root, { recursive: true, force: true });
  });
});
