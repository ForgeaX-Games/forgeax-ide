#!/usr/bin/env bun

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const KIT_KINDS = ["slots", "tools", "plugins"] as const;

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

export function desktopOrchestratorKitEntrypoints(source: string): string[] {
	const entries: string[] = [];
	for (const kit of readdirSync(source, { withFileTypes: true })) {
		if (!kit.isDirectory() || kit.name.startsWith(".")) continue;
		const kitRoot = join(source, kit.name);
		const condition = join(kitRoot, "condition.ts");
		if (existsSync(condition)) entries.push(condition);
		for (const kind of KIT_KINDS) {
			const kindRoot = join(kitRoot, kind);
			if (!existsSync(kindRoot)) continue;
			for (const entry of readdirSync(kindRoot, { withFileTypes: true })) {
				if (
					entry.isFile() &&
					!entry.name.startsWith(".") &&
					entry.name.endsWith(".ts")
				) {
					entries.push(join(kindRoot, entry.name));
				}
			}
		}
	}
	return entries.sort();
}

export async function bundleDesktopOrchestratorKits(
	source: string,
	outdir: string,
): Promise<string[]> {
	const entrypoints = desktopOrchestratorKitEntrypoints(source);
	if (entrypoints.length === 0)
		throw new Error(`no Orchestrator kit entrypoints found: ${source}`);
	const result = await Bun.build({
		entrypoints,
		outdir,
		root: source,
		target: "bun",
		format: "esm",
		splitting: true,
		minify: false,
		naming: {
			entry: "[dir]/[name].ts",
			chunk: "chunks/[name]-[hash].mjs",
		},
	});
	if (!result.success) {
		throw new AggregateError(
			result.logs,
			"failed to bundle desktop Orchestrator kits",
		);
	}
	for (const entry of entrypoints) {
		const output = join(outdir, entry.slice(source.length + 1));
		if (!existsSync(output))
			throw new Error(`bundled Orchestrator kit entry is missing: ${output}`);
	}
	return result.outputs.map((output) => output.path);
}

if (import.meta.main) {
	const source = argument("--source");
	const outdir = argument("--outdir");
	if (!source || !outdir) throw new Error("--source and --outdir are required");
	const outputs = await bundleDesktopOrchestratorKits(
		resolve(source),
		resolve(outdir),
	);
	console.log(
		JSON.stringify({
			code: "IDE_DESKTOP_ORCHESTRATOR_KITS_BUNDLED",
			outputs: outputs.length,
		}),
	);
}
