#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  composeArtifacts,
  createArtifactManifest,
  type ComposeInput,
  type ArtifactDescriptor,
  type ArtifactManifest,
} from './artifact-manifest';
import { gitProducer, gitValue, trackedIdentityFile } from './release-artifact-identity';
import { platformTargets, type ReleasePlatform } from './stage-release-sidecar';

const IDE_ROOT = resolve(import.meta.dir, '..');
const INTEGRATION_ROOT = resolve(IDE_ROOT, '../..');
const EDITOR_ROOT = join(INTEGRATION_ROOT, 'packages/editor');
const ENGINE_ROOT = join(EDITOR_ROOT, 'packages/engine');

function fail(message: string): never {
  throw new Error(`[engine-runtime-artifacts] ${message}`);
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) fail(`command failed (${result.status}): ${command} ${args.join(' ')}`);
}

export { trackedIdentityFile } from './release-artifact-identity';

function releaseSourceIdentity(): Record<string, string> {
  return {
    'ide-revision': gitValue(IDE_ROOT, 'rev-parse', 'HEAD'),
    'integration-revision': gitValue(INTEGRATION_ROOT, 'rev-parse', 'HEAD'),
  };
}

function engineDescriptor(): ArtifactDescriptor {
  return {
    artifactId: 'engine-runtime-common/v1',
    producer: gitProducer(ENGINE_ROOT, 'ForgeaX-Games/forgeax-engine'),
    inputs: {
      lockfiles: [trackedIdentityFile(ENGINE_ROOT, 'pnpm-lock.yaml')],
      buildScripts: [trackedIdentityFile(ENGINE_ROOT, 'scripts/stage-desktop-runtime.mjs')],
      toolchains: {
        node: process.version,
        ...releaseSourceIdentity(),
        'editor-revision': gitValue(EDITOR_ROOT, 'rev-parse', 'HEAD'),
      },
    },
    scope: 'common',
    target: null,
  };
}

function editorDescriptor(scope: 'common' | 'target', platform?: ReleasePlatform): ArtifactDescriptor {
  const target = platform ? platformTargets[platform] : undefined;
  return {
    artifactId: scope === 'common' ? 'editor-engine-runtime-common/v1' : 'editor-engine-runtime-target/v1',
    producer: gitProducer(EDITOR_ROOT, 'ForgeaX-Games/forgeax-editor'),
    inputs: {
      lockfiles: [trackedIdentityFile(EDITOR_ROOT, 'bun.lock')],
      buildScripts: [trackedIdentityFile(EDITOR_ROOT, 'scripts/stage-desktop-engine-runtime.ts')],
      toolchains: {
        bun: Bun.version,
        node: process.version,
        ...releaseSourceIdentity(),
        'engine-revision': gitValue(ENGINE_ROOT, 'rev-parse', 'HEAD'),
      },
    },
    scope,
    target: target ? { platform: platform!, triple: target.triple } : null,
  };
}

export function assertTargetHost(
  platform: ReleasePlatform,
  hostPlatform = process.platform,
  hostArch = process.arch,
): void {
  const expected = platform === 'macos-arm64'
    ? ['darwin', 'arm64']
    : platform === 'macos-x64'
      ? ['darwin', 'x64']
      : ['win32', 'x64'];
  if (hostPlatform !== expected[0] || hostArch !== expected[1]) {
    fail(`${platform} artifact must be staged on ${expected.join('/')}; current host is ${hostPlatform}/${hostArch}`);
  }
}

function writeManifest(root: string, manifestPath: string, descriptor: ArtifactDescriptor): void {
  const manifest = createArtifactManifest(root, descriptor);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
}

export function createEngineCommonArtifacts(output: string): void {
  const root = resolve(output);
  if (existsSync(root)) fail(`output already exists: ${root}`);
  const engine = join(root, 'engine');
  const editor = join(root, 'editor');
  mkdirSync(root, { recursive: true });
  run(process.execPath, [join(ENGINE_ROOT, 'scripts/stage-desktop-runtime.mjs'), '--output', join(engine, 'payload')], ENGINE_ROOT);
  run(process.execPath, [join(EDITOR_ROOT, 'scripts/stage-desktop-engine-runtime.ts'), '--scope', 'common', '--output', join(editor, 'payload')], EDITOR_ROOT);
  writeManifest(join(engine, 'payload'), join(engine, 'manifest.json'), engineDescriptor());
  writeManifest(join(editor, 'payload'), join(editor, 'manifest.json'), editorDescriptor('common'));
}

export function createEngineTargetArtifact(output: string, platform: ReleasePlatform): void {
  assertTargetHost(platform);
  const root = resolve(output);
  if (existsSync(root)) fail(`output already exists: ${root}`);
  mkdirSync(root, { recursive: true });
  run(process.execPath, [join(EDITOR_ROOT, 'scripts/stage-desktop-engine-runtime.ts'), '--scope', 'target', '--output', join(root, 'payload')], EDITOR_ROOT);
  writeManifest(join(root, 'payload'), join(root, 'manifest.json'), editorDescriptor('target', platform));
}

function manifest(path: string): ArtifactManifest {
  if (!existsSync(path)) fail(`manifest is missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as ArtifactManifest;
}

function commonInputs(commonRoot: string): ComposeInput[] {
  return [
    {
      root: join(commonRoot, 'engine/payload'),
      manifest: manifest(join(commonRoot, 'engine/manifest.json')), expected: engineDescriptor(),
    },
    {
      root: join(commonRoot, 'editor/payload'),
      manifest: manifest(join(commonRoot, 'editor/manifest.json')), expected: editorDescriptor('common'),
    },
  ];
}

function targetInput(targetRoot: string, platform: ReleasePlatform): ComposeInput {
  return {
    root: join(targetRoot, 'payload'),
    manifest: manifest(join(targetRoot, 'manifest.json')),
    expected: editorDescriptor('target', platform),
  };
}

export function composeEngineCommonArtifacts(common: string, destination: string): void {
  composeArtifacts(resolve(destination), commonInputs(resolve(common)));
}

export function composeEngineTargetArtifact(target: string, platform: ReleasePlatform, destination: string): void {
  composeArtifacts(resolve(destination), [targetInput(resolve(target), platform)]);
}

export function composeEngineArtifacts(common: string, target: string, platform: ReleasePlatform, destination: string): void {
  const commonRoot = resolve(common);
  const targetRoot = resolve(target);
  const output = resolve(destination);
  composeArtifacts(output, [
    ...commonInputs(commonRoot),
    targetInput(targetRoot, platform),
  ]);
}

if (import.meta.main) {
  const command = Bun.argv[2];
  if (command === 'common') {
    const output = argument('--output');
    if (!output) fail('--output is required');
    createEngineCommonArtifacts(output);
  } else if (command === 'target') {
    const output = argument('--output');
    const platform = argument('--platform') as ReleasePlatform | undefined;
    if (!output || !platform || !(platform in platformTargets)) fail('target requires --output and a supported --platform');
    createEngineTargetArtifact(output, platform);
  } else if (command === 'compose') {
    const common = argument('--common');
    const target = argument('--target');
    const destination = argument('--destination');
    const platform = argument('--platform') as ReleasePlatform | undefined;
    if (!common || !target || !destination || !platform || !(platform in platformTargets)) fail('compose requires --common, --target, --destination, and a supported --platform');
    composeEngineArtifacts(common, target, platform, destination);
  } else {
    fail('command must be common, target, or compose');
  }
  console.log(JSON.stringify({ code: 'ENGINE_RUNTIME_ARTIFACT_COMMAND_OK', command }));
}
