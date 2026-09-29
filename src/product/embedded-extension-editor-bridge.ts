import type {
	EditorAssetImportSourceHandler,
	EditorAssetImportSourceRequest,
} from "@forgeax/app-shell/application";
import { installWindowMessageObservation } from "@forgeax/app-shell/react";

interface EditorAssetImportResultMessage {
	readonly type: "extension:editor-asset-import-result";
	readonly requestId: string;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRequest(value: unknown): EditorAssetImportSourceRequest | null {
	if (!isRecord(value) || value.type !== "extension:editor-asset-import")
		return null;
	const requestId = value.requestId;
	const base64 = value.base64;
	const destPath = value.destPath;
	const sourceName = value.sourceName;
	if (
		typeof requestId !== "string" ||
		requestId.trim() === "" ||
		typeof base64 !== "string" ||
		base64.trim() === "" ||
		typeof destPath !== "string" ||
		destPath.trim() === "" ||
		typeof sourceName !== "string" ||
		sourceName.trim() === ""
	)
		return null;
	return {
		requestId: requestId.trim(),
		base64,
		destPath: destPath.trim(),
		sourceName: sourceName.trim(),
	};
}

function failureHint(value: unknown): string | null {
	if (!isRecord(value) || value.ok !== false) return null;
	if (typeof value.error === "string") return value.error;
	if (isRecord(value.error) && typeof value.error.hint === "string")
		return value.error.hint;
	return "Editor asset import failed";
}

export interface ExtensionEditorBridgeOptions {
	readonly ownerWindow: Window;
	readonly frameWindow: () => Window | null;
	readonly importAssetSource?: EditorAssetImportSourceHandler;
	readonly isTrustedEvent?: (event: MessageEvent) => boolean;
}

/**
 * Attach the IDE host-side bridge for embedded extension frames. It owns only
 * the message envelope; Editor keeps the asset import implementation.
 */
export function attachExtensionEditorAssetImportBridge(
	options: ExtensionEditorBridgeOptions,
): () => void {
	let disposed = false;
	const onMessage = (event: MessageEvent): void => {
		if (disposed) return;
		if (options.isTrustedEvent && !options.isTrustedEvent(event)) return;
		const source = options.frameWindow();
		if (!source || event.source !== source) return;
		const request = parseRequest(event.data);
		if (!request) {
			if (
				isRecord(event.data) &&
				event.data.type === "extension:editor-asset-import"
			) {
				source.postMessage(
					{
						type: "extension:editor-asset-import-result",
						requestId:
							typeof event.data.requestId === "string"
								? event.data.requestId
								: "",
						ok: false,
						error: "导入请求格式无效",
					} satisfies EditorAssetImportResultMessage,
					"*",
				);
			}
			return;
		}

		const reply = (message: EditorAssetImportResultMessage): void => {
			if (disposed) return;
			source.postMessage(message, "*");
		};
		const handler = options.importAssetSource;
		if (!handler) {
			reply({
				type: "extension:editor-asset-import-result",
				requestId: request.requestId,
				ok: false,
				error: "当前 Studio 没有可用的 Editor Gateway",
			});
			return;
		}

		void Promise.resolve(handler(request))
			.then((result) => {
				const error = failureHint(result);
				reply({
					type: "extension:editor-asset-import-result",
					requestId: request.requestId,
					ok: error === null,
					...(error === null ? { result } : { error }),
				});
			})
			.catch((error: unknown) => {
				reply({
					type: "extension:editor-asset-import-result",
					requestId: request.requestId,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	};

	const disposeWindowMessageObservation = installWindowMessageObservation({
		target: options.ownerWindow,
		onMessage,
	});
	return () => {
		disposed = true;
		disposeWindowMessageObservation();
	};
}
