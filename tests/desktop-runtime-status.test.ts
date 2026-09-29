import { describe, expect, test } from "bun:test";
import {
	type DesktopRuntimeSnapshot,
	desktopRuntimeView,
	observeDesktopRuntimeStatus,
} from "../src/runtime/desktop-runtime-status";

describe("desktop runtime startup state", () => {
	test("keeps the existing ready navigation contract visible", () => {
		const snapshot: DesktopRuntimeSnapshot = {
			revision: 3,
			state: "ready",
			publicOrigin: "http://127.0.0.1:18810",
		};
		expect(desktopRuntimeView(snapshot)).toMatchObject({
			ready: true,
			failed: false,
			showSpinner: false,
		});
		expect(snapshot.publicOrigin).toBe("http://127.0.0.1:18810");
	});

	test("stops the spinner and exposes the authoritative failure evidence", () => {
		const view = desktopRuntimeView({
			revision: 4,
			state: "failed",
			error: "ENOENT: open 'B:\\~BUN\\root\\game-charter.md'",
			stateFile: "C:\\ForgeaxProjects\\.forgeax\\runtime\\desktop-prod-1.json",
			logFile: "C:\\ForgeaxProjects\\.logs\\local-runtime.log",
		});
		expect(view).toMatchObject({ failed: true, showSpinner: false });
		expect(view.error).toContain("B:\\~BUN\\root");
	});

	test("late subscribers receive an initial failed snapshot without waiting for an event", async () => {
		const seen: DesktopRuntimeSnapshot[] = [];
		const unlisten = await observeDesktopRuntimeStatus(
			{
				listen: async () => () => {},
				snapshot: async () => ({
					revision: 8,
					state: "failed",
					error: "server exited",
				}),
			},
			(snapshot) => seen.push(snapshot),
		);
		expect(seen.at(-1)).toMatchObject({
			revision: 8,
			state: "failed",
			error: "server exited",
		});
		unlisten();
	});

	test("does not let an older initial snapshot overwrite an event observed during subscription", async () => {
		const seen: DesktopRuntimeSnapshot[] = [];
		let handler: ((snapshot: DesktopRuntimeSnapshot) => void) | undefined;
		await observeDesktopRuntimeStatus(
			{
				listen: async (next) => {
					handler = next;
					return () => {};
				},
				snapshot: async () => {
					handler?.({ revision: 2, state: "failed", error: "already failed" });
					return { revision: 1, state: "starting" };
				},
			},
			(snapshot) => seen.push(snapshot),
		);
		expect(seen.at(-1)).toMatchObject({
			revision: 2,
			state: "failed",
			error: "already failed",
		});
	});

	test("reports restart exhaustion without replacing the original runtime error", () => {
		const view = desktopRuntimeView({
			revision: 12,
			state: "failed",
			error: "original server ENOENT",
			supervisorError: "local runtime exceeded MAX_RESTARTS=5",
			restartExhausted: true,
		});
		expect(view.error).toBe("original server ENOENT");
		expect(view.detail).toBe("Automatic restart attempts are exhausted.");
	});
});
