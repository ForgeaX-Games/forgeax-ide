import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { build, type Rollup } from 'vite';
import {
  createIdeRuntimeAliases,
  IDE_OPTIMIZE_DEPS_EXCLUDE,
} from '../scripts/vite-runtime-contract';

const ideRoot = resolve(import.meta.dirname, '..');
const interfaceRoot = resolve(ideRoot, '../interface');

function chunks(output: Awaited<ReturnType<typeof build>>): Rollup.OutputChunk[] {
  const outputs = Array.isArray(output) ? output : [output];
  return outputs.flatMap((entry) => ('output' in entry ? entry.output : []))
    .filter((entry): entry is Rollup.OutputChunk => entry.type === 'chunk');
}

describe('IDE Vite runtime contract', () => {
  test('builds the installed App Shell window subpath through the release alias', async () => {
    const aliases = createIdeRuntimeAliases({ ideRoot, interfaceRoot });
    expect(aliases.find((alias) => alias.find.test('@forgeax/app-shell/window'))?.replacement)
      .toBe(resolve(interfaceRoot, 'node_modules/@forgeax/app-shell/dist/window.js'));
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: aliases },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: resolve(import.meta.dirname, 'fixtures/app-shell-window-entry.ts'),
          formats: ['es'],
        },
      },
    });

    const moduleIds = chunks(output).flatMap((chunk) => Object.keys(chunk.modules));
    expect(moduleIds.some((id) => id.includes('/@forgeax/app-shell/dist/'))).toBe(true);
    expect(chunks(output).some((chunk) => chunk.code.includes('resolvedSurfaceKey'))).toBe(true);
  });

  test('keeps both stateful Interface entry points out of optimizeDeps snapshots', () => {
    expect(IDE_OPTIMIZE_DEPS_EXCLUDE).toContain('@forgeax/interface/store');
    expect(IDE_OPTIMIZE_DEPS_EXCLUDE).toContain('@forgeax/interface/store-parts/session-client');
  });

  test('builds the store and session-client imports as one module identity', async () => {
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
          entry: resolve(import.meta.dirname, 'fixtures/session-client-identity.ts'),
          formats: ['es'],
        },
      },
    });

    const sessionClientId = resolve(interfaceRoot, 'src/store-parts/session-client.ts');
    const moduleIds = chunks(output).flatMap((chunk) => Object.keys(chunk.modules));
    expect(moduleIds.filter((id) => id === sessionClientId)).toHaveLength(1);
  });
});
