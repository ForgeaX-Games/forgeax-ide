import { describe, expect, test } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import {
	type MediaCheckProgress,
	verifyAvatarMedia,
} from "../../scripts/verify-avatar-media";

const header = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
async function withServer(
	handler: (url: string, response: ServerResponse, range?: string) => void,
	run: (origin: string) => Promise<void>,
): Promise<void> {
	const server = createServer((req, res) =>
		handler(req.url!, res, req.headers.range),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("expected TCP listener");
	try {
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
function valid(res: ServerResponse): void {
	res.writeHead(206, { "content-type": "video/webm", "content-length": "4" });
	res.end(header);
}

describe("bounded avatar HTTP range verification", () => {
	test("checks all 270 URLs including encoded Unicode with at most four in flight", async () => {
		const seen = new Set<string>();
		let maxInFlight = 0;
		let final: MediaCheckProgress | undefined;
		await withServer(
			(url, res, range) => {
				expect(range).toBe("bytes=0-3");
				seen.add(url);
				valid(res);
			},
			async (origin) => {
				const urls = Array.from(
					{ length: 270 },
					(_, i) => `/raw?path=${encodeURIComponent(`avatar/${i}_难过.webm`)}`,
				);
				final = await verifyAvatarMedia(origin, [...urls, urls[0]!], {
					onProgress: (p) => {
						maxInFlight = Math.max(maxInFlight, p.inFlight.length);
					},
				});
			},
		);
		expect(seen.size).toBe(270);
		expect(maxInFlight).toBe(4);
		expect(final).toMatchObject({ total: 270, checked: 270, inFlight: [] });
		expect(final!.slowest).toHaveLength(5);
	});

	test.each(["status", "mime", "magic", "length"])(
		"rejects a bad %s on the final resource instead of reducing coverage",
		async (kind) => {
			await withServer(
				(url, res) => {
					if (url !== "/last") return valid(res);
					res.writeHead(kind === "status" ? 200 : 206, {
						"content-type": kind === "mime" ? "text/plain" : "video/webm",
					});
					res.end(
						kind === "magic"
							? Buffer.alloc(4)
							: kind === "length"
								? header.subarray(0, 3)
								: header,
					);
				},
				async (origin) => {
					await expect(
						verifyAvatarMedia(origin, ["/first", "/last"]),
					).rejects.toThrow("/last");
				},
			);
		},
	);

	test.each(["headers", "body"] as const)(
		"times out stalled %s and cancels in-flight siblings",
		async (phase) => {
			let seen = 0;
			let final: MediaCheckProgress | undefined;
			await withServer(
				(_url, res) => {
					seen += 1;
					if (phase === "body") {
						res.writeHead(206, {
							"content-type": "video/webm",
							"content-length": "4",
						});
						res.write(header.subarray(0, 1));
					}
				},
				async (origin) => {
					const started = performance.now();
					await expect(
						verifyAvatarMedia(
							origin,
							Array.from({ length: 20 }, (_, i) => `/stalled-${i}`),
							{
								requestTimeoutMs: 100,
								onProgress: (p) => {
									final = p;
								},
							},
						),
					).rejects.toThrow(`during ${phase}`);
					expect(performance.now() - started).toBeLessThan(1500);
				},
			);
			// 4 concurrent workers × the default 2 attempts per URL (a transient stall
			// is retried once before the URL is declared failed). The remaining 16
			// URLs are never fetched once the first failure cancels the batch.
			expect(seen).toBeLessThanOrEqual(8);
			expect(final).toMatchObject({ checked: 0, inFlight: [] });
		},
	);

	test("reduces accumulated serial latency without skipping requests or extending deadlines", async () => {
		let requests = 0;
		await withServer(
			(_url, res) => {
				requests += 1;
				const timer = setTimeout(() => valid(res), 25);
				res.on("close", () => clearTimeout(timer));
			},
			async (origin) => {
				const urls = Array.from({ length: 40 }, (_, i) => `/media-${i}`);
				const serialStart = performance.now();
				const serial = await verifyAvatarMedia(origin, urls, {
					concurrency: 1,
				});
				const serialMs = performance.now() - serialStart;
				const parallelStart = performance.now();
				const parallel = await verifyAvatarMedia(origin, urls);
				const parallelMs = performance.now() - parallelStart;
				expect(serial.checked).toBe(40);
				expect(parallel.checked).toBe(40);
				expect(parallelMs).toBeLessThan(serialMs * 0.65);
				expect(requests).toBe(80);
			},
		);
	});

	test("handles an empty roster and rejects invalid execution bounds", async () => {
		expect(await verifyAvatarMedia("http://127.0.0.1", [])).toMatchObject({
			total: 0,
			checked: 0,
			inFlight: [],
		});
		await expect(
			verifyAvatarMedia("http://127.0.0.1", [], { concurrency: 5 }),
		).rejects.toThrow("concurrency");
		await expect(
			verifyAvatarMedia("http://127.0.0.1", [], { requestTimeoutMs: 0 }),
		).rejects.toThrow("timeout");
	});
});
