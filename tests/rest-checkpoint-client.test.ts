import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { createRestCheckpointClient } from "../src/integration/rest-checkpoint-client";

function response(body: unknown, status = 200): Promise<Response> {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	} as Response);
}

describe("IDE REST checkpoint integration", () => {
	test("owns its transport contract without importing Interface", async () => {
		const source = await readFile(
			new URL("../src/integration/rest-checkpoint-client.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("@forgeax/interface");
		expect(source).toContain("export interface RestCheckpointClient");
	});

	test("fetches encoded session checkpoints with the caller signal", async () => {
		const request = vi.fn(() =>
			response({
				checkpoints: [{ msgId: "m1", ts: 42, hasCode: true }],
				pending: null,
			}),
		);
		const client = createRestCheckpointClient(
			request as unknown as typeof fetch,
		);
		const controller = new AbortController();

		const result = await client.fetchCheckpoints(
			"session/one",
			controller.signal,
		);

		expect(request).toHaveBeenCalledWith(
			"/api/sessions/session%2Fone/checkpoints",
			{
				signal: controller.signal,
			},
		);
		expect(result).toEqual({
			checkpoints: [{ msgId: "m1", ts: 42, hasCode: true }],
			pending: null,
		});
	});

	test("posts each rewind operation to the canonical encoded route and body", async () => {
		const request = vi.fn((input: string, _init?: RequestInit) =>
			response(
				input.endsWith("/preview")
					? {
							filesChanged: ["a.ts"],
							insertions: 2,
							deletions: 1,
							binaryOrLarge: 0,
						}
					: input.endsWith("/rewind")
						? { boundaryId: "b0", filesChanged: ["a.ts"], keptDirty: [] }
						: input.endsWith("/cancel")
							? { keptDirty: ["local.ts"] }
							: { files: ["a.ts"] },
			),
		);
		const client = createRestCheckpointClient(
			request as unknown as typeof fetch,
		);

		expect(await client.rewindPreview("sid / one", "m1")).toEqual({
			filesChanged: ["a.ts"],
			insertions: 2,
			deletions: 1,
			binaryOrLarge: 0,
		});
		expect(await client.rewindTo("sid / one", "m2", "conversation")).toEqual({
			boundaryId: "b0",
			filesChanged: ["a.ts"],
			keptDirty: [],
		});
		expect(await client.rewindCancel("sid / one", "b1")).toEqual({
			keptDirty: ["local.ts"],
		});
		expect(await client.rewindOverwriteDirty("sid / one", "b2")).toEqual({
			files: ["a.ts"],
		});
		expect(await client.rewindUndoOverwrite("sid / one", "b3")).toEqual({
			files: ["a.ts"],
		});

		expect(request.mock.calls).toEqual([
			[
				"/api/sessions/sid%20%2F%20one/rewind/preview",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ msgId: "m1" }),
				},
			],
			[
				"/api/sessions/sid%20%2F%20one/rewind",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ msgId: "m2", mode: "conversation" }),
				},
			],
			[
				"/api/sessions/sid%20%2F%20one/rewind/cancel",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ boundaryId: "b1" }),
				},
			],
			[
				"/api/sessions/sid%20%2F%20one/rewind/overwrite-dirty",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ boundaryId: "b2" }),
				},
			],
			[
				"/api/sessions/sid%20%2F%20one/rewind/undo-overwrite",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ boundaryId: "b3" }),
				},
			],
		]);
	});

	test("preserves GET and POST error behavior", async () => {
		const getFailure = createRestCheckpointClient(
			vi.fn(() => response({}, 503)) as unknown as typeof fetch,
		);
		const postDetail = createRestCheckpointClient(
			vi.fn(() =>
				response({ error: "dirty files" }, 409),
			) as unknown as typeof fetch,
		);
		const postFallback = createRestCheckpointClient(
			vi.fn(() =>
				Promise.resolve({
					ok: false,
					status: 502,
					json: () => Promise.reject(new SyntaxError("invalid JSON")),
				} as Response),
			) as unknown as typeof fetch,
		);

		await expect(getFailure.fetchCheckpoints("sid")).rejects.toThrow(
			"GET checkpoints 503",
		);
		await expect(postDetail.rewindCancel("sid", "b1")).rejects.toThrow(
			"dirty files",
		);
		await expect(postFallback.rewindCancel("sid", "b1")).rejects.toThrow(
			"HTTP 502",
		);
	});
});
