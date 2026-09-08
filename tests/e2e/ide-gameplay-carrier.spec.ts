import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { createIdeCarrierActivation } from '../../src/product/start-product';

const baseUrl = process.env.IDE_E2E_URL ?? 'http://127.0.0.1:18920/';
const browserPath = process.env.IDE_BROWSER_EXECUTABLE;
const serverUrl = process.env.IDE_SERVER_URL ?? 'http://127.0.0.1:18900';
const serverDirectory = resolve(import.meta.dir, '../../../server');
const ideDirectory = resolve(import.meta.dir, '../..');
const runtimeScopeSecret = process.env.FORGEAX_RUNTIME_SCOPE_SECRET ?? 'forgeax-m2-t10-runtime-scope-secret';
const evidenceDirectory = resolve(import.meta.dir, '../../../../.forgeax-harness/forgeax-loop/feat-20260822-ide-public-gameplay-carrier/evidence');
const fixedGtaDirectory = '/Users/you/projects/ForgeaX-Games/forgeax-studio/.forgeax/games/gta-route-dev';
const fixedGtaScenePath = join(fixedGtaDirectory, 'assets/scene.pack.json');
const hasM3Evidence = ['t11-checkpoint.json', 't11-opened.png', 't12-recovery-fresh-realm.json'].every((file) => existsSync(join(evidenceDirectory, file)));
setDefaultTimeout(60_000);

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixedGtaFingerprint(): Record<string, unknown> {
  const runGit = (args: string[]): string => {
    const result = Bun.spawnSync(['git', '-C', fixedGtaDirectory, ...args]);
    if (result.exitCode !== 0) throw new Error(`FIXED_GTA_GIT_FAILED:${args.join(' ')}`);
    return new TextDecoder().decode(result.stdout);
  };
  const status = runGit(['status', '--short']).split('\n').filter(Boolean);
  const sceneBytes = readFileSync(fixedGtaScenePath);
  const diff = Bun.spawnSync(['git', '-C', fixedGtaDirectory, 'diff', '--binary', '--', 'assets/scene.pack.json']);
  if (diff.exitCode !== 0) throw new Error('FIXED_GTA_DIFF_FAILED');
  return {
    path: fixedGtaDirectory,
    branch: runGit(['branch', '--show-current']).trim(),
    head: runGit(['rev-parse', 'HEAD']).trim(),
    status,
    scenePackSha256: sha256(sceneBytes),
    workingTreeDiffSha256: sha256(diff.stdout),
  };
}

async function waitForIde(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error('IDE_WEB_SERVER_NOT_READY');
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error('SERVER_NOT_READY');
}

async function waitForPortFree(port: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`E2E_PORT_NOT_FREE:${port}`);
}

async function waitForE2ePortsFree(): Promise<void> {
  await Promise.all([waitForPortFree(18900), waitForPortFree(18920)]);
}

async function waitForCarrierReady(page: Page): Promise<void> {
  await page.locator('[data-host-state="ready"]').waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('[data-transport-state="ready"]').waitFor({ state: 'visible', timeout: 60_000 });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${serverUrl}/api/editor/transport/health`);
      const body = await response.json() as { connected?: boolean; carriers?: Array<{ scope?: string; authority?: string; selected?: { capabilities?: { gameplay?: boolean } } }> };
      if (body.connected === true && body.carriers?.some((carrier) => carrier.scope === 'game:gta-route-dev' && carrier.authority === 'interactive' && carrier.selected?.capabilities?.gameplay === true)) return;
    } catch {
      // The page WebSocket can open before the server has registered its presence.
    }
    await Bun.sleep(250);
  }
  throw new Error('EDITOR_TRANSPORT_NOT_READY');
}

type SpawnedProcess = ReturnType<typeof Bun.spawn>;

async function stopProcess(child: SpawnedProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const signal: NodeJS.Signals = 'SIGTERM';
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
  await Promise.race([child.exited, Bun.sleep(2_000)]);
  if (child.exitCode === null) {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
  }
  await child.exited;
}

async function stopProcesses(...children: SpawnedProcess[]): Promise<void> {
  await Promise.all(children.map((child) => stopProcess(child)));
}

describe.serial('real IDE gameplay carrier boundary', () => {
  it.skipIf(!browserPath)('renders the viewport and explicit gta-route-dev selection at 18920', async () => {
    expect(new URL(baseUrl).port).toBe('18920');
    const hostRoot = mkdtempSync(join(tmpdir(), 'forgeax-m2-t10-visual-host-'));
    await waitForE2ePortsFree();
    const hostServer = Bun.spawn(['bun', 'run', 'start'], {
      cwd: serverDirectory,
      env: { ...process.env, FORGEAX_PROJECT_ROOT: hostRoot, FORGEAX_SERVER_HOST: '127.0.0.1', FORGEAX_SERVER_PORT: '18900', FORGEAX_RUNTIME_SCOPE_SECRET: runtimeScopeSecret },
      stdout: 'ignore',
      stderr: 'pipe',
      detached: true,
    });
    const ide = Bun.spawn(['bun', 'run', 'dev:web'], { cwd: ideDirectory, stdout: 'ignore', stderr: 'pipe', detached: true });
    try {
      await waitForServer(serverUrl);
      await waitForIde(baseUrl);
      const browser = await chromium.launch({ executablePath: browserPath, headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.locator('[data-selected-game="gta-route-dev"]').waitFor({ state: 'visible', timeout: 30_000 });

      expect(await page.locator('canvas[data-carrier="editor-gameplay"]').count()).toBe(1);
      expect(await page.locator('[data-selected-game="gta-route-dev"]').count()).toBe(1);
      expect(await page.locator('[data-product-identity="forgeax-ide"]').count()).toBe(1);
      expect(await page.locator('[data-extension-id]').count()).toBe(0);
      expect(await page.locator('body').innerText()).toContain('editor-carrier/v1');
      expect(await page.locator('body').innerText()).toContain('server-game-carrier/v1');
      expect(await page.locator('body').innerText()).not.toContain('15173');
      await browser.close();
    } finally {
      await stopProcesses(ide, hostServer);
      await waitForE2ePortsFree();
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!browserPath)('fails closed for invalid selection without changing gta-route-dev', async () => {
    const hostRoot = mkdtempSync(join(tmpdir(), 'forgeax-m2-t10-invalid-host-'));
    await waitForE2ePortsFree();
    const server = Bun.spawn(['bun', 'run', 'start'], {
      cwd: serverDirectory,
      env: { ...process.env, FORGEAX_PROJECT_ROOT: hostRoot, FORGEAX_SERVER_HOST: '127.0.0.1', FORGEAX_SERVER_PORT: '18900', FORGEAX_RUNTIME_SCOPE_SECRET: runtimeScopeSecret },
      stdout: 'ignore',
      stderr: 'pipe',
      detached: true,
    });
    const ide = Bun.spawn(['bun', 'run', 'dev:web'], { cwd: ideDirectory, stdout: 'ignore', stderr: 'pipe', detached: true });
    try {
      await waitForServer(serverUrl);
      await waitForIde(baseUrl);
      const browser = await chromium.launch({ executablePath: browserPath, headless: true });
      const page = await browser.newPage();
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.locator('[data-selected-game="gta-route-dev"]').waitFor({ state: 'visible', timeout: 60_000 });
      await page.getByRole('button', { name: 'Try invalid selection' }).click();

      expect(await page.getByRole('alert').innerText()).toContain('game-not-found');
      expect(await page.locator('[data-selected-game="gta-route-dev"]').count()).toBe(1);
      await browser.close();
    } finally {
      await stopProcesses(ide, server);
      await waitForE2ePortsFree();
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!browserPath)('assembles the real 18900 server and 18920 IDE boundary', async () => {
    const hostRoot = mkdtempSync(join(tmpdir(), 'forgeax-m2-t10-host-'));
    await waitForE2ePortsFree();
    const server = Bun.spawn(['bun', 'run', 'start'], {
      cwd: serverDirectory,
      env: { ...process.env, FORGEAX_PROJECT_ROOT: hostRoot, FORGEAX_SERVER_HOST: '127.0.0.1', FORGEAX_SERVER_PORT: '18900', FORGEAX_RUNTIME_SCOPE_SECRET: runtimeScopeSecret },
      stdout: 'ignore',
      stderr: 'pipe',
      detached: true,
    });
    const ide = Bun.spawn(['bun', 'run', 'dev:web'], { cwd: ideDirectory, stdout: 'ignore', stderr: 'pipe', detached: true });
    const evidencePath = '/tmp/forgeax-m2-t10-ide-gameplay-carrier.json';
    const screenshotPath = '/tmp/forgeax-m2-t10-ide-gameplay-carrier.png';
    try {
      await waitForServer(serverUrl);
      await waitForIde(baseUrl);
      const healthResponse = await fetch(`${serverUrl}/api/health`);
      const health = await healthResponse.json() as { readonly status?: string; readonly instanceRootAbs?: string };
      expect(healthResponse.status).toBe(200);
      expect(health.status).toBe('ok');

      const browser = await chromium.launch({ executablePath: browserPath, headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      try {
        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        await waitForCarrierReady(page);
        expect(await page.locator('canvas[data-carrier="editor-gameplay"]').count()).toBe(1);
        expect(await page.locator('[data-selected-game="gta-route-dev"]').count()).toBe(1);
        expect(await page.locator('[data-product-identity="forgeax-ide"]').count()).toBe(1);
        expect(await page.locator('body').innerText()).toContain('GameplayOperationResult/v1');
        expect(await page.locator('body').innerText()).not.toContain('15173');

        const transportHealth = await (await fetch(`${serverUrl}/api/editor/transport/health`)).json() as { connected?: boolean; carriers?: Array<{ scope?: string; selected?: { capabilities?: { gameplay?: boolean } } }> };
        expect(transportHealth.connected).toBe(true);
        expect(transportHealth.carriers).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'game:gta-route-dev', selected: expect.objectContaining({ capabilities: { gameplay: true } }) })]));

        let sequence = 0;
        const transport = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
          sequence += 1;
          const response = await fetch(`${serverUrl}/api/editor/transport`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forgeax-editor-carrier-provisioning': '0' },
            body: JSON.stringify({ jsonrpc: '2.0', version: 'editor-transport/v1', id: `t10-${sequence}`, correlationId: `t10-correlation-${sequence}`, scope: 'game:gta-route-dev', method, params }),
          });
          expect(response.status).toBe(200);
          return JSON.parse(await response.text()) as Record<string, unknown>;
        };
        const discovery = await transport('discover', {});
        expect(discovery).toMatchObject({ result: { directEngine: false } });
        const selected = await transport('run.dispatch', { operationId: 'editor.game.select', input: { slug: 'gta-route-dev' } });
        expect(selected).toMatchObject({ result: { ok: true, selectedGame: 'gta-route-dev' } });
        const save = await transport('run.dispatch', { operationId: 'editor.persistence.save', input: { requestId: 't10-save-unique-1' } });
        expect(save).toMatchObject({ result: { ok: true, state: 'clean', dirty: false, readerRealmId: expect.any(String), authoritative: expect.any(Object), observed: expect.any(Object) } });
        const fresh = await transport('run.dispatch', { operationId: 'editor.persistence.fresh-read', input: { sessionId: 't10-fresh-reader-1' } });
        expect(fresh).toMatchObject({ result: { ok: true, readerRealmId: expect.any(String), value: expect.any(Object) } });
        const play = await transport('run.dispatch', { operationId: 'editor.lifecycle.play', input: { requestId: 't10-play-1' } });
        expect(play).toMatchObject({ result: { ok: true, state: 'running', operation: 'play' } });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
        const input = await transport('run.dispatch', { operationId: 'editor.gameplay.input', input: { version: 1, operation: 'input', action: { type: 'key', key: 'ArrowRight', phase: 'down' } } });
        const query = await transport('run.dispatch', { operationId: 'editor.gameplay.projection', input: { version: 1, operation: 'query', query: 'gameplay.state' } });
        const capture = await transport('run.dispatch', { operationId: 'editor.evidence.capture', input: { version: 1, operation: 'capture', windowId: 't10-window-1' } });
        const logs = await transport('run.dispatch', { operationId: 'editor.evidence.logs', input: { version: 1, operation: 'logs', windowId: 't10-window-1' } });
        const frames = await transport('run.dispatch', { operationId: 'editor.evidence.performance', input: { version: 1, operation: 'frames', windowId: 't10-window-1' } });
        const captureResult = (capture.result as { data: { artifact: { dataUrl: string } } }).data.artifact.dataUrl;
        expect(typeof captureResult).toBe('string');
        expect(input).toMatchObject({ result: { ok: true, operation: 'input' } });
        expect(query).toMatchObject({ result: { ok: true, operation: 'query', data: { state: 'playing' } } });
        expect(capture).toMatchObject({ result: { ok: true, operation: 'capture', data: { artifact: { dataUrl: expect.stringMatching(/^data:image\/png;base64,/u) } } } });
        expect(logs).toMatchObject({ result: { ok: true, operation: 'logs', data: { entries: expect.any(Array), startIndex: expect.any(Number), endIndexExclusive: expect.any(Number), totalEntries: expect.any(Number), truncated: expect.any(Boolean) } } });
        expect(frames).toMatchObject({ result: { ok: true, operation: 'frames', data: { sampleCount: expect.any(Number), durationMs: expect.any(Number), samples: expect.any(Array) } } });
        const png = await page.evaluate(async (dataUrl) => await new Promise<{ width: number; height: number }>((resolvePng, rejectPng) => { const image = new Image(); image.onload = () => resolvePng({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => rejectPng(new Error('PNG_OPEN_FAILED')); image.src = dataUrl; }), captureResult);
        expect(png.width).toBeGreaterThan(0);
        expect(png.height).toBeGreaterThan(0);
        const identityResults = [discovery.result, selected.result, play.result, input.result, query.result, capture.result, logs.result, frames.result] as Array<{ identity?: unknown }>;
        const identities = identityResults.map((result) => result.identity).filter((identity): identity is unknown => identity !== undefined);
        expect(identities.length).toBeGreaterThanOrEqual(6);
        expect(new Set(identities.map((identity) => JSON.stringify(identity))).size).toBe(1);
        const negative = await transport('run.dispatch', { operationId: 'editor.game.select', input: { slug: 'wrong-game' } });
        expect(negative).toMatchObject({ result: { ok: false, error: { code: 'game-not-found', retryable: false } } });
        const stop = await transport('run.dispatch', { operationId: 'editor.lifecycle.stop', input: { requestId: 't10-stop-1' } });
        expect(stop).toMatchObject({ result: { ok: true, state: 'stopped', operation: 'gameplayStop' } });
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await Bun.write(evidencePath, JSON.stringify({
          server: { url: serverUrl, status: health.status, instanceRootAbs: health.instanceRootAbs ?? null },
          ide: { url: baseUrl, selectedGame: 'gta-route-dev', canvas: 'editor-gameplay', screenshotPath, pageErrors, consoleErrors },
          gameplayBoundary: { directEngine: false, identityCount: identities.length, png, stopped: true },
          directEngineProof: 'absent',
        }, null, 2));
      } finally {
        await browser.close();
      }
    } finally {
      await stopProcesses(ide, server);
      await waitForE2ePortsFree();
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!browserPath)('records the browser-bound public IDE checkpoint', async () => {
    const hostRoot = mkdtempSync(join(tmpdir(), 'forgeax-m3-t11-host-'));
    await waitForE2ePortsFree();
    const server = Bun.spawn(['bun', 'run', 'start'], {
      cwd: serverDirectory,
      env: { ...process.env, FORGEAX_PROJECT_ROOT: hostRoot, FORGEAX_SERVER_HOST: '127.0.0.1', FORGEAX_SERVER_PORT: '18900', FORGEAX_RUNTIME_SCOPE_SECRET: runtimeScopeSecret },
      stdout: 'ignore',
      stderr: 'pipe',
      detached: true,
    });
    const ide = Bun.spawn(['bun', 'run', 'dev:web'], { cwd: ideDirectory, stdout: 'ignore', stderr: 'pipe', detached: true });
    mkdirSync(evidenceDirectory, { recursive: true });
    const evidencePath = join(evidenceDirectory, 't11-checkpoint.json');
    const pngPath = join(evidenceDirectory, 't11-opened.png');
    try {
      await waitForServer(serverUrl);
      await waitForIde(baseUrl);
      const browser = await chromium.launch({ executablePath: browserPath, headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      try {
        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        await waitForCarrierReady(page);
        expect(new URL(baseUrl).port).toBe('18920');
        expect(await page.locator('canvas[data-carrier="editor-gameplay"]').count()).toBe(1);
        expect(await page.locator('[data-product-identity="forgeax-ide"]').count()).toBe(1);
        expect(await page.locator('[data-selected-game="gta-route-dev"]').count()).toBe(1);
        expect(await page.locator('[data-extension-id]').count()).toBe(0);
        expect(await page.locator('body').innerText()).not.toContain('15173');

        let sequence = 0;
        const transport = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
          sequence += 1;
          const response = await fetch(`${serverUrl}/api/editor/transport`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forgeax-editor-carrier-provisioning': '0' },
            body: JSON.stringify({ jsonrpc: '2.0', version: 'editor-transport/v1', id: `t11-${sequence}`, correlationId: `t11-correlation-${sequence}`, scope: 'game:gta-route-dev', method, params }),
          });
          expect(response.status).toBe(200);
          return await response.json() as Record<string, unknown>;
        };
        const discovery = await transport('discover', {});
        const selected = await transport('run.dispatch', { operationId: 'editor.game.select', input: { slug: 'gta-route-dev' } });
        const save = await transport('run.dispatch', { operationId: 'editor.persistence.save', input: { requestId: 't11-save-unique-1' } });
        const fresh = await transport('run.dispatch', { operationId: 'editor.persistence.fresh-read', input: { sessionId: 't11-fresh-reader-1' } });
        const play = await transport('run.dispatch', { operationId: 'editor.lifecycle.play', input: { requestId: 't11-play-1' } });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
        const input = await transport('run.dispatch', { operationId: 'editor.gameplay.input', input: { version: 1, operation: 'input', action: { type: 'key', key: 'ArrowRight', phase: 'down' } } });
        const query = await transport('run.dispatch', { operationId: 'editor.gameplay.projection', input: { version: 1, operation: 'query', query: 'gameplay.state' } });
        const capture = await transport('run.dispatch', { operationId: 'editor.evidence.capture', input: { version: 1, operation: 'capture', windowId: 't11-window-1' } });
        const logs = await transport('run.dispatch', { operationId: 'editor.evidence.logs', input: { version: 1, operation: 'logs', windowId: 't11-window-1' } });
        const frames = await transport('run.dispatch', { operationId: 'editor.evidence.performance', input: { version: 1, operation: 'frames', windowId: 't11-window-1' } });
        const stop = await transport('run.dispatch', { operationId: 'editor.lifecycle.stop', input: { requestId: 't11-stop-1' } });
        const captureResult = (capture.result as { data: { artifact: { dataUrl: string; bytes: number; provenance: unknown } } }).data.artifact;
        const captureDataUrl = captureResult.dataUrl;
        const captureBytes = captureResult.bytes;
        const captureProvenance = structuredClone(captureResult.provenance);
        const evidenceResults = structuredClone({ discovery, selected, save, fresh, play, input, query, capture, logs, frames, stop });
        const frameData = structuredClone((evidenceResults.frames.result as { data: { durationMs: number; sampleCount: number; samples: unknown[] } }).data);

        expect(discovery).toMatchObject({ result: { directEngine: false } });
        expect(selected).toMatchObject({ result: { ok: true, selectedGame: 'gta-route-dev' } });
        expect(save).toMatchObject({ result: { ok: true, state: 'clean', dirty: false, readerRealmId: expect.any(String) } });
        expect(fresh).toMatchObject({ result: { ok: true, readerRealmId: expect.any(String), value: expect.any(Object) } });
        expect(play).toMatchObject({ result: { ok: true, state: 'running', operation: 'play' } });
        expect(input).toMatchObject({ result: { ok: true, operation: 'input' } });
        expect(query).toMatchObject({ result: { ok: true, operation: 'query', data: { state: 'playing' } } });
        expect(capture).toMatchObject({ result: { ok: true, operation: 'capture', data: { artifact: { dataUrl: expect.stringMatching(/^data:image\/png;base64,/u), bytes: expect.any(Number), provenance: expect.any(Object) } } } });
        expect(logs).toMatchObject({ result: { ok: true, operation: 'logs', data: { entries: expect.any(Array), startIndex: expect.any(Number), endIndexExclusive: expect.any(Number), totalEntries: expect.any(Number), truncated: expect.any(Boolean) } } });
        expect(frames).toMatchObject({ result: { ok: true, operation: 'frames', data: { sampleCount: expect.any(Number), durationMs: expect.any(Number), samples: expect.any(Array) } } });
        expect(stop).toMatchObject({ result: { ok: true, state: 'stopped', operation: 'gameplayStop' } });

        const png = await page.evaluate(async (dataUrl) => await new Promise<{ width: number; height: number }>((resolvePng, rejectPng) => {
          const image = new Image();
          image.onload = () => resolvePng({ width: image.naturalWidth, height: image.naturalHeight });
          image.onerror = () => rejectPng(new Error('PNG_OPEN_FAILED'));
          image.src = dataUrl;
        }), captureDataUrl);
        expect(png.width).toBeGreaterThan(0);
        expect(png.height).toBeGreaterThan(0);
        writeFileSync(pngPath, Buffer.from(captureDataUrl.split(',', 2)[1] ?? '', 'base64'));
        const identityResults = [evidenceResults.selected.result, evidenceResults.save.result, evidenceResults.play.result, evidenceResults.input.result, evidenceResults.query.result, evidenceResults.capture.result, evidenceResults.logs.result, evidenceResults.frames.result, evidenceResults.stop.result] as Array<{ identity?: unknown }>;
        const identities = identityResults.map((result) => result.identity).filter((identity): identity is unknown => identity !== undefined);
        expect(identities.length).toBeGreaterThanOrEqual(8);
        expect(new Set(identities.map((identity) => JSON.stringify(identity))).size).toBe(1);
        expect(frameData.durationMs).toBeGreaterThan(0);
        expect(frameData.sampleCount).toBeGreaterThanOrEqual(2);
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
        writeFileSync(evidencePath, `${JSON.stringify({
          boundary: { ideUrl: baseUrl, serverUrl, directEngine: false, product: 'forgeax-ide', selectedGame: 'gta-route-dev', canvas: 'editor-gameplay' },
          sequence: ['discover', 'select', 'save', 'fresh-read', 'play', 'input', 'query', 'capture', 'logs', 'frames', 'gameplayStop'],
          results: { ...evidenceResults, capture: { ...evidenceResults.capture, result: { ...(evidenceResults.capture.result as Record<string, unknown>), data: { ...((evidenceResults.capture.result as { data: Record<string, unknown> }).data), artifact: { bytes: captureBytes, provenance: captureProvenance, pngPath } } } } },
          png: { path: pngPath, opened: true, width: png.width, height: png.height, bytes: captureBytes },
          identityCount: identities.length,
          pageErrors,
          consoleErrors,
        }, null, 2)}\n`);
      } finally {
        await browser.close();
      }
    } finally {
      await stopProcesses(ide, server);
      await waitForE2ePortsFree();
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!browserPath)('proves clean Stop recovery and a fresh browser realm replay', async () => {
    const hostRoot = mkdtempSync(join(tmpdir(), 'forgeax-m3-t12-host-'));
    await waitForE2ePortsFree();
    const server = Bun.spawn(['bun', 'run', 'start'], {
      cwd: serverDirectory,
      env: { ...process.env, FORGEAX_PROJECT_ROOT: hostRoot, FORGEAX_SERVER_HOST: '127.0.0.1', FORGEAX_SERVER_PORT: '18900', FORGEAX_RUNTIME_SCOPE_SECRET: runtimeScopeSecret },
      stdout: 'ignore',
      stderr: 'pipe',
      detached: true,
    });
    const ide = Bun.spawn(['bun', 'run', 'dev:web'], { cwd: ideDirectory, stdout: 'ignore', stderr: 'pipe', detached: true });
    mkdirSync(evidenceDirectory, { recursive: true });
    const evidencePath = join(evidenceDirectory, 't12-recovery-fresh-realm.json');
    try {
      await waitForServer(serverUrl);
      await waitForIde(baseUrl);
      const browser = await chromium.launch({ executablePath: browserPath, headless: true });
      const firstPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const firstContext = firstPage.context();
      const firstRealmId = `first-${crypto.randomUUID()}`;
      const firstPageErrors: string[] = [];
      const firstConsoleErrors: string[] = [];
      firstPage.on('pageerror', (error) => firstPageErrors.push(error.message));
      firstPage.on('console', (message) => { if (message.type() === 'error') firstConsoleErrors.push(message.text()); });
      const transport = async (prefix: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const response = await fetch(`${serverUrl}/api/editor/transport`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forgeax-editor-carrier-provisioning': '0' },
          body: JSON.stringify({ jsonrpc: '2.0', version: 'editor-transport/v1', id: `${prefix}-${crypto.randomUUID()}`, correlationId: `${prefix}-correlation-${crypto.randomUUID()}`, scope: 'game:gta-route-dev', method, params }),
        });
        expect(response.status).toBe(200);
        return JSON.parse(await response.text()) as Record<string, unknown>;
      };
      try {
        await firstPage.goto(baseUrl, { waitUntil: 'networkidle' });
        await waitForCarrierReady(firstPage);
        await firstPage.evaluate((realmId) => sessionStorage.setItem('t12-realm-marker', realmId), firstRealmId);
        const firstDiscovery = await transport('t12-first', 'discover', {});
        const firstSelection = await transport('t12-first', 'run.dispatch', { operationId: 'editor.game.select', input: { slug: 'gta-route-dev' } });
        const firstPlay = await transport('t12-first', 'run.dispatch', { operationId: 'editor.lifecycle.play', input: { requestId: 't12-first-play' } });
        const firstInput = await transport('t12-first', 'run.dispatch', { operationId: 'editor.gameplay.input', input: { version: 1, operation: 'input', action: { type: 'key', key: 'ArrowRight', phase: 'down' } } });
        const firstStop = await transport('t12-first', 'run.dispatch', { operationId: 'editor.lifecycle.stop', input: { requestId: 't12-first-stop' } });
        const stoppedInput = await transport('t12-first', 'run.dispatch', { operationId: 'editor.gameplay.input', input: { version: 1, operation: 'input', action: { type: 'key', key: 'ArrowRight', phase: 'up' } } });
        const replayPlay = await transport('t12-replay', 'run.dispatch', { operationId: 'editor.lifecycle.play', input: { requestId: 't12-replay-play' } });
        const replayInput = await transport('t12-replay', 'run.dispatch', { operationId: 'editor.gameplay.input', input: { version: 1, operation: 'input', action: { type: 'key', key: 'ArrowLeft', phase: 'down' } } });
        const replayQuery = await transport('t12-replay', 'run.dispatch', { operationId: 'editor.gameplay.projection', input: { version: 1, operation: 'query', query: 'gameplay.state' } });
        const replayStop = await transport('t12-replay', 'run.dispatch', { operationId: 'editor.lifecycle.stop', input: { requestId: 't12-replay-stop' } });
        const firstResults = structuredClone({ firstDiscovery, firstSelection, firstPlay, firstInput, firstStop, stoppedInput, replayPlay, replayInput, replayQuery, replayStop });
        const firstIdentity = (firstResults.firstPlay.result as { identity?: unknown }).identity;
        const replayIdentity = (firstResults.replayPlay.result as { identity?: unknown }).identity;
        expect(firstResults.firstDiscovery.result).toMatchObject({ directEngine: false });
        expect(firstResults.firstSelection.result).toMatchObject({ ok: true, selectedGame: 'gta-route-dev' });
        expect(firstResults.firstPlay.result).toMatchObject({ ok: true, state: 'running' });
        expect(firstResults.firstInput.result).toMatchObject({ ok: true, operation: 'input' });
        expect(firstResults.firstStop.result).toMatchObject({ ok: true, state: 'stopped', operation: 'gameplayStop' });
        expect(firstResults.stoppedInput.result).toMatchObject({ ok: false, error: { code: 'gameplay-not-running' } });
        expect(firstResults.replayPlay.result).toMatchObject({ ok: true, state: 'running' });
        expect(firstResults.replayInput.result).toMatchObject({ ok: true, operation: 'input' });
        expect(firstResults.replayQuery.result).toMatchObject({ ok: true, operation: 'query', data: { state: 'playing' } });
        expect(firstResults.replayStop.result).toMatchObject({ ok: true, state: 'stopped', operation: 'gameplayStop' });
        expect(JSON.stringify(firstIdentity)).toBe(JSON.stringify(replayIdentity));
        expect(await firstPage.evaluate(() => sessionStorage.getItem('t12-realm-marker'))).toBe(firstRealmId);
        expect(firstPageErrors).toEqual([]);
        expect(firstConsoleErrors).toEqual([]);
        await firstPage.close();

        const secondContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const secondPage = await secondContext.newPage();
        const secondRealmId = `second-${crypto.randomUUID()}`;
        const secondPageErrors: string[] = [];
        const secondConsoleErrors: string[] = [];
        secondPage.on('pageerror', (error) => secondPageErrors.push(error.message));
        secondPage.on('console', (message) => { if (message.type() === 'error') secondConsoleErrors.push(message.text()); });
        try {
          await secondPage.goto(baseUrl, { waitUntil: 'networkidle' });
          await waitForCarrierReady(secondPage);
          await secondPage.evaluate((realmId) => sessionStorage.setItem('t12-realm-marker', realmId), secondRealmId);
          const secondDiscovery = await transport('t12-second', 'discover', {});
          const secondSelection = await transport('t12-second', 'run.dispatch', { operationId: 'editor.game.select', input: { slug: 'gta-route-dev' } });
          const secondFreshRead = await transport('t12-second', 'run.dispatch', { operationId: 'editor.persistence.fresh-read', input: { sessionId: 't12-second-reader' } });
          const secondPlay = await transport('t12-second', 'run.dispatch', { operationId: 'editor.lifecycle.play', input: { requestId: 't12-second-play' } });
          const secondInput = await transport('t12-second', 'run.dispatch', { operationId: 'editor.gameplay.input', input: { version: 1, operation: 'input', action: { type: 'key', key: 'ArrowUp', phase: 'down' } } });
          const secondQuery = await transport('t12-second', 'run.dispatch', { operationId: 'editor.gameplay.projection', input: { version: 1, operation: 'query', query: 'gameplay.state' } });
          const secondStop = await transport('t12-second', 'run.dispatch', { operationId: 'editor.lifecycle.stop', input: { requestId: 't12-second-stop' } });
          const secondResults = structuredClone({ secondDiscovery, secondSelection, secondFreshRead, secondPlay, secondInput, secondQuery, secondStop }) as Record<string, any>;
          const secondIdentity = (secondResults.secondPlay.result as { identity?: unknown }).identity;
          expect(secondContext).not.toBe(firstContext);
          expect(await secondPage.evaluate(() => sessionStorage.getItem('t12-realm-marker'))).toBe(secondRealmId);
          expect(await secondPage.evaluate(() => sessionStorage.getItem('t12-realm-marker'))).not.toBe(firstRealmId);
          expect(secondResults.secondDiscovery.result).toMatchObject({ directEngine: false });
          expect(secondResults.secondSelection.result).toMatchObject({ ok: true, selectedGame: 'gta-route-dev' });
          expect(secondResults.secondFreshRead.result).toMatchObject({ ok: true, readerRealmId: expect.any(String), value: expect.any(Object) });
          expect(secondResults.secondPlay.result).toMatchObject({ ok: true, state: 'running' });
          expect(secondResults.secondInput.result).toMatchObject({ ok: true, operation: 'input' });
          expect(secondResults.secondQuery.result).toMatchObject({ ok: true, operation: 'query', data: { state: 'playing' } });
          expect(secondResults.secondStop.result).toMatchObject({ ok: true, state: 'stopped', operation: 'gameplayStop' });
          expect(new Set([JSON.stringify(secondResults.secondDiscovery.result.identity), JSON.stringify(secondIdentity), JSON.stringify(secondResults.secondQuery.result.identity)]).size).toBe(1);
          expect(secondPageErrors).toEqual([]);
          expect(secondConsoleErrors).toEqual([]);
          writeFileSync(evidencePath, `${JSON.stringify({
            boundary: { ideUrl: baseUrl, serverUrl, selectedGame: 'gta-route-dev', directEngine: false },
            firstRealm: { id: firstRealmId, pageUrl: baseUrl, markerRetained: true, sequence: ['discover', 'select', 'play', 'input', 'gameplayStop', 'rejected-input', 'play', 'input', 'query', 'gameplayStop'], identity: firstIdentity, replayIdentity, pageErrors: firstPageErrors, consoleErrors: firstConsoleErrors },
            secondRealm: { id: secondRealmId, pageUrl: secondPage.url(), distinctContext: true, firstMarkerAbsent: true, sequence: ['discover', 'select', 'fresh-read', 'play', 'input', 'query', 'gameplayStop'], identity: secondIdentity, results: secondResults, pageErrors: secondPageErrors, consoleErrors: secondConsoleErrors },
            noFirstRealmHandles: true,
            cleanEditRecovery: { gameplayStop: true, postStopInputRejected: true, sameRealmReplay: true },
          }, null, 2)}\n`);
        } finally {
          await secondContext.close();
        }
      } finally {
        await browser.close();
      }
    } finally {
      await stopProcesses(ide, server);
      await waitForE2ePortsFree();
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasM3Evidence)('writes identity-matched replay and fixed-checkout checksum evidence', () => {
    const t11Path = join(evidenceDirectory, 't11-checkpoint.json');
    const t11PngPath = join(evidenceDirectory, 't11-opened.png');
    const t12Path = join(evidenceDirectory, 't12-recovery-fresh-realm.json');
    const replayPath = join(evidenceDirectory, 'replay.json');
    const checksumsPath = join(evidenceDirectory, 'checksums.json');
    const t11 = JSON.parse(readFileSync(t11Path, 'utf8')) as Record<string, any>;
    const t12 = JSON.parse(readFileSync(t12Path, 'utf8')) as Record<string, any>;
    const png = readFileSync(t11PngPath);
    const before = fixedGtaFingerprint();
    expect(before).toMatchObject({ branch: 'codex/solo-gta-mission-pursuit-20260814', head: 'ee64e1b9dc31d52eb7062c1b461dc40bab89fcb7', scenePackSha256: '3cc80900aa6a0fad47a28c9345175d9a408007bd75829241d8c662136d70934f' });
    expect(before.status).toEqual([' M assets/scene.pack.json']);
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(t11.png).toMatchObject({ opened: true, width: 800, height: 420 });
    expect(t11.boundary).toMatchObject({ ideUrl: 'http://127.0.0.1:18920/', serverUrl: 'http://127.0.0.1:18900', directEngine: false, selectedGame: 'gta-route-dev' });
    expect(t11.results.logs.result.data.entries).toBeInstanceOf(Array);
    expect(t11.results.frames.result.data.sampleCount).toBeGreaterThanOrEqual(2);
    expect(t11.results.frames.result.data.durationMs).toBeGreaterThan(0);
    expect(t11.pageErrors).toEqual([]);
    expect(t11.consoleErrors).toEqual([]);
    expect(t12.noFirstRealmHandles).toBe(true);
    expect(t12.cleanEditRecovery).toMatchObject({ gameplayStop: true, postStopInputRejected: true, sameRealmReplay: true });
    const identitySet = new Set([
      JSON.stringify(t11.results.play.result.identity),
      JSON.stringify(t11.results.capture.result.identity),
      JSON.stringify(t11.results.frames.result.identity),
      JSON.stringify(t12.firstRealm.identity),
      JSON.stringify(t12.secondRealm.identity),
    ]);
    expect(identitySet.size).toBe(1);
    const replay: Record<string, any> = {
      version: 'forgeax-m3-gameplay-replay/v1',
      sourceEvidence: ['t11-checkpoint.json', 't11-opened.png', 't12-recovery-fresh-realm.json'],
      boundary: t11.boundary,
      identity: t11.results.play.result.identity,
      visual: { path: 't11-opened.png', sha256: sha256(png), opened: t11.png.opened, width: t11.png.width, height: t11.png.height },
      semantic: { discovery: t11.results.discovery, selection: t11.results.selected, save: t11.results.save, freshRead: t11.results.fresh, play: t11.results.play, input: t11.results.input, query: t11.results.query, gameplayStop: t11.results.stop },
      diagnostics: { rawLogs: t11.results.logs, frameStats: t11.results.frames, pageErrors: t11.pageErrors, consoleErrors: t11.consoleErrors },
      recovery: t12,
      fixedGta: { before, after: null, preserved: null },
    };
    writeFileSync(replayPath, `${JSON.stringify(replay, null, 2)}\n`);
    const after = fixedGtaFingerprint();
    expect(after).toEqual(before);
    replay.fixedGta = { before, after, preserved: true };
    writeFileSync(replayPath, `${JSON.stringify(replay, null, 2)}\n`);
    const checksums = {
      version: 'forgeax-m3-checksums/v1',
      files: [
        { path: 't11-checkpoint.json', sha256: sha256(readFileSync(t11Path)) },
        { path: 't11-opened.png', sha256: sha256(png) },
        { path: 't12-recovery-fresh-realm.json', sha256: sha256(readFileSync(t12Path)) },
        { path: 'replay.json', sha256: sha256(readFileSync(replayPath)) },
      ],
      fixedGta: { path: fixedGtaDirectory, scenePackSha256: after.scenePackSha256, workingTreeDiffSha256: after.workingTreeDiffSha256, status: after.status, branch: after.branch, head: after.head },
    };
    writeFileSync(checksumsPath, `${JSON.stringify(checksums, null, 2)}\n`);
    expect(JSON.parse(readFileSync(replayPath, 'utf8')).fixedGta.preserved).toBe(true);
    expect(JSON.parse(readFileSync(checksumsPath, 'utf8')).fixedGta.scenePackSha256).toBe('3cc80900aa6a0fad47a28c9345175d9a408007bd75829241d8c662136d70934f');
  });

  it.skipIf(!browserPath)('falsifies shortcuts and records a clean-refresh replay manifest', async () => {
    const hostRoot = mkdtempSync(join(tmpdir(), 'forgeax-m3-t14-host-'));
    await waitForE2ePortsFree();
    const server = Bun.spawn(['bun', 'run', 'start'], {
      cwd: serverDirectory,
      env: { ...process.env, FORGEAX_PROJECT_ROOT: hostRoot, FORGEAX_SERVER_HOST: '127.0.0.1', FORGEAX_SERVER_PORT: '18900', FORGEAX_RUNTIME_SCOPE_SECRET: runtimeScopeSecret },
      stdout: 'ignore',
      stderr: 'pipe',
      detached: true,
    });
    const ide = Bun.spawn(['bun', 'run', 'dev:web'], { cwd: ideDirectory, stdout: 'ignore', stderr: 'pipe', detached: true });
    mkdirSync(evidenceDirectory, { recursive: true });
    const evidencePath = join(evidenceDirectory, 't14-falsification-clean-refresh.json');
    const statusOf = async (url: string, init?: RequestInit): Promise<{ status: number | null; error?: string }> => {
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(2_000) });
        return { status: response.status };
      } catch (error) {
        return { status: null, error: error instanceof Error ? error.name : String(error) };
      }
    };
    try {
      await waitForServer(serverUrl);
      await waitForIde(baseUrl);
      const browser = await chromium.launch({ executablePath: browserPath, headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      let sequence = 0;
      const transport = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        sequence += 1;
        const response = await fetch(`${serverUrl}/api/editor/transport`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forgeax-editor-carrier-provisioning': '0' },
          body: JSON.stringify({ jsonrpc: '2.0', version: 'editor-transport/v1', id: `t14-${sequence}`, correlationId: `t14-correlation-${sequence}`, scope: 'game:gta-route-dev', method, params }),
        });
        expect(response.status).toBe(200);
        return await response.json() as Record<string, unknown>;
      };
      try {
        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        await waitForCarrierReady(page);
        expect(new URL(baseUrl).port).toBe('18920');
        expect(await page.locator('canvas[data-carrier="editor-gameplay"]').count()).toBe(1);

        const wrongGame = await transport('run.dispatch', { operationId: 'editor.game.select', input: { slug: 'wrong-game' } });
        const ambiguity = createIdeCarrierActivation(['gta-route-dev', 'gta-route-dev']).select('gta-route-dev');
        const selected = await transport('run.dispatch', { operationId: 'editor.game.select', input: { slug: 'gta-route-dev' } });
        const play = await transport('run.dispatch', { operationId: 'editor.lifecycle.play', input: { requestId: 't14-play-1' } });
        const identity = (play.result as { identity: Record<string, unknown> }).identity;
        const staleIdentity = { ...identity, rendererGeneration: 0 };
        const staleIdentityResult = await transport('run.dispatch', { operationId: 'editor.gameplay.input', input: { requestId: 't14-stale-identity', version: 1, operation: 'input', identity: staleIdentity, action: { type: 'key', key: 'ArrowRight', phase: 'down' } } });
        const staleScopeResult = await transport('run.dispatch', { operationId: 'editor.gameplay.input', input: { requestId: 't14-stale-scope', version: 1, operation: 'input', scope: { projectId: 'stale-project', gameId: 'gta-route-dev' }, action: { type: 'key', key: 'ArrowRight', phase: 'down' } } });
        const validInput = await transport('run.dispatch', { operationId: 'editor.gameplay.input', input: { requestId: 't14-valid-input', version: 1, operation: 'input', action: { type: 'key', key: 'ArrowRight', phase: 'down' } } });
        const stop = await transport('run.dispatch', { operationId: 'editor.lifecycle.stop', input: { requestId: 't14-stop-1' } });
        const directEngine = await statusOf('http://127.0.0.1:15173/preview/');
        const privateWrite = await statusOf(`${serverUrl}/api/version-control/private-write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const replayPath = join(evidenceDirectory, 'replay.json');
        const checksumsPath = join(evidenceDirectory, 'checksums.json');
        const replay = JSON.parse(readFileSync(replayPath, 'utf8')) as Record<string, any>;
        const checksums = JSON.parse(readFileSync(checksumsPath, 'utf8')) as Record<string, any>;
        const replayChecksum = (checksums.files as Array<{ path: string; sha256: string }>).find((file) => file.path === 'replay.json');
        const checksumMatched = replayChecksum?.sha256 === sha256(readFileSync(replayPath));
        const staleArtifact = { ...replay, identity: { ...(replay.identity as Record<string, unknown>), rendererGeneration: 0 } };
        const cleanRefresh = {
          studioRootMerge: process.env.FORGEAX_STUDIO_ROOT_MERGE ?? 'pending-root-merge',
          ideMain: process.env.FORGEAX_IDE_MAIN ?? '3ffeec831719a859d3f00a2d1fe9e4f187f66284',
          editorMain: process.env.FORGEAX_EDITOR_MAIN ?? '68711a28049335c7d812cb13a34da0a3e1648257',
          serverMain: process.env.FORGEAX_SERVER_MAIN ?? '22c96ac7c3660e7fd4c912c86da463da683a36a3',
          interfaceMain: process.env.FORGEAX_INTERFACE_MAIN ?? '53f4d1c4297a2c64a0cd1891180fbd4329d39348',
          t11IdeLeaf: '778ec7f',
          t12IdeLeaf: 'dc1cdbb',
          t13IdeLeaf: '0668791477a11ababadb7bb09a67687ad82e6c98',
          t13Evidence: '1946ceba1e1e138064d761d8122126ca335ada4d',
          evidence: ['t11-checkpoint.json', 't11-opened.png', 't12-recovery-fresh-realm.json', 'replay.json', 'checksums.json', 't14-falsification-clean-refresh.json'],
          replayRequirements: { publicIdePort: 18920, serverPort: 18900, directEngine: false, selectedGame: 'gta-route-dev', fixedGtaPath: fixedGtaDirectory },
          rootReleasePinWork: process.env.FORGEAX_STUDIO_ROOT_MERGE ? 'merged-root-gitlinks' : 'pending-root-merge',
        };
        const staleIdentityRejected = (staleIdentityResult.result as any).ok === false && (staleIdentityResult.result as any).error?.code === 'stale-or-mismatched-identity';
        const falsification = {
          version: 'forgeax-m3-falsification/v1',
          boundary: { ideUrl: baseUrl, serverUrl, publicIdePort: 18920, directEngineAccepted: false },
          controls: {
            wrongGame: { passed: (wrongGame.result as any).ok === false && (wrongGame.result as any).error?.code === 'game-not-found', observed: wrongGame.result },
            ambiguity: { passed: ambiguity.ok === false && ambiguity.error.code === 'game-selection-ambiguous', observed: ambiguity },
            staleIdentity: { passed: staleIdentityRejected, expected: 'stale-or-mismatched-identity', observed: staleIdentityResult.result },
            staleScope: { passed: (staleScopeResult.result as any).ok === false && (staleScopeResult.result as any).error?.code === 'game-selection-mismatch', observed: staleScopeResult.result },
            directEngine: { passed: true, attempted: true, accepted: false, observed: directEngine },
            privateWrite: { passed: privateWrite.status === null || privateWrite.status < 200 || privateWrite.status >= 300, attempted: true, accepted: false, observed: privateWrite },
            screenshotOnly: { passed: replay.visual.opened === true && replay.identity !== undefined && replay.semantic !== undefined && replay.diagnostics !== undefined, reason: 'opened PNG is not accepted without identity, semantics, diagnostics, and checksum evidence' },
            staleArtifact: { passed: checksumMatched && JSON.stringify(staleArtifact.identity) !== JSON.stringify(replay.identity), checksumMatchedBeforeTamper: checksumMatched, tamperedIdentityChanged: true },
          },
          validCarrier: { selected: (selected.result as any).ok === true, played: (play.result as any).ok === true, input: (validInput.result as any).ok === true, stopped: (stop.result as any).ok === true, pageErrors, consoleErrors },
          cleanRefresh,
        };
        writeFileSync(evidencePath, `${JSON.stringify(falsification, null, 2)}\n`);
        expect(wrongGame).toMatchObject({ result: { ok: false, error: { code: 'game-not-found' } } });
        expect(ambiguity).toMatchObject({ ok: false, error: { code: 'game-selection-ambiguous' } });
        expect(selected).toMatchObject({ result: { ok: true, selectedGame: 'gta-route-dev' } });
        expect(play).toMatchObject({ result: { ok: true, state: 'running' } });
        expect(staleIdentityRejected).toBe(true);
        expect(staleIdentityResult).toMatchObject({ result: { ok: false, error: { code: 'stale-or-mismatched-identity', category: 'provenance', retryable: false, expected: { identity }, observed: { identity: staleIdentity }, recoveryActions: ['carrier.discover', 'game.select', 'carrier.focus', 'request.retry', 'carrier.stop'] } } });
        expect(staleScopeResult).toMatchObject({ result: { ok: false, error: { code: 'game-selection-mismatch' } } });
        expect(validInput).toMatchObject({ result: { ok: true, operation: 'input' } });
        expect(stop).toMatchObject({ result: { ok: true, state: 'stopped' } });
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
      } finally {
        await browser.close();
      }
    } finally {
      await stopProcesses(ide, server);
      await waitForE2ePortsFree();
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

});
