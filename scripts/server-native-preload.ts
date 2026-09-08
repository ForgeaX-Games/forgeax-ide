import fs from 'node:fs';
import Module from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const resourceRoot = process.env.FORGEAX_RESOURCE_ROOT;
if (!resourceRoot) throw new Error('FORGEAX_RESOURCE_ROOT is required by the server native preload');
const bunExecutable = process.env.FORGEAX_BUN_EXECUTABLE;
if (!bunExecutable) throw new Error('FORGEAX_BUN_EXECUTABLE is required by the server native preload');
process.execPath = bunExecutable;
// The preload adapts only the compiled server. Kernel and agent-host children
// run from different working directories and must execute their own entrypoints.
delete process.env.BUN_OPTIONS;

const serverRuntime = join(resourceRoot, 'server-runtime');
process.argv[1] = join(serverRuntime, 'compiled-server-entry.mjs');
const nativeRoot = join(serverRuntime, 'node_modules');
const assetRoot = join(serverRuntime, 'assets');
const assetNames = new Set(['game-charter.md', 'ui-bridge-contract.json']);

const moduleApi = Module as typeof Module & {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
};
const resolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith('@img/')) {
    const segments = request.split('/');
    const packageRoot = join(nativeRoot, segments.slice(0, 2).join('/'));
    const manifest = JSON.parse(fs.readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports?: Record<string, string>;
    };
    const key = segments.length === 2 ? '.' : `./${segments.slice(2).join('/')}`;
    const target = manifest.exports?.[key];
    if (typeof target === 'string') return join(packageRoot, target);
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};

const readFileSync = fs.readFileSync.bind(fs);
fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
  const value = path instanceof URL ? fileURLToPath(path) : path;
  if (typeof value === 'string' && value.startsWith('/$bunfs/root/')) {
    const name = basename(value);
    if (assetNames.has(name)) return readFileSync(join(assetRoot, name), options as never);
  }
  return readFileSync(path, options as never);
}) as typeof fs.readFileSync;

const NativeURL = URL;
globalThis.URL = class RuntimeAssetURL extends NativeURL {
  constructor(input: string | URL, base?: string | URL) {
    const inputName = typeof input === 'string' ? basename(input) : '';
    const baseValue = base?.toString() ?? '';
    if (assetNames.has(inputName) && baseValue.startsWith('file:///$bunfs/root/')) {
      super(pathToFileURL(join(assetRoot, inputName)).href);
      return;
    }
    super(input, base);
  }
} as typeof URL;
