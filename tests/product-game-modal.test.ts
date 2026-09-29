import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import {
	createSessionForProject,
	ProjectSessionRows,
} from "../src/product/game-modal";
import { listGameTemplates } from "../src/product/game-templates";

describe("IDE project session creation", () => {
	it("loads valid built-in project templates from the project API", async () => {
		const originalFetch = globalThis.fetch;
		let requested: string | undefined;
		try {
			globalThis.fetch = (async (input) => {
				requested = String(input);
				return Response.json({
					templates: [
						{ slug: "game-default", name: "Default" },
						{ slug: "", name: "Invalid" },
					],
				});
			}) as typeof fetch;
			await expect(listGameTemplates()).resolves.toEqual([
				{ slug: "game-default", name: "Default" },
			]);
			expect(requested).toBe("/api/projects/templates");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("routes the plus button to a new session without switching or deleting", async () => {
		const browser = new Window({ url: "http://localhost:18920" });
		const globals = {
			window: browser,
			document: browser.document,
			navigator: browser.navigator,
			HTMLElement: browser.HTMLElement,
			Element: browser.Element,
			Node: browser.Node,
			IS_REACT_ACT_ENVIRONMENT: true,
		};
		const previous = Object.fromEntries(
			Object.keys(globals).map((name) => [
				name,
				Object.getOwnPropertyDescriptor(globalThis, name),
			]),
		);
		for (const [name, value] of Object.entries(globals)) {
			Object.defineProperty(globalThis, name, {
				configurable: true,
				writable: true,
				value,
			});
		}
		let root: import("react-dom/client").Root | undefined;
		try {
			const { act, createElement } = await import("react");
			const { createRoot } = await import("react-dom/client");
			const picked = vi.fn();
			const created = vi.fn();
			const deleted = vi.fn();
			const mount = browser.document.createElement("div");
			browser.document.body.append(mount);
			root = createRoot(mount as unknown as Parameters<typeof createRoot>[0]);
			await act(async () => {
				root?.render(
					createElement(ProjectSessionRows, {
						games: [
							{
								slug: "project-a",
								name: "Project A",
								fileCount: 42,
								mtime: 1,
							},
						],
						currentSlug: null,
						onPick: picked,
						onNewSession: created,
						onDelete: deleted,
						labels: {
							empty: "empty",
							switchTo: (slug: string) => `switch ${slug}`,
							newSession: (slug: string) => `new session ${slug}`,
							delete: "delete",
							meta: () => "recent",
						},
					}),
				);
			});
			expect(mount.textContent).not.toContain("42");
			const plus = browser.document.querySelector(
				'button[aria-label="new session project-a"]',
			);
			await act(async () => {
				plus?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
			});
			expect(created).toHaveBeenCalledWith("project-a");
			expect(picked).not.toHaveBeenCalled();
			expect(deleted).not.toHaveBeenCalled();
		} finally {
			const { act } = await import("react");
			await act(async () => root?.unmount());
			await browser.happyDOM.close();
			for (const [name, descriptor] of Object.entries(previous)) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			}
		}
	});

	it("activates the selected project before creating a scoped session", async () => {
		const calls: string[] = [];
		const setActiveGame = vi.fn(async (slug: string) => {
			calls.push(`activate:${slug}`);
		});
		const createNewSession = vi.fn(async ({ scope }: { scope: string }) => {
			calls.push(`create:${scope}`);
			return { sid: "new-session" };
		});

		await expect(
			createSessionForProject("project-a", {
				setActiveGame,
				createNewSession,
			}),
		).resolves.toBe(true);
		expect(calls).toEqual(["activate:project-a", "create:project-a"]);
	});

	it("keeps the project list open when session creation returns nothing", async () => {
		await expect(
			createSessionForProject("project-a", {
				setActiveGame: vi.fn(async () => undefined),
				createNewSession: vi.fn(async () => null),
			}),
		).resolves.toBe(false);
	});
});
