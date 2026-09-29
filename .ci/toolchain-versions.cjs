#!/usr/bin/env node
// Node-only resolver: CI can read the exact source contract before Bun is installed.
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function exactVersion(value, source) {
	if (typeof value !== "string" || !EXACT_VERSION.test(value))
		throw new Error(
			`${source} must declare an exact major.minor.patch version`,
		);
	return value;
}

function packageManager(value, name, source) {
	if (typeof value !== "string" || !value.startsWith(`${name}@`))
		throw new Error(`${source} must declare ${name}@major.minor.patch`);
	return exactVersion(value.slice(name.length + 1), source);
}

function json(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function desktopToolchainSources(
	ide = resolve(__dirname, ".."),
	studio = resolve(ide, "../.."),
) {
	const engine = join(studio, "packages/editor/packages/engine");
	const bun = packageManager(
		json(join(ide, "package.json")).packageManager,
		"bun",
		"IDE package.json#packageManager",
	);
	const node = exactVersion(
		readFileSync(join(engine, ".nvmrc"), "utf8").trim(),
		"Engine .nvmrc",
	);
	const pnpm = packageManager(
		json(join(engine, "package.json")).packageManager,
		"pnpm",
		"Engine package.json#packageManager",
	);
	if (readFileSync(join(engine, ".pnpm-version"), "utf8").trim() !== pnpm)
		throw new Error("Engine .pnpm-version disagrees with packageManager");
	const rust = exactVersion(
		json(join(ide, ".ci/desktop-build-inputs.json")).rust,
		"IDE desktop-build-inputs.json#rust",
	);
	const rustChannel = readFileSync(
		join(engine, "packages/wgpu-wasm/rust-toolchain.toml"),
		"utf8",
	).match(/^channel\s*=\s*"([^"]+)"\s*$/m)?.[1];
	if (rustChannel !== rust.slice(0, rust.lastIndexOf(".")))
		throw new Error(
			"IDE Rust version is outside the Engine wgpu-wasm toolchain channel",
		);
	const wasmPack = exactVersion(
		json(join(engine, "scripts/ci/editor-prerequisite-build.contract.json"))
			.toolchainInputs?.wasmPackVersion,
		"Engine editor-prerequisite-build.contract.json#wasmPackVersion",
	);
	const server = exactVersion(
		json(join(ide, "product/forgeax-product.json")).services?.find(
			(value) => value.id === "forgeax-server",
		)?.version,
		"IDE forgeax-product.json#forgeax-server.version",
	);
	if (json(join(studio, "packages/server/package.json")).version !== server)
		throw new Error(
			"Server package version disagrees with the IDE product declaration",
		);
	return { bun, node, rust, wasmPack, pnpm, server, engine };
}

if (require.main === module) {
	const sources = desktopToolchainSources();
	const mode = process.argv[2] ?? "json";
	if (mode === "json") {
		console.log(JSON.stringify(sources));
	} else if (mode === "values") {
		console.log(
			[
				sources.node,
				sources.bun,
				sources.pnpm,
				sources.rust,
				sources.wasmPack,
			].join(" "),
		);
	} else if (mode === "github") {
		const { appendFileSync } = require("node:fs");
		if (!process.env.GITHUB_OUTPUT)
			throw new Error("GITHUB_OUTPUT is required for github output mode");
		for (const name of ["bun", "node", "pnpm", "rust", "wasmPack"])
			appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${sources[name]}\n`);
	} else {
		throw new Error(
			"usage: node .ci/toolchain-versions.cjs [json|values|github]",
		);
	}
}

module.exports = { desktopToolchainSources };
