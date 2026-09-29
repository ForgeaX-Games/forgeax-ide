import { afterEach, expect, test } from "vitest";
import { reportError } from "../src/integration/error-reporting";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
	if (originalWindow)
		Object.defineProperty(globalThis, "window", originalWindow);
	else Reflect.deleteProperty(globalThis, "window");
});
function setWindow(value: object) {
	Object.defineProperty(globalThis, "window", { configurable: true, value });
}

test("unconfigured and server environments remain inert without reading the error", () => {
	const error = new Error("original");
	Object.defineProperty(error, "message", {
		get() {
			throw new Error("must not read");
		},
	});
	Reflect.deleteProperty(globalThis, "window");
	expect(() => reportError(error)).not.toThrow();
	setWindow({});
	expect(() => reportError(error)).not.toThrow();
});

test("reports through the live installer slot with the original SDK receiver and payload", () => {
	const payloads: unknown[] = [];
	const reporter = {
		error(payload: unknown) {
			expect(this).toBe(reporter);
			payloads.push(payload);
		},
	};
	const target: { __forgeaxAegis?: typeof reporter } = {};
	setWindow(target);
	const error = new Error("render failed");
	error.stack = "original stack";
	reportError(error); // The SDK has not loaded yet; do not buffer or initialize it.
	expect(payloads).toEqual([]);
	target.__forgeaxAegis = reporter;
	reportError(error, "component tree", "studio-shell");
	reportError(error, null);
	expect(payloads).toEqual([
		{
			msg: "[studio-shell] render failed",
			stack: "original stack",
			componentStack: "component tree",
		},
		{
			msg: "[react] render failed",
			stack: "original stack",
			componentStack: "",
		},
	]);
	delete target.__forgeaxAegis;
	reportError(error);
	expect(payloads).toHaveLength(2);
});

test("preserves empty scope and stack fallbacks and never reaches another window", () => {
	const payloads: unknown[] = [];
	setWindow({
		__forgeaxAegis: { error: (payload: unknown) => payloads.push(payload) },
		get opener() {
			throw new Error("must stay in current window");
		},
	});
	const error = new Error("failed");
	error.stack = undefined;
	reportError(error, undefined, "");
	expect(payloads).toEqual([
		{ msg: "[] failed", stack: "", componentStack: "" },
	]);
});

test("SDK, slot and error getter failures cannot break recovery", () => {
	setWindow({
		__forgeaxAegis: {
			error() {
				throw new Error("SDK failed");
			},
		},
	});
	expect(() => reportError(new Error("original"))).not.toThrow();
	setWindow({
		get __forgeaxAegis() {
			throw new Error("slot failed");
		},
	});
	expect(() => reportError(new Error("original"))).not.toThrow();
	const error = new Error("original");
	Object.defineProperty(error, "message", {
		get() {
			throw new Error("getter failed");
		},
	});
	setWindow({
		__forgeaxAegis: {
			error() {
				throw new Error("must not send");
			},
		},
	});
	expect(() => reportError(error)).not.toThrow();
});
