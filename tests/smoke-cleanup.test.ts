import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
	assessLauncherShutdown,
	cleanupRuntimeLauncher,
	createSmokeDiagnostic,
	runWithSmokeCleanup,
	serializeDiagnosticError,
	verifyPortsReleased,
} from "../scripts/smoke-assembled-desktop-runtime";
import {
	createProcessObserver,
	type ProcessObserver,
	parseWindowsProcessSnapshot,
} from "../scripts/smoke-process-evidence";

const guardian =
	process.env.FORGEAX_RUNTIME_GUARDIAN_BIN?.trim() ||
	join(
		import.meta.dirname,
		"..",
		"src-tauri",
		"target",
		"debug",
		"runtime-guardian",
	);
const nativeGuardianAvailable =
	process.platform !== "win32" && existsSync(guardian);

async function freePort(): Promise<number> {
	return await new Promise((resolvePromise, rejectPromise) => {
		const server = createServer();
		server.once("error", rejectPromise);
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			const address = server.address();
			if (!address || typeof address === "string")
				return rejectPromise(new Error("failed to allocate test port"));
			server.close((error) =>
				error ? rejectPromise(error) : resolvePromise(address.port),
			);
		});
	});
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!existsSync(path) && Date.now() < deadline) await sleep(20);
	if (!existsSync(path)) throw new Error(`fixture did not write ${path}`);
}

type Fixture = {
	child: ChildProcessWithoutNullStreams;
	stateFile: string;
	port: number;
	directory: string;
	observer: ProcessObserver;
};

async function spawnFixture(
	mode: "ready" | "fail" | "timeout",
): Promise<Fixture> {
	const directory = mkdtempSync(join(tmpdir(), "desktop-smoke-cleanup-"));
	const stateFile = join(directory, "runtime-state.json");
	const target = join(directory, "target.cjs");
	const port = await freePort();
	writeFileSync(
		target,
		`
const fs = require('node:fs'), cp = require('node:child_process');
const stateFile = process.argv[2], port = Number(process.argv[3]), mode = process.argv[4];
const grandchild = cp.spawn(process.execPath, ['-e', "require('node:net').createServer().listen(+process.argv[1], '127.0.0.1'); setInterval(() => {}, 1000)", String(port)], { stdio: 'ignore' });
const state = (status, error) => fs.writeFileSync(stateFile, JSON.stringify({ status, error, servicePids: { fixture: process.pid, grandchild: grandchild.pid }, managedPorts: { fixture: port } }));
state(mode === 'fail' ? 'failed' : mode === 'ready' ? 'ready' : 'starting', mode === 'fail' ? 'fixture startup failure' : undefined);
const stop = () => { state('stopped'); try { grandchild.kill('SIGTERM'); } catch {} process.exit(0); };
process.stdin.on('data', stop);
if (mode === 'fail') setTimeout(() => process.exit(17), 150);
setInterval(() => {}, 1000);
`,
	);
	const child = spawn(
		guardian,
		[
			"--grace-ms",
			"150",
			"--",
			process.execPath,
			target,
			stateFile,
			String(port),
			mode,
		],
		{ stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" },
	);
	if (typeof child.pid !== "number" || !Number.isSafeInteger(child.pid))
		throw new Error("fixture guardian did not provide a PID");
	const observer = createProcessObserver(child);
	await waitForFile(stateFile);
	return { child, stateFile, port, directory, observer };
}

async function cleanupFixture(
	fixture: Fixture,
	expectedStartupFailure?: string,
) {
	const guardianPid = fixture.child.pid;
	if (typeof guardianPid !== "number" || !Number.isSafeInteger(guardianPid))
		throw new Error("fixture guardian lost its PID");
	try {
		return await cleanupRuntimeLauncher({
			child: fixture.child,
			stateFile: fixture.stateFile,
			pids: [guardianPid],
			processObserver: fixture.observer,
			ports: [fixture.port],
			deadlineMs: Date.now() + 5_000,
			expectedStartupFailure,
		});
	} finally {
		fixture.observer.stop();
	}
}

async function waitForExit(
	child: ChildProcessWithoutNullStreams,
	timeoutMs = 2_000,
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await Promise.race([
		new Promise<void>((resolve) => child.once("exit", () => resolve())),
		sleep(timeoutMs).then(() => {
			throw new Error("fixture did not exit before timeout");
		}),
	]);
}

async function waitForStatus(
	fixture: Fixture,
	status: string,
	timeoutMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = JSON.parse(readFileSync(fixture.stateFile, "utf8")) as {
			status?: string;
		};
		if (state.status === status) return;
		await sleep(20);
	}
	throw new Error(`fixture did not reach ${status}`);
}

async function runFixtureFailurePath(
	fixture: Fixture,
	mode: "ready" | "fail" | "timeout",
	diagnostic = createSmokeDiagnostic(),
): Promise<void> {
	const report = (name: string, detail?: unknown): void =>
		diagnostic.event(name, detail);
	return runWithSmokeCleanup({
		run: async () => {
			if (mode === "ready") return await waitForStatus(fixture, "ready");
			if (mode === "fail") {
				await waitForExit(fixture.child);
				throw new Error("fixture startup failure");
			}
			const deadline = Date.now() + 180;
			while (Date.now() < deadline) {
				const state = JSON.parse(readFileSync(fixture.stateFile, "utf8")) as {
					status?: string;
				};
				if (state.status !== "starting")
					throw new Error(
						`fixture unexpectedly left starting: ${state.status}`,
					);
				await sleep(20);
			}
			throw new Error("fixture readiness exceeded its deadline");
		},
		cleanup: async () => {
			const result = await cleanupFixture(
				fixture,
				mode === "fail" ? "fixture startup failure" : undefined,
			);
			report("cleanup-result", {
				errors: result.errors.map(serializeDiagnosticError),
			});
			return result.errors;
		},
		report,
	});
}

describe("desktop smoke cleanup evidence", () => {
	test("keeps phase, output, state, and cleanup evidence outside a disposable fixture", () => {
		const directory = mkdtempSync(
			join(tmpdir(), "desktop-smoke-evidence-test-"),
		);
		const diagnostic = createSmokeDiagnostic(directory);
		diagnostic.phase("launch-runtime");
		diagnostic.output("stderr", "raw launcher failure\n");
		diagnostic.state({ status: "failed", error: "fixture failure" });
		diagnostic.event("cleanup-result", { released: true });
		expect(existsSync(join(directory, "run.json"))).toBe(true);
		expect(readFileSync(join(directory, "stderr.log"), "utf8")).toContain(
			"raw launcher failure",
		);
		expect(
			JSON.parse(readFileSync(join(directory, "runtime-state.json"), "utf8")),
		).toMatchObject({ status: "failed" });
		rmSync(directory, { recursive: true, force: true });
	});

	test("uses a distinct directory for concurrent diagnostics", () => {
		const first = createSmokeDiagnostic(),
			second = createSmokeDiagnostic();
		try {
			expect(first.directory).not.toBe(second.directory);
		} finally {
			rmSync(first.directory, { recursive: true, force: true });
			rmSync(second.directory, { recursive: true, force: true });
		}
	});

	test("does not accept a cleanup failure merely because an earlier startup failed", () => {
		expect(
			assessLauncherShutdown({
				exited: true,
				forced: false,
				exitCode: 1,
				signalCode: null,
				terminalState: { status: "failed", error: "cleanup exploded" },
				expectedStartupFailure: "startup input missing",
			}).ok,
		).toBe(false);
	});

	for (const [mode, description] of [
		["ready", "normal shutdown", undefined],
		["fail", "mid-start failure", "fixture startup failure"],
		["timeout", "readiness timeout", undefined],
	] as const) {
		test.runIf(nativeGuardianAvailable)(
			`uses shared production failure orchestration after ${description}`,
			async () => {
				const fixture = await spawnFixture(mode);
				const diagnostic = createSmokeDiagnostic();
				try {
					if (mode === "ready")
						await expect(
							runFixtureFailurePath(fixture, mode, diagnostic),
						).resolves.toBeUndefined();
					else
						await expect(
							runFixtureFailurePath(fixture, mode, diagnostic),
						).rejects.toThrow(
							mode === "fail"
								? "fixture startup failure"
								: "fixture readiness exceeded its deadline",
						);
					if (mode === "fail") expect(fixture.child.exitCode).toBe(17);
					const events = readFileSync(
						join(diagnostic.directory, "events.ndjson"),
						"utf8",
					);
					if (mode !== "ready")
						expect(events).toContain(
							mode === "timeout"
								? "fixture readiness exceeded its deadline"
								: "fixture startup failure",
						);
					expect(events).toContain("cleanup-result");
					expect(await verifyPortsReleased([fixture.port])).toEqual([]);
				} finally {
					rmSync(fixture.directory, { recursive: true, force: true });
					rmSync(diagnostic.directory, { recursive: true, force: true });
				}
			},
		);
	}

	test.runIf(nativeGuardianAvailable)(
		"a diagnostic write failure does not prevent production cleanup",
		async () => {
			const diagnosticDirectory = mkdtempSync(
				join(tmpdir(), "desktop-smoke-broken-diagnostic-"),
			);
			const diagnostic = createSmokeDiagnostic(diagnosticDirectory);
			const fixture = await spawnFixture("ready");
			try {
				rmSync(diagnosticDirectory, { recursive: true, force: true });
				let failure: unknown;
				let cleanupRan = false;
				try {
					await runWithSmokeCleanup({
						run: async () => {
							throw new Error("primary readiness failure");
						},
						cleanup: async () => {
							cleanupRan = true;
							const result = await cleanupFixture(fixture);
							return result.errors;
						},
						// The directory is already gone: this is the actual reporting path,
						// not a hand-injected cleanup error.
						report: diagnostic.event,
					});
				} catch (error) {
					failure = error;
				}
				expect(cleanupRan).toBe(true);
				expect(failure).toBeInstanceOf(AggregateError);
				const detail = serializeDiagnosticError(failure) as {
					name: string;
					message: string;
					errors: Array<{ name: string; message: string }>;
				};
				expect(detail.name).toBe("AggregateError");
				expect(detail.message).toBe(
					"assembled desktop smoke and cleanup failed",
				);
				expect(detail.errors[0]).toMatchObject({
					message: "primary readiness failure",
				});
				expect(
					detail.errors.slice(1).every((error) => error.name === "Error"),
				).toBe(true);
				expect(await verifyPortsReleased([fixture.port])).toEqual([]);
			} finally {
				rmSync(fixture.directory, { recursive: true, force: true });
			}
		},
	);

	test("returns a cleanup-finished diagnostic write failure without replacing successful cleanup", async () => {
		let cleanupRan = false;
		let failure: unknown;
		try {
			await runWithSmokeCleanup({
				run: async () => undefined,
				cleanup: async () => {
					cleanupRan = true;
					return [];
				},
				report: (name) => {
					if (name === "cleanup-finished")
						throw new Error("cleanup evidence write failed");
				},
			});
		} catch (error) {
			failure = error;
		}
		expect(cleanupRan).toBe(true);
		expect(serializeDiagnosticError(failure)).toMatchObject({
			name: "AggregateError",
			message: "assembled desktop smoke cleanup failed",
			errors: [{ message: "cleanup evidence write failed" }],
		});
	});

	test("preserves an undefined rejection after cleanup", async () => {
		let cleanupRan = false;
		let rejected = false;
		try {
			await runWithSmokeCleanup({
				run: async () => {
					throw undefined;
				},
				cleanup: async () => {
					cleanupRan = true;
					return [];
				},
			});
		} catch (error) {
			rejected = true;
			expect(error).toBeUndefined();
		}
		expect(rejected).toBe(true);
		expect(cleanupRan).toBe(true);
	});

	test("actual unavailable executable records its spawn failure and returns without a phantom shutdown wait", async () => {
		const directory = mkdtempSync(join(tmpdir(), "desktop-smoke-spawn-error-"));
		const diagnostic = createSmokeDiagnostic(directory);
		const unavailable = join(directory, "not-an-executable");
		const child = spawn(unavailable, [], { stdio: ["pipe", "pipe", "pipe"] });
		let spawnError: Error | undefined;
		child.once("error", (error) => {
			spawnError = error;
		});
		const started = Date.now();
		try {
			await expect(
				runWithSmokeCleanup({
					run: async () => {
						while (!spawnError) await sleep(5);
						throw new Error(`fixture could not spawn: ${spawnError.message}`, {
							cause: spawnError,
						});
					},
					cleanup: async () => [],
					report: (name, detail) => diagnostic.event(name, detail),
				}),
			).rejects.toThrow("fixture could not spawn");
			expect(Date.now() - started).toBeLessThan(500);
			expect(readFileSync(join(directory, "events.ndjson"), "utf8")).toContain(
				"fixture could not spawn",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("parses Windows CIM single and array snapshots, and rejects invalid JSON", () => {
		expect(
			parseWindowsProcessSnapshot(
				'{"ProcessId":12,"ParentProcessId":1,"CreationDate":"20260914000100.000000+000"}',
			),
		).toEqual([
			{ pid: 12, parentPid: 1, startedAt: "20260914000100.000000+000" },
		]);
		expect(() => parseWindowsProcessSnapshot("{bad")).toThrow(
			"could not parse Windows process snapshot",
		);
		expect(() =>
			parseWindowsProcessSnapshot(
				'[{"ProcessId":13,"ParentProcessId":12,"CreationDate":"created"},{"ProcessId":"bad"}]',
			),
		).toThrow("invalid row");
		expect(() => parseWindowsProcessSnapshot("[]")).toThrow("empty");
	});

	test("serializes nested cleanup errors for a diagnostic event", () => {
		const detail = serializeDiagnosticError(
			new AggregateError(
				[
					new Error("port still bound"),
					new Error("process still alive", {
						cause: new Error("query failed"),
					}),
				],
				"cleanup failed",
			),
		) as any;
		expect(detail).toMatchObject({
			name: "AggregateError",
			message: "cleanup failed",
			errors: [
				{ message: "port still bound" },
				{ message: "process still alive", cause: { message: "query failed" } },
			],
		});
	});
});
