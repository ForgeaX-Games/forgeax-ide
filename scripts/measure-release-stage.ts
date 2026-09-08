#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const IDE_ROOT = resolve(import.meta.dir, '..');
const INTEGRATION_ROOT = resolve(IDE_ROOT, '../..');
const METRICS_ROOT = join(IDE_ROOT, 'release-work/metrics');

function fail(message: string): never {
  throw new Error(`[release-stage] ${message}`);
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

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function measurePath(path: string): { exists: boolean; files: number; symlinks: number; bytes: number } {
  if (!existsSync(path)) return { exists: false, files: 0, symlinks: 0, bytes: 0 };
  let files = 0;
  let symlinks = 0;
  let bytes = 0;
  const walk = (entryPath: string): void => {
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      symlinks += 1;
      bytes += stat.size;
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(entryPath)) walk(join(entryPath, entry));
    } else if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
    }
  };
  walk(path);
  return { exists: true, files, symlinks, bytes };
}

const separator = Bun.argv.indexOf('--');
if (separator < 0 || separator === Bun.argv.length - 1) fail('a command is required after --');
const stage = required('--stage');
if (!/^[a-z][a-z0-9-]*$/.test(stage)) fail('invalid stage id');
const report = resolve(required('--report'));
if (!inside(METRICS_ROOT, report) || !report.endsWith('.json')) fail(`report must be a JSON file under ${METRICS_ROOT}`);
const platform = argument('--platform') ?? 'common';
const targetTriple = argument('--target-triple') ?? null;
const sizeSpecs: Array<{ label: string; path: string }> = [];
for (let index = 2; index < separator; index += 1) {
  if (Bun.argv[index] !== '--size') continue;
  const spec = Bun.argv[index + 1] ?? '';
  const equals = spec.indexOf('=');
  if (equals < 1) fail('--size must be label=path');
  const label = spec.slice(0, equals);
  const path = resolve(spec.slice(equals + 1));
  if (!/^[a-z][a-z0-9-]*$/.test(label) || !inside(INTEGRATION_ROOT, path)) fail(`invalid measured path: ${spec}`);
  sizeSpecs.push({ label, path });
}

const command = Bun.argv.slice(separator + 1);
const startedAt = new Date().toISOString();
const started = process.hrtime.bigint();
const result = spawnSync(command[0], command.slice(1), { env: process.env, stdio: 'inherit' });
const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
const outputs = sizeSpecs.map(({ label, path }) => ({ label, path: relative(INTEGRATION_ROOT, path).replaceAll('\\', '/'), ...measurePath(path) }));
const record = {
  schema: 'forgeax-ide-release-stage/v1',
  stage,
  platform,
  targetTriple,
  startedAt,
  durationMs: Math.round(durationMs * 1000) / 1000,
  exitCode: result.status ?? 1,
  outputs,
};
mkdirSync(dirname(report), { recursive: true });
const temporary = `${report}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
renameSync(temporary, report);
console.log(JSON.stringify({ code: 'IDE_RELEASE_STAGE_RECORDED', report, ...record }));
process.exit(result.status ?? 1);
