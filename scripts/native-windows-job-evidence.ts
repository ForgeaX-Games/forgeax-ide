/**
 * Native Windows smoke containment evidence.
 *
 * The smoke runner owns an outer Job before it spawns tauri-driver.  Child
 * processes inherit it, including nested product Jobs on Windows 8+.  We keep
 * the handle alive through the verdict and inspect it before teardown; this
 * never opens or prolongs the product launcher's private Job handle.
 */
import {
	createWindowsJobOwner,
	loadWindowsJobAdapter,
	queryWindowsJobProcessIds,
	type WindowsJobAdapter,
	type WindowsJobOwner,
	type WindowsJobQueryAdapter,
} from "./desktop-windows-job";
import {
	type ProcessIdentity,
	type ProcessSnapshot,
	readProcessSnapshot,
} from "./smoke-process-evidence";

type Snapshotter = () => ProcessSnapshot[];
type JobAdapter = WindowsJobAdapter & WindowsJobQueryAdapter;

export type NativeWindowsJobEvidence = Readonly<{
	/** Query the outer Job directly. Any native failure aborts the smoke run. */
	query(): readonly number[];
	/** Resolve every queried PID to a creation identity; missing data is fatal. */
	snapshot(): readonly ProcessIdentity[];
	/** Fail if a member has appeared, including a PID reused after the baseline. */
	assertCleaned(baseline: readonly ProcessIdentity[]): void;
}>;

function identityKey(value: ProcessIdentity): string {
	return `${value.pid}\u0000${value.startedAt}`;
}

function requireIdentitySnapshot(
	pids: readonly number[],
	snapshot: readonly ProcessSnapshot[],
): ProcessIdentity[] {
	const identities: ProcessIdentity[] = [];
	const seen = new Set<number>();
	for (const pid of pids) {
		if (!Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid))
			throw new Error(
				`Job Object query returned invalid or duplicate PID ${pid}`,
			);
		seen.add(pid);
		const matches = snapshot.filter((value) => value.pid === pid);
		if (
			matches.length !== 1 ||
			typeof matches[0]?.startedAt !== "string" ||
			matches[0].startedAt.length === 0
		) {
			throw new Error(
				`Job Object member ${pid} has no unambiguous CIM creation identity`,
			);
		}
		identities.push({ pid, startedAt: matches[0].startedAt });
	}
	return identities;
}

export function createNativeWindowsJobEvidence(
	adapter: JobAdapter,
	owner: WindowsJobOwner,
	snapshotter: Snapshotter = readProcessSnapshot,
): NativeWindowsJobEvidence {
	const query = (): readonly number[] => {
		const pids = queryWindowsJobProcessIds(adapter, owner.handle);
		// The current smoke runner is assigned before this object is returned.
		// An empty list would therefore be contradictory evidence, never clean.
		if (pids.length === 0)
			throw new Error(
				"Windows Job Object contains no active members and cannot prove containment",
			);
		return pids;
	};
	const snapshot = (): readonly ProcessIdentity[] =>
		requireIdentitySnapshot(query(), snapshotter());
	return {
		query,
		snapshot,
		assertCleaned(baseline) {
			const baselineKeys = new Set(baseline.map(identityKey));
			if (baselineKeys.size !== baseline.length)
				throw new Error(
					"Job Object baseline contains duplicate creation identities",
				);
			const residual = snapshot().filter(
				(value) => !baselineKeys.has(identityKey(value)),
			);
			if (residual.length > 0) {
				throw new Error(
					`Windows Job Object retained non-baseline member(s): ${residual.map((value) => `${value.pid}@${value.startedAt}`).join(", ")}`,
				);
			}
		},
	};
}

/** Create and retain the smoke runner's outer Job before it spawns a driver. */
export async function initializeNativeWindowsJobEvidence(
	platform = process.platform,
): Promise<NativeWindowsJobEvidence | undefined> {
	if (platform !== "win32") return undefined;
	if (process.arch !== "x64")
		throw new Error(
			`unsupported Windows native smoke runtime architecture: ${process.arch}`,
		);
	const adapter = await loadWindowsJobAdapter();
	const owner = createWindowsJobOwner(adapter);
	return createNativeWindowsJobEvidence(adapter, owner);
}
