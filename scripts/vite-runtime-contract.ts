import { resolve } from "node:path";

export interface IdeRuntimeRoots {
	readonly ideRoot: string;
	readonly interfaceRoot: string;
}

export interface IdeRuntimeAlias {
	readonly find: RegExp;
	readonly replacement: string;
}

const INTERFACE_PACKAGE_ID = ["@forgeax", "interface"].join("/");
const INTERFACE_STORE_ID = `${INTERFACE_PACKAGE_ID}/store`;
const INTERFACE_SESSION_CLIENT_ID = `${INTERFACE_PACKAGE_ID}/store-parts/session-client`;
const INTERFACE_MENU_REGISTRY_ID = `${INTERFACE_PACKAGE_ID}/lib/menu-registry`;

// Resolve shared runtime packages through their public exports from the IDE's
// declared dependency graph, regardless of which workspace imports them.
export const IDE_RUNTIME_DEDUPE = [
	"react",
	"react-dom",
	"@forgeax/agents",
	"@forgeax/app-shell",
	"@forgeax/extension-platform",
	"@forgeax/types",
] as const;

/** Stateful Interface modules must stay outside dependency pre-bundles. A
 * pre-bundled consumer and the source-integrated product otherwise receive
 * separate module globals (most visibly the configured session client). */
export const IDE_OPTIMIZE_DEPS_EXCLUDE = [
	"@forgeax/app-shell/window",
	"@forgeax/app-shell/application",
	"@forgeax/app-shell/react",
	"@forgeax/app-shell/pages",
	"@forgeax/app-shell/dock",
	"@forgeax/extension-platform/extensions",
	INTERFACE_STORE_ID,
	INTERFACE_SESSION_CLIENT_ID,
	INTERFACE_MENU_REGISTRY_ID,
] as const;

export function createIdeRuntimeAliases(
	roots: IdeRuntimeRoots,
): IdeRuntimeAlias[] {
	return [
		{
			find: /^@forgeax\/interface\/store$/,
			replacement: resolve(roots.interfaceRoot, "src/store.ts"),
		},
		{
			find: /^@forgeax\/interface\/store-parts\/session-client$/,
			replacement: resolve(
				roots.interfaceRoot,
				"src/store-parts/session-client.ts",
			),
		},
		{
			find: /^@forgeax\/interface\/lib\/menu-registry$/,
			replacement: resolve(roots.interfaceRoot, "src/lib/menu-registry.ts"),
		},
	];
}
