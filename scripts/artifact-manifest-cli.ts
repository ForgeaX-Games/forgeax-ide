#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  composeArtifacts,
  createArtifactManifest,
  verifyArtifactManifest,
  type ArtifactDescriptor,
  type ArtifactExpectation,
  type ArtifactManifest,
} from './artifact-manifest';

function fail(message: string): never {
  throw new Error(`[artifact-manifest-cli] ${message}`);
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = argument(name);
  if (!value) fail(`${name} is required`);
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

const command = Bun.argv[2];
if (command === 'create') {
  const root = resolve(required('--root'));
  const descriptor = readJson(required('--descriptor')) as ArtifactDescriptor;
  const output = resolve(required('--output'));
  const manifest = createArtifactManifest(root, descriptor);
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ code: 'ARTIFACT_MANIFEST_CREATED', artifactId: manifest.artifactId, digest: manifest.digest, files: manifest.files.length, output }));
} else if (command === 'verify') {
  const root = resolve(required('--root'));
  const manifest = readJson(required('--manifest'));
  const expected = readJson(required('--expected')) as ArtifactExpectation;
  const verified = verifyArtifactManifest(root, manifest, expected);
  console.log(JSON.stringify({ code: 'ARTIFACT_MANIFEST_VERIFIED', artifactId: verified.artifactId, digest: verified.digest, files: verified.files.length }));
} else if (command === 'compose') {
  const destination = resolve(required('--destination'));
  const inputPath = required('--inputs');
  const raw = readJson(inputPath) as Array<{ root: string; manifest: string; expected: string }>;
  if (!Array.isArray(raw)) fail('--inputs must name a JSON array');
  const base = resolve(inputPath, '..');
  const inputs = raw.map((input) => {
    if (!input || typeof input.root !== 'string' || typeof input.manifest !== 'string' || typeof input.expected !== 'string') fail('invalid compose input');
    const root = resolve(base, input.root);
    const manifestPath = resolve(base, input.manifest);
    if (!existsSync(manifestPath)) fail(`manifest is missing: ${manifestPath}`);
    return { root, manifest: readJson(manifestPath), expected: readJson(resolve(base, input.expected)) as ArtifactExpectation };
  });
  const files = composeArtifacts(destination, inputs);
  console.log(JSON.stringify({ code: 'ARTIFACTS_COMPOSED', destination, files: files.length }));
} else {
  fail('command must be create, verify, or compose');
}
