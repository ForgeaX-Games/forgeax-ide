#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

export function resolveAuthorizedAppTarget(raw: string | undefined): string {
  const app = resolve(raw ?? '');
  if (!raw || !app.endsWith('.app') || !existsSync(app) || !statSync(app).isDirectory()) {
    throw new Error('--app must point to one existing .app bundle');
  }
  for (const required of ['Contents/Info.plist', 'Contents/MacOS/bun']) {
    if (!existsSync(join(app, required))) throw new Error(`not a ForgeaX desktop bundle: missing ${required}`);
  }
  return app;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 'unknown'}`);
}

if (import.meta.main) {
  if (process.platform !== 'darwin') throw new Error('local macOS app authorization requires macOS');
  const app = resolveAuthorizedAppTarget(argument('--app'));
  run(process.execPath, ['run', join(import.meta.dir, 'verify-macos-bundle.ts'), '--app', app]);
  run('xattr', ['-dr', 'com.apple.quarantine', app]);
  if (!Bun.argv.includes('--no-open')) run('open', [app]);
  console.log(JSON.stringify({
    code: 'IDE_LOCAL_MACOS_APP_AUTHORIZED',
    app,
    quarantineScope: app,
    opened: !Bun.argv.includes('--no-open'),
  }));
}
