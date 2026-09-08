#!/usr/bin/env bun
import { copyFileSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

import tauriConfig from '../src-tauri/tauri.conf.json';

const [binaryArg, ...binaryArgs] = process.argv.slice(2);
if (!binaryArg) {
  console.error('macos-dev-runner requires the Cargo binary path');
  process.exit(2);
}

const escapePlist = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

const binary = resolve(binaryArg);
const productName = tauriConfig.productName;
const bundleRoot = resolve(dirname(binary), `${productName}.app`);
const contentsDir = resolve(bundleRoot, 'Contents');
const macosDir = resolve(contentsDir, 'MacOS');
const resourcesDir = resolve(contentsDir, 'Resources');
const bundledExecutable = resolve(macosDir, productName);
const iconSource = resolve(import.meta.dir, '../src-tauri/icons/icon.icns');

mkdirSync(macosDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
rmSync(bundledExecutable, { force: true });
linkSync(binary, bundledExecutable);
copyFileSync(iconSource, resolve(resourcesDir, 'icon.icns'));
writeFileSync(resolve(contentsDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${escapePlist(productName)}</string>
  <key>CFBundleExecutable</key>
  <string>${escapePlist(basename(bundledExecutable))}</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${escapePlist(tauriConfig.identifier)}</string>
  <key>CFBundleName</key>
  <string>${escapePlist(productName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapePlist(tauriConfig.version)}</string>
  <key>CFBundleVersion</key>
  <string>${escapePlist(tauriConfig.version)}</string>
</dict>
</plist>
`);

const child = spawn(bundledExecutable, binaryArgs, {
  env: process.env,
  stdio: 'inherit',
});
// Bun 1.4 adds a memory-pressure-only overload to the global Process type.
// Keep the signal forwarding contract explicit for the Node-compatible
// process implementation used by this runner across Bun type versions.
type SignalProcess = {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
};
const signalProcess = process as unknown as SignalProcess;
let forwardedSignal: NodeJS.Signals | undefined;
const forwardSignal = (signal: NodeJS.Signals): void => {
  forwardedSignal = signal;
  child.kill(signal);
};
const onSigint = (): void => forwardSignal('SIGINT');
const onSigterm = (): void => forwardSignal('SIGTERM');
signalProcess.on('SIGINT', onSigint);
signalProcess.on('SIGTERM', onSigterm);

const status = await new Promise<number>((resolveStatus) => {
  child.once('error', (error) => {
    console.error(`failed to start ${productName}: ${error.message}`);
    resolveStatus(1);
  });
  child.once('exit', (code) => {
    if (code !== null) return resolveStatus(code);
    resolveStatus(forwardedSignal === 'SIGINT' ? 130 : 143);
  });
});
signalProcess.off('SIGINT', onSigint);
signalProcess.off('SIGTERM', onSigterm);
process.exit(status);
