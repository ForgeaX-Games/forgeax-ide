import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
	createProcessObserver,
	type ProcessSnapshot,
	parsePosixProcessSnapshot,
	parseWindowsProcessSnapshot,
} from "../scripts/smoke-process-evidence";

const fixtures: ChildProcess[] = [];

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline)
			throw new Error("fixture did not reach expected state");
		await sleep(20);
	}
}

async function terminateFixture(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (child.pid && process.platform !== "win32") {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			/* process group has already gone */
		}
	} else if (child.pid) {
		try {
			child.kill("SIGKILL");
		} catch {
			/* fixture already exited */
		}
	}
	await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function killStillObservedPrivateGroups(
	observer: ReturnType<typeof createProcessObserver>,
): void {
	const first = observer.snapshot();
	const second = observer.snapshot();
	for (const group of first.groups) {
		// Do not signal a bare, previously-reaped PGID. Require a member with the
		// same creation identity in two immediate evidence snapshots.
		const stable = first.liveMembers.some(
			(a) =>
				a.processGroupId === group &&
				second.liveMembers.some(
					(b) => b.pid === a.pid && b.startedAt === a.startedAt,
				),
		);
		if (stable)
			try {
				process.kill(-group, "SIGKILL");
			} catch {
				/* exited between evidence and signal */
			}
	}
}

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map(terminateFixture));
});

describe("smoke process ownership evidence", () => {
	test("polls until observed processes exit under the Node runtime", async () => {
		let captures = 0;
		const observer = createProcessObserver(
			{ pid: 501 },
			{
				pollIntervalMs: 0,
				snapshotter: () =>
					++captures <= 2
						? [
								{
									pid: 501,
									parentPid: 1,
									processGroupId: 501,
									startedAt: "owned-root",
								},
							]
						: [
								{
									pid: 999,
									parentPid: 1,
									processGroupId: 999,
									startedAt: "unrelated",
								},
							],
			},
		);
		try {
			const result = await observer.verify(Date.now() + 1_000);
			expect(result.errors).toEqual([]);
			expect(result.liveMembers).toEqual([]);
			expect(captures).toBeGreaterThanOrEqual(3);
		} finally {
			observer.stop();
		}
	});

	test.runIf(process.platform !== "win32")(
		"keeps a fast-orphaned, portless grandchild visible through its confirmed private PGID",
		async () => {
			const child = spawn(
				process.execPath,
				[
					"-e",
					`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
      setTimeout(() => process.exit(0), 180);
    `,
				],
				{ detached: true, stdio: "ignore" },
			);
			fixtures.push(child);
			const observer = createProcessObserver(child, { pollIntervalMs: 15 });
			const launcherPid = child.pid!;
			await new Promise<void>((resolve) => child.once("exit", () => resolve()));
			await sleep(100);
			const evidence = observer.snapshot();
			expect(evidence.errors).toEqual([]);
			expect(evidence.groups).toEqual([launcherPid]);
			// Its parent is now init/launchd, so a parent-PID-only walk would miss it.
			expect(
				evidence.liveMembers.some((member) => member.pid !== launcherPid),
			).toBe(true);
			expect(evidence.owned.some((member) => member.pid !== launcherPid)).toBe(
				true,
			);
			killStillObservedPrivateGroups(observer);
			const settled = await observer.verify(Date.now() + 2_000);
			observer.stop();
			expect(settled.liveMembers).toEqual([]);
			expect(settled.errors).toEqual([]);
		},
	);

	test.runIf(process.platform !== "win32")(
		"records a descendant born during shutdown before final verification",
		async () => {
			const child = spawn(
				process.execPath,
				[
					"-e",
					`
      const { spawn } = require('node:child_process');
      setTimeout(() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' }), 180);
      setTimeout(() => process.exit(0), 350);
    `,
				],
				{ detached: true, stdio: "ignore" },
			);
			fixtures.push(child);
			const observer = createProcessObserver(child, { pollIntervalMs: 10 });
			const launcherPid = child.pid!;
			await new Promise<void>((resolve) => child.once("exit", () => resolve()));
			await sleep(80);
			const duringShutdown = observer.snapshot();
			expect(duringShutdown.errors).toEqual([]);
			expect(
				duringShutdown.liveMembers.some((member) => member.pid !== launcherPid),
			).toBe(true);
			killStillObservedPrivateGroups(observer);
			const settled = await observer.verify(Date.now() + 2_000);
			observer.stop();
			expect(settled.liveMembers).toEqual([]);
		},
	);

	test("anchors the first launcher identity and rejects PID reuse without overwriting it", () => {
		const snapshots: ProcessSnapshot[][] = [
			[{ pid: 41, parentPid: 1, processGroupId: 41, startedAt: "first" }],
			[{ pid: 41, parentPid: 1, processGroupId: 41, startedAt: "reused" }],
		];
		const observer = createProcessObserver(
			{ pid: 41 },
			{ snapshotter: () => snapshots.shift() ?? [], pollIntervalMs: 0 },
		);
		const result = observer.snapshot();
		observer.stop();
		expect(result.owned).toEqual([
			{ pid: 41, processGroupId: 41, startedAt: "first" },
		]);
		expect(result.errors.join("\n")).toContain("reused");
	});

	test("fails closed for a mixed POSIX snapshot and invalid Windows CIM data", () => {
		expect(
			parsePosixProcessSnapshot(" 2 0 0 Tue Sep 14 10:00:00 2026\n"),
		).toEqual([
			{
				pid: 2,
				parentPid: 0,
				processGroupId: 0,
				startedAt: "Tue Sep 14 10:00:00 2026",
			},
		]);
		expect(() =>
			parsePosixProcessSnapshot(" 1 0 1 Tue Sep 14 10:00:00 2026\nbad row\n"),
		).toThrow("invalid row");
		expect(() => parsePosixProcessSnapshot("")).toThrow("empty");
		expect(() =>
			parseWindowsProcessSnapshot(
				'[{"ProcessId":0,"ParentProcessId":0,"CreationDate":"ok"},{"ProcessId":"bad","ParentProcessId":0,"CreationDate":"ok"}]',
			),
		).toThrow("invalid row");
		expect(
			parseWindowsProcessSnapshot(
				'{"ProcessId":0,"ParentProcessId":0,"CreationDate":"ok"}',
			),
		).toEqual([{ pid: 0, parentPid: 0, startedAt: "ok" }]);
	});

	test("does not accept a shared PGID as smoke-owned", () => {
		const observer = createProcessObserver(
			{ pid: 81 },
			{
				snapshotter: () => [
					{ pid: 81, parentPid: 1, processGroupId: 7, startedAt: "created" },
				],
				pollIntervalMs: 0,
			},
		);
		const result = observer.snapshot();
		observer.stop();
		expect(result.groups).toEqual([]);
		expect(result.owned).toEqual([]);
		expect(result.errors.join("\n")).toContain("shared process group");
	});

	test("an explicit creation identity can anchor a shared LaunchServices group without adopting unrelated peers", () => {
		const snapshots: ProcessSnapshot[][] = [
			[
				{ pid: 201, parentPid: 1, processGroupId: 7, startedAt: "app-created" },
				{
					pid: 202,
					parentPid: 1,
					processGroupId: 7,
					startedAt: "unrelated-peer",
				},
				{
					pid: 203,
					parentPid: 201,
					processGroupId: 203,
					startedAt: "guardian-created",
				},
			],
		];
		const observer = createProcessObserver(
			{ pid: 201 },
			{
				explicitRootIdentity: { pid: 201, startedAt: "app-created" },
				snapshotter: () => snapshots[0]!,
				pollIntervalMs: 0,
			},
		);
		const result = observer.snapshot();
		observer.stop();
		expect(result.errors).toEqual([]);
		expect(result.groups).toEqual([203]);
		expect(result.owned.map((value) => value.pid).sort()).toEqual([201, 203]);
		expect(result.liveMembers.map((value) => value.pid).sort()).toEqual([
			201, 203,
		]);
	});

	test("rejects state identities that are not observed through the anchored ancestry", () => {
		const snapshot = [
			{ pid: 301, parentPid: 1, processGroupId: 9, startedAt: "app" },
			{ pid: 302, parentPid: 1, processGroupId: 10, startedAt: "unrelated" },
		] as ProcessSnapshot[];
		const observer = createProcessObserver(
			{ pid: 301 },
			{
				explicitRootIdentity: { pid: 301, startedAt: "app" },
				snapshotter: () => snapshot,
				pollIntervalMs: 0,
			},
		);
		const result = observer.observeStateRoots([
			{ pid: 302, startedAt: "unrelated" },
		]);
		observer.stop();
		expect(result.errors.join("\n")).toContain(
			"not observed through the product ancestry",
		);
	});

	test("keeps an explicit-root guardian group through parent exit, new shutdown descendants, and rejects root PID reuse", () => {
		const snapshots: ProcessSnapshot[][] = [
			[
				{ pid: 401, parentPid: 1, processGroupId: 7, startedAt: "app-first" },
				{
					pid: 402,
					parentPid: 401,
					processGroupId: 402,
					startedAt: "guardian",
				},
			],
			[
				{
					pid: 403,
					parentPid: 1,
					processGroupId: 402,
					startedAt: "orphan-child",
				},
				{
					pid: 404,
					parentPid: 403,
					processGroupId: 402,
					startedAt: "shutdown-descendant",
				},
			],
			[{ pid: 401, parentPid: 1, processGroupId: 7, startedAt: "app-reused" }],
		];
		const observer = createProcessObserver(
			{ pid: 401 },
			{
				explicitRootIdentity: { pid: 401, startedAt: "app-first" },
				snapshotter: () => snapshots.shift() ?? [],
				pollIntervalMs: 0,
			},
		);
		const afterParentExit = observer.snapshot();
		expect(afterParentExit.errors).toEqual([]);
		expect(
			afterParentExit.liveMembers.map((value) => value.pid).sort(),
		).toEqual([403, 404]);
		const reused = observer.snapshot();
		observer.stop();
		expect(
			reused.owned.some(
				(value) => value.pid === 401 && value.startedAt === "app-reused",
			),
		).toBe(false);
		expect(reused.errors.join("\n")).toContain("reused");
	});

	test("fails closed when an otherwise valid evidence source becomes empty", () => {
		const snapshots: ProcessSnapshot[][] = [
			[{ pid: 91, parentPid: 1, processGroupId: 91, startedAt: "created" }],
			[],
		];
		const observer = createProcessObserver(
			{ pid: 91 },
			{ snapshotter: () => snapshots.shift() ?? [], pollIntervalMs: 0 },
		);
		const result = observer.snapshot();
		observer.stop();
		expect(result.errors.join("\n")).toContain("empty");
	});

	test("retains a confirmed Windows-like child identity after its root exits", () => {
		const snapshots: ProcessSnapshot[][] = [
			[
				{ pid: 101, parentPid: 1, startedAt: "root-created" },
				{ pid: 102, parentPid: 101, startedAt: "child-created" },
			],
			[{ pid: 102, parentPid: 1, startedAt: "child-created" }],
		];
		const observer = createProcessObserver(
			{ pid: 101 },
			{ snapshotter: () => snapshots.shift() ?? [], pollIntervalMs: 0 },
		);
		const result = observer.snapshot();
		observer.stop();
		expect(result.errors).toEqual([]);
		expect(result.liveMembers).toEqual([
			{ pid: 102, startedAt: "child-created" },
		]);
		expect(result.limitation).toContain(
			"does not claim Job-object containment",
		);
	});

	test.runIf(
		process.platform === "darwin" &&
			existsSync(
				join(
					import.meta.dirname,
					"../src-tauri/resources/sidecars/runtime-guardian-aarch64-apple-darwin",
				),
			),
	)(
		"follows a real native guardian across its target setsid boundary",
		async () => {
			const guardian = join(
				import.meta.dirname,
				"../src-tauri/resources/sidecars/runtime-guardian-aarch64-apple-darwin",
			);
			const child = spawn(
				guardian,
				[
					"--grace-ms",
					"1000",
					"--",
					process.execPath,
					"-e",
					`
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
      setTimeout(() => process.exit(0), 2000);
    `,
				],
				{ detached: true, stdio: ["pipe", "ignore", "ignore"] },
			);
			fixtures.push(child);
			const observer = createProcessObserver(child, { pollIntervalMs: 10 });
			const guardianPid = child.pid!;
			let evidence: ReturnType<typeof observer.snapshot> | undefined;
			await waitFor(() => {
				evidence = observer.snapshot();
				return (
					evidence.groups.includes(guardianPid) &&
					evidence.groups.length >= 2 &&
					evidence.liveMembers.some(
						(member) => member.processGroupId !== guardianPid,
					)
				);
			});
			const settledLaunchEvidence = evidence!;
			expect(settledLaunchEvidence.errors).toEqual([]);
			expect(settledLaunchEvidence.groups.length).toBeGreaterThanOrEqual(2);
			expect(settledLaunchEvidence.groups).toContain(guardianPid);
			expect(
				settledLaunchEvidence.liveMembers.some(
					(member) => member.processGroupId !== guardianPid,
				),
			).toBe(true);
			killStillObservedPrivateGroups(observer);
			const settled = await observer.verify(Date.now() + 2_000);
			observer.stop();
			expect(settled.liveMembers).toEqual([]);
		},
	);
});
