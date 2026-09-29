#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";

const IDE_ROOT = resolve(import.meta.dirname, "..");
const MANIFEST_PATH = join(
	IDE_ROOT,
	"src-tauri/resources/runtime/desktop-runtime-manifest.json",
);
const BUILD_SOURCE_PATH = join(
	IDE_ROOT,
	"release-work/desktop-build-source.json",
);

export type RuntimeBenchmarkSample = {
	startupReadyMs: number;
	projectBindMs: number;
	previewValidatedMs: number;
	runtimeToValidationMs: number;
	runtimeRssMaxKiB: number;
	rssSampleCount: number;
	rssMaxMembers: number;
	diagnostics: string;
};

type ProcessRow = { pid: number; ppid: number; rssKiB: number };

export function parseProcessRows(output: string): ProcessRow[] {
	return output
		.trim()
		.split("\n")
		.flatMap((line): ProcessRow[] => {
			const values = line.trim().split(/\s+/).map(Number);
			const [pid, ppid, rssKiB] = values;
			if (
				values.length !== 3 ||
				pid === undefined ||
				ppid === undefined ||
				rssKiB === undefined ||
				![pid, ppid, rssKiB].every(
					(value) => Number.isSafeInteger(value) && value >= 0,
				)
			)
				return [];
			return [{ pid, ppid, rssKiB }];
		});
}

/** Sum RSS for the launcher and every descendant of the recorded service PIDs. */
export function ownedRuntimeRss(
	rows: readonly ProcessRow[],
	rootPids: readonly number[],
): { totalKiB: number; members: number } | null {
	const owned = new Set(rootPids);
	if (
		owned.size === 0 ||
		rootPids.some((pid) => !rows.some((row) => row.pid === pid))
	)
		return null;
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (!owned.has(row.pid) && owned.has(row.ppid)) {
				owned.add(row.pid);
				changed = true;
			}
		}
	}
	const selected = rows.filter((row) => owned.has(row.pid));
	return {
		totalKiB: selected.reduce((sum, row) => sum + row.rssKiB, 0),
		members: selected.length,
	};
}

export function smokePhaseDurations(
	eventsNdjson: string,
): Pick<
	RuntimeBenchmarkSample,
	| "startupReadyMs"
	| "projectBindMs"
	| "previewValidatedMs"
	| "runtimeToValidationMs"
> {
	const phases = new Map<string, number>();
	for (const line of eventsNdjson.trim().split("\n")) {
		const event = JSON.parse(line) as {
			at?: string;
			name?: string;
			detail?: unknown;
		};
		if (event.name !== "phase" || typeof event.detail !== "string") continue;
		const at = Date.parse(event.at ?? "");
		if (!Number.isFinite(at)) throw new Error("invalid smoke phase timestamp");
		if (!phases.has(event.detail)) phases.set(event.detail, at);
	}
	const span = (from: string, to: string): number => {
		const start = phases.get(from);
		const end = phases.get(to);
		if (start === undefined || end === undefined || end < start)
			throw new Error(`missing or reversed smoke phases: ${from} -> ${to}`);
		return end - start;
	};
	return {
		startupReadyMs: span("launch-runtime", "bind-project"),
		projectBindMs: span("bind-project", "browser-preview"),
		previewValidatedMs: span("browser-preview", "cleanup-launcher"),
		runtimeToValidationMs: span("launch-runtime", "cleanup-launcher"),
	};
}

function readRunningState(diagnosticRoot: string): {
	directory: string;
	rootPids: number[];
} | null {
	for (const entry of readdirSync(diagnosticRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
		const directory = join(diagnosticRoot, entry.name);
		const file = join(directory, "runtime-state.json");
		if (!existsSync(file)) continue;
		let state: {
			status?: string;
			launcherPid?: number;
			servicePids?: Record<string, number>;
		};
		try {
			state = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		if (state.status !== "ready") continue;
		const rootPids = [
			...new Set([
				state.launcherPid,
				...Object.values(state.servicePids ?? {}),
			]),
		].filter(
			(pid): pid is number =>
				typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0,
		);
		if (rootPids.length > 0) return { directory, rootPids };
	}
	return null;
}

async function runSample(): Promise<RuntimeBenchmarkSample> {
	const diagnosticRoot = mkdtempSync(
		join(tmpdir(), "forgeax-runtime-benchmark-"),
	);
	const child = spawn(process.execPath, ["run", "smoke:desktop-runtime"], {
		cwd: IDE_ROOT,
		env: { ...process.env, IDE_SMOKE_DIAGNOSTIC_DIR: diagnosticRoot },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (chunk) => {
			output = `${output}${String(chunk)}`.slice(-16_384);
		});
	let runtimeRssMaxKiB = 0;
	let rssSampleCount = 0;
	let rssMaxMembers = 0;
	const timer = setInterval(() => {
		const state = readRunningState(diagnosticRoot);
		if (!state) return;
		const ps = spawnSync("ps", ["-axo", "pid=,ppid=,rss="], {
			encoding: "utf8",
			timeout: 2_000,
		});
		if (ps.status !== 0 || !ps.stdout) return;
		const sample = ownedRuntimeRss(parseProcessRows(ps.stdout), state.rootPids);
		if (!sample) return;
		rssSampleCount += 1;
		if (sample.totalKiB > runtimeRssMaxKiB) {
			runtimeRssMaxKiB = sample.totalKiB;
			rssMaxMembers = sample.members;
		}
	}, 250);
	let exitCode: number | null;
	try {
		exitCode = await new Promise<number | null>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("close", resolveExit);
		});
	} finally {
		clearInterval(timer);
	}
	const run = readdirSync(diagnosticRoot).filter((name) =>
		name.startsWith("run-"),
	);
	const runName = run[0];
	if (exitCode !== 0 || runName === undefined || run.length !== 1)
		throw new Error(
			`desktop runtime smoke failed (exit=${exitCode}, diagnostics=${diagnosticRoot}):\n${output}`,
		);
	const diagnostics = join(diagnosticRoot, runName);
	if (rssSampleCount === 0)
		throw new Error(`no runtime RSS samples were captured: ${diagnostics}`);
	return {
		...smokePhaseDurations(
			readFileSync(join(diagnostics, "events.ndjson"), "utf8"),
		),
		runtimeRssMaxKiB,
		rssSampleCount,
		rssMaxMembers,
		diagnostics,
	};
}

function integerOption(name: string, fallback: number, min: number): number {
	const index = Bun.argv.indexOf(name);
	const value = index < 0 ? fallback : Number(Bun.argv[index + 1]);
	if (!Number.isSafeInteger(value) || value < min || value > 20)
		throw new Error(`${name} must be an integer from ${min} to 20`);
	return value;
}

function machineModel(): string {
	if (platform() !== "darwin") return cpus()[0]?.model ?? "unknown";
	const result = spawnSync("sysctl", ["-n", "hw.model"], {
		encoding: "utf8",
	});
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

async function main(): Promise<void> {
	if (platform() === "win32")
		throw new Error("RSS process-tree sampling currently requires ps");
	const warmups = integerOption("--warmups", 1, 0);
	const runs = integerOption("--runs", 3, 1);
	if (!existsSync(MANIFEST_PATH) || !existsSync(BUILD_SOURCE_PATH))
		throw new Error(
			"assembled desktop resources and source context are required",
		);
	const buildSource = JSON.parse(readFileSync(BUILD_SOURCE_PATH, "utf8")) as {
		repositories?: Record<string, { revision?: string; dirty?: boolean }>;
	};
	const ide = buildSource.repositories?.["packages/ide"];
	const studio = buildSource.repositories?.["."];
	if (!ide?.revision || !studio?.revision)
		throw new Error("desktop build source omits IDE or Studio revision");
	const warmupResults: RuntimeBenchmarkSample[] = [];
	for (let index = 0; index < warmups; index++) {
		console.error(`[runtime-benchmark] warmup ${index + 1}/${warmups}`);
		warmupResults.push(await runSample());
	}
	const samples: RuntimeBenchmarkSample[] = [];
	for (let index = 0; index < runs; index++) {
		console.error(`[runtime-benchmark] sample ${index + 1}/${runs}`);
		samples.push(await runSample());
	}
	const manifest = readFileSync(MANIFEST_PATH);
	console.log(
		JSON.stringify(
			{
				schema: "forgeax-ide-assembled-runtime-benchmark/v1",
				measurement:
					"assembled runtime + Chromium preview; warmups are recorded separately; not installed Tauri UI",
				source: {
					ideRevision: ide.revision,
					studioRevision: studio.revision,
					dirtyAtBuild: Boolean(ide.dirty || studio.dirty),
					runtimeManifestSha256: createHash("sha256")
						.update(manifest)
						.digest("hex"),
				},
				host: {
					platform: platform(),
					architecture: arch(),
					osRelease: release(),
					machineModel: machineModel(),
					logicalCpus: cpus().length,
					memoryBytes: totalmem(),
				},
				command: ["bun", "run", "smoke:desktop-runtime"],
				warmups: warmupResults,
				samples,
			},
			null,
			2,
		),
	);
}

if (import.meta.main) await main();
