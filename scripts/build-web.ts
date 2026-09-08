#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ideRoot = resolve(import.meta.dir, '..');
const integrationRoot = resolve(ideRoot, '../..');
const vite = join(ideRoot, 'node_modules/vite/bin/vite.js');
const result = spawnSync(process.execPath, [vite, 'build'], {
  cwd: ideRoot,
  stdio: 'inherit',
  env: { ...process.env, FORGEAX_INTEGRATION_ROOT: integrationRoot },
});
process.exit(result.status ?? 1);
