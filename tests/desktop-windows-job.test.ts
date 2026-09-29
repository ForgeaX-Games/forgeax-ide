import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
	createWindowsJobOwner,
	ERROR_MORE_DATA,
	encodeJobObjectExtendedLimitInformation,
	initializeWindowsJobObject,
	JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS,
	JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
	JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_LIMIT_FLAGS_OFFSET,
	JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
	JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
	queryWindowsJobProcessIds,
	type WindowsJobAdapter,
} from "../scripts/desktop-windows-job";

type AdapterOptions = Partial<WindowsJobAdapter>;

function adapter(
	overrides: AdapterOptions = {},
): WindowsJobAdapter & { calls: string[]; closedHandles: bigint[] } {
	const calls: string[] = [];
	const closedHandles: bigint[] = [];
	return {
		library: { name: "test-library" },
		createJobObject: () => {
			calls.push("create");
			return 11n;
		},
		setInformationJobObject: (_handle, informationClass, information) => {
			calls.push(`set:${informationClass}:${information.byteLength}`);
			return true;
		},
		getCurrentProcess: () => {
			calls.push("current");
			return 22n;
		},
		assignProcessToJobObject: () => {
			calls.push("assign");
			return true;
		},
		closeHandle: (handle) => {
			calls.push("close-handle");
			closedHandles.push(handle);
			return true;
		},
		getLastError: () => 1234,
		closeLibrary: () => {
			calls.push("close-library");
		},
		...overrides,
		calls,
		closedHandles,
	};
}

describe("Windows launcher Job Object contract", () => {
	test("encodes the x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION layout exactly", () => {
		const information = encodeJobObjectExtendedLimitInformation();
		expect(information).toHaveLength(144);
		expect(information.byteLength).toBe(
			JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
		);
		expect(
			new DataView(information.buffer).getUint32(
				JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_LIMIT_FLAGS_OFFSET,
				true,
			),
		).toBe(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
		expect(
			information.slice(
				0,
				JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_LIMIT_FLAGS_OFFSET,
			),
		).toEqual(new Uint8Array(16));
	});

	test("calls Create, Set, current-process, and Assign in kernel order and retains the owner", () => {
		const value = adapter();
		const owner = createWindowsJobOwner(value);
		expect(value.calls).toEqual([
			"create",
			`set:${JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS}:144`,
			"current",
			"assign",
		]);
		expect(owner).toEqual({ library: value.library, handle: 11n });
		expect(value.closedHandles).toEqual([]);
		expect(value.calls).not.toContain("close-library");
	});

	test.each([
		["CreateJobObjectW", adapter({ createJobObject: () => 0n })],
		[
			"SetInformationJobObject",
			adapter({ setInformationJobObject: () => false }),
		],
		["GetCurrentProcess", adapter({ getCurrentProcess: () => 0n })],
		[
			"AssignProcessToJobObject",
			adapter({ assignProcessToJobObject: () => false }),
		],
	] as const)(
		"fails closed when %s fails and closes a partial job",
		(name, value) => {
			expect(() => createWindowsJobOwner(value)).toThrow(name);
			if (name === "CreateJobObjectW") expect(value.closedHandles).toEqual([]);
			else expect(value.closedHandles).toEqual([11n]);
			expect(value.calls).toContain("close-library");
		},
	);

	test("surfaces CloseHandle failure instead of hiding partial cleanup failure", () => {
		const value = adapter({
			setInformationJobObject: () => false,
			closeHandle: () => false,
		});
		expect(() => createWindowsJobOwner(value)).toThrow("CloseHandle failed");
		expect(value.calls).toContain("close-library");
	});

	test("is a no-op off Windows and can be called repeatedly", async () => {
		await initializeWindowsJobObject("darwin");
		await initializeWindowsJobObject("linux");
	});

	test("retries an undersized Job process list and decodes x64 PIDs", () => {
		const calls: number[] = [];
		let call = 0;
		const result = queryWindowsJobProcessIds(
			{
				queryInformationJobObject: (_handle, informationClass, information) => {
					calls.push(informationClass);
					const view = new DataView(information.buffer);
					if (call++ === 0) {
						view.setUint32(0, 20, true);
						view.setUint32(4, 16, true);
						return true;
					}
					view.setUint32(0, 2, true);
					view.setUint32(4, 2, true);
					view.setBigUint64(8, 101n, true);
					view.setBigUint64(16, 202n, true);
					return true;
				},
				getLastError: () => ERROR_MORE_DATA,
			},
			11n,
		);
		expect(result).toEqual([101, 202]);
		expect(calls).toEqual([
			JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS,
			JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS,
		]);
	});

	test("retries ERROR_MORE_DATA instead of accepting an incomplete native query", () => {
		let call = 0;
		expect(
			queryWindowsJobProcessIds(
				{
					queryInformationJobObject: (_handle, _class, bytes) => {
						const view = new DataView(bytes.buffer);
						if (call++ === 0) {
							view.setUint32(0, 17, true);
							view.setUint32(4, 16, true);
							return false;
						}
						view.setUint32(0, 1, true);
						view.setUint32(4, 1, true);
						view.setBigUint64(8, 404n, true);
						return true;
					},
					getLastError: () => ERROR_MORE_DATA,
				},
				11n,
			),
		).toEqual([404]);
	});

	test.each([
		[
			"native failure",
			{
				queryInformationJobObject: (): boolean => false,
				getLastError: (): number => 5,
			},
			"GetLastError=5",
		],
		[
			"invalid header",
			{
				queryInformationJobObject: (
					_h: bigint,
					_c: number,
					bytes: Uint8Array,
				): boolean => {
					const view = new DataView(bytes.buffer);
					view.setUint32(0, 1, true);
					view.setUint32(4, 2, true);
					return true;
				},
				getLastError: (): number => 0,
			},
			"invalid process list",
		],
		[
			"invalid PID",
			{
				queryInformationJobObject: (
					_h: bigint,
					_c: number,
					bytes: Uint8Array,
				): boolean => {
					const view = new DataView(bytes.buffer);
					view.setUint32(0, 1, true);
					view.setUint32(4, 1, true);
					view.setBigUint64(8, 0n, true);
					return true;
				},
				getLastError: (): number => 0,
			},
			"invalid process ID",
		],
	] as const)("fails closed on Job member %s", (_name, value, message) => {
		expect(() => queryWindowsJobProcessIds(value, 11n)).toThrow(message);
	});

	test("initializes containment before reserving ports or spawning services", () => {
		const runtime = readFileSync(
			join(import.meta.dirname, "../scripts/desktop-runtime.ts"),
			"utf8",
		);
		const initialize = runtime.indexOf("await initializeWindowsJobObject()");
		expect(initialize).toBeGreaterThanOrEqual(0);
		expect(initialize).toBeLessThan(
			runtime.indexOf("const ports = await reserveDesktopPorts()"),
		);
		expect(initialize).toBeLessThan(runtime.search(/spawn\(\s*["']server["']/));
		expect(initialize).toBeLessThan(runtime.search(/spawn\(\s*["']engine["']/));
	});

	test.skipIf(process.platform !== "win32")(
		"contains child and grandchild when the launcher is killed",
		async () => {
			const fixture = spawn(
				"bun",
				[
					"run",
					`${import.meta.dirname}/fixtures/desktop-windows-job-launcher.ts`,
				],
				{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
			);
			const fixtureExited = once(fixture, "exit").then(
				([code]) => code as number | null,
			);
			const stderrPromise = collectOutput(
				Readable.toWeb(fixture.stderr!) as ReadableStream<Uint8Array>,
			);
			let childPid: number | undefined;
			let grandchildPid: number | undefined;
			let failure: unknown;
			try {
				let line: string;
				try {
					line = await readProtocolLine(
						Readable.toWeb(fixture.stdout!) as ReadableStream<Uint8Array>,
						5_000,
					);
				} catch (error) {
					if (fixture.exitCode === null && fixture.signalCode === null) {
						fixture.kill("SIGKILL");
						await fixtureExited;
					}
					const stderr = await stderrPromise;
					throw new Error(
						`${error instanceof Error ? error.message : String(error)}; launcher stderr: ${stderr.trim() || "(empty)"}`,
						{ cause: error },
					);
				}
				const message = JSON.parse(line) as {
					code?: unknown;
					childPid?: unknown;
					grandchildPid?: unknown;
				};
				expect(message.code).toBe("desktop-windows-job-pids");
				childPid = requireFixturePid(message.childPid, "child");
				grandchildPid = requireFixturePid(message.grandchildPid, "grandchild");
				expect(childPid).not.toBe(grandchildPid);
				expectProcessAlive(childPid, "child");
				expectProcessAlive(grandchildPid, "grandchild");

				fixture.kill("SIGKILL");
				await fixtureExited;
				expect(fixture.signalCode ?? fixture.exitCode).toBeTruthy();
				await waitForProcessGone(childPid, "child", 5_000);
				await waitForProcessGone(grandchildPid, "grandchild", 5_000);
			} catch (error) {
				failure = error;
			} finally {
				const cleanupErrors: unknown[] = [];
				if (fixture.exitCode === null && fixture.signalCode === null) {
					try {
						fixture.kill("SIGKILL");
						await fixtureExited;
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
				for (const [pid, name] of [
					[childPid, "child"],
					[grandchildPid, "grandchild"],
				] as const) {
					if (pid === undefined) continue;
					try {
						await killAndWaitForProcessGone(pid, name, 5_000);
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
				try {
					await stderrPromise;
				} catch (error) {
					cleanupErrors.push(error);
				}
				if (cleanupErrors.length > 0) {
					failure =
						failure === undefined
							? new AggregateError(
									cleanupErrors,
									"Windows Job fixture cleanup failed",
								)
							: new AggregateError(
									[failure, ...cleanupErrors],
									"Windows Job fixture assertion and cleanup failed",
								);
				}
			}
			if (failure !== undefined) throw failure;
		},
	);
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
				throw new Error("launcher exited before sending PID protocol");
			buffered += decoder.decode(result.value, { stream: true });
			const newline = buffered.indexOf("\n");
			if (newline >= 0) return buffered.slice(0, newline);
		}
	};
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("timed out waiting for launcher PID protocol")),
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

async function collectOutput(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) return output;
			output += decoder.decode(result.value, { stream: true });
		}
	} finally {
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
	if (error === null || typeof error !== "object") return false;
	const value = error as { code?: unknown; message?: unknown };
	return (
		value.code === "ESRCH" ||
		(typeof value.message === "string" &&
			/no such process|process .*not found|does not exist/i.test(value.message))
	);
}

function expectProcessAlive(pid: number, name: string): void {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (isProcessNotFound(error))
			throw new Error(`${name} ${pid} exited before launcher termination`);
		throw new Error(
			`could not probe ${name} ${pid}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

async function waitForProcessGone(
	pid: number,
	name: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (isProcessNotFound(error)) return;
			throw new Error(
				`could not probe ${name} ${pid} after launcher termination: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		await sleep(100);
	}
	throw new Error(`${name} ${pid} survived launcher termination timeout`);
}

async function killAndWaitForProcessGone(
	pid: number,
	name: string,
	timeoutMs: number,
): Promise<void> {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (!isProcessNotFound(error))
			throw new Error(
				`could not clean up ${name} ${pid}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
	}
	await waitForProcessGone(pid, name, timeoutMs);
}
