import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { createRestModelConfigClient } from "../src/integration/rest-model-config-client";

function response(body: unknown, status = 200): Promise<Response> {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	} as Response);
}

describe("IDE REST model config integration", () => {
	test("owns its transport contract without importing Interface", async () => {
		const source = await readFile(
			new URL(
				"../src/integration/rest-model-config-client.ts",
				import.meta.url,
			),
			"utf8",
		);

		expect(source).not.toContain("@forgeax/interface");
		expect(source).toContain("export interface RestModelConfigClient");
	});

	test("lists the gateway or provider-scoped catalog through list_models", async () => {
		const request = vi.fn((_input: string, _init?: RequestInit) =>
			response({
				result: {
					ok: true,
					data: {
						models: [{ id: "model-a", source: "live", live: true }],
						driver: {
							id: "codex",
							source: "kernel",
							ids: 1,
						},
					},
				},
			}),
		);
		const client = createRestModelConfigClient(
			request as unknown as typeof fetch,
		);

		expect(await client.listModels()).toEqual([
			{ id: "model-a", source: "live", live: true },
		]);
		expect(await client.listModels("codex")).toEqual([
			{ id: "model-a", source: "live", live: true },
		]);
		expect(await client.listModelsWithMeta("codex")).toEqual({
			models: [{ id: "model-a", source: "live", live: true }],
			driver: { id: "codex", source: "kernel", ids: 1 },
		});
		expect(request.mock.calls).toEqual([
			[
				"/api/commands/list_models/query",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ args: [] }),
				},
			],
			[
				"/api/commands/list_models/query",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ args: ["codex"] }),
				},
			],
			[
				"/api/commands/list_models/query",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ args: ["codex"] }),
				},
			],
		]);
	});

	test("gets and sets the selected agent model through canonical command routes", async () => {
		const request = vi.fn((input: string, _init?: RequestInit) =>
			response({
				result: input.endsWith("/query")
					? {
							ok: true,
							data: {
								sid: "session/one",
								agentPath: "agents/forge",
								selected: "model-a",
								chain: ["model-a"],
								raw: ["model-a"],
							},
						}
					: {
							ok: true,
							data: {
								selected: "model-b",
								chain: ["model-b", "model-c"],
								restarted: true,
							},
						},
			}),
		);
		const client = createRestModelConfigClient(
			request as unknown as typeof fetch,
		);

		expect(await client.getAgentModel("session/one", "agents/forge")).toEqual({
			sid: "session/one",
			agentPath: "agents/forge",
			selected: "model-a",
			chain: ["model-a"],
			raw: ["model-a"],
		});
		expect(
			await client.setAgentModels("session/one", "agents/forge", [
				"model-b",
				"model-c",
			]),
		).toEqual({
			selected: "model-b",
			chain: ["model-b", "model-c"],
			restarted: true,
		});
		expect(request.mock.calls).toEqual([
			[
				"/api/commands/get_agent_model/query",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ args: ["session/one", "agents/forge"] }),
				},
			],
			[
				"/api/commands/set_agent_models/execute",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						args: ["session/one", "agents/forge", "model-b", "model-c"],
					}),
				},
			],
		]);
	});

	test("preserves validation and command-envelope error behavior", async () => {
		const failedRequest = vi.fn(() =>
			response({ result: { ok: false, error: "catalog unavailable" } }, 503),
		);
		const failed = createRestModelConfigClient(
			failedRequest as unknown as typeof fetch,
		);
		const fallback = createRestModelConfigClient(
			vi.fn(() => response({}, 502)) as unknown as typeof fetch,
		);
		const request = vi.fn(() => response({ result: { ok: true, data: {} } }));
		const valid = createRestModelConfigClient(
			request as unknown as typeof fetch,
		);

		await expect(failed.listModels()).rejects.toThrow("catalog unavailable");
		await expect(fallback.getAgentModel("sid", "agent")).rejects.toThrow(
			"get_agent_model failed (HTTP 502)",
		);
		await expect(valid.setAgentModels("sid", "agent", [])).rejects.toThrow(
			"setAgentModels: at least one model required",
		);
		expect(request).not.toHaveBeenCalled();
	});
});
