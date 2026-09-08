import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { identityContent, type ArtifactDescriptor, type ArtifactIdentityFile } from './artifact-manifest';

function fail(message: string): never {
  throw new Error(`[release-artifact-identity] ${message}`);
}

export function gitValue(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed in ${root}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function submoduleRevision(superprojectRoot: string, submodulePath: string): string {
  const result = spawnSync('git', ['ls-tree', '-z', 'HEAD', '--', submodulePath], {
    cwd: superprojectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) fail(`git ls-tree HEAD -- ${submodulePath} failed in ${superprojectRoot}: ${result.stderr.trim()}`);
  const match = /^160000 commit ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(result.stdout);
  if (!match || match[2] !== submodulePath) fail(`missing or invalid gitlink: ${submodulePath}`);
  const expected = match[1];
  const submoduleRoot = join(superprojectRoot, submodulePath);
  if (existsSync(join(submoduleRoot, '.git'))) {
    const actual = gitValue(submoduleRoot, 'rev-parse', 'HEAD');
    if (actual !== expected) fail(`submodule revision mismatch for ${submodulePath}: expected ${expected}, received ${actual}`);
  }
  return expected;
}

export function trackedIdentityFile(root: string, path: string, identityPath = path): ArtifactIdentityFile {
  const result = spawnSync('git', ['cat-file', 'blob', `HEAD:${path}`], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) fail(`git cat-file blob HEAD:${path} failed in ${root}: ${result.stderr.toString().trim()}`);
  return identityContent(identityPath, result.stdout);
}

export function gitProducer(root: string, repository: string): ArtifactDescriptor['producer'] {
  return {
    repository,
    revision: gitValue(root, 'rev-parse', 'HEAD'),
    tree: gitValue(root, 'rev-parse', 'HEAD^{tree}'),
  };
}
