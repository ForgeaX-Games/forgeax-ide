/**
 * Windows process containment for the packaged desktop launcher.
 *
 * Keep all bun:ffi usage behind a dynamic import. This module is imported by
 * the portable launcher bundle, but non-Windows launchers must never load the
 * experimental FFI module.
 */

export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
export const JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS = 3;
export const JOB_OBJECT_BASIC_PROCESS_ID_LIST_HEADER_SIZE = 8;
export const JOB_OBJECT_BASIC_PROCESS_ID_LIST_POINTER_SIZE = 8;
export const ERROR_MORE_DATA = 234;
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144;
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_LIMIT_FLAGS_OFFSET = 16;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;

export type WindowsJobApi = {
	createJobObject(): bigint;
	setInformationJobObject(
		handle: bigint,
		informationClass: number,
		information: Uint8Array,
	): boolean;
	getCurrentProcess(): bigint;
	assignProcessToJobObject(job: bigint, process: bigint): boolean;
	closeHandle(handle: bigint): boolean;
	getLastError(): number;
};

export type WindowsJobAdapter = WindowsJobApi & {
	/** Native library owner. It must remain reachable until launcher exit. */
	library: unknown;
	closeLibrary(): void;
};

/** The read-only subset used to enumerate active job members. */
export type WindowsJobQueryAdapter = Pick<WindowsJobApi, "getLastError"> & {
	queryInformationJobObject(
		handle: bigint,
		informationClass: number,
		information: Uint8Array,
	): boolean;
};

export type WindowsJobOwner = Readonly<{
	library: unknown;
	handle: bigint;
}>;

/** Encode JOBOBJECT_EXTENDED_LIMIT_INFORMATION for the supported x64 ABI. */
export function encodeJobObjectExtendedLimitInformation(): Uint8Array {
	const information = new Uint8Array(
		JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
	);
	new DataView(information.buffer).setUint32(
		JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_LIMIT_FLAGS_OFFSET,
		JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		true,
	);
	return information;
}

function lastError(adapter: WindowsJobApi): string {
	try {
		return `GetLastError=${adapter.getLastError()}`;
	} catch (error) {
		return `GetLastError failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function nativeFailure(name: string, adapter: WindowsJobApi): Error {
	return new Error(`${name} failed (${lastError(adapter)})`);
}

function closeFailure(
	adapter: WindowsJobAdapter,
	handle: bigint,
	cause: unknown,
): Error {
	const detail = cause instanceof Error ? cause.message : String(cause);
	const failures = [detail];
	try {
		if (!adapter.closeHandle(handle)) {
			failures.push(`CloseHandle failed (${lastError(adapter)})`);
		}
	} catch (error) {
		failures.push(
			`CloseHandle threw: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		adapter.closeLibrary();
	} catch (error) {
		failures.push(
			`native library cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return new Error(failures.join("; "));
}

/**
 * Run the ordered native initialization with explicit failure cleanup.
 *
 * A successful owner intentionally has no close method: closing either the
 * job handle or its native library would defeat the kill-on-close contract
 * before the launcher process exits.
 */
export function createWindowsJobOwner(
	adapter: WindowsJobAdapter,
): WindowsJobOwner {
	let handle = 0n;
	try {
		handle = adapter.createJobObject();
		if (handle === 0n) throw nativeFailure("CreateJobObjectW", adapter);

		const information = encodeJobObjectExtendedLimitInformation();
		if (
			!adapter.setInformationJobObject(
				handle,
				JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
				information,
			)
		) {
			throw nativeFailure("SetInformationJobObject", adapter);
		}

		const process = adapter.getCurrentProcess();
		if (process === 0n) throw nativeFailure("GetCurrentProcess", adapter);
		if (!adapter.assignProcessToJobObject(handle, process)) {
			throw nativeFailure("AssignProcessToJobObject", adapter);
		}

		return { library: adapter.library, handle };
	} catch (error) {
		if (handle !== 0n) {
			// Closing a partially initialized job is required. The launcher has not
			// joined it yet, so this cannot terminate an owned descendant tree.
			throw closeFailure(adapter, handle, error);
		}
		try {
			adapter.closeLibrary();
		} catch (closeError) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`${detail}; native library cleanup failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
			);
		}
		throw error;
	}
}

/**
 * Enumerate all active members of a Job Object on the supported x64 ABI.
 *
 * QueryInformationJobObject reports ERROR_MORE_DATA when the variable-size
 * ProcessIdList buffer is too small.  Its header tells us how many slots to
 * reserve on the retry; we never treat a partial list as containment proof.
 */
export function queryWindowsJobProcessIds(
	adapter: WindowsJobQueryAdapter,
	handle: bigint,
): number[] {
	let capacity = 16;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const information = new Uint8Array(
			JOB_OBJECT_BASIC_PROCESS_ID_LIST_HEADER_SIZE +
				capacity * JOB_OBJECT_BASIC_PROCESS_ID_LIST_POINTER_SIZE,
		);
		const ok = adapter.queryInformationJobObject(
			handle,
			JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS,
			information,
		);
		const view = new DataView(
			information.buffer,
			information.byteOffset,
			information.byteLength,
		);
		const assigned = view.getUint32(0, true);
		const listed = view.getUint32(4, true);
		if (ok && listed === assigned) {
			if (listed > capacity) {
				throw new Error(
					`QueryInformationJobObject returned invalid process list (assigned=${assigned}, listed=${listed}, capacity=${capacity})`,
				);
			}
			const pids: number[] = [];
			for (let index = 0; index < listed; index += 1) {
				const pid = view.getBigUint64(
					JOB_OBJECT_BASIC_PROCESS_ID_LIST_HEADER_SIZE +
						index * JOB_OBJECT_BASIC_PROCESS_ID_LIST_POINTER_SIZE,
					true,
				);
				if (pid === 0n || pid > BigInt(Number.MAX_SAFE_INTEGER)) {
					throw new Error(
						`QueryInformationJobObject returned invalid process ID ${pid}`,
					);
				}
				pids.push(Number(pid));
			}
			if (new Set(pids).size !== pids.length)
				throw new Error(
					"QueryInformationJobObject returned duplicate process IDs",
				);
			return pids;
		}
		if (ok && listed > assigned) {
			throw new Error(
				`QueryInformationJobObject returned invalid process list (assigned=${assigned}, listed=${listed}, capacity=${capacity})`,
			);
		}
		if (!ok) {
			const error = adapter.getLastError();
			if (error !== ERROR_MORE_DATA)
				throw new Error(
					`QueryInformationJobObject failed (GetLastError=${error})`,
				);
		}
		// Microsoft documents NumberOfProcessIdsInList < NumberOfAssignedProcesses
		// as a partial result requiring a larger buffer, even after a successful
		// call.  A partial membership list can never prove containment cleanup.
		const nextCapacity = Math.max(capacity * 2, assigned, listed);
		if (
			!Number.isSafeInteger(nextCapacity) ||
			nextCapacity <= capacity ||
			nextCapacity > 1_048_576
		) {
			throw new Error(
				`QueryInformationJobObject could not safely resize process list (assigned=${assigned}, listed=${listed}, capacity=${capacity})`,
			);
		}
		capacity = nextCapacity;
	}
	throw new Error("QueryInformationJobObject kept reporting ERROR_MORE_DATA");
}

export async function loadWindowsJobAdapter(): Promise<
	WindowsJobAdapter & WindowsJobQueryAdapter
> {
	const { dlopen } = await import("bun:ffi");
	const library = dlopen("kernel32.dll", {
		CreateJobObjectW: { returns: "u64", args: ["ptr", "ptr"] },
		SetInformationJobObject: {
			returns: "i32",
			args: ["u64", "i32", "ptr", "u32"],
		},
		GetCurrentProcess: { returns: "u64", args: [] },
		AssignProcessToJobObject: { returns: "i32", args: ["u64", "u64"] },
		QueryInformationJobObject: {
			returns: "i32",
			args: ["u64", "i32", "ptr", "u32", "ptr"],
		},
		CloseHandle: { returns: "i32", args: ["u64"] },
		GetLastError: { returns: "u32", args: [] },
	});
	return {
		library,
		createJobObject: () => library.symbols.CreateJobObjectW(null, null),
		setInformationJobObject: (handle, informationClass, information) =>
			library.symbols.SetInformationJobObject(
				handle,
				informationClass,
				information,
				information.byteLength,
			) !== 0,
		getCurrentProcess: () => library.symbols.GetCurrentProcess(),
		assignProcessToJobObject: (job, process) =>
			library.symbols.AssignProcessToJobObject(job, process) !== 0,
		queryInformationJobObject: (handle, informationClass, information) =>
			library.symbols.QueryInformationJobObject(
				handle,
				informationClass,
				information,
				information.byteLength,
				null,
			) !== 0,
		closeHandle: (handle) => library.symbols.CloseHandle(handle) !== 0,
		getLastError: () => library.symbols.GetLastError(),
		closeLibrary: () => library.close(),
	};
}

let processJobOwner: WindowsJobOwner | undefined;

/** Initialize the launcher-owned Windows Job Object exactly once. */
export async function initializeWindowsJobObject(
	platform = process.platform,
): Promise<void> {
	if (platform !== "win32") return;
	if (process.arch !== "x64")
		throw new Error(
			`unsupported Windows desktop runtime architecture: ${process.arch}`,
		);
	if (processJobOwner) return;
	const adapter = await loadWindowsJobAdapter();
	processJobOwner = createWindowsJobOwner(adapter);
}
