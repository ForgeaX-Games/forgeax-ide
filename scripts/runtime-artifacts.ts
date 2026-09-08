#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  composeArtifacts,
  createArtifactManifest,
  normalizePortableArtifactFiles,
  verifyArtifactManifest,
  type ArtifactDescriptor,
  type ArtifactManifest,
} from './artifact-manifest';
import { composeEngineCommonArtifacts, composeEngineTargetArtifact } from './engine-runtime-artifacts';
import { gitProducer, gitValue, submoduleRevision, trackedIdentityFile } from './release-artifact-identity';
import type { ReleaseContext } from './resolve-release-context';
import { platformTargets, type ReleasePlatform } from './stage-release-sidecar';
import { materializeWebArtifact } from './web-runtime-artifact';

const IDE_ROOT = resolve(import.meta.dir, '..');
const INTEGRATION_ROOT = resolve(IDE_ROOT, '../..');
const AGENT_HOST_ROOT = join(INTEGRATION_ROOT, 'packages/agent-host');
const CLI_ROOT = join(INTEGRATION_ROOT, 'packages/cli');
const EDITOR_ROOT = join(INTEGRATION_ROOT, 'packages/editor');
const ENGINE_ROOT = join(EDITOR_ROOT, 'packages/engine');
const ORCHESTRATOR_ROOT = join(INTEGRATION_ROOT, 'packages/orchestrator');
const SERVER_ROOT = join(INTEGRATION_ROOT, 'packages/server');
const COPY_EXCLUDES = new Set([
  '.git', '.forgeax-harness', 'node_modules', 'target', '__tests__', 'test', 'tests',
  '.vite', '.forgeax', 'host-games', 'shared-assets', 'engine-assets',
]);

type PackageJson = { version?: string; optionalDependencies?: Record<string, string> };

function fail(message: string): never {
  throw new Error(`[runtime-artifacts] ${message}`);
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

function copyTree(source: string, destination: string, exclude = false): void {
  if (!existsSync(source)) fail(`required source is missing: ${source}`);
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: exclude ? (path) => !COPY_EXCLUDES.has(basename(path)) : undefined,
  });
}

function run(args: string[], cwd = IDE_ROOT): void {
  const result = spawnSync(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, FORGEAX_INTEGRATION_ROOT: INTEGRATION_ROOT },
  });
  if (result.status !== 0) fail(`command failed (${result.status}): bun ${args.join(' ')}`);
}

function descriptor(scope: 'common' | 'target', platform?: ReleasePlatform, context?: ReleaseContext): ArtifactDescriptor {
  const target = platform ? platformTargets[platform] : undefined;
  const buildScripts = [
    trackedIdentityFile(IDE_ROOT, 'scripts/runtime-artifacts.ts'),
    ...(scope === 'common' ? [
      trackedIdentityFile(IDE_ROOT, 'scripts/desktop-runtime.ts'),
      trackedIdentityFile(IDE_ROOT, 'scripts/server-native-preload.ts'),
    ] : [trackedIdentityFile(IDE_ROOT, 'scripts/stage-release-sidecar.ts')]),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const toolchains: Record<string, string> = {
    bun: Bun.version,
    node: process.version,
    'integration-revision': gitValue(INTEGRATION_ROOT, 'rev-parse', 'HEAD'),
    'editor-revision': submoduleRevision(INTEGRATION_ROOT, 'packages/editor'),
    'engine-revision': submoduleRevision(EDITOR_ROOT, 'packages/engine'),
    'server-revision': submoduleRevision(INTEGRATION_ROOT, 'packages/server'),
  };
  if (scope === 'common') {
    toolchains['agent-host-revision'] = submoduleRevision(INTEGRATION_ROOT, 'packages/agent-host');
    toolchains['cli-revision'] = submoduleRevision(INTEGRATION_ROOT, 'packages/cli');
    toolchains['orchestrator-revision'] = submoduleRevision(INTEGRATION_ROOT, 'packages/orchestrator');
    toolchains['publishable-shader-inputs'] = process.env.FORGEAX_REQUIRE_PUBLISHABLE_SHADER_INPUTS === '1' ? 'required' : 'not-required';
  } else {
    if (!context) fail('target artifact requires release context');
    toolchains['server-candidate-manifest-sha256'] = context.sidecarManifestSha256;
    toolchains['server-service-version'] = context.serviceVersion;
  }
  return {
    artifactId: scope === 'common' ? 'ide-desktop-runtime-common/v1' : 'ide-desktop-runtime-target/v1',
    producer: gitProducer(IDE_ROOT, 'ForgeaX-Games/forgeax-ide'),
    inputs: {
      lockfiles: [
        trackedIdentityFile(IDE_ROOT, 'bun.lock', 'ide/bun.lock'),
        trackedIdentityFile(INTEGRATION_ROOT, 'bun.lock', 'integration/bun.lock'),
      ],
      buildScripts,
      toolchains,
    },
    scope,
    target: target ? { platform: platform!, triple: target.triple } : null,
  };
}

function writeManifest(root: string, path: string, artifactDescriptor: ArtifactDescriptor): ArtifactManifest {
  const manifest = createArtifactManifest(root, artifactDescriptor);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

function readManifest(path: string): ArtifactManifest {
  if (!existsSync(path)) fail(`manifest is missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as ArtifactManifest;
}

function createOutput(output: string, build: (temporary: string, payload: string) => void): void {
  const root = resolve(output);
  if (existsSync(root)) fail(`output already exists: ${root}`);
  const temporary = `${root}.create-${process.pid}`;
  if (existsSync(temporary)) fail(`temporary output already exists: ${temporary}`);
  try {
    const payload = join(temporary, 'payload');
    mkdirSync(payload, { recursive: true });
    build(temporary, payload);
    renameSync(temporary, root);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function resolveDependency(parent: string, name: string, fallbacks: readonly string[], version?: string): string | null {
  const candidates = [join(parent, 'node_modules', name)];
  for (let ancestor = dirname(parent); ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    if (basename(ancestor) === 'node_modules') candidates.push(join(ancestor, name));
    if (ancestor === INTEGRATION_ROOT || ancestor === IDE_ROOT) break;
  }
  candidates.push(...fallbacks.map((root) => join(root, name)));
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (existsSync(join(resolved, 'package.json')) && (!version || readJson(join(resolved, 'package.json')).version === version)) return resolved;
    } catch {
      // Continue through the declared install roots.
    }
  }
  for (const store of [join(INTEGRATION_ROOT, 'node_modules/.bun'), join(IDE_ROOT, 'node_modules/.bun')]) {
    if (!existsSync(store)) continue;
    for (const entry of readdirSync(store)) {
      const candidate = join(store, entry, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json')) && (!version || readJson(join(candidate, 'package.json')).version === version)) return candidate;
    }
  }
  return null;
}

export function sharpNativePackageNames(optional: Record<string, string>, platform: ReleasePlatform): string[] {
  const suffix = platform === 'macos-arm64' ? 'darwin-arm64' : platform === 'macos-x64' ? 'darwin-x64' : 'win32-x64';
  return Object.keys(optional)
    .filter((name) => name === `@img/sharp-${suffix}` || name === `@img/sharp-libvips-${suffix}`)
    .sort();
}

function stageServerTargetRuntime(payload: string, platform: ReleasePlatform): string[] {
  const destination = join(payload, 'server-runtime/node_modules');
  const fallbacks = [join(SERVER_ROOT, 'node_modules'), join(INTEGRATION_ROOT, 'node_modules'), join(IDE_ROOT, 'node_modules')];
  const sharp = resolveDependency(SERVER_ROOT, 'sharp', fallbacks);
  if (!sharp) fail('server sharp dependency is not installed');
  const optional = readJson(join(sharp, 'package.json')).optionalDependencies ?? {};
  const names = sharpNativePackageNames(optional, platform);
  if (names.length === 0) fail(`sharp native dependencies are not declared for ${platform}`);
  const required: string[] = [];
  for (const name of names) {
    const source = resolveDependency(sharp, name, fallbacks, optional[name]);
    if (!source) fail(`sharp native dependency is not installed at ${optional[name]}: ${name}`);
    copyTree(source, join(destination, name), true);
    required.push(`server-runtime/node_modules/${name}/package.json`);
  }
  return required;
}

function stageServerCommonRuntime(payload: string): string[] {
  const cliEntry = join(CLI_ROOT, 'src/cli/main.ts');
  run(['build', join(IDE_ROOT, 'scripts/server-native-preload.ts'), '--target=bun', '--outfile', join(payload, 'server-runtime/native-preload.mjs')]);
  run(['build', join(AGENT_HOST_ROOT, 'src/main.ts'), '--target=bun', '--packages=bundle', '--outfile', join(payload, 'server-runtime/agent-host.mjs')]);
  if (!existsSync(cliEntry)) fail(`forgeax-core serve entry is missing: ${cliEntry}`);
  run([
    'build', cliEntry,
    '--target=bun',
    '--packages=bundle',
    '--external', 'react-devtools-core',
    '--outfile', join(payload, 'server-runtime/forgeax-core-serve.mjs'),
  ]);
  const assets = [
    [join(SERVER_ROOT, 'src/game/game-charter.md'), 'game-charter.md'],
    [join(ORCHESTRATOR_ROOT, 'src/kernel/ui-bridge-contract.json'), 'ui-bridge-contract.json'],
  ] as const;
  for (const [source, name] of assets) {
    if (!existsSync(source)) fail(`server runtime asset is missing: ${source}`);
    const output = join(payload, 'server-runtime/assets', name);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(source, output);
  }
  return [
    'server-runtime/native-preload.mjs',
    'server-runtime/agent-host.mjs',
    'server-runtime/forgeax-core-serve.mjs',
    'server-runtime/assets/game-charter.md',
    'server-runtime/assets/ui-bridge-contract.json',
  ];
}

function stageGameCreationResources(payload: string): string[] {
  const catalog = join(payload, 'editor/apps/standalone/template-catalog.ts');
  if (!existsSync(catalog)) fail(`composed Editor template catalog is missing: ${catalog}`);
  copyTree(join(SERVER_ROOT, 'templates/game-minimal'), join(payload, 'server/templates/game-minimal'), true);
  const templates = join(payload, 'editor/packages/engine/templates');
  if (!existsSync(templates)) fail(`composed Engine templates are missing: ${templates}`);
  const required = [
    'editor/apps/standalone/template-catalog.ts',
    'server/templates/game-minimal/forge.json',
    'server/templates/game-minimal/main.ts',
  ];
  let templateCount = 0;
  for (const entry of readdirSync(templates, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'node_modules') continue;
    const templateRoot = join(templates, entry.name);
    const manifestPath = join(templateRoot, 'forge.json');
    const manifestRelative = `editor/packages/engine/templates/${entry.name}/forge.json`;
    if (!existsSync(manifestPath)) fail(`packaged game template is incomplete: ${manifestRelative}`);
    const templateEntry = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { entry?: unknown }).entry;
    if (typeof templateEntry !== 'string' || !templateEntry || templateEntry !== templateEntry.trim()
      || templateEntry.includes('\\') || isAbsolute(templateEntry) || templateEntry.split('/').includes('..')) {
      fail(`packaged game template has an invalid entry: ${manifestRelative}`);
    }
    const entryPath = resolve(templateRoot, templateEntry);
    const relativeEntry = relative(templateRoot, entryPath);
    if (!relativeEntry || relativeEntry === '..' || relativeEntry.startsWith(`..${sep}`) || isAbsolute(relativeEntry)) {
      fail(`packaged game template entry escapes its root: ${manifestRelative}`);
    }
    const entryRelative = `editor/packages/engine/templates/${entry.name}/${templateEntry}`;
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) fail(`packaged game template is incomplete: ${entryRelative}`);
    required.push(manifestRelative, entryRelative);
    templateCount += 1;
  }
  if (templateCount === 0) fail('no engine game templates were staged');
  return required;
}

export function createRuntimeCommonArtifact(output: string, webCommon: string, engineCommon: string): ArtifactManifest {
  let result: ArtifactManifest | undefined;
  createOutput(output, (temporary, payload) => {
    materializeWebArtifact(webCommon, join(payload, 'interface/dist'));
    const engine = join(temporary, 'engine-common');
    composeEngineCommonArtifacts(engineCommon, engine);
    copyTree(engine, payload);
    rmSync(engine, { recursive: true, force: true });
    mkdirSync(join(payload, 'runtime'), { recursive: true });
    run(['build', join(IDE_ROOT, 'scripts/desktop-runtime.ts'), '--target=bun', '--outfile', join(payload, 'runtime/local-runtime.mjs')]);
    const required = [...stageGameCreationResources(payload), ...stageServerCommonRuntime(payload)];
    for (const path of required) if (!existsSync(join(payload, path))) fail(`common runtime resource is missing: ${path}`);
    normalizePortableArtifactFiles(payload);
    result = writeManifest(payload, join(temporary, 'manifest.json'), descriptor('common'));
  });
  return result!;
}

export function createRuntimeTargetArtifact(
  output: string,
  platform: ReleasePlatform,
  engineTarget: string,
  serverSidecarRoot: string,
  context: ReleaseContext,
): ArtifactManifest {
  let result: ArtifactManifest | undefined;
  const target = platformTargets[platform];
  createOutput(output, (temporary, payload) => {
    const engine = join(temporary, 'engine-target');
    composeEngineTargetArtifact(engineTarget, platform, engine);
    copyTree(engine, payload);
    rmSync(engine, { recursive: true, force: true });
    const sharpResources = stageServerTargetRuntime(payload, platform);
    const sidecars = join(payload, 'sidecars');
    mkdirSync(sidecars, { recursive: true });
    const bunSidecar = join(sidecars, `bun-${target.triple}${target.extension}`);
    copyFileSync(process.execPath, bunSidecar);
    const serverName = `forgeax-server-${target.triple}${target.extension}`;
    const serverSource = join(resolve(serverSidecarRoot), 'sidecars', serverName);
    if (!existsSync(serverSource) || statSync(serverSource).size < 1_048_576) fail(`validated server sidecar is missing: ${serverSource}`);
    const serverSidecar = join(sidecars, serverName);
    copyFileSync(serverSource, serverSidecar);
    if (target.extension === '') {
      chmodSync(bunSidecar, 0o755);
      chmodSync(serverSidecar, 0o755);
    }
    for (const path of [
      `sidecars/bun-${target.triple}${target.extension}`,
      `sidecars/${serverName}`,
      ...sharpResources,
    ]) if (!existsSync(join(payload, path))) fail(`target runtime resource is missing: ${path}`);
    result = writeManifest(payload, join(temporary, 'manifest.json'), descriptor('target', platform, context));
  });
  return result!;
}

export function materializeRuntimeWeb(common: string, destination: string): void {
  const commonRoot = resolve(common);
  const manifest = readManifest(join(commonRoot, 'manifest.json'));
  verifyArtifactManifest(join(commonRoot, 'payload'), manifest, descriptor('common'));
  const output = resolve(destination);
  if (existsSync(output)) fail(`Web destination already exists: ${output}`);
  copyTree(join(commonRoot, 'payload/interface/dist'), output);
}

export function runtimeArtifactInputs(common: string, target: string, platform: ReleasePlatform, context: ReleaseContext) {
  const commonRoot = resolve(common);
  const targetRoot = resolve(target);
  return [
    { root: join(commonRoot, 'payload'), manifest: readManifest(join(commonRoot, 'manifest.json')), expected: descriptor('common') },
    { root: join(targetRoot, 'payload'), manifest: readManifest(join(targetRoot, 'manifest.json')), expected: descriptor('target', platform, context) },
  ];
}

if (import.meta.main) {
  const command = Bun.argv[2];
  const output = argument('--output');
  if (!output) fail('--output is required');
  if (command === 'common') {
    const webCommon = argument('--web-common');
    const engineCommon = argument('--engine-common');
    if (!webCommon || !engineCommon) fail('common requires --web-common and --engine-common');
    createRuntimeCommonArtifact(output, webCommon, engineCommon);
  } else if (command === 'target') {
    const platform = argument('--platform') as ReleasePlatform | undefined;
    const engineTarget = argument('--engine-target');
    const serverSidecarRoot = argument('--server-sidecar-root');
    const contextPath = argument('--context');
    if (!platform || !(platform in platformTargets) || !engineTarget || !serverSidecarRoot || !contextPath) {
      fail('target requires --platform, --engine-target, --server-sidecar-root, and --context');
    }
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as ReleaseContext;
    createRuntimeTargetArtifact(output, platform, engineTarget, serverSidecarRoot, context);
  } else {
    fail('command must be common or target');
  }
  console.log(JSON.stringify({ code: 'DESKTOP_RUNTIME_ARTIFACT_COMMAND_OK', command }));
}
