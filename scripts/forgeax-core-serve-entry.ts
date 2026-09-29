#!/usr/bin/env bun

export {};

// Desktop-only forgeax-core serve entry.
//
// The general CLI entry also imports the Ink TUI. Bundling that entry for the
// headless desktop sidecar leaves Ink's optional react-devtools-core import in
// the output, which then fails before --serve can open its socket. Keep the
// packaged subprocess on the serve-only dependency graph.

// Keep the integration-only sibling out of the standalone IDE TypeScript
// program. Bun still resolves and bundles this literal require during release
// assembly, where `packages/cli` is a validated Studio input.
const { startServe } = require("../../cli/src/cli/serve") as {
	startServe(sockPath: string): Promise<void>;
};

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

const sock = argument("--sock") ?? process.env.FORGEAX_CORE_SOCK;
if (!sock?.trim()) {
	process.stderr.write(
		"forgeax-core desktop serve requires --sock <path> (or FORGEAX_CORE_SOCK).\n",
	);
	process.exit(1);
}

await startServe(sock);
