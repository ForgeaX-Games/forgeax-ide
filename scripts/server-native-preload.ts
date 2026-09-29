import fs from "node:fs";
import Module from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeWindowsDevicePath } from "./desktop-environment";
import { resolveServerRuntimeAsset } from "./server-runtime-assets";

function installNativePreload(): void {
	const installed = Symbol.for("forgeax.server.native-preload");
	if (Reflect.get(globalThis, installed)) return;

	const configuredResourceRoot = process.env.FORGEAX_RESOURCE_ROOT;
	if (!configuredResourceRoot)
		throw new Error(
			"FORGEAX_RESOURCE_ROOT is required by the server native preload",
		);
	const resourceRoot = normalizeWindowsDevicePath(configuredResourceRoot);
	const bunExecutable = process.env.FORGEAX_BUN_EXECUTABLE;
	if (!bunExecutable)
		throw new Error(
			"FORGEAX_BUN_EXECUTABLE is required by the server native preload",
		);
	process.execPath = bunExecutable;
	// The preload adapts only the compiled server. Kernel and agent-host children
	// run from different working directories and must execute their own entrypoints.
	delete process.env.BUN_OPTIONS;

	const productRoot = normalizeWindowsDevicePath(
		process.env.FORGEAX_PRODUCT_ROOT ?? join(resourceRoot, "product"),
	);
	const serverRuntime = join(resourceRoot, "server-runtime");
	process.argv[1] = join(serverRuntime, "compiled-server-entry.mjs");
	const nativeRoot = join(serverRuntime, "node_modules");
	const assetRoot = join(serverRuntime, "assets");

	const moduleApi = Module as typeof Module & {
		_resolveFilename: (
			request: string,
			parent: unknown,
			isMain: boolean,
			options?: unknown,
		) => string;
	};
	const resolveFilename = moduleApi._resolveFilename;
	moduleApi._resolveFilename = function (request, parent, isMain, options) {
		if (request === "playwright" || request === "playwright-core") {
			return join(nativeRoot, request, "index.js");
		}
		if (request.startsWith("@img/")) {
			const segments = request.split("/");
			const packageRoot = join(nativeRoot, segments.slice(0, 2).join("/"));
			const manifest = JSON.parse(
				fs.readFileSync(join(packageRoot, "package.json"), "utf8"),
			) as {
				exports?: Record<string, string>;
			};
			const key =
				segments.length === 2 ? "." : `./${segments.slice(2).join("/")}`;
			const target = manifest.exports?.[key];
			if (typeof target === "string") return join(packageRoot, target);
		}
		const productManifestRequest =
			/^(@forgeax-extension\/[^/]+)\/package\.json$/.exec(request);
		if (productManifestRequest) {
			const manifest = join(
				productRoot,
				"node_modules",
				productManifestRequest[1]!,
				"package.json",
			);
			if (fs.existsSync(manifest)) return manifest;
		}
		return resolveFilename.call(this, request, parent, isMain, options);
	};

	const readFileSync = fs.readFileSync.bind(fs);
	fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: unknown) => {
		const value =
			path instanceof URL ? path : typeof path === "string" ? path : null;
		const asset =
			value === null ? null : resolveServerRuntimeAsset(value, assetRoot);
		if (asset) return readFileSync(asset, options as never);
		return readFileSync(path, options as never);
	}) as typeof fs.readFileSync;

	const NativeURL = URL;
	globalThis.URL = class RuntimeAssetURL extends NativeURL {
		constructor(input: string | URL, base?: string | URL) {
			const resolved = new NativeURL(input, base);
			const asset = resolveServerRuntimeAsset(resolved, assetRoot);
			super(asset ? pathToFileURL(asset).href : resolved.href);
		}
	} as typeof URL;
	Reflect.set(globalThis, installed, true);
}
installNativePreload();
