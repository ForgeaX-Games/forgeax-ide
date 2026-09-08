import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import transport from '../../release/transport-contract.v1.json';
import { verifyReleaseBundle } from '../../scripts/verify-release-bundle';
import type { ReleaseContext } from '../../scripts/resolve-release-context';

let root = '';
const context: ReleaseContext = {
  orchestrationId: 'issue7-bundle', version: '1.2.3', ideRevision: 'a'.repeat(40), integrationRevision: 'b'.repeat(40), revisionBranch: 'main',
  sidecarManifestUrl: 'https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json', sidecarManifestSha256: 'c'.repeat(64),
  mode: 'dry-run', targetTag: 'v1.2.3', serviceVersion: '0.1.0', candidateArtifactName: 'ide-release-candidate-issue7-bundle',
  assetsArtifactName: 'ide-release-assets-issue7-bundle', workflowDefinitionRevision: 'd'.repeat(40),
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'release-bundle-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function inputs(logicalId: string) {
  const platform = transport.platforms.find((entry) => entry.logicalId === logicalId)!;
  const bundleRoot = join(root, 'bundle'); mkdirSync(bundleRoot, { recursive: true });
  for (const installer of platform.installerRoster) writeFileSync(join(bundleRoot, `ForgeaX${installer.extension}`), installer.logicalId);
  if (logicalId.startsWith('macos-')) mkdirSync(join(bundleRoot, 'macos', 'ForgeaX Studio.app'), { recursive: true });
  return {
    context, logicalId, targetTriple: platform.targetTriple, bundleRoot,
    assetsOutput: join(root, 'assets'), evidenceOutput: join(root, 'evidence', `${logicalId}.json`), recordOutput: join(root, 'records', `${logicalId}.json`),
  };
}

describe('instrumented native bundle verification', () => {
  test('smokes Windows and creates exact candidate-bound installer evidence', () => {
    const commands: string[][] = [];
    const record = verifyReleaseBundle(inputs('windows-x64'), (command, args) => commands.push([command, ...args]));
    expect(commands).toEqual([['bun', 'run', 'smoke:production-bundle']]);
    expect(record.logicalId).toBe('windows-x64');
    expect(record.artifacts).toHaveLength(2);
    expect(existsSync(join(root, 'records', 'windows-x64.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'evidence', 'windows-x64.json'), 'utf8')).mode).toBe('dry-run');
  });

  test('adds complete macOS bundle verification before accepting the DMG', () => {
    const commands: string[][] = [];
    verifyReleaseBundle(inputs('macos-x64'), (command, args) => commands.push([command, ...args]));
    expect(commands[0]).toEqual(['bun', 'run', 'smoke:production-bundle']);
    expect(commands[1][0]).toBe('bun');
    expect(commands[1].join(' ')).toContain('verify:macos-bundle --app');
    expect(commands[1].at(-1)?.endsWith('bundle/macos/ForgeaX Studio.app')).toBe(true);
  });

  test('rejects target drift and publish mode before running verification', () => {
    const commands: string[][] = [];
    expect(() => verifyReleaseBundle({ ...inputs('macos-x64'), targetTriple: 'aarch64-apple-darwin' }, (command, args) => commands.push([command, ...args]))).toThrow('do not match');
    expect(() => verifyReleaseBundle({ ...inputs('windows-x64'), context: { ...context, mode: 'publish' } }, (command, args) => commands.push([command, ...args]))).toThrow('intent=dry-run');
    expect(commands).toEqual([]);
  });
});
