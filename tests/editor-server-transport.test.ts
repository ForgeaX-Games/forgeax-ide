import type {
	TransportRequest,
	ViewportRuntimeClientSnapshot,
} from "@forgeax/editor/bridge";
import { describe, expect, test } from "vitest";
import {
	editorServerTransportUrl,
	forwardServerEditorRequest,
	viewportTransportScope,
} from "../src/integration/editor-server-transport-core";

const readySnapshot: ViewportRuntimeClientSnapshot = {
	status: "ready",
	runtime: {
		version: "viewport-runtime/v1",
		runtimeId: "runtime-7",
		runtimeGeneration: 3,
		carrierId: "studio-viewport",
		carrierKind: "iframe",
	},
	catalogRoots: null,
};

const request: TransportRequest = {
	jsonrpc: "2.0",
	version: "editor-transport/v1",
	id: "request-1",
	correlationId: "correlation-1",
	scope: "game:snake",
	method: "discover",
	params: { scope: "game:snake" },
};

describe("released Studio Editor transport bridge", () => {
	test("uses the page origin so desktop dynamic ports and Vite proxy share one route", () => {
		expect(
			editorServerTransportUrl({ protocol: "http:", host: "127.0.0.1:18810" }),
		).toBe("ws://127.0.0.1:18810/ws/editor/transport");
		expect(
			editorServerTransportUrl({
				protocol: "https:",
				host: "studio.example.test",
			}),
		).toBe("wss://studio.example.test/ws/editor/transport");
	});

	test("routes the game-scoped Server request through the one active Viewport service", async () => {
		expect(viewportTransportScope(readySnapshot)).toBe("viewport:runtime-7:3");
		const forwarded: TransportRequest[] = [];
		const response = await forwardServerEditorRequest(
			request,
			readySnapshot,
			async (input) => {
				forwarded.push(input);
				return {
					jsonrpc: "2.0",
					version: "editor-transport/v1",
					id: input.id,
					correlationId: input.correlationId,
					result: { ok: true },
				};
			},
		);
		expect(forwarded[0]).toEqual({
			...request,
			scope: "viewport:runtime-7:3",
			params: {
				...(request.params as Record<string, unknown>),
				scope: "viewport:runtime-7:3",
			},
		});
		expect(response).toMatchObject({ result: { ok: true } });
	});

	test("routes gameplay to the public mounted-viewport bridge and preserves its result", async () => {
		const input = { version: 1, operation: "describe" };
		const result = {
			version: 1,
			operation: "describe",
			ok: false,
			error: {
				owner: "editor-gameplay-carrier",
				phase: "producer",
				retryable: true,
				code: "surface-unavailable",
				hint: "game stopped",
			},
		};
		let received: unknown;
		const response = await forwardServerEditorRequest(
			{ ...request, method: "gameplay", params: input },
			readySnapshot,
			async () => {
				throw new Error("gameplay must not enter the editing transport");
			},
			async (value) => {
				received = value;
				return result;
			},
		);
		expect(received).toEqual(input);
		expect(response).toEqual({
			jsonrpc: request.jsonrpc,
			version: request.version,
			id: request.id,
			correlationId: request.correlationId,
			result,
		});
	});

	test("fails closed until the authoritative Viewport client is ready", async () => {
		const disconnected: ViewportRuntimeClientSnapshot = {
			status: "disconnected",
			runtime: null,
			catalogRoots: null,
		};
		await expect(
			forwardServerEditorRequest(request, disconnected, async () => {
				throw new Error("disconnected requests must not reach the viewport");
			}),
		).resolves.toMatchObject({
			error: { code: "viewport-runtime-disconnected" },
		});
	});
});

test("Play forwards a stable operation request id for asynchronous failure correlation", async () => {
	for (const requestId of [undefined, "existing-play"]) {
		let received: TransportRequest | undefined;
		await forwardServerEditorRequest(
			{
				...request,
				method: "run.dispatch",
				params: {
					operationId: "editor.play",
					input: {
						dirtyPolicy: "last-saved",
						...(requestId ? { requestId } : {}),
					},
				},
			},
			readySnapshot,
			async (value) => {
				received = value;
				return {
					jsonrpc: "2.0",
					version: "editor-transport/v1",
					id: value.id,
					correlationId: value.correlationId,
					result: {},
				};
			},
		);
		expect(received?.params).toMatchObject({
			input: {
				requestId: requestId ?? request.correlationId,
				dirtyPolicy: "last-saved",
			},
		});
	}
});
