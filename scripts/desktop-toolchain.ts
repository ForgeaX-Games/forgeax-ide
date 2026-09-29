#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export type DesktopToolchainSources = {
	bun: string;
	node: string;
	rust: string;
	wasmPack: string;
	pnpm: string;
	server: string;
	engine: string;
};

const require = createRequire(import.meta.url);
const { desktopToolchainSources } =
	require("../.ci/toolchain-versions.cjs") as {
		desktopToolchainSources: (
			ide?: string,
			studio?: string,
		) => DesktopToolchainSources;
	};

export { desktopToolchainSources };

export function verifyDesktopToolchain(
	sources = desktopToolchainSources(),
	run: (command: string, cwd: string) => string = (command, cwd) => {
		const result = spawnSync(command, ["--version"], {
			cwd,
			encoding: "utf8",
		});
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error(
				`${command} --version failed in ${cwd}: ${result.status}`,
			);
		return result.stdout.trim();
	},
	ide = resolve(import.meta.dirname, ".."),
	profile: "all" | "release-target" = "all",
) {
	if (typeof Bun !== "undefined" && Bun.version !== sources.bun)
		throw new Error(
			`running Bun version mismatch: expected ${sources.bun}, got ${Bun.version}`,
		);
	const expected = {
		bun: sources.bun,
		node: `v${sources.node}`,
		rustc: `rustc ${sources.rust}`,
		"wasm-pack": `wasm-pack ${sources.wasmPack}`,
		pnpm: sources.pnpm,
	};
	const commands =
		profile === "all"
			? Object.keys(expected)
			: ["bun", "node", "rustc", "pnpm"];
	const verified: Record<string, string> = {};
	for (const command of commands) {
		const version = expected[command as keyof typeof expected];
		const cwd = command === "pnpm" ? sources.engine : ide;
		const actual = run(command, cwd);
		if (
			command === "rustc"
				? !actual.startsWith(`${version} `)
				: actual !== version
		)
			throw new Error(
				`${command} version mismatch in ${cwd}: expected ${version}, got ${actual}`,
			);
		verified[command] = version;
	}
	return verified;
}

if (import.meta.main) {
	const sources = desktopToolchainSources();
	const command = Bun.argv[2] ?? "sources";
	if (
		command !== "sources" &&
		command !== "verify" &&
		command !== "verify-release-target"
	)
		throw new Error(
			"usage: bun scripts/desktop-toolchain.ts [sources|verify|verify-release-target]",
		);
	const { engine: _, ...versions } = sources;
	console.log(
		JSON.stringify({
			versions,
			verified:
				command === "sources"
					? null
					: verifyDesktopToolchain(
							sources,
							undefined,
							undefined,
							command === "verify-release-target" ? "release-target" : "all",
						),
		}),
	);
}
