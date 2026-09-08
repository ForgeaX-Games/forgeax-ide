#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';

const ideRoot = resolve(import.meta.dirname, '..');
const port = Number(process.env.IDE_PRODUCTION_SMOKE_PORT ?? '19899');
const baseUrl = `http://127.0.0.1:${port}/`;
const distRoot = resolve(ideRoot, 'dist');
const indexPath = resolve(distRoot, 'index.html');
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.wgsl', 'text/plain; charset=utf-8'],
]);

function browserLaunchOptions(): Parameters<typeof chromium.launch>[0] {
  const configuredExecutable = process.env.IDE_BROWSER_EXECUTABLE;
  if (configuredExecutable) {
    if (!existsSync(configuredExecutable)) throw new Error('IDE_BROWSER_EXECUTABLE must point to a Chromium-compatible browser');
    return { executablePath: configuredExecutable, headless: true };
  }
  if (process.platform === 'win32') return { channel: 'msedge', headless: true };
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(executablePath)) throw new Error('IDE_BROWSER_EXECUTABLE must point to a Chromium-compatible browser');
  return { executablePath, headless: true };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
}

function resolveRequestedAsset(requestUrl: string): string {
  const pathname = decodeURIComponent(new URL(requestUrl, baseUrl).pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (requested.includes('\\') || requested.split('/').includes('..')) throw new Error('IDE_PRODUCTION_BUNDLE_ASSET_PATH_INVALID');
  const assetPath = resolve(distRoot, requested);
  const relativeAsset = relative(distRoot, assetPath);
  if (relativeAsset === '..' || relativeAsset.startsWith(`..${sep}`) || isAbsolute(relativeAsset)) {
    throw new Error('IDE_PRODUCTION_BUNDLE_ASSET_PATH_INVALID');
  }
  return assetPath;
}

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('IDE_PRODUCTION_SMOKE_PORT must be a valid TCP port');
}
if (!await isFile(indexPath)) throw new Error('IDE_PRODUCTION_BUNDLE_INDEX_MISSING');

const server = createServer(async (request, response) => {
  try {
    const requestedAsset = resolveRequestedAsset(request.url ?? '/');
    const assetPath = await isFile(requestedAsset) ? requestedAsset : indexPath;
    const body = await readFile(assetPath);
    response.writeHead(200, { 'content-type': contentTypes.get(extname(assetPath)) ?? 'application/octet-stream' });
    response.end(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'IDE_PRODUCTION_BUNDLE_ASSET_PATH_INVALID' ? 400 : 500;
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(message);
  }
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(port, '127.0.0.1', resolveListen);
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch(browserLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#root > *').first().waitFor({ state: 'visible' });
  const visibleText = (await page.locator('#root').innerText()).trim();
  if (!visibleText) throw new Error('production bundle mounted an empty root');
  if (pageErrors.length > 0) throw new Error(`production bundle page errors:\n${pageErrors.join('\n')}`);
  console.log(JSON.stringify({
    code: 'IDE_PRODUCTION_BUNDLE_SMOKE_OK',
    rootMounted: true,
    consoleErrorCount: consoleErrors.length,
  }));
} finally {
  await browser?.close();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
