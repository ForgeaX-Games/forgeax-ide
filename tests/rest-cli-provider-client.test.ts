import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	createRestCliProviderClient,
	displayableKernelCapabilities,
} from "../src/integration/rest-cli-provider-client";

const realDateNow = Date.now;

function response(body: unknown, status = 200): Promise<Response> {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	} as Response);
}

afterEach(() => {
	Date.now = realDateNow;
});

describe("IDE REST CLI provider integration", () => {
	test("owns its transport contract without importing Interface", async () => {
		const source = await readFile(
			new URL(
				"../src/integration/rest-cli-provider-client.ts",
				import.meta.url,
			),
			"utf8",
		);

		expect(source).not.toContain("@forgeax/interface");
		expect(source).toContain("export interface RestCliProviderClient");
	});

	test("maps provider health through the canonical server route", async () => {
		Date.now = () => 1234;
		const request = vi.fn(() =>
			response({
				providers: [
					{
						id: "forgeax-core",
						ok: true,
						detail: "ready",
						capabilities: {
							streaming: true,
							sessions: true,
							forkExtract: false,
						},
					},
					{
						id: "custom-provider",
						ok: false,
					},
				],
			}),
		);
		const client = createRestCliProviderClient(
			request as unknown as typeof fetch,
		);

		const result = await client.fetchCliProviders(true);

		expect(request).toHaveBeenCalledWith("/api/cli/health");
		expect(result).toEqual({
			providers: [
				{
					id: "forgeax-core",
					displayName: "ForgeaX Kernel",
					health: { ok: true, detail: "ready" },
					capabilities: { streaming: true, forkExtract: false },
				},
				{
					id: "custom-provider",
					displayName: "custom-provider",
					health: { ok: false, detail: undefined },
					capabilities: {},
				},
			],
			cachedAt: 1234,
		});
	});

	test("retains only kernel capabilities shared with the product UI", () => {
		expect(
			displayableKernelCapabilities({
				streaming: false,
				thinking: true,
				toolCalls: false,
				midTurnInject: true,
				forkExtract: false,
				sessions: true,
				jsonlReplay: true,
			}),
		).toEqual({
			streaming: false,
			thinking: true,
			toolCalls: false,
			midTurnInject: true,
			forkExtract: false,
		});
	});

	test("preserves the existing non-success and JSON failure behavior", async () => {
		const unavailable = createRestCliProviderClient(
			vi.fn(() => response({}, 503)) as unknown as typeof fetch,
		);
		const malformed = createRestCliProviderClient(
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.reject(new SyntaxError("invalid JSON")),
				} as Response),
			) as unknown as typeof fetch,
		);

		await expect(unavailable.fetchCliProviders()).rejects.toThrow(
			"/api/cli/health 503",
		);
		await expect(malformed.fetchCliProviders()).rejects.toThrow("invalid JSON");
	});
});
