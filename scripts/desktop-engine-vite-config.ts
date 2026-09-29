const PLAY_PACKAGE_ROOT_DECLARATION =
	"const PLAY_PACKAGE_ROOT = resolve(here, 'node_modules');";
const OPTIMIZE_DEPS_DECLARATION = "  optimizeDeps: enginePreset.optimizeDeps,";
// Editor fdbcd146 (2026-09-08) expanded the worktree resolver to also match
// the `@forgeax/engine` facade itself and its `engine/` subpaths, splitting
// the return across lines. Keep this anchor byte-identical to the upstream
// resolver body so the packaged rewrite stays anchored across editor bumps.
const ENGINE_WORKSPACE_RESOLUTION = `return id === '@forgeax/engine' || id.startsWith('@forgeax/engine/') || id.startsWith('@forgeax/engine-')
      ? resolvePlayEngineEntry(id)
      : null;`;

// Keep the Vite host and packages that resolve data relative to their own
// package URL external. The remaining config graph is pure JavaScript and can
// be collapsed into one sequentially-readable desktop resource.
export const DESKTOP_ENGINE_VITE_CONFIG_EXTERNALS = [
	"./src/runtime-scope-controller.mjs",
	"vite",
	"typescript",
	"css-tree",
	"mdn-data",
	// The ScriptablePack loader resolves its worker relative to the published
	// @forgeax/engine-pack module URL. Bundling that package into the top-level
	// Vite config changes import.meta.url to resources/engine/vite.config.mjs
	// and makes the worker lookup escape to resources/dist.
	"@forgeax/engine-pack",
	// The MSDF font importer (cli-font.ts) resolves its worker
	// (node-msdf-worker.mjs) relative to import.meta.url. Bundling
	// @forgeax/engine-font into the top-level Vite config changes
	// import.meta.url to resources/engine/vite.config.mjs, causing the
	// worker lookup to escape to resources/engine/ where the file is
	// absent (it lives under node_modules/@forgeax/engine-font/dist/).
	"@forgeax/engine-font",
	"@forgeax/engine-wgpu-wasm",
	"@forgeax/engine-fbx",
	"@forgeax/engine-codec",
] as const;

const PACKAGED_WORKSPACE_DISCOVERY = `const PACKAGED_ENGINE_RESOURCE_ROOT = resolve(
  process.env.FORGEAX_ENGINE_RESOURCE_ROOT ?? here,
);
const viteRoot = resolve(process.env.FORGEAX_ENGINE_WORKSPACE_ROOT ?? here);
const PLAY_PACKAGE_ROOT = resolve(PACKAGED_ENGINE_RESOURCE_ROOT, 'node_modules');

// The shared preset normally derives this list from Editor's source layout.
// Desktop assembly flattens that layout, so the packaged Play host must derive
// the same invariant from the dependency graph it actually ships.
function packagedForgeaXWorkspacePackages(): string[] {
  return readdirSync(resolve(PLAY_PACKAGE_ROOT, '@forgeax'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => \`@forgeax/\${entry.name}\`);
}

const PACKAGED_FORGEAX_WORKSPACE_PACKAGES = packagedForgeaXWorkspacePackages();`;

const PACKAGED_OPTIMIZE_DEPS = `  optimizeDeps: {
    ...enginePreset.optimizeDeps,
    exclude: [
      ...new Set([
        ...enginePreset.optimizeDeps.exclude,
        ...PACKAGED_FORGEAX_WORKSPACE_PACKAGES,
      ]),
    ],
  },`;

const PACKAGED_WORKSPACE_RESOLUTION = `return PACKAGED_FORGEAX_WORKSPACE_PACKAGES.some(
      (name) => id === name || id.startsWith(\`${"${name}"}/\`),
    ) ? resolvePlayEngineEntry(id) : null;`;

function replaceExactlyOnce(
	source: string,
	search: string,
	replacement: string,
	label: string,
): string {
	const occurrences = source.split(search).length - 1;
	if (occurrences !== 1) {
		throw new Error(
			`[desktop-engine-vite-config] expected one ${label}; found ${occurrences}`,
		);
	}
	return source.replace(search, replacement);
}

export function rewriteDesktopEngineViteConfig(source: string): string {
	// The workspace-resolver anchor spans multiple lines, so the rewrite is
	// newline-style sensitive. Normalize CRLF checkouts (Windows git
	// core.autocrlf=true) once up front; every anchor and the downstream
	// replacement chain in assemble-desktop-runtime assumes LF.
	const normalized = source.replaceAll("\r\n", "\n");
	let rewritten = replaceExactlyOnce(
		normalized,
		PLAY_PACKAGE_ROOT_DECLARATION,
		PACKAGED_WORKSPACE_DISCOVERY,
		"Play package-root declaration",
	);
	rewritten = replaceExactlyOnce(
		rewritten,
		OPTIMIZE_DEPS_DECLARATION,
		PACKAGED_OPTIMIZE_DEPS,
		"optimizeDeps declaration",
	);
	rewritten = replaceExactlyOnce(
		rewritten,
		"const viteRoot = here;",
		"// viteRoot is declared with the packaged resource boundary above.",
		"Play Vite-root declaration",
	);
	rewritten = replaceExactlyOnce(
		rewritten,
		ENGINE_WORKSPACE_RESOLUTION,
		PACKAGED_WORKSPACE_RESOLUTION,
		"Play packaged-workspace resolver",
	);
	return replaceExactlyOnce(
		rewritten,
		"'./src/runtime-scope-controller.ts'",
		"'./src/runtime-scope-controller.mjs'",
		"Play runtime controller import",
	);
}

export function desktopEngineViteConfigBundleArgs(
	input: string,
	output: string,
): string[] {
	return [
		"build",
		input,
		"--target=node",
		"--format=esm",
		"--packages=bundle",
		...DESKTOP_ENGINE_VITE_CONFIG_EXTERNALS.map((name) => `--external=${name}`),
		"--outfile",
		output,
	];
}

// Bundle while Editor's host/core source graph is still available. Keep this
// module under engine/src: project validation resolves shared assets one level
// above its module URL. The outer Vite bundle must not inline it again.
export function desktopRuntimeControllerBundleArgs(
	input: string,
	output: string,
): string[] {
	return [
		"build",
		input,
		"--target=node",
		"--format=esm",
		"--packages=external",
		"--outfile",
		output,
	];
}
