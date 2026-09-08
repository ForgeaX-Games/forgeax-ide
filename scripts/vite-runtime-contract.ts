import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface IdeRuntimeRoots {
  readonly ideRoot: string;
  readonly interfaceRoot: string;
}

export interface IdeRuntimeAlias {
  readonly find: RegExp;
  readonly replacement: string;
}

const INTERFACE_PACKAGE_ID = ['@forgeax', 'interface'].join('/');
const INTERFACE_STORE_ID = `${INTERFACE_PACKAGE_ID}/store`;
const INTERFACE_SESSION_CLIENT_ID = `${INTERFACE_PACKAGE_ID}/store-parts/session-client`;
const INTERFACE_MENU_REGISTRY_ID = `${INTERFACE_PACKAGE_ID}/lib/menu-registry`;

/** Stateful Interface modules must stay outside dependency pre-bundles. A
 * pre-bundled consumer and the source-integrated product otherwise receive
 * separate module globals (most visibly the configured session client). */
export const IDE_OPTIMIZE_DEPS_EXCLUDE = [
  '@forgeax/app-shell/window',
  INTERFACE_STORE_ID,
  INTERFACE_SESSION_CLIENT_ID,
  INTERFACE_MENU_REGISTRY_ID,
] as const;

export function createIdeRuntimeAliases(roots: IdeRuntimeRoots): IdeRuntimeAlias[] {
  const appShellWindowEntry = resolve(
    roots.interfaceRoot,
    'node_modules/@forgeax/app-shell/dist/window.js',
  );
  if (!existsSync(appShellWindowEntry)) {
    throw new Error(`forgeax-studio App Shell window entry is missing: ${appShellWindowEntry}`);
  }

  return [
    { find: /^@forgeax\/app-shell\/window$/, replacement: appShellWindowEntry },
    {
      find: /^@forgeax\/ide-integration\/interface-store-source$/,
      replacement: resolve(roots.interfaceRoot, 'src/store.ts'),
    },
    {
      find: /^@forgeax\/interface\/store$/,
      replacement: resolve(roots.ideRoot, 'src/integration/interface-store.ts'),
    },
    {
      find: /^@forgeax\/interface\/store-parts\/session-client$/,
      replacement: resolve(roots.interfaceRoot, 'src/store-parts/session-client.ts'),
    },
    {
      find: /^@forgeax\/interface\/lib\/menu-registry$/,
      replacement: resolve(roots.interfaceRoot, 'src/lib/menu-registry.ts'),
    },
  ];
}
