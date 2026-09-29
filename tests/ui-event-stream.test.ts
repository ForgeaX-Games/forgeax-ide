import { afterEach, expect, test, vi } from "vitest";
import { createRestStudioDomainClients } from "../src/integration/rest-studio-domain-clients";
import { subscribeUiEvents } from "../src/integration/ui-event-stream";

class Socket {
	static instances: Socket[] = [];
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onclose?: () => void;
	onerror?: () => void;
	closed = false;
	constructor(readonly url: URL) {
		Socket.instances.push(this);
	}
	close() {
		this.closed = true;
		this.onclose?.();
	}
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	Socket.instances = [];
});
function setup() {
	vi.stubGlobal("window", {
		location: { href: "https://studio.example.test/game" },
	});
	vi.stubGlobal("WebSocket", Socket);
}
test("UI events reconnect and disposal prevents all later callbacks", () => {
	setup();
	vi.useFakeTimers();
	const listener = vi.fn();
	const opened = vi.fn();
	const stop = subscribeUiEvents("projects.active.changed", listener, opened);
	const first = Socket.instances[0]!;
	expect(first.url.protocol).toBe("wss:");
	expect(first.url.searchParams.get("topic")).toBe("projects.active.changed");
	first.onopen?.();
	first.onmessage?.({ data: "invalid" });
	first.onmessage?.({ data: '{"payload":1}' });
	expect(listener).toHaveBeenCalledExactlyOnceWith({ payload: 1 });
	first.close();
	vi.advanceTimersByTime(500);
	expect(Socket.instances).toHaveLength(2);
	const second = Socket.instances[1]!;
	stop();
	second.onopen?.();
	second.onmessage?.({ data: "{}" });
	vi.advanceTimersByTime(20000);
	expect(Socket.instances).toHaveLength(2);
	expect(second.closed).toBe(true);
	expect(opened).toHaveBeenCalledTimes(1);
	expect(listener).toHaveBeenCalledTimes(1);
});
test("a newer project event wins over the outstanding authority read", async () => {
	setup();
	let resolve!: (response: Response) => void;
	const pending = new Promise<Response>((done) => {
		resolve = done;
	});
	const fetcher = vi.fn((_url: string, _init?: RequestInit) => pending);
	vi.stubGlobal("fetch", fetcher);
	const listener = vi.fn();
	const stop =
		createRestStudioDomainClients().projects.subscribeActiveProject(listener);
	const socket = Socket.instances[0]!;
	socket.onopen?.();
	socket.onmessage?.({
		data: JSON.stringify({ payload: { activeSlug: "new-game" } }),
	});
	resolve(Response.json({ activeSlug: "old-game" }));
	await pending;
	await new Promise((done) => setTimeout(done, 0));
	expect(listener).toHaveBeenCalledExactlyOnceWith({ activeSlug: "new-game" });
	stop();
	expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
