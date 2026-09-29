import { describe, expect, test } from "vitest";
import { attachExtensionEditorAssetImportBridge } from "../src/product/embedded-extension-editor-bridge";

function windows() {
	let listener: ((event: MessageEvent) => void) | undefined;
	const ownerWindow = {
		addEventListener: (_type: string, next: (event: MessageEvent) => void) => {
			listener = next;
		},
		removeEventListener: () => {
			listener = undefined;
		},
	} as unknown as Window;
	const replies: unknown[] = [];
	const frameWindow = {
		postMessage: (message: unknown) => replies.push(message),
	} as unknown as Window;
	return {
		ownerWindow,
		frameWindow,
		replies,
		send(source: Window, data: unknown) {
			listener?.({ source, data } as MessageEvent);
		},
		isListening: () => Boolean(listener),
	};
}

describe("IDE embedded extension Editor asset bridge", () => {
	test("forwards a valid request to the injected Editor callback", async () => {
		const browser = windows();
		let received: unknown;
		const detach = attachExtensionEditorAssetImportBridge({
			ownerWindow: browser.ownerWindow,
			frameWindow: () => browser.frameWindow,
			importAssetSource: async (request) => {
				received = request;
				return { ok: true, requestId: request.requestId };
			},
		});

		browser.send(browser.frameWindow, {
			type: "extension:editor-asset-import",
			requestId: "request-1",
			destPath: "assets/3d/robot.glb",
			sourceName: "robot.glb",
			base64: "Z2xi",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(received).toEqual({
			requestId: "request-1",
			destPath: "assets/3d/robot.glb",
			sourceName: "robot.glb",
			base64: "Z2xi",
		});
		expect(browser.replies).toEqual([
			{
				type: "extension:editor-asset-import-result",
				requestId: "request-1",
				ok: true,
				result: { ok: true, requestId: "request-1" },
			},
		]);
		detach();
		expect(browser.isListening()).toBe(false);
	});

	test("ignores other frames and rejects malformed requests from its frame", () => {
		const browser = windows();
		const detach = attachExtensionEditorAssetImportBridge({
			ownerWindow: browser.ownerWindow,
			frameWindow: () => browser.frameWindow,
		});
		browser.send({} as Window, {
			type: "extension:editor-asset-import",
			requestId: "foreign",
		});
		expect(browser.replies).toEqual([]);
		browser.send(browser.frameWindow, {
			type: "extension:editor-asset-import",
			requestId: "bad",
		});
		expect(browser.replies).toEqual([
			{
				type: "extension:editor-asset-import-result",
				requestId: "bad",
				ok: false,
				error: "导入请求格式无效",
			},
		]);
		detach();
	});
});
