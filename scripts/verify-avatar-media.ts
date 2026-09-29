export type MediaCheckProgress = {
	checked: number;
	total: number;
	inFlight: Array<{
		url: string;
		startedAt: string;
		phase: "headers" | "body";
	}>;
	slowest: Array<{ url: string; elapsedMs: number }>;
};

/** Exercise every HTTP range endpoint without serializing hundreds of disk
 * opens. A per-request deadline includes body consumption, not just headers.
 * First failure cancels and settles siblings before returning the original error.
 */
export async function verifyAvatarMedia(
	origin: string,
	urls: Iterable<string>,
	options: {
		concurrency?: number;
		requestTimeoutMs?: number;
		/** Attempts per URL before declaring failure. Default 2 — transient
		 * failures (AV scanner holding a fresh file open, momentary stalls) are
		 * retried once; deterministic failures still fail on the second attempt. */
		maxAttemptsPerUrl?: number;
		onProgress?: (progress: MediaCheckProgress) => void;
	} = {},
): Promise<MediaCheckProgress> {
	const concurrency = options.concurrency ?? 4;
	const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
	const maxAttempts = options.maxAttemptsPerUrl ?? 2;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
		throw new Error("avatar concurrency must be between 1 and 4");
	if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)
		throw new Error("avatar request timeout must be positive");
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)
		throw new Error("avatar attempts per URL must be between 1 and 3");
	const items = [...new Set(urls)];
	const progress: MediaCheckProgress = {
		checked: 0,
		total: items.length,
		inFlight: [],
		slowest: [],
	};
	const controller = new AbortController();
	let cursor = 0;
	let firstFailure: Error | undefined;
	const report = () => options.onProgress?.(structuredClone(progress));
	report();
	async function worker(): Promise<void> {
		while (!controller.signal.aborted && cursor < items.length) {
			const url = items[cursor++]!;
			const current: MediaCheckProgress["inFlight"][number] = {
				url,
				startedAt: new Date().toISOString(),
				phase: "headers",
			};
			const started = performance.now();
			progress.inFlight.push(current);
			report();
			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				const request = new AbortController();
				const cancel = () => request.abort(controller.signal.reason);
				controller.signal.addEventListener("abort", cancel, { once: true });
				const timer = setTimeout(
					() =>
						request.abort(
							new Error(`avatar request exceeded ${requestTimeoutMs}ms`),
						),
					requestTimeoutMs,
				);
				try {
					const response = await fetch(new URL(url, origin), {
						headers: { Range: "bytes=0-3" },
						signal: request.signal,
					});
					current.phase = "body";
					report();
					const media = Buffer.from(await response.arrayBuffer());
					if (
						response.status !== 206 ||
						response.headers.get("content-type") !== "video/webm" ||
						!media.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
					) {
						throw new Error(
							`range/WEBM validation failed (status=${response.status}, type=${response.headers.get("content-type")}, bytes=${media.length})`,
						);
					}
					progress.checked += 1;
					progress.slowest.push({
						url,
						elapsedMs: Math.round(performance.now() - started),
					});
					progress.slowest.sort((a, b) => b.elapsedMs - a.elapsedMs);
					progress.slowest.length = Math.min(progress.slowest.length, 5);
					break;
				} catch (error) {
					// Sibling cancellation is not this URL's failure — stop immediately.
					if (controller.signal.aborted) break;
					if (attempt >= maxAttempts) {
						if (!firstFailure) {
							const detail =
								error instanceof Error ? error.message : String(error);
							firstFailure = new Error(
								`avatar media failed during ${current.phase} after ${Math.round(performance.now() - started)}ms (attempt ${attempt}): ${url}: ${detail}`,
							);
							controller.abort(firstFailure);
						}
						break;
					}
					// Transient failure — retry this URL on the next loop iteration.
				} finally {
					clearTimeout(timer);
					controller.signal.removeEventListener("abort", cancel);
				}
			}
			progress.inFlight.splice(progress.inFlight.indexOf(current), 1);
			report();
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
	);
	if (firstFailure) throw firstFailure;
	return progress;
}
