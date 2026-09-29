import { afterEach, describe, expect, test, vi } from "vitest";
import {
	PASSIVE_FEEDBACK_EVENT,
	PASSIVE_FEEDBACK_RECOVERED_EVENT,
	type PassiveFeedbackResolution,
	type PassiveFeedbackSignal,
	reportPassiveFeedbackRecovery,
	reportPassiveFeedbackSignal,
} from "../src/integration/dom-passive-feedback-bridge";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreWindow(): void {
	if (originalWindow)
		Object.defineProperty(globalThis, "window", originalWindow);
	else delete (globalThis as { window?: unknown }).window;
}

afterEach(restoreWindow);

describe("IDE passive feedback DOM bridge", () => {
	test("dispatches the established event with the unchanged signal detail", () => {
		const dispatchEvent = vi.fn((_event: Event) => true);
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { dispatchEvent },
		});
		const signal: PassiveFeedbackSignal = {
			code: "agent_crash",
			message: "Agent process exited",
			source: "chat",
			ts: 123,
			scope: { sid: "session/one", agentId: "forge" },
		};

		reportPassiveFeedbackSignal(signal);

		expect(PASSIVE_FEEDBACK_EVENT).toBe("forgeax:passive-feedback");
		expect(dispatchEvent).toHaveBeenCalledTimes(1);
		const event = dispatchEvent.mock
			.calls[0]?.[0] as CustomEvent<PassiveFeedbackSignal>;
		expect(event.type).toBe(PASSIVE_FEEDBACK_EVENT);
		expect(event.detail).toBe(signal);
	});

	test("is a no-op without a browser window", () => {
		delete (globalThis as { window?: unknown }).window;

		expect(() =>
			reportPassiveFeedbackSignal({
				code: "ui.stall",
				message: "No first token",
			}),
		).not.toThrow();
		expect(() =>
			reportPassiveFeedbackRecovery({
				exceptionKey: "agent-unresponsive",
			}),
		).not.toThrow();
	});

	test("dispatches the established scoped recovery event unchanged", () => {
		const dispatchEvent = vi.fn((_event: Event) => true);
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { dispatchEvent },
		});
		const resolution: PassiveFeedbackResolution = {
			exceptionKey: "agent-unresponsive",
			scope: { sid: "session/one", agentId: "forge" },
		};

		reportPassiveFeedbackRecovery(resolution);

		expect(PASSIVE_FEEDBACK_RECOVERED_EVENT).toBe(
			"forgeax:passive-feedback-recovered",
		);
		expect(dispatchEvent).toHaveBeenCalledTimes(1);
		const event = dispatchEvent.mock
			.calls[0]?.[0] as CustomEvent<PassiveFeedbackResolution>;
		expect(event.type).toBe(PASSIVE_FEEDBACK_RECOVERED_EVENT);
		expect(event.detail).toBe(resolution);
	});

	test("preserves dispatch failures for the caller", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				dispatchEvent: () => {
					throw new Error("dispatch failed");
				},
			},
		});

		expect(() =>
			reportPassiveFeedbackSignal({
				code: "renderer-error",
				message: "Renderer unavailable",
			}),
		).toThrow("dispatch failed");
	});
});
