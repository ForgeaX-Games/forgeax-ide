#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ideRoot = resolve(import.meta.dir, '..');

function hostTarget(): { triple: string; extension: string } {
  if (process.platform === 'darwin' && process.arch === 'arm64') return { triple: 'aarch64-apple-darwin', extension: '' };
  if (process.platform === 'darwin' && process.arch === 'x64') return { triple: 'x86_64-apple-darwin', extension: '' };
  if (process.platform === 'win32' && process.arch === 'x64') return { triple: 'x86_64-pc-windows-msvc', extension: '.exe' };
  if (process.platform === 'linux' && process.arch === 'x64') return { triple: 'x86_64-unknown-linux-gnu', extension: '' };
  throw new Error(`unsupported desktop build host: ${process.platform}/${process.arch}`);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: ideRoot, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ['run', 'build:web']);
const target = hostTarget();
const sidecars = join(ideRoot, 'src-tauri/resources/sidecars');
mkdirSync(sidecars, { recursive: true });
const bunSidecar = join(sidecars, `bun-${target.triple}${target.extension}`);
copyFileSync(process.execPath, bunSidecar);
if (!target.extension) chmodSync(bunSidecar, 0o755);
run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml']);
