import { registerChatSendPreparation } from "@forgeax/chat/send-preparation";
import {
	executeLiveGameplay,
	forwardViewportRuntimeTransportRequest,
	getViewportRuntimeClientSnapshot,
	subscribePlayCarrierEvents,
	subscribeViewportRuntimeClient,
	type TransportRequest,
} from "@forgeax/editor/bridge";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
	editorServerTransportUrl,
	forwardServerEditorRequest,
	viewportTransportScope,
} from "./editor-server-transport-core";

const TRANSPORT_VERSION = "editor-transport/v1" as const;

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function isTransportRequest(value: unknown): value is TransportRequest {
	const request = record(value);
	return (
		request?.jsonrpc === "2.0" &&
		request.version === TRANSPORT_VERSION &&
		typeof request.id === "string" &&
		typeof request.correlationId === "string" &&
		typeof request.scope === "string" &&
		typeof request.method === "string" &&
		Object.hasOwn(request, "params")
	);
}

export function EditorServerTransport({
	gameSlug,
}: {
	readonly gameSlug: string;
}): null {
	const pageIdentity = useRef(crypto.randomUUID());
	const snapshot = useSyncExternalStore(
		subscribeViewportRuntimeClient,
		getViewportRuntimeClientSnapshot,
		getViewportRuntimeClientSnapshot,
	);
	const internalScope = viewportTransportScope(snapshot);

	useEffect(() => {
		const externalScope = `game:${gameSlug}`;
		const pageId = pageIdentity.current;
		const playRequests = new Map<string, string>();
		let registered = false;
		let disposed = false;
		let reconnect: ReturnType<typeof setTimeout> | null = null;
		let socket: WebSocket | null = null;

		const presence = () =>
			({
				visibility:
					document.visibilityState === "visible" ? "visible" : "hidden",
				focused: document.hasFocus(),
				capabilities: { gameplay: true },
			}) as const;
		const sendPresence = () => {
			if (socket?.readyState !== WebSocket.OPEN) return;
			socket.send(
				JSON.stringify({ type: "editor-transport/presence", ...presence() }),
			);
		};
		const engage = (event: Event) => {
			if (!event.isTrusted || socket?.readyState !== WebSocket.OPEN) return;
			socket.send(
				JSON.stringify({ type: "editor-transport/engage", ...presence() }),
			);
		};
		const connect = () => {
			if (disposed) return;
			const current = new WebSocket(editorServerTransportUrl(window.location));
			socket = current;
			current.onopen = () => {
				current.send(
					JSON.stringify({
						type: "editor-transport/ready",
						version: TRANSPORT_VERSION,
						role: "interactive",
						scope: externalScope,
						pageId,
						...presence(),
					}),
				);
			};
			current.onmessage = (event) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(String(event.data));
				} catch {
					return;
				}
				const message = record(parsed);
				if (
					message?.type === "editor-transport/registered" &&
					message.pageId === pageId &&
					message.scope === externalScope
				)
					registered = true;
				const request =
					message?.type === "editor-transport/request" ? message.request : null;
				if (!isTransportRequest(request) || request.scope !== externalScope)
					return;
				const params = record(request.params);
				const input = record(params?.input);
				if (
					request.method === "run.dispatch" &&
					params?.operationId === "editor.play"
				) {
					const requestId =
						typeof input?.requestId === "string"
							? input.requestId
							: request.correlationId;
					if (playRequests.size >= 50)
						playRequests.delete(playRequests.keys().next().value!);
					playRequests.set(requestId, request.correlationId);
				}
				void forwardServerEditorRequest(
					request,
					getViewportRuntimeClientSnapshot(),
					forwardViewportRuntimeTransportRequest,
					executeLiveGameplay,
				).then((response) => {
					if (current.readyState !== WebSocket.OPEN) return;
					current.send(
						JSON.stringify({ type: "editor-transport/response", response }),
					);
				});
			};
			current.onclose = () => {
				registered = false;
				if (disposed) return;
				reconnect = setTimeout(connect, 500);
			};
		};

		const unsubscribeCarrier = subscribePlayCarrierEvents(
			({ requestId, event }) => {
				if (
					!requestId ||
					!playRequests.has(requestId) ||
					socket?.readyState !== WebSocket.OPEN ||
					!registered
				)
					return;
				socket.send(
					JSON.stringify({
						type: "editor-transport/runtime-event",
						version: TRANSPORT_VERSION,
						scope: externalScope,
						correlationId: playRequests.get(requestId),
						event,
					}),
				);
			},
		);
		document.addEventListener("pointerdown", engage, true);
		document.addEventListener("keydown", engage, true);
		document.addEventListener("visibilitychange", sendPresence);
		window.addEventListener("focus", sendPresence);
		window.addEventListener("blur", sendPresence);
		const removePreparation = registerChatSendPreparation(
			async ({ sessionId }) => {
				if (
					internalScope === null ||
					!registered ||
					socket?.readyState !== WebSocket.OPEN
				)
					throw new Error(
						"The game editor is not ready. Wait for the page to connect before sending.",
					);
				const response = await fetch("/api/editor/transport/bind", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, scope: externalScope, pageId }),
					signal: AbortSignal.timeout(5000),
				});
				if (!response.ok)
					throw new Error(
						"The originating editor page could not be bound. Reconnect this game page before sending.",
					);
			},
		);
		if (internalScope !== null) connect();
		return () => {
			removePreparation();
			unsubscribeCarrier();
			disposed = true;
			if (reconnect !== null) clearTimeout(reconnect);
			document.removeEventListener("pointerdown", engage, true);
			document.removeEventListener("keydown", engage, true);
			document.removeEventListener("visibilitychange", sendPresence);
			window.removeEventListener("focus", sendPresence);
			window.removeEventListener("blur", sendPresence);
			socket?.close();
		};
	}, [gameSlug, internalScope]);

	return null;
}
