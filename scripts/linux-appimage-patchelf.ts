#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export type PreservedExecutable = { source: string; names: string[] };
const SYSTEM_LIBRARIES = new Set([
	"libc.so.6",
	"libpthread.so.0",
	"libdl.so.2",
	"libm.so.6",
	"librt.so.1",
	"libresolv.so.2",
]);

/** Bun's executable layout must survive AppImage assembly without ELF rewriting. */
export function preserveExecutable(
	args: string[],
	sources: PreservedExecutable[],
	patchelf: string,
): boolean {
	if (args.length !== 3 || args[0] !== "--set-rpath") return false;
	const target = args[2]!;
	const source = sources.find((entry) =>
		entry.names.includes(basename(target)),
	);
	if (!source) return false;
	if (!readFileSync(target).equals(readFileSync(source.source))) {
		throw new Error(
			`AppImage executable changed before ELF processing: ${target}`,
		);
	}
	const needed = spawnSync(patchelf, ["--print-needed", target], {
		encoding: "utf8",
	});
	if (needed.status !== 0)
		throw new Error(
			`cannot inspect preserved executable dependencies: ${needed.stderr}`,
		);
	const unexpected = needed.stdout
		.trim()
		.split(/\s+/)
		.filter((name) => name && !SYSTEM_LIBRARIES.has(name));
	if (unexpected.length)
		throw new Error(
			`preserved executable requires non-system libraries: ${unexpected.join(", ")}`,
		);
	return true;
}

if (import.meta.main) {
	const patchelf = process.env.FORGEAX_SYSTEM_PATCHELF;
	const sources = process.env.FORGEAX_APPIMAGE_EXECUTABLES;
	if (!patchelf || !sources)
		throw new Error("AppImage executable preservation inputs are required");
	const args = Bun.argv.slice(2);
	if (!preserveExecutable(args, JSON.parse(sources), patchelf)) {
		const result = spawnSync(patchelf, args, { stdio: "inherit" });
		process.exit(result.status ?? 1);
	}
}
