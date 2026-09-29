import { expect, test } from "vitest";
import { createComposerReferenceQueue } from "../src/integration/composer-reference-queue";

const pill = (display: string) => ({
	kind: "file" as const,
	display,
	detail: display,
	tooltip: { title: display, lines: [] as string[] },
});

test("adopts older shell references before product-local requests exactly once", () => {
	const owner = createComposerReferenceQueue();
	const a = pill("early shell"),
		b = pill("product"),
		c = pill("compatibility");
	owner.runtime.request(b);
	const runtime = owner.createRuntime([a]);
	expect(runtime).toBe(owner.runtime);
	expect(runtime.getQueue()).toEqual([a, b]);
	expect(runtime.getPending()).toBe(a);
	expect(owner.createRuntime([a])).toBe(runtime);
	expect(runtime.getQueue()).toEqual([a, b]);
	runtime.request(c);
	runtime.clear();
	expect(owner.runtime.getPending()).toBe(b);
	owner.runtime.clear();
	expect(runtime.getPending()).toBe(c);
	runtime.clear();
	runtime.clear();
	expect(runtime.getPending()).toBeNull();
});

test("snapshots stay stable between mutations and unsubscribe leaves queued work intact", () => {
	const { runtime } = createComposerReferenceQueue();
	const a = pill("a");
	let changes = 0;
	const stop = runtime.subscribe(() => changes++);
	const empty = runtime.getQueue();
	expect(runtime.getQueue()).toBe(empty);
	runtime.request(a);
	expect(runtime.getQueue()).not.toBe(empty);
	const snapshot = runtime.getQueue();
	expect(runtime.getQueue()).toBe(snapshot);
	expect(changes).toBe(1);
	stop();
	stop();
	runtime.request(pill("b"));
	expect(changes).toBe(1);
	expect(runtime.getPending()).toBe(a);
	let remounted = 0;
	runtime.subscribe(() => remounted++);
	runtime.clear();
	expect(remounted).toBe(1);
	expect(runtime.getPending()?.display).toBe("b");
});

test("separate product queue factories never share requests", () => {
	const first = createComposerReferenceQueue();
	const second = createComposerReferenceQueue();
	first.runtime.request(pill("first"));
	expect(second.runtime.getPending()).toBeNull();
	expect(second.createRuntime([]).getQueue()).toEqual([]);
});

test("startup seed adoption does not call subscribers inside the ownership handoff", () => {
	const owner = createComposerReferenceQueue();
	const early = pill("early");
	let calls = 0;
	owner.runtime.subscribe(() => {
		calls++;
		throw new Error("Subscriber must not run during initial ownership handoff");
	});
	expect(() => owner.createRuntime([early])).not.toThrow();
	expect(calls).toBe(0);
	expect(owner.runtime.getPending()).toBe(early);
	expect(owner.createRuntime([])).toBe(owner.runtime);
	expect(() => owner.runtime.request(pill("ordinary request"))).toThrow();
	expect(calls).toBe(1);
});
