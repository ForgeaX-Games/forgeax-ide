import { describe, expect, test } from "vitest";
import {
	createProductSessionStreams,
	type PerceptionQueryDetail,
	type ProductSessionEvent,
	type ProductSessionStreamDependencies,
} from "../src/integration/product-session-stream-lifecycle";

type SessionHandler = (event: ProductSessionEvent) => void;

function createHarness() {
	const handlers = new Map<string, SessionHandler>();
	const intervalCallbacks: Array<() => void> = [];
	const clearedIntervals: unknown[] = [];
	const perceptions: PerceptionQueryDetail[] = [];
	const emitted: Array<{
		sid: string;
		content: string;
		options: Parameters<ProductSessionStreamDependencies["emitMessage"]>[2];
	}> = [];
	let history: Array<{ key: string; id: string | null; status?: string }> = [];
	let now = 0;

	const dependencies: ProductSessionStreamDependencies = {
		onSessionEvent(key, handler) {
			handlers.set(key, handler);
		},
		async emitMessage(sid, content, options) {
			emitted.push({ sid, content, options });
		},
		async fetchNarrativeHistory() {
			return history;
		},
		now() {
			return now;
		},
		setInterval(callback) {
			intervalCallbacks.push(callback);
			return callback;
		},
		clearInterval(handle) {
			clearedIntervals.push(handle);
		},
		dispatchPerception(detail) {
			perceptions.push(detail);
		},
	};

	return {
		clearedIntervals,
		dependencies,
		emitted,
		handlers,
		intervalCallbacks,
		perceptions,
		setHistory(next: typeof history) {
			history = next;
		},
		setNow(next: number) {
			now = next;
		},
	};
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function sessionEvent(
	type: string,
	payload: Record<string, unknown>,
	overrides: Partial<ProductSessionEvent> = {},
): ProductSessionEvent {
	return {
		sid: "session-1",
		emitterId: "agents/kotone",
		event: { type, payload },
		...overrides,
	};
}

describe("IDE product session streams", () => {
	test("relays valid perception queries through the established browser event detail", () => {
		const harness = createHarness();
		const streams = createProductSessionStreams(harness.dependencies);
		streams.subscribePerceptionStream();

		const handler = harness.handlers.get("perception");
		expect(handler).toBeDefined();
		handler?.(
			sessionEvent("perception:query", {
				reqId: "request-1",
				kind: "frame",
				query: { quality: "preview" },
			}),
		);
		handler?.(
			sessionEvent("perception:query", {
				reqId: "request-2",
				kind: "unexpected",
			}),
		);
		handler?.(sessionEvent("perception:query", { kind: "world" }));
		handler?.(sessionEvent("hook:toolCall", { reqId: "ignored" }));

		expect(harness.perceptions).toEqual([
			{
				sid: "session-1",
				reqId: "request-1",
				kind: "frame",
				query: { quality: "preview" },
			},
			{
				sid: "session-1",
				reqId: "request-2",
				kind: "world",
				query: undefined,
			},
		]);
	});

	test("coalesces a narrative watcher and nudges its agent only after a seen run completes", async () => {
		const harness = createHarness();
		const streams = createProductSessionStreams(harness.dependencies);
		streams.subscribeNarrativeCopilot();

		const handler = harness.handlers.get("narrative-copilot");
		expect(handler).toBeDefined();
		const toolCall = sessionEvent("hook:toolCall", {
			name: "narrative:start-pipeline",
		});
		handler?.(toolCall);
		handler?.(toolCall);
		expect(harness.intervalCallbacks).toHaveLength(1);

		harness.setHistory([{ key: "run-1", id: "run-id", status: "running" }]);
		harness.intervalCallbacks[0]?.();
		await flushAsyncWork();
		expect(harness.emitted).toHaveLength(0);

		harness.setHistory([]);
		harness.intervalCallbacks[0]?.();
		await flushAsyncWork();
		expect(harness.emitted).toHaveLength(0);
		expect(harness.clearedIntervals).toHaveLength(0);

		harness.setHistory([{ key: "run-1", id: "run-id", status: "completed" }]);
		harness.intervalCallbacks[0]?.();
		await flushAsyncWork();

		expect(harness.clearedIntervals).toEqual([harness.intervalCallbacks[0]]);
		expect(harness.emitted).toHaveLength(1);
		expect(harness.emitted[0]).toMatchObject({
			sid: "session-1",
			options: {
				to: "agents/kotone",
				type: "user_input",
				payload: {
					narrativeAutoNudge: true,
					runKey: "run-1",
					runStatus: "completed",
				},
			},
		});
		expect(harness.emitted[0]?.content).toContain("管线已完成");

		handler?.(toolCall);
		expect(harness.intervalCallbacks).toHaveLength(2);
	});

	test("ignores unrelated narrative events and expires a watcher without nudging", async () => {
		const harness = createHarness();
		const streams = createProductSessionStreams(harness.dependencies);
		streams.subscribeNarrativeCopilot();

		const handler = harness.handlers.get("narrative-copilot");
		handler?.(sessionEvent("hook:toolCall", { name: "other:tool" }));
		handler?.(
			sessionEvent(
				"hook:toolCall",
				{ name: "narrative:start-pipeline" },
				{ emitterId: undefined },
			),
		);
		expect(harness.intervalCallbacks).toHaveLength(0);

		handler?.(
			sessionEvent("hook:toolCall", {
				toolCall: { name: "narrative:start-pipeline" },
			}),
		);
		expect(harness.intervalCallbacks).toHaveLength(1);
		harness.setNow(40 * 60 * 1_000 + 1);
		harness.intervalCallbacks[0]?.();
		await flushAsyncWork();

		expect(harness.clearedIntervals).toEqual([harness.intervalCallbacks[0]]);
		expect(harness.emitted).toHaveLength(0);
	});
});
