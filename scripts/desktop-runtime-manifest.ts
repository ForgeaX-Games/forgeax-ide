import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  inventoryArtifactFiles,
  sha256,
  type ArtifactFile,
  type ArtifactManifest,
} from './artifact-manifest';
import { platformTargets, type ReleasePlatform } from './stage-release-sidecar';

export const DESKTOP_RUNTIME_MANIFEST_SCHEMA = 'forgeax-ide-desktop-runtime/v2' as const;
export const DESKTOP_RUNTIME_MANIFEST_PATH = 'runtime/desktop-runtime-manifest.json';

type ArtifactReference = { artifactId: string; digest: string };
export type DesktopRuntimeManifest = {
  schema: typeof DESKTOP_RUNTIME_MANIFEST_SCHEMA;
  algorithm: 'sha256';
  platform: ReleasePlatform;
  targetTriple: string;
  inputs: { common: ArtifactReference; target: ArtifactReference };
  ports: { server: 18810; engine: 15273 };
  files: ArtifactFile[];
  digest: string;
};

const MANIFEST_KEYS = ['algorithm', 'digest', 'files', 'inputs', 'platform', 'ports', 'schema', 'targetTriple'];
const INPUT_KEYS = ['common', 'target'];
const REFERENCE_KEYS = ['artifactId', 'digest'];
const PORT_KEYS = ['engine', 'server'];
const SHA256 = /^[0-9a-f]{64}$/;

function fail(message: string): never {
  throw new Error(`[desktop-runtime-manifest] ${message}`);
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function reference(manifest: ArtifactManifest): ArtifactReference {
  return { artifactId: manifest.artifactId, digest: manifest.digest };
}

function unsigned(manifest: Omit<DesktopRuntimeManifest, 'digest'>): Omit<DesktopRuntimeManifest, 'digest'> {
  return manifest;
}

export function createDesktopRuntimeManifest(
  resources: string,
  platform: ReleasePlatform,
  common: ArtifactManifest,
  target: ArtifactManifest,
): DesktopRuntimeManifest {
  const value = unsigned({
    schema: DESKTOP_RUNTIME_MANIFEST_SCHEMA,
    algorithm: 'sha256',
    platform,
    targetTriple: platformTargets[platform].triple,
    inputs: { common: reference(common), target: reference(target) },
    ports: { server: 18810, engine: 15273 },
    files: inventoryArtifactFiles(resources),
  });
  const manifest = { ...value, digest: sha256(canonicalJson(value)) };
  const output = join(resources, DESKTOP_RUNTIME_MANIFEST_PATH);
  if (existsSync(output)) fail(`refusing to replace existing manifest: ${output}`);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

function assertReference(value: unknown, expectedId: string): asserts value is ArtifactReference {
  if (!exactKeys(value, REFERENCE_KEYS) || value.artifactId !== expectedId
    || typeof value.digest !== 'string' || !SHA256.test(value.digest)) fail(`invalid ${expectedId} reference`);
}

export function verifyDesktopRuntimeManifest(
  resources: string,
  value: unknown,
  platform: ReleasePlatform,
  expectedInputs?: { common: ArtifactReference; target: ArtifactReference },
): DesktopRuntimeManifest {
  if (!exactKeys(value, MANIFEST_KEYS)) fail('unknown or missing manifest fields');
  const manifest = value as unknown as DesktopRuntimeManifest;
  if (manifest.schema !== DESKTOP_RUNTIME_MANIFEST_SCHEMA || manifest.algorithm !== 'sha256') fail('unknown schema or digest algorithm');
  if (manifest.platform !== platform || manifest.targetTriple !== platformTargets[platform].triple) fail('platform identity mismatch');
  if (!exactKeys(manifest.inputs, INPUT_KEYS)) fail('invalid artifact inputs');
  assertReference(manifest.inputs.common, 'ide-desktop-runtime-common/v1');
  assertReference(manifest.inputs.target, 'ide-desktop-runtime-target/v1');
  if (expectedInputs && canonicalJson(manifest.inputs) !== canonicalJson(expectedInputs)) fail('artifact input digest mismatch');
  if (!exactKeys(manifest.ports, PORT_KEYS) || manifest.ports.server !== 18810 || manifest.ports.engine !== 15273) fail('port contract mismatch');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 || typeof manifest.digest !== 'string' || !SHA256.test(manifest.digest)) fail('invalid files or digest');
  const actual = inventoryArtifactFiles(resources).filter((file) => file.path !== DESKTOP_RUNTIME_MANIFEST_PATH);
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) fail('composed resource files do not match manifest');
  const { digest, ...withoutDigest } = manifest;
  if (sha256(canonicalJson(withoutDigest)) !== digest) fail('manifest digest mismatch');
  return manifest;
}

export function readDesktopRuntimeManifest(resources: string): unknown {
  const path = join(resources, DESKTOP_RUNTIME_MANIFEST_PATH);
  if (!existsSync(path)) fail(`manifest is missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
