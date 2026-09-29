import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createIdeProjectContext } from "../src/product/project-context";

const originalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage",
);
beforeEach(() => {
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			get length() {
				return values.size;
			},
			key: (index: number) => [...values.keys()][index] ?? null,
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
			clear: () => values.clear(),
		},
	});
});
afterEach(() => {
	if (originalStorage)
		Object.defineProperty(globalThis, "localStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("product project context", () => {
	test("keeps existing migration timing, identity notifications and unsubscribe behavior", () => {
		localStorage.setItem("old-workbench-layout", "retired");
		localStorage.setItem("forgeax:project:alpha:recent-page", "keep");
		const project = createIdeProjectContext();
		expect(localStorage.getItem("old-workbench-layout")).toBe("retired");
		expect(project.getCurrentProject()).toBe("default");
		expect(localStorage.getItem("old-workbench-layout")).toBeNull();
		expect(localStorage.getItem("forgeax:project:alpha:recent-page")).toBe(
			"keep",
		);
		const events: string[] = [];
		project.subscribeCurrentProject(() => {
			throw new Error("isolated observer");
		});
		const unsubscribe = project.subscribeCurrentProject((id) =>
			events.push(id),
		);
		project.setCurrentProject("alpha");
		project.setCurrentProject("alpha");
		project.setCurrentProject("");
		expect(events).toEqual(["alpha"]);
		expect(project.getCurrentProject()).toBe("alpha");
		unsubscribe();
		project.setCurrentProject("beta");
		expect(events).toEqual(["alpha"]);
		localStorage.setItem("old-workbench-layout", "created after migration");
		project.getCurrentProject();
		expect(localStorage.getItem("old-workbench-layout")).toBe(
			"created after migration",
		);
	});
});
