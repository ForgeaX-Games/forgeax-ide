import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { build, type Rollup } from 'vite';
import { createIdeRuntimeAliases } from '../scripts/vite-runtime-contract';

const ideRoot = resolve(import.meta.dirname, '..');
const interfaceRoot = resolve(ideRoot, '../interface');

function outputChunks(output: Awaited<ReturnType<typeof build>>): Rollup.OutputChunk[] {
  const outputs = Array.isArray(output) ? output : [output];
  return outputs.flatMap((entry) => ('output' in entry ? entry.output : []))
    .filter((entry): entry is Rollup.OutputChunk => entry.type === 'chunk');
}

describe('@forgeax/files package boundary', () => {
  test('owns file contracts, canonical topics, state and page contribution', async () => {
    const manifest = await Bun.file(new URL('../packages/files/package.json', import.meta.url)).json();
    const productManifest = await Bun.file(new URL('../package.json', import.meta.url)).json();
    const source = await Bun.file(new URL('../packages/files/src/index.tsx', import.meta.url)).text();

    expect(manifest.name).toBe('@forgeax/files');
    expect(manifest.dependencies?.['@forgeax/interface']).toBeUndefined();
    expect(manifest.peerDependencies?.['@forgeax/app-shell']).toBe('^0.83.0');
    expect(manifest.peerDependencies?.['@forgeax/interface']).toBeUndefined();
    expect(manifest.peerDependenciesMeta?.['@forgeax/interface']).toBeUndefined();
    expect(productManifest.workspaces).toBeUndefined();
    expect(source).not.toContain('@forgeax/interface');
    expect(source).toContain("RESOURCE_FILES_TOPIC = 'resource-editor:files'");
    expect(source).toContain("RESOURCE_OPEN_FILE_TOPIC = 'resource-editor:open-file'");
    expect(source).toContain('export interface FilesRuntime');
    expect(source).toContain('configureFilesRuntime');
    expect(source).not.toContain('configureFilesClient');
    expect(source).toContain('createFilesContribution');
    expect(source).toContain("id: '@forgeax/files#page/explorer'");
    expect(source).toContain("id: '@forgeax/files#page/preview'");
    expect(source).toContain("id: '@forgeax/files#panel/explorer'");
    expect(source).toContain("id: '@forgeax/files#panel/preview'");
    expect(source).toContain("id: '@forgeax/files#resource-editor/default'");
    expect(source).not.toContain('forgeax-ide.files#');
    expect(source).toContain("schemes: ['forgeax-file']");
    expect(source).not.toContain('@forgeax/ai-page');
    expect(source).not.toContain('/api/files');
    expect(source).not.toContain('page:files');
    expect(source).not.toContain('page:open-file');
  });

  test('keeps HTTP transport in the IDE adapter', async () => {
    const adapter = await Bun.file(new URL('../src/integration/rest-files-client.ts', import.meta.url)).text();

    expect(adapter).toContain("fetch(`/api/files?path=${encodeURIComponent(path)}`)");
    expect(adapter).toContain("fetch('/api/files'");
    expect(adapter).toContain('rawUrl(path)');
  });

  test('passes the real page registry owner and reference validation', async () => {
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [
          ...createIdeRuntimeAliases({ ideRoot, interfaceRoot }),
          { find: /^@forgeax\/interface\/(.+)$/, replacement: `${resolve(interfaceRoot, 'src')}/$1` },
          { find: /^@\/(.+)$/, replacement: `${resolve(interfaceRoot, 'src')}/$1` },
        ],
        dedupe: ['react', 'react-dom'],
      },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: resolve(import.meta.dirname, 'fixtures/files-registration.ts'),
          formats: ['iife'],
          name: 'FilesRegistrationFixture',
        },
      },
    });
    const entry = outputChunks(output).find((chunk) => chunk.isEntry);
    expect(entry).toBeDefined();
    const built = new Function(`${entry!.code}; return FilesRegistrationFixture;`)() as {
      filesRegistration: Record<string, string | undefined>;
    };

    expect(built.filesRegistration).toEqual({
      explorer: 'available',
      preview: 'available',
      owner: '@forgeax/files',
      resourceEditorId: '@forgeax/files#resource-editor/default',
    });
  });
});
