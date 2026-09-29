import { writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** Drain a nonblocking child pipe without losing partial writes or blocking the event loop. */
export async function writeDesktopPipe(
	fd: number,
	payload: Uint8Array,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	let offset = 0;
	while (offset < payload.byteLength) {
		if (performance.now() >= deadline)
			throw new Error("Desktop target environment pipe write timed out");
		try {
			const count = writeSync(fd, payload, offset, payload.byteLength - offset);
			if (count > 0) {
				offset += count;
				continue;
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EAGAIN" && code !== "EWOULDBLOCK" && code !== "EINTR")
				throw error;
		}
		await sleep(10);
	}
}
