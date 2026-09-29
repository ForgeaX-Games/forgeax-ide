import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
	assessDesktopTeardown,
	DESKTOP_TASKKILL_TIMEOUT_MS,
	desktopProcessTreePlan,
	desktopSpawnOptions,
	executeDesktopProcessTreePlan,
} from "../scripts/desktop-process-tree";
import { posixProcessGroupExists } from "./helpers/posix-process-group";

describe("desktop process tree contract", () => {
	test("uses negative POSIX process-group PIDs for graceful and forced signals", () => {
		expect(desktopProcessTreePlan("posix", [101, 202], "SIGTERM")).toEqual([
			{ kind: "signal", pid: -101, signal: "SIGTERM", target: "group" },
			{ kind: "signal", pid: -202, signal: "SIGTERM", target: "group" },
		]);
		expect(desktopProcessTreePlan("posix", [101], "SIGKILL")).toEqual([
			{ kind: "signal", pid: -101, signal: "SIGKILL", target: "group" },
		]);
	});

	test("uses exact Windows taskkill tree arguments only for forced stop", () => {
		expect(desktopProcessTreePlan("win32", [303], "SIGTERM")).toEqual([
			{ kind: "signal", pid: 303, signal: "SIGTERM", target: "process" },
		]);
		expect(desktopProcessTreePlan("win32", [303, 404], "SIGKILL")).toEqual([
			{
				kind: "taskkill",
				pid: 303,
				command: "taskkill",
				args: ["/PID", "303", "/T", "/F"],
			},
			{
				kind: "taskkill",
				pid: 404,
				command: "taskkill",
				args: ["/PID", "404", "/T", "/F"],
			},
		]);
	});

	test("collects taskkill and signal failures rather than converting them to success", async () => {
		const actions = desktopProcessTreePlan("win32", [505, 606], "SIGKILL");
		const calls: string[][] = [];
		const failures = await executeDesktopProcessTreePlan(actions, {
			signal: () => {},
			taskkill: (args) => {
				calls.push([...args]);
				return {
					result: Promise.resolve({
						exitCode: args[1] === "505" ? 1 : 0,
						stderr: "access denied",
					}),
					terminate: () => {},
				};
			},
		});
		expect(calls).toEqual([
			["/PID", "505", "/T", "/F"],
			["/PID", "606", "/T", "/F"],
		]);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.error).toContain("access denied");
	});

	test("treats ESRCH as success only after confirming the POSIX group is gone", async () => {
		const action = desktopProcessTreePlan("posix", [707], "SIGTERM")[0]!;
		const goneCalls: number[] = [];
		const gone = await executeDesktopProcessTreePlan([action], {
			signal: () => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			},
			groupExists: (pid) => {
				goneCalls.push(pid);
				return false;
			},
			taskkill: () => ({
				result: Promise.resolve({ exitCode: 0 }),
				terminate: () => {},
			}),
		});
		expect(gone).toEqual([]);
		expect(goneCalls).toEqual([707]);

		const live = await executeDesktopProcessTreePlan([action], {
			signal: () => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			},
			groupExists: () => true,
			taskkill: () => ({
				result: Promise.resolve({ exitCode: 0 }),
				terminate: () => {},
			}),
		});
		expect(live).toHaveLength(1);
		expect(live[0]?.error).toContain("process group still exists");

		const recheckFailed = await executeDesktopProcessTreePlan([action], {
			signal: () => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			},
			groupExists: () => {
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			},
			taskkill: () => ({
				result: Promise.resolve({ exitCode: 0 }),
				terminate: () => {},
			}),
		});
		expect(recheckFailed).toHaveLength(1);
		expect(recheckFailed[0]?.error).toContain("process group recheck failed");
	});

	test("rechecks a POSIX group after a successful signal without treating leader exit as closure", async () => {
		const action = desktopProcessTreePlan("posix", [717], "SIGTERM")[0]!;
		const checked: number[] = [];
		const failures = await executeDesktopProcessTreePlan([action], {
			signal: () => {},
			groupExists: (pid) => {
				checked.push(pid);
				return true;
			},
			taskkill: () => ({
				result: Promise.resolve({ exitCode: 0 }),
				terminate: () => {},
			}),
		});
		expect(failures).toEqual([]);
		expect(checked).toEqual([717]);
	});

	test.skipIf(process.platform === "win32")(
		"forces the original POSIX group after its leader exits",
		async () => {
			const fixture = spawn(
				"bun",
				[
					"run",
					join(import.meta.dirname, "fixtures/desktop-posix-process-group.ts"),
				],
				{
					...desktopSpawnOptions(process.platform),
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const fixtureExited = once(fixture, "exit").then(
				([code]) => code as number | null,
			);
			const groupLeaderPid = fixture.pid!;
			let grandchildPid: number | undefined;
			let failure: unknown;
			try {
				const message = JSON.parse(
					await readProtocolLine(
						Readable.toWeb(fixture.stdout!) as ReadableStream<Uint8Array>,
						5_000,
					),
				) as {
					code?: unknown;
					leaderPid?: unknown;
					grandchildPid?: unknown;
				};
				expect(message.code).toBe("desktop-posix-process-group-pids");
				expect(message.leaderPid).toBe(groupLeaderPid);
				grandchildPid = requireFixturePid(message.grandchildPid, "grandchild");
				expect(grandchildPid).not.toBe(groupLeaderPid);
				expect(posixProcessGroupExists(groupLeaderPid)).toBe(true);

				const executor = {
					signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
						process.kill(pid, signal);
					},
					groupExists: posixProcessGroupExists,
					taskkill: () => ({
						result: Promise.resolve({ exitCode: 0 }),
						terminate: () => {},
					}),
				};
				const gracefulFailures = await executeDesktopProcessTreePlan(
					desktopProcessTreePlan("posix", [groupLeaderPid], "SIGTERM"),
					executor,
				);
				expect(gracefulFailures).toEqual([]);
				await fixtureExited;
				expect(fixture.exitCode).toBe(0);
				expect(posixProcessGroupExists(groupLeaderPid)).toBe(true);

				const signals: Array<{ pid: number; signal: string }> = [];
				const forcedFailures = await executeDesktopProcessTreePlan(
					desktopProcessTreePlan("posix", [groupLeaderPid], "SIGKILL"),
					{
						...executor,
						signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
							signals.push({ pid, signal });
							process.kill(pid, signal);
						},
					},
				);
				// macOS can report EPERM while an orphaned group is being reaped even
				// though the group kill has taken effect; closure below remains the
				// authoritative assertion.
				expect(
					forcedFailures.every((item) => item.error.includes("EPERM")),
				).toBe(true);
				expect(signals).toEqual([{ pid: -groupLeaderPid, signal: "SIGKILL" }]);
				await waitForProcessGroupGone(groupLeaderPid, 5_000);
				expect(posixProcessGroupExists(groupLeaderPid)).toBe(false);
			} catch (error) {
				failure = error;
			} finally {
				try {
					if (posixProcessGroupExists(groupLeaderPid))
						process.kill(-groupLeaderPid, "SIGKILL");
				} catch (error) {
					if (isPermissionError(error)) {
						try {
							process.kill(-groupLeaderPid, "SIGKILL");
						} catch (retryError) {
							if (
								!isProcessNotFound(retryError) &&
								!isPermissionError(retryError)
							) {
								failure =
									failure === undefined
										? retryError
										: new AggregateError([failure, retryError]);
							}
						}
					} else if (!isProcessNotFound(error)) {
						failure =
							failure === undefined
								? error
								: new AggregateError([failure, error]);
					}
				}
				try {
					await fixtureExited;
				} catch (error) {
					failure =
						failure === undefined
							? error
							: new AggregateError([failure, error]);
				}
				if (grandchildPid !== undefined) {
					try {
						await waitForProcessGone(grandchildPid, 5_000);
					} catch (error) {
						failure =
							failure === undefined
								? error
								: new AggregateError([failure, error]);
					}
				}
			}
			if (failure !== undefined) throw failure;
		},
	);

	test("bounds a never-settling taskkill and terminates its helper", async () => {
		let terminateCalls = 0;
		const failures = await executeDesktopProcessTreePlan(
			[desktopProcessTreePlan("win32", [808], "SIGKILL")[0]!],
			{
				signal: () => {},
				taskkill: () => ({
					result: new Promise<{ exitCode: number | null }>(() => {}),
					terminate: () => {
						terminateCalls += 1;
					},
				}),
			},
			{ taskkillTimeoutMs: 5 },
		);
		expect(terminateCalls).toBe(1);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.error).toContain("timed out after 5ms");
	});

	test("consumes a taskkill rejection that arrives after the timeout", async () => {
		let rejectResult!: (reason: unknown) => void;
		const result = new Promise<{ exitCode: number | null }>((_, reject) => {
			rejectResult = reject;
		});
		const failures = await executeDesktopProcessTreePlan(
			[desktopProcessTreePlan("win32", [818], "SIGKILL")[0]!],
			{
				signal: () => {},
				taskkill: () => ({ result, terminate: () => {} }),
			},
			{ taskkillTimeoutMs: 5 },
		);
		rejectResult(new Error("late taskkill failure"));
		await sleep(0);
		expect(failures[0]?.error).toContain("timed out after 5ms");
	});

	test("aggregates taskkill timeout and helper termination failures", async () => {
		const failures = await executeDesktopProcessTreePlan(
			[desktopProcessTreePlan("win32", [909], "SIGKILL")[0]!],
			{
				signal: () => {},
				taskkill: () => ({
					result: new Promise<{ exitCode: number | null }>(() => {}),
					terminate: () => {
						throw new Error("helper is unkillable");
					},
				}),
			},
			{ taskkillTimeoutMs: 5 },
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.error).toContain("timed out after 5ms");
		expect(failures[0]?.error).toContain(
			"failed to terminate taskkill helper: helper is unkillable",
		);
	});

	test("continues later taskkill actions after one timeout", async () => {
		const calls: string[] = [];
		const actions = desktopProcessTreePlan("win32", [1_010, 1_011], "SIGKILL");
		const failures = await executeDesktopProcessTreePlan(
			actions,
			{
				signal: () => {},
				taskkill: (args) => {
					calls.push(args[1]!);
					if (args[1] === "1010")
						return {
							result: new Promise<{ exitCode: number | null }>(() => {}),
							terminate: () => {},
						};
					return {
						result: Promise.resolve({ exitCode: 0 }),
						terminate: () => {},
					};
				},
			},
			{ taskkillTimeoutMs: 5 },
		);
		expect(calls).toEqual(["1010", "1011"]);
		expect(failures).toHaveLength(1);
	});

	test("keeps ordinary taskkill throws as failures", async () => {
		const action = desktopProcessTreePlan("win32", [1_012], "SIGKILL")[0]!;
		const failures = await executeDesktopProcessTreePlan([action], {
			signal: () => {},
			taskkill: () => {
				throw new Error("taskkill spawn failed");
			},
		});
		expect(failures).toHaveLength(1);
		expect(failures[0]?.error).toContain("taskkill spawn failed");
	});

	test("keeps the taskkill deadline inside the Rust launcher shutdown budget", () => {
		const forcedActions = desktopProcessTreePlan("win32", [1, 2], "SIGKILL");
		const teardownBudgetMs =
			forcedActions.length * DESKTOP_TASKKILL_TIMEOUT_MS + 3_000 + 3_000;
		expect(teardownBudgetMs).toBeLessThan(15_000);
	});

	test("selects detached process groups on POSIX and hidden non-detached children on Windows", () => {
		expect(desktopSpawnOptions("darwin")).toEqual({ detached: true });
		expect(desktopSpawnOptions("linux")).toEqual({ detached: true });
		expect(desktopSpawnOptions("win32")).toEqual({
			detached: false,
			windowsHide: true,
		});
	});

	test("forced teardown is failed and live children prevent PID runtime cleanup", () => {
		expect(
			assessDesktopTeardown({
				forced: true,
				childrenLive: false,
				failures: [],
				exitCode: 0,
			}),
		).toMatchObject({
			status: "failed",
			exitCode: 1,
			cleanupRuntimeDirectory: true,
		});
		expect(
			assessDesktopTeardown({
				forced: false,
				childrenLive: true,
				failures: [],
				exitCode: 0,
			}),
		).toMatchObject({
			status: "failed",
			exitCode: 1,
			cleanupRuntimeDirectory: false,
		});
		expect(
			assessDesktopTeardown({
				forced: false,
				childrenLive: false,
				groupsLive: true,
				failures: [],
				exitCode: 0,
			}),
		).toMatchObject({
			status: "failed",
			exitCode: 1,
			cleanupRuntimeDirectory: false,
		});
	});
});

const FIXTURE_PID_MIN = 100;

async function readProtocolLine(
	stream: ReadableStream<Uint8Array>,
	timeoutMs: number,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const readLine = async (): Promise<string> => {
		while (true) {
			const result = await reader.read();
			if (result.done)
				throw new Error("POSIX fixture exited before sending PID protocol");
			buffered += decoder.decode(result.value, { stream: true });
			const newline = buffered.indexOf("\n");
			if (newline >= 0) return buffered.slice(0, newline);
		}
	};
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(new Error("timed out waiting for POSIX fixture PID protocol")),
				timeoutMs,
			);
		});
		return await Promise.race([readLine(), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		await reader.cancel();
		reader.releaseLock();
	}
}

function requireFixturePid(value: unknown, name: string): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < FIXTURE_PID_MIN
	) {
		throw new Error(
			`fixture ${name} PID is invalid or too short: ${String(value)}`,
		);
	}
	return value;
}

function isProcessNotFound(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		(error as { code?: unknown }).code === "ESRCH"
	);
}

async function waitForProcessGroupGone(
	pid: number,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (!posixProcessGroupExists(pid)) return;
		} catch (error) {
			if (!isPermissionError(error)) throw error;
		}
		await sleep(50);
	}
	throw new Error(`POSIX process group ${pid} survived shutdown timeout`);
}

function isPermissionError(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		(error as { code?: unknown }).code === "EPERM"
	);
}

async function waitForProcessGone(
	pid: number,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (isProcessNotFound(error)) return;
			throw error;
		}
		await sleep(50);
	}
	throw new Error(`POSIX fixture descendant ${pid} survived shutdown timeout`);
}
