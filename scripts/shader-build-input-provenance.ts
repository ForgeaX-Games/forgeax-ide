import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SHADER_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const SHADER_PLUGIN_PACKAGE = '@forgeax/engine-vite-plugin-shader' as const;
export const SHADER_BUILD_COMMAND = 'pnpm --filter @forgeax/engine-vite-plugin-shader... run build' as const;

export type EngineSourceIdentity = {
  readonly revision: string;
  readonly tree: string;
  readonly dirty: boolean;
};

export type ShaderBuildInputPaths = {
  readonly shaderPluginEntry: string;
  readonly wgpuWasmGlue: string;
  readonly provenancePath: string;
};

export type ShaderBuildProvenance = {
  readonly schemaVersion: typeof SHADER_PROVENANCE_SCHEMA_VERSION;
  readonly artifact: typeof SHADER_PLUGIN_PACKAGE;
  readonly source: {
    readonly revision: string;
    readonly tree: string;
    readonly dirty: boolean;
  };
  readonly build: {
    readonly command: typeof SHADER_BUILD_COMMAND;
  };
  readonly outputs: {
    readonly 'index.mjs': {
      readonly sha256: string;
    };
  };
};

export type ShaderBuildProvenanceCheck = {
  readonly valid: boolean;
  readonly reusable: boolean;
  readonly publishable: boolean;
  readonly reasons: readonly string[];
  readonly current: EngineSourceIdentity;
  readonly observed: ShaderBuildProvenance | null;
};

const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function shaderBuildInputPaths(engineRoot: string): ShaderBuildInputPaths {
  const shaderDistRoot = resolve(engineRoot, 'packages/vite-plugin-shader/dist');
  return {
    shaderPluginEntry: resolve(shaderDistRoot, 'index.mjs'),
    wgpuWasmGlue: resolve(engineRoot, 'packages/wgpu-wasm/pkg/wgpu_wasm.js'),
    provenancePath: resolve(shaderDistRoot, 'forgeax-build-provenance.v1.json'),
  };
}

function gitOutput(engineRoot: string, args: readonly string[]): string {
  try {
    return execFileSync('git', ['-C', engineRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Engine git identity at ${engineRoot}: ${detail}`);
  }
}

export function readEngineSourceIdentity(engineRoot: string): EngineSourceIdentity {
  const revision = gitOutput(engineRoot, ['rev-parse', 'HEAD']);
  const tree = gitOutput(engineRoot, ['rev-parse', 'HEAD^{tree}']);
  const status = gitOutput(engineRoot, [
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--ignore-submodules=dirty',
  ]);
  return { revision, tree, dirty: status.length > 0 };
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readProvenance(path: string): ShaderBuildProvenance | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) return null;
    const source = parsed.source;
    const build = parsed.build;
    const outputs = parsed.outputs;
    const indexOutput = isRecord(outputs) ? outputs['index.mjs'] : undefined;
    if (
      parsed.schemaVersion !== SHADER_PROVENANCE_SCHEMA_VERSION
      || parsed.artifact !== SHADER_PLUGIN_PACKAGE
      || !isRecord(source)
      || typeof source.revision !== 'string'
      || typeof source.tree !== 'string'
      || typeof source.dirty !== 'boolean'
      || !isRecord(build)
      || build.command !== SHADER_BUILD_COMMAND
      || !isRecord(indexOutput)
      || typeof indexOutput.sha256 !== 'string'
    ) {
      return null;
    }
    return parsed as unknown as ShaderBuildProvenance;
  } catch {
    return null;
  }
}

export function inspectShaderBuildProvenance(
  paths: ShaderBuildInputPaths,
  current: EngineSourceIdentity,
): ShaderBuildProvenanceCheck {
  const reasons: string[] = [];
  const observed = readProvenance(paths.provenancePath);

  if (!existsSync(paths.shaderPluginEntry)) reasons.push(`missing shader plugin: ${paths.shaderPluginEntry}`);
  if (observed === null) {
    reasons.push(`missing or invalid provenance: ${paths.provenancePath}`);
  } else {
    if (!SHA1_PATTERN.test(observed.source.revision)) reasons.push('provenance source.revision is not a full git SHA');
    if (!SHA1_PATTERN.test(observed.source.tree)) reasons.push('provenance source.tree is not a full git tree SHA');
    if (!SHA256_PATTERN.test(observed.outputs['index.mjs'].sha256)) reasons.push('provenance index.mjs hash is invalid');
    if (observed.source.revision !== current.revision) reasons.push('provenance Engine revision does not match the checkout');
    if (observed.source.tree !== current.tree) reasons.push('provenance Engine tree does not match the checkout');
    if (observed.source.dirty !== current.dirty) reasons.push('provenance dirty state does not match the checkout');
    if (existsSync(paths.shaderPluginEntry) && sha256File(paths.shaderPluginEntry) !== observed.outputs['index.mjs'].sha256) {
      reasons.push('shader plugin dist/index.mjs hash does not match provenance');
    }
  }

  const valid = reasons.length === 0;
  return {
    valid,
    reusable: valid && !current.dirty,
    publishable: valid && !current.dirty,
    reasons,
    current,
    observed,
  };
}

export function writeShaderBuildProvenance(
  paths: ShaderBuildInputPaths,
  current: EngineSourceIdentity,
): ShaderBuildProvenance {
  if (!existsSync(paths.shaderPluginEntry)) {
    throw new Error(`Cannot write shader provenance before the plugin is built: ${paths.shaderPluginEntry}`);
  }
  const provenance: ShaderBuildProvenance = {
    schemaVersion: SHADER_PROVENANCE_SCHEMA_VERSION,
    artifact: SHADER_PLUGIN_PACKAGE,
    source: {
      revision: current.revision,
      tree: current.tree,
      dirty: current.dirty,
    },
    build: { command: SHADER_BUILD_COMMAND },
    outputs: { 'index.mjs': { sha256: sha256File(paths.shaderPluginEntry) } },
  };
  const temporaryPath = `${paths.provenancePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  try {
    renameSync(temporaryPath, paths.provenancePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return provenance;
}
