import {
	__resetRegistryForTest,
	registerAction,
	registerStateSlice,
} from "@forgeax/app-shell/application";
import { expect, test } from "vitest";
import type {
	UiActionBridgeContext,
	UiActionBridgeEvent,
} from "../src/product/ui-action-bridge";
import { bootIdeUiActionBridge } from "../src/product/ui-action-bridge";

test("lease authority preserves manifest, queries, visibility, renewal and debounce policy", async () => {
	const saved = new Map<string, PropertyDescriptor | undefined>();
	const replace = (key: string, value: unknown) => {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value,
		});
	};
	const focus = new EventTarget();
	let focused = true;
	const doc = Object.assign(new EventTarget(), {
		visibilityState: "visible",
		hasFocus: () => focused,
	});
	const timeouts = new Map<number, () => void>();
	let interval: (() => void) | undefined;
	let serial = 0;
	let now = 1000;
	const oldNow = Date.now;
	let activeSid: string | null = "session / one";
	let activeListener: (sid: string | null) => void = () => {};
	let queryListener: (event: UiActionBridgeEvent) => void = () => {};
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	let deny = false;
	let fail = false;
	let installed = 0;
	let screenshotQuery: unknown;
	const settle = async () => {
		for (let i = 0; i < 30; i++) await Promise.resolve();
	};
	const count = (suffix: string) =>
		requests.filter((r) => r.path.endsWith(suffix)).length;
	const query = async (
		kind: string,
		sid = activeSid!,
		input: unknown = {},
		reqId: unknown = "request",
	) => {
		queryListener({
			sid,
			event: {
				type: "perception:query",
				payload: { kind, query: input, reqId },
			},
		});
		await settle();
	};
	const reply = () =>
		requests.filter((r) => r.path.endsWith("/perception-reply")).at(-1)!.body;
	try {
		__resetRegistryForTest();
		Date.now = () => now;
		replace("window", focus);
		replace("document", doc);
		replace("setTimeout", (callback: () => void, delay: number) => {
			expect(delay).toBe(300);
			const id = ++serial;
			timeouts.set(id, callback);
			return id;
		});
		replace("clearTimeout", (id: number) => timeouts.delete(id));
		replace("setInterval", (callback: () => void, delay: number) => {
			expect(delay).toBe(10000);
			interval = callback;
			return 1;
		});
		replace("fetch", async (path: string, init: RequestInit) => {
			const request = {
				path,
				body: JSON.parse(String(init.body)) as Record<string, unknown>,
			};
			requests.push(request);
			expect(init.method).toBe("POST");
			if (fail) throw new Error("offline");
			return {
				json: async () =>
					path.endsWith("/ui-lease")
						? { ok: !deny, leaseId: "lease", ttlMs: 30000 }
						: {},
			};
		});
		const context: UiActionBridgeContext = {
			getActiveSid: () => activeSid,
			subscribeActiveSid: (listener) => {
				activeListener = listener;
			},
			subscribeSessionEvents: (listener) => {
				queryListener = listener;
			},
			installPresentation: () => {
				installed++;
			},
			buildA11ySummary: () => ({ marker: "a11y" }),
			captureUiScreenshot: async (input) => {
				screenshotQuery = input;
				return { captured: false, reason: "fixture" };
			},
		};
		bootIdeUiActionBridge(context);
		await settle();
		expect(installed).toBe(1);
		expect(requests.map((r) => r.path)).toEqual([
			"/api/sessions/session%20%2F%20one/ui-lease",
			"/api/sessions/session%20%2F%20one/ui-manifest",
		]);
		const clientId = requests[0]!.body.clientId;
		expect(typeof clientId).toBe("string");
		expect(requests[1]!.body.leaseId).toBe("lease");
		let invoked: Record<string, unknown> | undefined;
		registerAction({
			id: "fixture.action",
			title: "Fixture",
			capability: "read",
			run: (args) => {
				invoked = args;
				return { status: "completed" };
			},
		});
		registerStateSlice("fixture", () => ({ selected: true }));
		expect(timeouts.size).toBe(1);
		for (const callback of timeouts.values()) callback();
		timeouts.clear();
		await settle();
		expect(count("/ui-manifest")).toBe(2);
		await query("ui_snapshot", activeSid!, {
			detail: "a11y",
			ids: ["fixture.action", 17],
		});
		expect(reply().leaseId).toBe("lease");
		expect(reply().reqId).toBe("request");
		expect((reply().snapshot as Record<string, unknown>).a11y).toEqual({
			marker: "a11y",
		});
		expect((reply().snapshot as Record<string, unknown>).state).toEqual({
			fixture: { selected: true },
		});
		await query("ui_invoke", activeSid!, {
			actionId: "fixture.action",
			args: { value: 7 },
		});
		expect(invoked).toEqual({ value: 7 });
		expect((reply().snapshot as Record<string, unknown>).status).toBe(
			"completed",
		);
		await query("ui_invoke", activeSid!, {});
		expect((reply().snapshot as Record<string, unknown>).status).toBe(
			"rejected",
		);
		await query("ui_screenshot", activeSid!, { target: "panel" });
		expect(screenshotQuery).toEqual({ target: "panel" });
		expect(reply().snapshot).toEqual({ captured: false, reason: "fixture" });
		const replies = count("/perception-reply");
		await query("world");
		await query("ui_snapshot", activeSid!, {}, 42);
		expect(count("/perception-reply")).toBe(replies);
		doc.visibilityState = "hidden";
		await query("ui_snapshot", "unknown");
		const leases = count("/ui-lease");
		interval!();
		await settle();
		expect(count("/ui-lease")).toBe(leases);
		expect(count("/perception-reply")).toBe(replies);
		// Hidden holders may still answer until expiration, but may not renew.
		await query("ui_snapshot");
		expect(count("/perception-reply")).toBe(replies + 1);
		now += 30001;
		await query("ui_snapshot");
		expect(count("/perception-reply")).toBe(replies + 1);
		doc.visibilityState = "visible";
		interval!();
		await settle();
		expect(count("/ui-lease")).toBe(leases);
		focused = false;
		await query("ui_snapshot", "unfocused");
		expect(count("/ui-lease")).toBe(leases);
		focused = true;
		await query("ui_snapshot", "opportunistic");
		expect(
			requests.filter((r) => r.path.endsWith("/ui-lease")).at(-1)!.body
				.claimOnly,
		).toBe(true);
		expect(count("/perception-reply")).toBe(replies + 2);
		interval!();
		await settle();
		expect(
			requests
				.filter((r) => r.path.endsWith("/ui-lease"))
				.every((r) => r.body.clientId === clientId),
		).toBe(true);
		expect(
			requests.filter((r) => r.path.endsWith("/ui-lease")).at(-1)!.body.leaseId,
		).toBe("lease");
		activeSid = "next";
		activeListener(activeSid);
		await settle();
		const afterSwitch = count("/ui-lease");
		activeListener(activeSid);
		await settle();
		expect(count("/ui-lease")).toBe(afterSwitch);
		focus.dispatchEvent(new Event("focus"));
		doc.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(count("/ui-lease")).toBe(afterSwitch + 2);
		deny = true;
		const beforeDeny = count("/perception-reply");
		await query("ui_snapshot", "denied");
		expect(count("/perception-reply")).toBe(beforeDeny);
		fail = true;
		await query("ui_snapshot", "offline");
		expect(count("/perception-reply")).toBe(beforeDeny);
	} finally {
		__resetRegistryForTest();
		Date.now = oldNow;
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
