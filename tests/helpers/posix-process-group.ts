/**
 * Probe a POSIX process group without changing its state. ESRCH means the
 * group is gone; permission and other kernel errors must remain failures.
 */
export function posixProcessGroupExists(groupLeaderPid: number): boolean {
	if (!Number.isSafeInteger(groupLeaderPid) || groupLeaderPid <= 0) {
		throw new Error(`invalid POSIX process group PID: ${groupLeaderPid}`);
	}
	try {
		process.kill(-groupLeaderPid, 0);
		return true;
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ESRCH"
		)
			return false;
		throw error;
	}
}
