import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  inspectShaderBuildProvenance,
  readEngineSourceIdentity,
  shaderBuildInputPaths,
  writeShaderBuildProvenance,
} from './shader-build-input-provenance';

const ideRoot = resolve(import.meta.dir, '..');
const integrationRoot = process.env.FORGEAX_INTEGRATION_ROOT
  ? resolve(process.env.FORGEAX_INTEGRATION_ROOT)
  : resolve(ideRoot, '../..');

const engineRoot = resolve(integrationRoot, 'packages/editor/packages/engine');
const shaderInputs = shaderBuildInputPaths(engineRoot);

// The public Editor Vite preset is evaluated by the consumer's Node process.
// Its package exports intentionally point at Engine's generated dist files, so
// a clean integration checkout must build every config-time import before Vite
// loads the preset. Keeping this list next to the preparation gate prevents a
// new public preset import from silently turning into a clean-CI-only failure.
const engineConfigBuildInputs = [
  ['packages/vite-plugin-shader/dist/index.mjs', '@forgeax/engine-vite-plugin-shader...'],
  ['packages/vite-plugin-pack/dist/index.mjs', '@forgeax/engine-vite-plugin-pack...'],
  ['packages/vite-plugin-rhi-debug/dist/index.mjs', '@forgeax/engine-vite-plugin-rhi-debug...'],
  ['packages/image/dist/image-importer.mjs', '@forgeax/engine-image...'],
  ['packages/gltf/dist/index.mjs', '@forgeax/engine-gltf...'],
  ['packages/fbx/dist/index.mjs', '@forgeax/engine-fbx...'],
  ['packages/font/dist/font-importer.mjs', '@forgeax/engine-font...'],
  ['packages/vfx-compiler/dist/index.mjs', '@forgeax/engine-vfx-compiler...'],
  ['packages/shader-compiler/dist/index.mjs', '@forgeax/engine-shader-compiler...'],
  ['packages/audio-webaudio/dist/audio-importer.mjs', '@forgeax/engine-audio-webaudio...'],
] as const;

function runEngineCommand(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], {
    cwd: engineRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      FORGEAX_REPO_ROOT: engineRoot,
    },
  });

  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runIdeCommand(command: string, args: readonly string[]): void {
  const result = spawnSync(command, [...args], {
    cwd: ideRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      FORGEAX_INTEGRATION_ROOT: integrationRoot,
    },
  });

  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const currentSource = readEngineSourceIdentity(engineRoot);
let provenanceCheck = inspectShaderBuildProvenance(shaderInputs, currentSource);
const needsShaderBuild = !provenanceCheck.reusable;
const missingConfigInputs = engineConfigBuildInputs.filter(([entry]) => !existsSync(resolve(engineRoot, entry)));

if (!existsSync(shaderInputs.wgpuWasmGlue)) {
  runEngineCommand('bun', ['run', '--cwd', 'packages/wgpu-wasm', 'build:wasm']);
}
if (needsShaderBuild || missingConfigInputs.length > 0) {
  const filters = new Set(missingConfigInputs.map(([, filter]) => filter));
  if (needsShaderBuild) filters.add('@forgeax/engine-vite-plugin-shader...');
  runEngineCommand('pnpm', [
    ...[...filters].flatMap((filter) => ['--filter', filter]),
    'run',
    'build',
  ]);
  if (needsShaderBuild) writeShaderBuildProvenance(shaderInputs, currentSource);
}

if (!existsSync(shaderInputs.wgpuWasmGlue)) {
  throw new Error(`Engine WASM source build did not produce ${shaderInputs.wgpuWasmGlue}`);
}
for (const [entry] of engineConfigBuildInputs) {
  const absoluteEntry = resolve(engineRoot, entry);
  if (!existsSync(absoluteEntry)) {
    throw new Error(`Engine package build did not produce ${absoluteEntry}`);
  }
}

provenanceCheck = inspectShaderBuildProvenance(shaderInputs, currentSource);
if (!provenanceCheck.valid) {
  throw new Error([
    'Engine shader build provenance is invalid:',
    ...provenanceCheck.reasons.map((reason) => `- ${reason}`),
  ].join('\n'));
}
if (
  process.env.FORGEAX_REQUIRE_PUBLISHABLE_SHADER_INPUTS === '1'
  && !provenanceCheck.publishable
) {
  throw new Error(
    'Engine shader build provenance is not publishable: release builds require a clean Engine checkout',
  );
}

runIdeCommand('bun', ['run', 'verify:shader-vite-contract']);
