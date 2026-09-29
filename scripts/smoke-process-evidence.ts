import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** A PID is never an identity on its own: creation time is part of the proof. */
export type ProcessIdentity = {
	readonly pid: number;
	readonly startedAt: string;
};
export type ProcessSnapshot = ProcessIdentity & {
	readonly parentPid: number;
	/** Undefined on Windows: CIM has no process-group equivalent. */
	readonly processGroupId?: number;
};

export type OwnedProcess = ProcessIdentity & {
	readonly processGroupId?: number;
};
export type ProcessEvidence = {
	readonly owned: readonly OwnedProcess[];
	readonly groups: readonly number[];
	readonly liveMembers: readonly OwnedProcess[];
	readonly errors: readonly string[];
	/** Windows has no observed Job membership here, so no containment claim is made. */
	readonly limitation?: string;
};

export type ProcessObserver = {
	observeStateRoots(roots: readonly ProcessIdentity[]): ProcessEvidence;
	snapshot(): ProcessEvidence;
	stop(): void;
	verify(deadlineMs: number): Promise<ProcessEvidence>;
};

type Snapshotter = () => ProcessSnapshot[];
export type ProcessObserverOptions = {
	readonly snapshotter?: Snapshotter;
	readonly pollIntervalMs?: number;
	/**
	 * LaunchServices does not give an application a private PGID.  This option
	 * is deliberately an *exact creation identity*, never a bundle id or PID:
	 * it permits that one root plus descendants, but never adopts its shared
	 * group.  The normal launcher observer remains strict by default.
	 */
	readonly explicitRootIdentity?: ProcessIdentity;
};

function invalidRow(message: string): never {
	throw new Error(`process snapshot contains an invalid row: ${message}`);
}

function requirePid(value: unknown, label: string, allowZero = false): number {
	if (
		!Number.isSafeInteger(value) ||
		(!allowZero && Number(value) <= 0) ||
		Number(value) < 0
	)
		invalidRow(label);
	return Number(value);
}

export function parsePosixProcessSnapshot(output: string): ProcessSnapshot[] {
	const lines = output.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0)
		throw new Error("POSIX process snapshot is empty and cannot prove cleanup");
	return lines.map((line) => {
		// ps -axo pid=,ppid=,pgid=,lstart= ; lstart is deliberately retained verbatim.
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
		if (!match || !match[4]) invalidRow("POSIX row");
		return {
			pid: requirePid(Number(match[1]), "PID"),
			parentPid: requirePid(Number(match[2]), "PPID", true),
			// Linux's full ps snapshot can include kernel/system records in PGID 0.
			// They are evidence only: a positive launcher can never claim them.
			processGroupId: requirePid(Number(match[3]), "PGID", true),
			startedAt: match[4],
		};
	});
}

/** Pure parser so Windows evidence can be tested on a non-Windows runner. */
export function parseWindowsProcessSnapshot(output: string): ProcessSnapshot[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch (error) {
		throw new Error(
			`could not parse Windows process snapshot: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	const rows = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
	if (rows.length === 0)
		throw new Error(
			"Windows process snapshot is empty and cannot prove cleanup",
		);
	return rows.map((row) => {
		if (!row || typeof row !== "object") invalidRow("Windows row");
		const value = row as {
			ProcessId?: unknown;
			ParentProcessId?: unknown;
			CreationDate?: unknown;
		};
		if (
			typeof value.CreationDate !== "string" ||
			value.CreationDate.length === 0
		)
			invalidRow("CreationDate");
		return {
			// PID 0 is legitimate system evidence on Windows, but cannot become a root.
			pid: requirePid(value.ProcessId, "ProcessId", true),
			parentPid: requirePid(value.ParentProcessId, "ParentProcessId", true),
			startedAt: value.CreationDate,
		};
	});
}

export function readProcessSnapshot(): ProcessSnapshot[] {
	const windows = process.platform === "win32";
	const result = spawnSync(
		windows ? "powershell.exe" : "ps",
		windows
			? [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress",
				]
			: ["-axo", "pid=,ppid=,pgid=,lstart="],
		{ encoding: "utf8", timeout: 2_000, windowsHide: true },
	);
	if (result.error || result.status !== 0 || result.signal) {
		throw new Error(
			`could not inspect process evidence: ${result.error?.message ?? result.stderr ?? result.signal ?? result.status}`,
		);
	}
	return windows
		? parseWindowsProcessSnapshot(result.stdout)
		: parsePosixProcessSnapshot(result.stdout);
}

function identityKey(identity: ProcessIdentity): string {
	return `${identity.pid}\u0000${identity.startedAt}`;
}
function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
	return a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * Records only a launcher-created POSIX group (the launcher must be its group
 * leader). It observes evidence; it never signals a PID or a group.
 */
export function createProcessObserver(
	child: Pick<ChildProcess, "pid">,
	options: ProcessObserverOptions = {},
): ProcessObserver {
	const childPid = child.pid;
	if (
		typeof childPid !== "number" ||
		!Number.isSafeInteger(childPid) ||
		childPid <= 0
	)
		throw new Error(
			"cannot establish process evidence without a positive launcher PID",
		);
	const launcherPid = childPid;
	const takeSnapshot = options.snapshotter ?? readProcessSnapshot;
	const groups = new Set<number>();
	const identities = new Map<string, OwnedProcess>();
	const errors: string[] = [];
	let root: ProcessIdentity | undefined;
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const evidence = (
		snapshot: ProcessSnapshot[] | undefined,
	): ProcessEvidence => {
		const liveMembers: OwnedProcess[] = [];
		if (snapshot) {
			const conflictingIdentity = (entry: ProcessSnapshot): boolean => {
				for (const owned of identities.values())
					if (owned.pid === entry.pid && owned.startedAt !== entry.startedAt)
						return true;
				return false;
			};
			const trustedPids = new Set<number>();
			const accept = (entry: ProcessSnapshot): boolean => {
				if (conflictingIdentity(entry)) return false;
				const member: OwnedProcess = {
					pid: entry.pid,
					startedAt: entry.startedAt,
					...(entry.processGroupId === undefined
						? {}
						: { processGroupId: entry.processGroupId }),
				};
				identities.set(identityKey(member), member);
				trustedPids.add(entry.pid);
				if (!liveMembers.some((value) => sameIdentity(value, member)))
					liveMembers.push(member);
				return true;
			};
			// Windows has no PGID from CIM. Its direct launcher identity still
			// seeds a read-only parent/child evidence walk, but the result carries
			// the Job-containment limitation rather than failing every run.
			const anchoredRoot = root;
			if (anchoredRoot) {
				const rootEntry = snapshot.find((entry) =>
					sameIdentity(entry, anchoredRoot),
				);
				if (rootEntry) accept(rootEntry);
			}
			// A previously confirmed creation identity remains evidence even after
			// its launcher or PG leader exits. This is essential on Windows, where
			// CIM has no PGID/Job membership to seed the next snapshot. It also
			// catches a POSIX member which changes group without becoming a new
			// ownership root. A same PID with another creation time is rejected by
			// accept() and can never replace this identity.
			for (const entry of snapshot)
				if (identities.has(identityKey(entry))) accept(entry);
			// Existing groups remain authoritative after their leaders exit.
			for (const entry of snapshot)
				if (
					entry.processGroupId !== undefined &&
					groups.has(entry.processGroupId)
				)
					accept(entry);
			// A guardian may create a target with setsid().  Establish that new
			// private group only while its parent is still current evidence from an
			// already confirmed group; never from a state-file PID alone.
			let changed = true;
			while (changed) {
				changed = false;
				for (const entry of snapshot) {
					if (!trustedPids.has(entry.parentPid) || conflictingIdentity(entry))
						continue;
					const wasTrusted = trustedPids.has(entry.pid);
					if (
						accept(entry) &&
						entry.processGroupId === entry.pid &&
						!groups.has(entry.processGroupId)
					) {
						groups.add(entry.processGroupId);
						changed = true;
					}
					if (!wasTrusted && trustedPids.has(entry.pid)) changed = true;
				}
			}
		}
		const lacksGroupEvidence = [...identities.values()].some(
			(value) => value.processGroupId === undefined,
		);
		return {
			owned: [...identities.values()],
			groups: [...groups],
			liveMembers,
			errors: [...errors],
			...(process.platform === "win32" || lacksGroupEvidence
				? {
						limitation:
							"Windows CIM supplies PID/PPID/creation evidence only; this observer does not claim Job-object containment.",
					}
				: {}),
		};
	};

	const capture = (): ProcessEvidence => {
		let snapshot: ProcessSnapshot[];
		try {
			snapshot = takeSnapshot();
		} catch (error) {
			errors.push(
				`process evidence snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return evidence(undefined);
		}
		if (snapshot.length === 0) {
			errors.push(
				"process evidence snapshot is empty and cannot prove cleanup",
			);
			return evidence(undefined);
		}
		const rootNow = snapshot.find((entry) => entry.pid === launcherPid);
		if (!root) {
			if (!rootNow)
				errors.push(
					`launcher ${launcherPid} was absent before its creation identity could be established`,
				);
			else if (
				options.explicitRootIdentity &&
				!sameIdentity(rootNow, options.explicitRootIdentity)
			) {
				errors.push(
					`launcher PID ${launcherPid} did not match its explicit creation identity`,
				);
			} else if (rootNow.processGroupId === undefined) {
				root = { pid: rootNow.pid, startedAt: rootNow.startedAt };
				identities.set(identityKey(root), root);
			} else if (
				rootNow.processGroupId !== launcherPid &&
				!options.explicitRootIdentity
			)
				errors.push(
					`launcher ${launcherPid} is in shared process group ${rootNow.processGroupId}; refusing ownership`,
				);
			else if (rootNow.processGroupId !== launcherPid) {
				// Exact root only. Do not add the shared PGID to groups.
				root = { pid: rootNow.pid, startedAt: rootNow.startedAt };
				identities.set(identityKey(root), {
					...root,
					processGroupId: rootNow.processGroupId,
				});
			} else {
				root = { pid: rootNow.pid, startedAt: rootNow.startedAt };
				groups.add(rootNow.processGroupId);
				identities.set(identityKey(root), {
					...root,
					processGroupId: rootNow.processGroupId,
				});
			}
		} else {
			const anchoredRoot = root;
			if (rootNow && anchoredRoot && !sameIdentity(anchoredRoot, rootNow)) {
				errors.push(
					`launcher PID ${launcherPid} was reused; refusing to replace its original creation identity`,
				);
			}
		}
		return evidence(snapshot);
	};

	capture();
	if (options.pollIntervalMs !== 0)
		timer = setInterval(() => {
			if (!stopped) capture();
		}, options.pollIntervalMs ?? 50);
	return {
		observeStateRoots(roots) {
			// State roots are evidence hints only; accepting a naked PID would reintroduce PID reuse ownership.
			if (
				roots.some(
					(value) =>
						!Number.isSafeInteger(value.pid) ||
						value.pid <= 0 ||
						typeof value.startedAt !== "string" ||
						value.startedAt.length === 0,
				)
			) {
				errors.push("rejected invalid state-root identity");
			}
			const current = capture();
			for (const rootHint of roots) {
				if (!current.owned.some((value) => sameIdentity(value, rootHint))) {
					errors.push(
						`state-root ${rootHint.pid} was not observed through the product ancestry`,
					);
				}
			}
			return capture();
		},
		snapshot: capture,
		stop() {
			stopped = true;
			if (timer) clearInterval(timer);
			timer = undefined;
		},
		async verify(deadlineMs) {
			while (Date.now() < deadlineMs) {
				const current = capture();
				if (current.errors.length > 0 || current.liveMembers.length === 0)
					return current;
				await sleep(
					Math.min(
						options.pollIntervalMs ?? 50,
						Math.max(1, deadlineMs - Date.now()),
					),
				);
			}
			return capture();
		},
	};
}
