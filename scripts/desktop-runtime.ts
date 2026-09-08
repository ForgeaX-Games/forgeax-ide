#!/usr/bin/env bun

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SERVER_PORT = 18810;
const ENGINE_PORT = 15273;
const STARTUP_TIMEOUT_MS = 60_000;

type ServiceProbe = { ready: boolean; url: string; status?: number; error?: string };
type RuntimeStatus = 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';

const resourceRoot = resolve(requiredEnv('FORGEAX_RESOURCE_ROOT'));
const projectRoot = resolve(requiredEnv('FORGEAX_PROJECT_ROOT'));
const stateFile = resolve(requiredEnv('FORGEAX_RUNTIME_STATE_FILE'));
const publicOrigin = `http://127.0.0.1:${SERVER_PORT}`;
const startedAt = new Date().toISOString();
const children = new Map<string, Bun.Subprocess>();
let status: RuntimeStatus = 'starting';
let readiness: Record<string, ServiceProbe> | undefined;
let failure: string | undefined;
let stopping = false;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function targetTriple(): { triple: string; extension: string } {
  if (process.platform === 'darwin' && process.arch === 'arm64') return { triple: 'aarch64-apple-darwin', extension: '' };
  if (process.platform === 'darwin' && process.arch === 'x64') return { triple: 'x86_64-apple-darwin', extension: '' };
  if (process.platform === 'win32' && process.arch === 'x64') return { triple: 'x86_64-pc-windows-msvc', extension: '.exe' };
  throw new Error(`unsupported desktop runtime platform: ${process.platform}/${process.arch}`);
}

function writeState(): void {
  const document = {
    schemaVersion: 1,
    profile: 'desktop-prod',
    status,
    launcherPid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    publicOrigin,
    resourceRoot,
    projectRoot,
    managedPorts: { server: SERVER_PORT, engine: ENGINE_PORT },
    servicePids: Object.fromEntries([...children].map(([name, child]) => [name, child.pid])),
    ...(readiness ? { readiness: { ready: Object.values(readiness).every((item) => item.ready), checkedAt: new Date().toISOString(), services: readiness } } : {}),
    ...(failure ? { error: failure } : {}),
  };
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
  renameSync(temporary, stateFile);
}

function replaceJunction(path: string, target: string): void {
  rmSync(path, { recursive: true, force: true });
  symlinkSync(resolve(target), path, 'junction');
}

function materializeNodeModules(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.vite' || entry.name === '.vite-temp') continue;
    const input = realpathSync(join(source, entry.name));
    const output = join(destination, entry.name);
    if (statSync(input).isDirectory()) symlinkSync(input, output, 'junction');
    else copyFileSync(input, output);
  }
}

function materializeEngineWorkspace(): string {
  const source = join(resourceRoot, 'engine');
  const destination = join(projectRoot, '.engine-runtime');
  for (const required of ['vite.config.ts', 'package.json', 'src', 'node_modules/vite/bin/vite.js']) {
    if (!existsSync(join(source, required))) throw new Error(`packaged engine resource is missing: engine/${required}`);
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of ['index.html', 'vite.config.ts', 'engine-vite-preset.mjs', 'ddc-root-policy.mjs', 'package.json', 'tsconfig.json', 'rhi-debug-config.ts']) {
    const input = join(source, entry);
    const output = join(destination, entry);
    rmSync(output, { recursive: true, force: true });
    if (existsSync(input)) copyFileSync(input, output);
  }
  for (const entry of ['src', 'public']) {
    const input = join(source, entry);
    const output = join(destination, entry);
    rmSync(output, { recursive: true, force: true });
    if (existsSync(input)) cpSync(input, output, { recursive: true, dereference: true, force: true });
  }
  mkdirSync(join(projectRoot, '.forgeax', 'games'), { recursive: true });
  materializeNodeModules(join(source, 'node_modules'), join(destination, 'node_modules'));
  for (const entry of ['forgeax-editor-assets', 'forgeax-engine-assets']) {
    replaceJunction(join(destination, entry), join(source, entry));
  }
  replaceJunction(join(destination, '.forgeax'), join(projectRoot, '.forgeax'));
  rmSync(join(destination, 'shared-assets'), { recursive: true, force: true });
  rmSync(join(destination, 'engine-assets'), { recursive: true, force: true });
  return destination;
}

function spawn(name: string, command: string[], cwd: string, env: NodeJS.ProcessEnv): Bun.Subprocess {
  const child = Bun.spawn(command, { cwd, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  children.set(name, child);
  writeState();
  return child;
}

async function probe(url: string): Promise<ServiceProbe> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return { ready: response.ok, url, status: response.status };
  } catch (error) {
    return { ready: false, url, error: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForReadiness(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [server, engine] = await Promise.all([
      probe(`${publicOrigin}/api/health`),
      probe(`http://127.0.0.1:${ENGINE_PORT}/preview/`),
    ]);
    readiness = { server, interface: server, engine };
    writeState();
    if (server.ready && engine.ready) return;
    if ([...children.values()].some((child) => child.exitCode !== null)) {
      throw new Error('a packaged runtime service exited before readiness');
    }
    await Bun.sleep(250);
  }
  throw new Error('packaged runtime did not become ready within 60 seconds');
}

async function stop(exitCode: number): Promise<never> {
  if (stopping) await new Promise(() => {});
  stopping = true;
  if (status !== 'failed') status = 'stopping';
  writeState();
  for (const child of children.values()) child.kill('SIGTERM');
  await Promise.race([
    Promise.all([...children.values()].map((child) => child.exited)),
    Bun.sleep(3_000),
  ]);
  for (const child of children.values()) if (child.exitCode === null) child.kill('SIGKILL');
  if (status !== 'failed') {
    status = 'stopped';
    writeState();
  }
  process.exit(exitCode);
}

async function main(): Promise<void> {
  mkdirSync(projectRoot, { recursive: true });
  rmSync(stateFile, { force: true });
  writeState();
  const { triple, extension } = targetTriple();
  const server = join(resourceRoot, 'sidecars', `forgeax-server-${triple}${extension}`);
  if (!existsSync(server)) throw new Error(`packaged server sidecar is missing: ${server}`);
  const serverRuntime = join(resourceRoot, 'server-runtime');
  if (!existsSync(serverRuntime)) throw new Error(`packaged server native runtime is missing: ${serverRuntime}`);
  const serverPreload = join(serverRuntime, 'native-preload.mjs');
  if (!existsSync(serverPreload)) throw new Error(`packaged server native preload is missing: ${serverPreload}`);
  const agentHost = join(serverRuntime, 'agent-host.mjs');
  if (!existsSync(agentHost)) throw new Error(`packaged agent host is missing: ${agentHost}`);
  const coreServe = join(serverRuntime, 'forgeax-core-serve.mjs');
  if (!existsSync(coreServe)) throw new Error(`packaged forgeax-core serve entry is missing: ${coreServe}`);
  const engineRoot = materializeEngineWorkspace();
  const runtimeSecret = crypto.randomUUID();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    FORGEAX_STARTUP_PROFILE: 'desktop-prod',
    FORGEAX_RESOURCE_ROOT: resourceRoot,
    FORGEAX_PROJECT_ROOT: projectRoot,
    FORGEAX_SERVER_HOST: '127.0.0.1',
    FORGEAX_SERVER_PORT: String(SERVER_PORT),
    FORGEAX_SERVER_URL: publicOrigin,
    FORGEAX_INTERFACE_PORT: String(SERVER_PORT),
    FORGEAX_HMR_CLIENT_PORT: String(SERVER_PORT),
    FORGEAX_SERVE_SPA: '1',
    FORGEAX_ENGINE_HOST: '127.0.0.1',
    FORGEAX_ENGINE_PORT: String(ENGINE_PORT),
    FORGEAX_ENGINE_URL: `http://127.0.0.1:${ENGINE_PORT}`,
    FORGEAX_GAMES_URL_PREFIX: 'host-games',
    FORGEAX_RUNTIME_SCOPE_SECRET: runtimeSecret,
    FORGEAX_AGENT_HOST_SOCK: join(projectRoot, '.forgeax', 'runtime', 'agent-host.sock'),
    FORGEAX_AGENT_HOST_ENTRY: agentHost,
    FORGEAX_CORE_SERVE_ENTRY: coreServe,
    FORGEAX_NPC_BRAIN_DATA_DIR: join(projectRoot, '.forgeax', 'runtime', 'npc-brain'),
    FORGEAX_NPC_BRAIN_AUTH_TOKEN: runtimeSecret,
  };
  const serverChild = spawn('server', [server], serverRuntime, {
    ...env,
    NODE_PATH: join(serverRuntime, 'node_modules'),
    // Bun splits BUN_OPTIONS on spaces and does not decode percent-encoded file
    // URLs. Resolve the preload from the server cwd so an app bundle such as
    // "ForgeaX Studio.app" remains launchable.
    BUN_OPTIONS: '--preload=./native-preload.mjs',
    FORGEAX_BUN_EXECUTABLE: process.execPath,
  });
  const engineChild = spawn('engine', [process.execPath, 'run', join(engineRoot, 'node_modules/vite/bin/vite.js')], engineRoot, env);
  await waitForReadiness();
  status = 'ready';
  writeState();
  const exited = await Promise.race([
    serverChild.exited.then((code) => `server exited with ${code}`),
    engineChild.exited.then((code) => `engine exited with ${code}`),
  ]);
  throw new Error(exited);
}

process.once('SIGINT', () => void stop(130));
process.once('SIGTERM', () => void stop(143));

async function listenForShutdown(): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  const reader = Bun.stdin.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      if (lines.includes('shutdown')) {
        await stop(0);
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

void listenForShutdown();

main().catch(async (error) => {
  if (stopping) return;
  failure = error instanceof Error ? error.message : String(error);
  status = 'failed';
  writeState();
  console.error(`[desktop-runtime] ${failure}`);
  await stop(1);
});
