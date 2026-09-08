import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import valid from './fixtures/resources/valid.json';
import mismatch from './fixtures/resources/mismatch.json';

type ShellResources = { frontendDist: string; resources: string[]; externalBin: string[]; capabilities: string[] };

function validate(resources: ShellResources): string[] {
  const errors: string[] = [];
  if (resources.frontendDist !== '../dist') errors.push('frontend-version');
  if (!resources.resources.length || !resources.externalBin.length) errors.push('sidecar-resource');
  if (!resources.resources.every((resource) => resources.externalBin.includes(resource))) errors.push('sidecar-mismatch');
  if (!resources.capabilities.includes('main')) errors.push('capability');
  return errors;
}

describe('Tauri shell resource boundary', () => {
  it('keeps frontend, sidecar and capabilities explicit', () => expect(validate(valid)).toEqual([]));
  it('rejects version mismatch and missing native resources', () => expect(validate(mismatch)).toEqual(expect.arrayContaining(['frontend-version', 'sidecar-resource', 'capability'])));
  it('uses the cross-platform graceful shutdown protocol before force-kill', () => {
    const shell = readFileSync(join(import.meta.dir, '../src/lib.rs'), 'utf8');
    const launcher = readFileSync(join(import.meta.dir, '../../scripts/desktop-runtime.ts'), 'utf8');
    expect(shell).toContain('child.write(b"shutdown\\n")');
    expect(shell).toContain('shutting_down.swap(true, Ordering::SeqCst)');
    expect(shell).not.toContain('Command::new("/bin/kill")');
    expect(launcher).toContain("lines.includes('shutdown')");
  });
});
