import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTargetHost, trackedIdentityFile } from '../../scripts/engine-runtime-artifacts';
import { sha256 } from '../../scripts/artifact-manifest';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Engine runtime artifact orchestration', () => {
  test('binds every logical target to its native build host', () => {
    expect(() => assertTargetHost('macos-arm64', 'darwin', 'arm64')).not.toThrow();
    expect(() => assertTargetHost('macos-x64', 'darwin', 'x64')).not.toThrow();
    expect(() => assertTargetHost('windows-x64', 'win32', 'x64')).not.toThrow();
    expect(() => assertTargetHost('macos-x64', 'darwin', 'arm64')).toThrow('must be staged on darwin/x64');
    expect(() => assertTargetHost('windows-x64', 'darwin', 'x64')).toThrow('must be staged on win32/x64');
  });

  test('binds cross-job artifacts to IDE and Studio integration revisions', () => {
    const source = readFileSync(join(import.meta.dir, '../../scripts/engine-runtime-artifacts.ts'), 'utf8');
    expect(source).toContain("'ide-revision': gitValue(IDE_ROOT, 'rev-parse', 'HEAD')");
    expect(source).toContain("'integration-revision': gitValue(INTEGRATION_ROOT, 'rev-parse', 'HEAD')");
  });

  test('binds tracked inputs to Git blob bytes instead of checkout line endings', () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-artifact-identity-'));
    roots.push(root);
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'CI'], { cwd: root });
    writeFileSync(join(root, 'bun.lock'), 'line-one\nline-two\n');
    execFileSync('git', ['add', 'bun.lock'], { cwd: root });
    execFileSync('git', ['-c', 'core.hooksPath=.git/disabled-hooks', 'commit', '-m', 'fixture'], { cwd: root });

    writeFileSync(join(root, 'bun.lock'), 'line-one\r\nline-two\r\n');
    expect(sha256(readFileSync(join(root, 'bun.lock')))).not.toBe(sha256('line-one\nline-two\n'));

    expect(trackedIdentityFile(root, 'bun.lock')).toEqual({
      path: 'bun.lock',
      sha256: sha256('line-one\nline-two\n'),
    });
  });
});
