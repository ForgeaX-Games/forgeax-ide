#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const IDE_ROOT = resolve(import.meta.dir, '..');
const integrationRoot = process.env.FORGEAX_INTEGRATION_ROOT
  ? resolve(process.env.FORGEAX_INTEGRATION_ROOT)
  : '';
const fxScript = integrationRoot ? resolve(integrationRoot, 'scripts/fx.ts') : '';

if (!fxScript || !existsSync(fxScript)) {
  console.error('FORGEAX_INTEGRATION_ROOT must point to a ForgeaX Studio integration checkout');
  process.exit(2);
}

const debug = process.argv.slice(2).includes('debug');
const macosCargoRunner = resolve(IDE_ROOT, 'scripts/macos-dev-runner.ts');
const macosCargoRunnerEnv = process.platform === 'darwin'
  ? {
      [process.arch === 'arm64'
        ? 'CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER'
        : 'CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER']: `${process.execPath} ${macosCargoRunner}`,
    }
  : {};
const runtimeEnv = {
  ...process.env,
  FORGEAX_INTEGRATION_ROOT: integrationRoot,
  FORGEAX_STARTUP_PROFILE: 'desktop-dev',
  ...macosCargoRunnerEnv,
};

// Bun 1.4 adds a memory-pressure-only overload to the global Process type.
// Keep the signal forwarding contract explicit for the Node-compatible
// process implementation used by this launcher across Bun type versions.
type SignalProcess = {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
};
const signalProcess = process as unknown as SignalProcess;

function runFx(args: string[], stdio: 'inherit' | 'ignore' = 'inherit'): number {
  return spawnSync(process.execPath, [fxScript, ...args], {
    cwd: integrationRoot,
    env: runtimeEnv,
    stdio,
    windowsHide: true,
  }).status ?? 1;
}

const started = runFx(['restart']);
if (started !== 0) process.exit(started);

let status = 1;
try {
  const tauriConfig = JSON.stringify({
    build: { beforeDevCommand: '', devUrl: 'http://127.0.0.1:18920' },
    bundle: { externalBin: [], resources: [] },
  });
  const tauri = spawn(process.execPath, ['run', 'tauri', 'dev', '--config', tauriConfig], {
    cwd: IDE_ROOT,
    env: { ...runtimeEnv, FORGEAX_DEVTOOLS: debug ? '1' : '0' },
    stdio: 'inherit',
    windowsHide: true,
  });
  let forwardedSignal: NodeJS.Signals | undefined;
  const forwardSignal = (signal: NodeJS.Signals): void => {
    forwardedSignal = signal;
    tauri.kill(signal);
  };
  const onSigint = (): void => forwardSignal('SIGINT');
  const onSigterm = (): void => forwardSignal('SIGTERM');
  signalProcess.on('SIGINT', onSigint);
  signalProcess.on('SIGTERM', onSigterm);
  status = await new Promise<number>((resolveStatus) => {
    tauri.once('error', () => resolveStatus(1));
    tauri.once('exit', (code) => {
      if (code !== null) return resolveStatus(code);
      resolveStatus(forwardedSignal === 'SIGINT' ? 130 : 143);
    });
  });
  signalProcess.off('SIGINT', onSigint);
  signalProcess.off('SIGTERM', onSigterm);
} finally {
  runFx(['stop', '--force'], 'ignore');
}

process.exit(status);
