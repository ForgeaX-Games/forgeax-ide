import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath, type PluginOption } from "vite";
import checker from "vite-plugin-checker";
import {
	sanitizeReleaseSourceCode,
	sanitizeReleaseSourcePaths,
} from "./scripts/release-source-path-sanitize";
import { vitePluginBrand } from "./scripts/vite-plugin-brand";
import {
	createIdeRuntimeAliases,
	IDE_OPTIMIZE_DEPS_EXCLUDE,
	IDE_RUNTIME_DEDUPE,
} from "./scripts/vite-runtime-contract";

const integrationRootEnv = process.env.FORGEAX_INTEGRATION_ROOT;
if (!integrationRootEnv) {
	throw new Error(
		"FORGEAX_INTEGRATION_ROOT is required; forgeax-ide runs only inside forgeax-studio.",
	);
}
const integrationRoot = integrationRootEnv;

const ideRoot = resolve(import.meta.dirname);
const expectedIdeRoot = resolve(integrationRoot, "packages/ide");
if (ideRoot !== expectedIdeRoot) {
	throw new Error(
		`forgeax-ide must be mounted at ${expectedIdeRoot}; received ${ideRoot}`,
	);
}

const studioPackagePath = resolve(integrationRoot, "package.json");
const studioPackage = existsSync(studioPackagePath)
	? (JSON.parse(readFileSync(studioPackagePath, "utf8")) as { name?: unknown })
	: null;
if (studioPackage?.name !== "forgeax-studio") {
	throw new Error(
		`FORGEAX_INTEGRATION_ROOT is not a forgeax-studio checkout: ${integrationRoot}`,
	);
}

const interfaceRoot = resolve(integrationRoot, "packages/interface");
if (!existsSync(resolve(interfaceRoot, "package.json"))) {
	throw new Error(
		`forgeax-studio Interface checkout is missing: ${interfaceRoot}`,
	);
}
const brandPlugin = vitePluginBrand({ packageDir: ideRoot });
// The isolated Vite contracts exercise module resolution and transformation.
// TypeScript and Biome are already explicit CI gates; starting their checker
// workers for every short-lived contract server makes those probes wait on
// unrelated workspace analysis and can leave their workers to be reaped.
const isViteContractProbe = process.env.FORGEAX_VITE_CONTRACT_PROBE === "1";

const packageRoot = (name: string): string =>
	resolve(integrationRoot, "packages", name);
const editorRoot = packageRoot("editor");
const enginePackagesRoot = resolve(editorRoot, "packages/engine/packages");
const enginePackagesViteRoot = `${normalizePath(enginePackagesRoot)}/`;
const enginePluginBrowser = resolve(
	enginePackagesRoot,
	"plugin/src/browser.ts",
);
const enginePluginLoaderUnavailable = resolve(
	ideRoot,
	"src/integration/engine-plugin-loader-unavailable.ts",
);
const engineWgpuWasmUnavailable = resolve(
	ideRoot,
	"src/integration/engine-wgpu-wasm-unavailable.ts",
);
const engineWgpuWasmRoot = resolve(enginePackagesRoot, "wgpu-wasm");
const desktopBuild = process.env.FORGEAX_DESKTOP_BUILD === "1";

function runtimePort(
	raw: string | undefined,
	fallback: number,
	name: string,
): number {
	if (raw === undefined) return fallback;
	if (!/^\d+$/.test(raw))
		throw new Error(`${name} must be an integer port, received '${raw}'`);
	const port = Number(raw);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`${name} must be between 1 and 65535, received '${raw}'`);
	}
	return port;
}

const studioServerPort = runtimePort(
	process.env.FORGEAX_SERVER_PORT,
	18900,
	"FORGEAX_SERVER_PORT",
);
const playRuntimePort = runtimePort(
	process.env.FORGEAX_ENGINE_PORT,
	15173,
	"FORGEAX_ENGINE_PORT",
);
const studioServerTarget = `http://127.0.0.1:${studioServerPort}`;
const studioServerWebSocketTarget = `ws://127.0.0.1:${studioServerPort}`;
const playRuntimeTarget = `http://127.0.0.1:${playRuntimePort}`;
const engineMcpTarget = process.env.FORGEAX_MCP_URL?.trim();

type SourcePackage = {
	readonly id: string;
	readonly root: string;
	readonly entry: string;
	readonly subpaths?: Readonly<Record<string, string>>;
};

type PackageExports = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function distTargetToSourceBase(target: string): string | null {
	if (!target.startsWith("./dist/")) return null;
	const distPath = target.slice("./dist/".length);
	for (const extension of [".d.ts", ".mjs", ".js", ".cjs"]) {
		if (distPath.endsWith(extension))
			return distPath.slice(0, -extension.length);
	}
	return null;
}

function exportTargetCandidates(exportValue: unknown): string[] {
	if (typeof exportValue === "string") return [exportValue];
	if (!isRecord(exportValue)) return [];
	return ["browser", "import", "default", "types", "node"]
		.map((key) => exportValue[key])
		.filter((value): value is string => typeof value === "string");
}

function resolveExportSourceFile(
	sourceRoot: string,
	exportValue: unknown,
): string | null {
	for (const target of exportTargetCandidates(exportValue)) {
		const sourceBase = distTargetToSourceBase(target);
		if (sourceBase === null) continue;
		const sourceFile = resolveSourceFile(resolve(sourceRoot, sourceBase));
		if (sourceFile !== null) return sourceFile;
	}
	return null;
}

function deriveExportSubpaths(
	sourceRoot: string,
	exportsValue: unknown,
): Readonly<Record<string, string>> | undefined {
	if (!isRecord(exportsValue)) return undefined;
	const subpaths: Record<string, string> = {};
	for (const [key, value] of Object.entries(exportsValue as PackageExports)) {
		if (key === "." || key === "./package.json" || !key.startsWith("./"))
			continue;
		const sourceFile = resolveExportSourceFile(sourceRoot, value);
		if (sourceFile !== null) subpaths[key.slice(2)] = sourceFile;
	}
	return Object.keys(subpaths).length > 0 ? subpaths : undefined;
}

function discoverEngineSourcePackages(): SourcePackage[] {
	if (!existsSync(enginePackagesRoot)) return [];
	return readdirSync(enginePackagesRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => resolve(enginePackagesRoot, entry.name))
		.flatMap((root): SourcePackage[] => {
			const packageJsonPath = resolve(root, "package.json");
			const sourceRoot = resolve(root, "src");
			const entry = resolveSourceFile(resolve(sourceRoot, "index"));
			if (
				!existsSync(packageJsonPath) ||
				!existsSync(sourceRoot) ||
				entry === null
			)
				return [];
			const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
				name?: unknown;
				exports?: unknown;
			};
			return typeof manifest.name === "string" &&
				manifest.name.startsWith("@forgeax/engine-")
				? [
						{
							id: manifest.name,
							root: sourceRoot,
							entry:
								resolveExportSourceFile(
									sourceRoot,
									isRecord(manifest.exports)
										? manifest.exports["."]
										: manifest.exports,
								) ?? entry,
							subpaths: deriveExportSubpaths(sourceRoot, manifest.exports),
						},
					]
				: [];
		});
}

const sourcePackages: readonly SourcePackage[] = [
	{
		id: "@forgeax/interface",
		root: resolve(interfaceRoot, "src"),
		entry: resolve(interfaceRoot, "src/index.ts"),
	},
	{
		id: "@forgeax/engine-plugin",
		root: resolve(ideRoot, "src/integration"),
		entry: enginePluginBrowser,
		subpaths: { loader: enginePluginLoaderUnavailable },
	},
	desktopBuild
		? {
				id: "@forgeax/engine-wgpu-wasm",
				root: resolve(engineWgpuWasmRoot, "src"),
				entry: resolve(engineWgpuWasmRoot, "src/index.ts"),
				subpaths: { pkg: resolve(engineWgpuWasmRoot, "pkg/wgpu_wasm.js") },
			}
		: {
				id: "@forgeax/engine-wgpu-wasm",
				root: resolve(ideRoot, "src/integration"),
				entry: engineWgpuWasmUnavailable,
				subpaths: { pkg: engineWgpuWasmUnavailable },
			},
	...discoverEngineSourcePackages(),
];

function resolveSourceFile(path: string): string | null {
	for (const candidate of [
		path,
		`${path}.ts`,
		`${path}.tsx`,
		`${path}.js`,
		`${path}.jsx`,
		resolve(path, "index.ts"),
		resolve(path, "index.tsx"),
		resolve(path, "index.js"),
		resolve(path, "index.jsx"),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function sourcePackageResolve(): PluginOption {
	return {
		name: "forgeax:ide-source-package-resolve",
		enforce: "pre",
		resolveId(id) {
			for (const sourcePackage of sourcePackages) {
				if (id === sourcePackage.id) return sourcePackage.entry;
				const prefix = `${sourcePackage.id}/`;
				if (!id.startsWith(prefix)) continue;
				const subpath = id.slice(prefix.length);
				return (
					sourcePackage.subpaths?.[subpath] ??
					resolveSourceFile(resolve(sourcePackage.root, subpath))
				);
			}
			return null;
		},
	};
}

function engineSourceRuntimeUrlResolve(): PluginOption {
	return {
		name: "forgeax:engine-source-runtime-url-resolve",
		enforce: "pre",
		transform(code, id) {
			const [filePath] = id.split("?");
			if (!normalizePath(filePath).startsWith(enginePackagesViteRoot))
				return null;
			let transformed = code;
			transformed = transformed.replace(
				/new URL\((['"])\.\/([^'"]+)\.mjs\1,\s*import\.meta\.url\)/g,
				(match, quote: string, specifier: string) => {
					const sourceFile = resolve(dirname(filePath), `${specifier}.ts`);
					return existsSync(sourceFile)
						? `new URL(${quote}./${specifier}.ts${quote}, import.meta.url)`
						: match;
				},
			);
			return transformed === code ? null : { code: transformed, map: null };
		},
	};
}

function releaseSourcePathSanitize(): PluginOption {
	return {
		name: "forgeax:ide-release-source-path-sanitize",
		enforce: "pre",
		transform(code) {
			const transformed = sanitizeReleaseSourceCode(code);
			return transformed === code ? null : { code: transformed, map: null };
		},
		generateBundle(_options, bundle) {
			for (const output of Object.values(bundle)) {
				if (output.type === "chunk") {
					output.code = sanitizeReleaseSourcePaths(
						output.code,
						integrationRoot,
					);
					continue;
				}
				if (!/\.(?:css|html|json|md|mjs|svg|txt)$/.test(output.fileName))
					continue;
				const source =
					typeof output.source === "string"
						? output.source
						: new TextDecoder().decode(output.source);
				const sanitized = sanitizeReleaseSourcePaths(source, integrationRoot);
				if (sanitized !== source) output.source = sanitized;
			}
		},
		writeBundle(options) {
			if (options.dir === undefined) return;
			const manifestPath = resolve(options.dir, "shaders/manifest.json");
			if (!existsSync(manifestPath)) return;
			const source = readFileSync(manifestPath, "utf8");
			const sanitized = sanitizeReleaseSourcePaths(source, integrationRoot);
			if (sanitized !== source) writeFileSync(manifestPath, sanitized);
		},
	};
}

const aliases = [
	...createIdeRuntimeAliases({ ideRoot, interfaceRoot }),
	{
		find: /^@forgeax\/interface\/(.+)$/,
		replacement: `${resolve(interfaceRoot, "src")}/$1`,
	},
	{
		find: /^@forgeax\/interface$/,
		replacement: resolve(interfaceRoot, "src/index.ts"),
	},
	{ find: /^@\/(.+)$/, replacement: `${resolve(interfaceRoot, "src")}/$1` },
];

type EnginePreset = {
	plugins: unknown[];
	optimizeDeps: {
		exclude: string[];
		include: string[];
		holdUntilCrawlEnd: false;
	};
	resolve: { dedupe: string[]; preserveSymlinks: boolean };
	build: { target: "esnext" };
};
// Keep this config-time import on the public facade (`@forgeax/editor/vite-preset`);
// the runtime specifier is assembled so IDE's Vite-7 typecheck does not compile
// the Editor source tree into this product's type graph.
const publicEditorSubpath = (subpath: string): string =>
	`@forgeax/editor/${subpath}`;
const editorVitePresetSpecifier = publicEditorSubpath("vite-preset");
type EditorVitePresetModule = {
	engineVitePreset?: (options: {
		base: string;
		gameDirAbs: string | null;
		preserveSymlinks: boolean;
	}) => EnginePreset;
	default?: {
		engineVitePreset?: (options: {
			base: string;
			gameDirAbs: string | null;
			preserveSymlinks: boolean;
		}) => EnginePreset;
	};
};
const ideRequire = createRequire(resolve(ideRoot, "package.json"));
let editorVitePresetModule: EditorVitePresetModule;
try {
	// Resolve through the IDE package's public export map, then import the
	// resolved entry by URL. Vite's bundled config runs from .vite-temp; an
	// anchored require keeps that temporary location from changing package
	// resolution in a clean Studio integration checkout.
	const editorVitePresetEntry = ideRequire.resolve(editorVitePresetSpecifier);
	editorVitePresetModule = (await import(
		/* @vite-ignore */ pathToFileURL(editorVitePresetEntry).href
	)) as EditorVitePresetModule;
} catch (error) {
	const detail =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	throw new Error(`Failed to load ${editorVitePresetSpecifier}: ${detail}`, {
		cause: error,
	});
}
const engineVitePreset =
	editorVitePresetModule.engineVitePreset ??
	editorVitePresetModule.default?.engineVitePreset;
if (typeof engineVitePreset !== "function") {
	throw new Error(
		`${editorVitePresetSpecifier} must export engineVitePreset()`,
	);
}
const enginePreset = engineVitePreset({
	base: "/",
	gameDirAbs: null,
	preserveSymlinks: false,
});
// The Editor package is authored against Vite 8 while this consumer remains on
// Vite 7. Plugin hooks are the runtime contract; bridge the two Vite type graphs
// once at the public preset boundary and keep all host-owned assembly local.
const enginePresetPlugins = enginePreset.plugins as unknown as PluginOption[];

export default defineConfig({
	plugins: [
		brandPlugin,
		...(isViteContractProbe
			? []
			: [
					// The checker supports Vite 7 and 8; workspace peer declarations may use
					// a separate Rollup instance. Adapt the plugin boundary like the Editor preset.
					// One checker instance keeps all four source packages in the same overlay.
					checker({
						root: integrationRoot,
						typescript: {
							root: ideRoot,
							tsconfigPath: "tsconfig.frontend.json",
						},
						biome: {
							command: "check",
							flags: `--config-path=${JSON.stringify(resolve(integrationRoot, "biome.frontend.json"))} --diagnostic-level=error ${["interface", "chat", "dashboard", "settings"].map((name) => JSON.stringify(resolve(integrationRoot, "packages", name))).join(" ")}`,
							watchPath: [
								"packages/interface",
								"packages/chat",
								"packages/dashboard",
								"packages/settings",
								"biome.frontend.json",
							],
							dev: {
								flags:
									"--config-path=biome.frontend.json --diagnostic-level=error",
								logLevel: ["error"],
							},
						},
						overlay: { initialIsOpen: "error" },
						terminal: true,
						enableBuild: true,
					}) as unknown as PluginOption,
					checker({
						root: ideRoot,
						biome: {
							command: "check",
							flags: "--config-path=biome.json --diagnostic-level=error",
							// Do not watch integration checkouts or build caches.
							watchPath: [
								"src",
								"packages",
								"scripts",
								"tests",
								"vite.config.ts",
								"vitest.config.ts",
								"biome.json",
								"package.json",
								"tsconfig.frontend.json",
								"tsconfig.lint.json",
							],
							dev: { logLevel: ["error"] },
						},
						overlay: { initialIsOpen: "error" },
						terminal: true,
						enableBuild: true,
					}) as unknown as PluginOption,
				]),
		sourcePackageResolve(),
		...enginePresetPlugins,
		engineSourceRuntimeUrlResolve(),
		releaseSourcePathSanitize(),
		react(),
	],
	// IDE owns its Tailwind/PostCSS pipeline while compatibility views remain
	// in Interface. The IDE config scans both source roots and editor panels.
	css: { postcss: ideRoot },
	resolve: {
		...enginePreset.resolve,
		alias: aliases,
		dedupe: [
			...new Set([...enginePreset.resolve.dedupe, ...IDE_RUNTIME_DEDUPE]),
		],
	},
	// App Shell and the Interface store are source-integrated runtime contracts.
	// Keeping their stateful entry points out of long-lived optimizer snapshots
	// preserves the installed export surface and one session-client identity.
	optimizeDeps: {
		...enginePreset.optimizeDeps,
		// Only the Studio shell entry — product/sources HTML must not join dep scan.
		entries: [resolve(ideRoot, "index.html")],
		exclude: [
			...new Set([
				...enginePreset.optimizeDeps.exclude,
				...IDE_OPTIMIZE_DEPS_EXCLUDE,
			]),
		],
	},
	worker: {
		format: "es",
		plugins: () => [
			sourcePackageResolve(),
			engineSourceRuntimeUrlResolve(),
			releaseSourcePathSanitize(),
		],
	},
	build: {
		...enginePreset.build,
		target: "esnext",
	},
	server: {
		fs: { allow: [integrationRoot] },
		proxy: {
			"/api": { target: studioServerTarget, changeOrigin: true, ws: true },
			"/ws": {
				target: studioServerWebSocketTarget,
				ws: true,
				changeOrigin: true,
			},
			...(engineMcpTarget
				? {
						"/engine/mcp": {
							target: engineMcpTarget,
							changeOrigin: true,
							proxyTimeout: 600_000,
							timeout: 600_000,
							rewrite: (path: string) =>
								path.replace(/^\/engine\/mcp(?=\/|\?|$)/, "/mcp"),
						},
					}
				: {}),
			// Extension iframe assets are served by forgeax-server. Without this
			// route Vite applies its SPA fallback and each extension iframe loads a
			// second copy of the IDE shell (Studio nested inside Studio).
			"/extensions": { target: studioServerTarget, changeOrigin: true },
			// The versioned Extension Runtime API is also server-owned. Keep it out
			// of the IDE SPA fallback so extension frames receive runtime responses.
			"/__extensions__": { target: studioServerTarget, changeOrigin: true },
			"/__ce-api__": { target: studioServerTarget, changeOrigin: true },
			// The migrated IDE shell hosts editor panels in-process, but engine boot
			// still asks the host origin for the bare shader manifest in some paths.
			// Proxy it to Play Runtime's /preview base; otherwise Vite's SPA fallback
			// returns index.html and Engine reports ShaderError: manifest-malformed.
			"/shaders": {
				target: playRuntimeTarget,
				changeOrigin: true,
				rewrite: (path) => `/preview${path}`,
			},
			"/preview": { target: playRuntimeTarget, changeOrigin: true, ws: true },
		},
	},
});
