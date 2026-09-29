import { describe, expect, test } from "vitest";
import {
	createModelRouteService,
	currentCatalogProvider,
	deriveActiveSource,
} from "../src/integration/model-route";
import type { ModelCatalogEntry } from "../src/integration/rest-model-config-client";

function model(id: string, hidden = false): ModelCatalogEntry {
	return { id, hidden };
}

describe("IDE Settings model-route integration", () => {
	test("derives the active source and catalog provider without adding state", () => {
		expect(deriveActiveSource(null, null)).toBeNull();
		expect(deriveActiveSource("forgeax", "")).toBeNull();
		expect(deriveActiveSource(null, "gpt-5")).toBe("api-key");
		expect(deriveActiveSource("forgeax", "claude-sonnet")).toBe("api-key");
		expect(deriveActiveSource("codex", "gpt-5")).toBe("codex");
		expect(currentCatalogProvider(null)).toBeNull();
		expect(currentCatalogProvider("forgeax")).toBeNull();
		expect(currentCatalogProvider("claude-code")).toBe("claude-code");
	});

	test("persists native model selection before clearing the CLI override", async () => {
		const requests: Array<{ input: string; init?: RequestInit }> = [];
		const providerOverrides: Array<string | null> = [];
		const service = createModelRouteService({
			getState: () => ({
				tabs: [],
				setProviderOverride: (provider) => providerOverrides.push(provider),
			}),
			listModels: async () => [],
			setAgentModels: async () => ({
				selected: "",
				chain: [],
				restarted: false,
			}),
			request: async (input, init) => {
				requests.push({ input, init });
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			},
		});

		await service.applyModelRoute({ kind: "api-key", model: "gpt-5" });
		expect(requests).toHaveLength(1);
		expect(requests[0]?.input).toBe("/api/settings/env");
		expect(requests[0]?.init?.method).toBe("PUT");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			FORGEAX_MODEL: "gpt-5",
		});
		expect(providerOverrides).toEqual([null]);

		await service.applyModelRoute({ kind: "cli", providerId: "codex" });
		expect(requests).toHaveLength(1);
		expect(providerOverrides).toEqual([null, "codex"]);
	});

	test("does not mutate the provider override when native persistence fails", async () => {
		const providerOverrides: Array<string | null> = [];
		const service = createModelRouteService({
			getState: () => ({
				tabs: [],
				setProviderOverride: (provider) => providerOverrides.push(provider),
			}),
			listModels: async () => [],
			setAgentModels: async () => ({
				selected: "",
				chain: [],
				restarted: false,
			}),
			request: async () =>
				new Response(
					JSON.stringify({ ok: false, error: "settings rejected" }),
					{ status: 500 },
				),
		});

		await expect(
			service.applyModelRoute({ kind: "api-key", model: "gpt-5" }),
		).rejects.toThrow("settings rejected");
		expect(providerOverrides).toEqual([]);
	});

	test("resets every valid open session independently to the first visible model", async () => {
		const listCalls: Array<string | null> = [];
		const writes: Array<{ sid: string; agentPath: string; models: string[] }> =
			[];
		const warnings: unknown[][] = [];
		const service = createModelRouteService({
			getState: () => ({
				tabs: [
					{ sid: "session-a", agentId: "agent-a" },
					{ sid: null, agentId: "missing-session" },
					{ sid: "session-b", agentId: "agent-b" },
					{ sid: "session-c", agentId: "agent-c" },
				],
				setProviderOverride() {},
			}),
			listModels: async (provider) => {
				listCalls.push(provider ?? null);
				return [model("hidden", true), model("visible"), model("later")];
			},
			setAgentModels: async (sid, agentPath, models) => {
				writes.push({ sid, agentPath, models });
				if (sid === "session-b") throw new Error("agent write failed");
				return { selected: models[0]!, chain: models, restarted: false };
			},
			request: async () =>
				new Response(JSON.stringify({ ok: true }), { status: 200 }),
			warn: (...args) => warnings.push(args),
		});

		await expect(
			service.resetOpenSessionsModelToProviderDefault("codex"),
		).resolves.toEqual({
			selected: "visible",
			count: 2,
		});
		expect(listCalls).toEqual(["codex"]);
		expect(writes).toEqual([
			{ sid: "session-a", agentPath: "agent-a", models: ["visible"] },
			{ sid: "session-b", agentPath: "agent-b", models: ["visible"] },
			{ sid: "session-c", agentPath: "agent-c", models: ["visible"] },
		]);
		expect(warnings).toHaveLength(1);
	});

	test("does no transport work without sessions and returns null for an empty catalog", async () => {
		let stateReads = 0;
		let listCalls = 0;
		const service = createModelRouteService({
			getState: () => {
				stateReads += 1;
				return {
					tabs:
						stateReads === 1 ? [] : [{ sid: "session-a", agentId: "agent-a" }],
					setProviderOverride() {},
				};
			},
			listModels: async () => {
				listCalls += 1;
				return [];
			},
			setAgentModels: async () => ({
				selected: "",
				chain: [],
				restarted: false,
			}),
			request: async () =>
				new Response(JSON.stringify({ ok: true }), { status: 200 }),
		});

		await expect(
			service.resetOpenSessionsModelToProviderDefault(null),
		).resolves.toBeNull();
		expect(listCalls).toBe(0);
		await expect(
			service.resetOpenSessionsModelToProviderDefault(null),
		).resolves.toBeNull();
		expect(listCalls).toBe(1);
	});
});

test.each([
	["remembered", "remembered"],
	["hidden", "first"],
	["removed", "first"],
])("provider reset handles saved model %s", async (saved, selected) => {
	const service = createModelRouteService({
		getState: () => ({
			tabs: [{ sid: "session", agentId: "root" }],
			setProviderOverride() {},
		}),
		getLastModel: (providerId) => {
			expect(providerId).toBe("codex");
			return saved;
		},
		listModels: async () => [
			model("first"),
			model("remembered"),
			model("hidden", true),
		],
		setAgentModels: async (_sid, _agent, models) => {
			expect(models).toEqual([selected]);
			return { selected: models[0]!, chain: models, restarted: false };
		},
	});
	expect(
		await service.resetOpenSessionsModelToProviderDefault("codex"),
	).toEqual({ selected, count: 1 });
});
