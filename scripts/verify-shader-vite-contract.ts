import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer, normalizePath, type ViteDevServer } from 'vite';

const ideRoot = resolve(import.meta.dir, '..');

export type ShaderViteContractResult = {
  readonly moduleId: string;
  readonly queries: readonly string[];
  readonly sourceLength: number;
};

function integrationRootFromEnvironment(): string {
  return process.env.FORGEAX_INTEGRATION_ROOT
    ? resolve(process.env.FORGEAX_INTEGRATION_ROOT)
    : resolve(ideRoot, '../..');
}

function withoutStringLiterals(source: string): string {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gsu, '');
}

export function extractRawShaderDefault(code: string, moduleId: string): string {
  if (/^\s*#define_import_path\b/mu.test(withoutStringLiterals(code))) {
    throw new Error(`${moduleId} contains a top-level #define_import_path directive`);
  }
  const match = code.match(/(?:^|\n)\s*export\s+default\s+("(?:\\.|[^"\\])*")\s*;?/u);
  if (match === null) throw new Error(`${moduleId} did not produce an export default string module`);
  const value: unknown = JSON.parse(match[1]);
  if (typeof value !== 'string') throw new Error(`${moduleId} default export is not a string`);
  if (!value.includes('#define_import_path')) {
    throw new Error(`${moduleId} raw default export lost the shader directive`);
  }
  return value;
}

export async function verifyShaderViteContract(): Promise<ShaderViteContractResult> {
  const integrationRoot = integrationRootFromEnvironment();
  const shaderPath = resolve(
    integrationRoot,
    'packages/editor/packages/edit-runtime/src/viewport/shaders/infinite-grid.wgsl',
  );
  if (!existsSync(shaderPath)) throw new Error(`Editor infinite-grid shader is missing: ${shaderPath}`);

  const cacheDir = mkdtempSync(resolve(tmpdir(), 'forgeax-shader-vite-'));
  const previousIntegrationRoot = process.env.FORGEAX_INTEGRATION_ROOT;
  process.env.FORGEAX_INTEGRATION_ROOT = integrationRoot;
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      configFile: resolve(ideRoot, 'vite.config.ts'),
      configLoader: 'runner',
      root: ideRoot,
      cacheDir,
      server: {
        middlewareMode: false,
        hmr: false,
        port: 0,
      },
      optimizeDeps: {
        noDiscovery: true,
        include: [],
      },
    });
    await server.listen();

    const moduleId = `/@fs/${normalizePath(shaderPath)}`;
    const directQuery = '?raw';
    const direct = await server.transformRequest(`${moduleId}${directQuery}`);
    if (direct === null) throw new Error(`${moduleId}${directQuery} was not transformed`);
    const sources = [extractRawShaderDefault(direct.code, `${moduleId}${directQuery}`)];

    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined) throw new Error('Vite did not expose a local probe URL');
    const httpQueries = ['?raw&import', '?import&raw'] as const;
    for (const query of httpQueries) {
      const response = await fetch(new URL(`${moduleId}${query}`, baseUrl));
      if (!response.ok) {
        throw new Error(`${moduleId}${query} returned HTTP ${response.status}`);
      }
      sources.push(extractRawShaderDefault(await response.text(), `${moduleId}${query}`));
    }
    if (sources.some((source) => source !== sources[0])) {
      throw new Error('raw shader query order changed the default source');
    }
    return {
      moduleId,
      queries: [directQuery, ...httpQueries],
      sourceLength: sources[0].length,
    };
  } finally {
    try {
      if (server !== undefined) await server.close();
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      if (previousIntegrationRoot === undefined) delete process.env.FORGEAX_INTEGRATION_ROOT;
      else process.env.FORGEAX_INTEGRATION_ROOT = previousIntegrationRoot;
    }
  }
}

if (import.meta.main) {
  verifyShaderViteContract()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
