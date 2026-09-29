/** Read-only UI events. WebSockets do not consume the HTTP/1 request pool. */
export function subscribeUiEvents(
	topic: string,
	listener: (event: unknown) => void,
	onOpen?: () => void,
): () => void {
	let stopped = false;
	let socket: WebSocket | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let delay = 500;
	const connect = () => {
		if (stopped) return;
		const url = new URL("/ws/ui-events", window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("topic", topic);
		const current = new WebSocket(url);
		socket = current;
		current.onopen = () => {
			if (stopped || current !== socket) return;
			delay = 500;
			onOpen?.();
		};
		current.onmessage = (event) => {
			if (stopped || current !== socket) return;
			let value: unknown;
			try {
				value = JSON.parse(String(event.data));
			} catch {
				return;
			}
			listener(value);
		};
		current.onerror = () => current.close();
		current.onclose = () => {
			if (stopped || current !== socket) return;
			socket = undefined;
			retry = setTimeout(connect, delay);
			delay = Math.min(delay * 2, 10_000);
		};
	};
	connect();
	return () => {
		stopped = true;
		if (retry !== undefined) clearTimeout(retry);
		socket?.close();
		socket = undefined;
	};
}
