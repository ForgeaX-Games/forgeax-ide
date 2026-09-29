export type DesktopProcessPlatform = "posix" | "win32";
export type DesktopProcessSignal = "SIGTERM" | "SIGKILL";

export type DesktopProcessAction =
	| {
			kind: "signal";
			pid: number;
			signal: DesktopProcessSignal;
			target: "group" | "process";
	  }
	| {
			kind: "taskkill";
			pid: number;
			command: "taskkill";
			args: readonly ["/PID", string, "/T", "/F"];
	  };

export type ProcessTreeFailure = {
	action: DesktopProcessAction;
	error: string;
};

export const DESKTOP_TASKKILL_TIMEOUT_MS = 2_000;

export type ProcessTreeTaskkillOperation = {
	result: Promise<{ exitCode: number | null; stderr?: string }>;
	terminate(): void;
};

export type ProcessTreeExecutor = {
	signal(pid: number, signal: DesktopProcessSignal): void | Promise<void>;
	taskkill(args: readonly string[]): ProcessTreeTaskkillOperation;
	/** Check a POSIX process group for closure after a group signal. */
	groupExists?(groupLeaderPid: number): boolean | Promise<boolean>;
};

export type ProcessTreeExecutionOptions = {
	taskkillTimeoutMs?: number;
};

type TaskkillResult = { exitCode: number | null; stderr?: string };

async function awaitTaskkillResult(
	operation: ProcessTreeTaskkillOperation,
	timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: TaskkillResult }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const result = operation.result.then(
		(value) => ({ timedOut: false as const, value }),
		(error) => ({ timedOut: false as const, error }),
	);
	try {
		const outcome = await Promise.race([
			result,
			new Promise<{ timedOut: true }>((resolve) => {
				timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
			}),
		]);
		if ("error" in outcome) throw outcome.error;
		return outcome;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function isErrno(error: unknown, code: string): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}

/** Bun's detached process-group behavior is explicit and platform-specific. */
export function desktopSpawnOptions(platform: NodeJS.Platform): {
	detached: boolean;
	windowsHide?: boolean;
} {
	return platform === "win32"
		? { detached: false, windowsHide: true }
		: { detached: true };
}

function assertPid(pid: number): void {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new Error(
			`desktop runtime child pid must be a positive integer: ${pid}`,
		);
	}
}

/** Build the one platform plan used by both graceful and forced teardown. */
export function desktopProcessTreePlan(
	platform: DesktopProcessPlatform,
	pids: readonly number[],
	signal: DesktopProcessSignal,
): DesktopProcessAction[] {
	pids.forEach(assertPid);
	if (platform === "win32" && signal === "SIGKILL") {
		return pids.map((pid) => ({
			kind: "taskkill" as const,
			pid,
			command: "taskkill" as const,
			args: ["/PID", String(pid), "/T", "/F"] as const,
		}));
	}
	return pids.map((pid) => ({
		kind: "signal" as const,
		// POSIX process groups are led by the direct child PID. A negative PID
		// is the kernel contract for signalling that whole group.
		pid: platform === "posix" ? -pid : pid,
		signal,
		target: platform === "posix" ? ("group" as const) : ("process" as const),
	}));
}

/** Execute every planned action and return failures instead of hiding them. */
export async function executeDesktopProcessTreePlan(
	actions: readonly DesktopProcessAction[],
	executor: ProcessTreeExecutor,
	options: ProcessTreeExecutionOptions = {},
): Promise<ProcessTreeFailure[]> {
	const taskkillTimeoutMs =
		options.taskkillTimeoutMs ?? DESKTOP_TASKKILL_TIMEOUT_MS;
	if (!Number.isFinite(taskkillTimeoutMs) || taskkillTimeoutMs <= 0) {
		throw new RangeError(
			`desktop taskkill timeout must be a positive finite number: ${taskkillTimeoutMs}`,
		);
	}
	const failures: ProcessTreeFailure[] = [];
	for (const action of actions) {
		try {
			if (action.kind === "signal") {
				await executor.signal(action.pid, action.signal);
				if (action.target === "group") {
					const groupLeaderPid = Math.abs(action.pid);
					const groupExists = executor.groupExists;
					if (!groupExists) {
						failures.push({
							action,
							error: "process group closure could not be verified after signal",
						});
						continue;
					}
					// A successful signal only means the kernel accepted the request;
					// descendants may still be alive. Probe here, while the owning
					// runtime performs the authoritative post-grace/post-force checks.
					await groupExists(groupLeaderPid);
				}
				continue;
			}
			const operation = executor.taskkill(action.args);
			const result = await awaitTaskkillResult(operation, taskkillTimeoutMs);
			if (result.timedOut) {
				const timeoutFailure = `${action.command} ${action.args.join(" ")} timed out after ${taskkillTimeoutMs}ms`;
				try {
					operation.terminate();
				} catch (terminateError) {
					failures.push({
						action,
						error: `${timeoutFailure}; failed to terminate taskkill helper: ${terminateError instanceof Error ? terminateError.message : String(terminateError)}`,
					});
					continue;
				}
				failures.push({ action, error: timeoutFailure });
				continue;
			}
			const { value } = result;
			if (value.exitCode !== 0) {
				const detail = value.stderr?.trim();
				failures.push({
					action,
					error: `${action.command} ${action.args.join(" ")} exited with ${String(value.exitCode)}${detail ? `: ${detail}` : ""}`,
				});
			}
		} catch (error) {
			if (
				action.kind === "signal" &&
				action.target === "group" &&
				isErrno(error, "ESRCH")
			) {
				try {
					const groupLeaderPid = Math.abs(action.pid);
					const groupExists = executor.groupExists;
					if (groupExists && !(await groupExists(groupLeaderPid))) continue;
					const reason = groupExists
						? "process group still exists after signal returned ESRCH"
						: "process group existence could not be verified after signal returned ESRCH";
					failures.push({
						action,
						error: `${error instanceof Error ? error.message : String(error)}; ${reason}`,
					});
					continue;
				} catch (recheckError) {
					failures.push({
						action,
						error: `${error instanceof Error ? error.message : String(error)}; process group recheck failed: ${recheckError instanceof Error ? recheckError.message : String(recheckError)}`,
					});
					continue;
				}
			}
			failures.push({
				action,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return failures;
}

export type DesktopTeardownAssessment = {
	status: "failed" | "stopped";
	exitCode: number;
	cleanupRuntimeDirectory: boolean;
	error?: string;
};

/** Encode the terminal runtime contract independently of process APIs. */
export function assessDesktopTeardown(input: {
	forced: boolean;
	childrenLive: boolean;
	groupsLive?: boolean;
	failures: readonly string[];
	exitCode: number;
	existingFailure?: string;
}): DesktopTeardownAssessment {
	const reasons = [
		...(input.existingFailure ? [input.existingFailure] : []),
		...(input.forced ? ["forced process-tree teardown"] : []),
		...(input.childrenLive ? ["direct runtime child is still alive"] : []),
		...(input.groupsLive ? ["runtime process group is still alive"] : []),
		...input.failures,
	];
	const failed = reasons.length > 0;
	return {
		status: failed ? "failed" : "stopped",
		exitCode: failed
			? input.exitCode === 0
				? 1
				: input.exitCode
			: input.exitCode,
		cleanupRuntimeDirectory: !input.childrenLive && !input.groupsLive,
		...(reasons.length > 0 ? { error: reasons.join("; ") } : {}),
	};
}
