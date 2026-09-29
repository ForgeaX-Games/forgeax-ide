import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
	WindowsJobAdapter,
	WindowsJobOwner,
	WindowsJobQueryAdapter,
} from "../scripts/desktop-windows-job";
import {
	createNativeWindowsJobEvidence,
	initializeNativeWindowsJobEvidence,
} from "../scripts/native-windows-job-evidence";
import type { ProcessSnapshot } from "../scripts/smoke-process-evidence";

function evidenceAdapter(
	source: readonly number[] | (() => readonly number[]),
	failure?: number,
): WindowsJobAdapter & WindowsJobQueryAdapter {
	return {
		library: {},
		createJobObject: () => 1n,
		setInformationJobObject: () => true,
		getCurrentProcess: () => 2n,
		assignProcessToJobObject: () => true,
		closeHandle: () => true,
		closeLibrary: () => {},
		getLastError: () => failure ?? 0,
		queryInformationJobObject: (_handle, _class, bytes) => {
			if (failure !== undefined) return false;
			const pids = typeof source === "function" ? source() : source;
			const view = new DataView(bytes.buffer);
			view.setUint32(0, pids.length, true);
			view.setUint32(4, pids.length, true);
			for (const [index, pid] of pids.entries())
				view.setBigUint64(8 + index * 8, BigInt(pid), true);
			return true;
		},
	};
}

function owner(): WindowsJobOwner {
	return { library: {}, handle: 77n };
}
function rows(...entries: Array<[number, string]>): ProcessSnapshot[] {
	return entries.map(([pid, startedAt]) => ({ pid, startedAt, parentPid: 0 }));
}

describe("native Windows Job evidence", () => {
	test("captures a baseline with creation identities and accepts exactly those members", () => {
		const value = createNativeWindowsJobEvidence(
			evidenceAdapter([10, 20]),
			owner(),
			() => rows([10, "driver"], [20, "runner"]),
		);
		const baseline = value.snapshot();
		expect(baseline).toEqual([
			{ pid: 10, startedAt: "driver" },
			{ pid: 20, startedAt: "runner" },
		]);
		expect(() => value.assertCleaned(baseline)).not.toThrow();
	});

	test("fails if a non-baseline descendant remains in the outer Job", () => {
		let current = [10, 20];
		const value = createNativeWindowsJobEvidence(
			evidenceAdapter(() => current),
			owner(),
			() =>
				rows(
					...current.map((pid) => [pid, `created-${pid}`] as [number, string]),
				),
		);
		const baseline = value.snapshot();
		current = [10, 20, 30];
		expect(() => value.assertCleaned(baseline)).toThrow("30@created-30");
	});

	test("treats PID reuse as a new residual identity", () => {
		let created = "before";
		const value = createNativeWindowsJobEvidence(
			evidenceAdapter([10]),
			owner(),
			() => rows([10, created]),
		);
		const baseline = value.snapshot();
		created = "after";
		expect(() => value.assertCleaned(baseline)).toThrow("10@after");
	});

	test("fails closed when a queried PID is missing its CIM creation identity", () => {
		const value = createNativeWindowsJobEvidence(
			evidenceAdapter([10]),
			owner(),
			() => [],
		);
		expect(() => value.snapshot()).toThrow(
			"no unambiguous CIM creation identity",
		);
	});

	test("fails closed on an empty outer Job result", () => {
		const value = createNativeWindowsJobEvidence(
			evidenceAdapter([]),
			owner(),
			() => [],
		);
		expect(() => value.snapshot()).toThrow("contains no active members");
	});

	test("propagates a Job query failure instead of claiming cleanup", () => {
		const value = createNativeWindowsJobEvidence(
			evidenceAdapter([], 5),
			owner(),
			() => rows([10, "unused"]),
		);
		expect(() => value.snapshot()).toThrow("GetLastError=5");
	});

	test("does not load bun:ffi outside Windows", async () => {
		await expect(
			initializeNativeWindowsJobEvidence("darwin"),
		).resolves.toBeUndefined();
	});

	test.skipIf(process.platform !== "win32")(
		"contains a grandchild after its short-lived parent exits when spawned after Job initialization",
		() => {
			const evidence = JSON.parse(
				execFileSync(
					"bun",
					[
						join(
							import.meta.dirname,
							"fixtures/native-windows-job-evidence.ts",
						),
					],
					{ encoding: "utf8", timeout: 20_000 },
				),
			);
			expect(Number.isSafeInteger(evidence.grandchildPid)).toBe(true);
			expect(evidence.observed).toBe(true);
			expect(evidence.dirtyError).toContain("non-baseline member");
			expect(evidence.remaining).toBe(false);
		},
	);
});
