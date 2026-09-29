import type {
	TransportRequest,
	TransportResponse,
	ViewportRuntimeClientSnapshot,
} from "@forgeax/editor/bridge";

const TRANSPORT_VERSION = "editor-transport/v1" as const;

type BrowserLocation = Pick<Location, "host" | "protocol">;

/** The released desktop shell is served by its dynamically allocated Server. */
export function editorServerTransportUrl(location: BrowserLocation): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/ws/editor/transport`;
}

export function viewportTransportScope(
	snapshot: ViewportRuntimeClientSnapshot,
): string | null {
	const runtime = snapshot.runtime;
	return snapshot.status === "ready" && runtime !== null
		? `viewport:${runtime.runtimeId}:${runtime.runtimeGeneration}`
		: null;
}

export async function forwardServerEditorRequest(
	request: TransportRequest,
	snapshot: ViewportRuntimeClientSnapshot,
	forward: (request: TransportRequest) => Promise<TransportResponse>,
	gameplay?: (input: unknown) => Promise<unknown>,
): Promise<TransportResponse> {
	const scope = viewportTransportScope(snapshot);
	if (scope === null) {
		return {
			jsonrpc: "2.0",
			version: TRANSPORT_VERSION,
			id: request.id,
			correlationId: request.correlationId,
			error: {
				code: "viewport-runtime-disconnected",
				hint: "The authoritative Viewport Runtime is not ready.",
				retryable: true,
				recoveryActions: ["transport.reconnect"],
			},
		};
	}
	// Gameplay is owned by the visible viewport's public bridge. The editing
	// transport does not install a gameplay executor; forwarding there reports
	// an unavailable bridge even while the visible game is running.
	if (request.method === "gameplay" && gameplay) {
		return {
			jsonrpc: "2.0",
			version: TRANSPORT_VERSION,
			id: request.id,
			correlationId: request.correlationId,
			result: await gameplay(request.params),
		};
	}
	const params =
		request.params !== null &&
		typeof request.params === "object" &&
		!Array.isArray(request.params)
			? (request.params as Record<string, unknown>)
			: null;
	const input =
		params?.input !== null &&
		typeof params?.input === "object" &&
		!Array.isArray(params.input)
			? (params.input as Record<string, unknown>)
			: {};
	const forwardedParams = params
		? {
				...params,
				...(params.scope === request.scope ? { scope } : {}),
				...(request.method === "run.dispatch" &&
				params.operationId === "editor.play"
					? {
							input: {
								...input,
								requestId:
									typeof input.requestId === "string"
										? input.requestId
										: request.correlationId,
							},
						}
					: {}),
			}
		: request.params;
	return forward({ ...request, scope, params: forwardedParams });
}
