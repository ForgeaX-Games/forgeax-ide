import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

test("product locale retains persistence, one-time observation, translation and live subscribers", async () => {
	const values = new Map([["forgeax.locale", "zh"]]);
	const window = Object.assign(new EventTarget(), {
		localStorage: {
			getItem: (_key: string): string | null => null,
			setItem: (_key: string, _value: string) => {},
		},
	});
	let registrations = 0,
		broadcasts = 0,
		flushes = 0;
	const add = window.addEventListener.bind(window);
	window.addEventListener = (...args) => {
		registrations++;
		add(...args);
	};
	window.localStorage = {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
	};
	vi.stubGlobal("window", window);
	vi.stubGlobal("document", {
		documentElement: { lang: "" },
		querySelectorAll: () => [
			{ contentWindow: { postMessage: () => broadcasts++ } },
		],
	});
	const locale = await import("../src/product/product-locale");
	const runtime = locale.createIdeLocaleRuntime({
		flushBrowserPrefs: () => flushes++,
	});
	expect(runtime).toBe(
		locale.createIdeLocaleRuntime({ flushBrowserPrefs: () => flushes++ }),
	);
	const seen: string[] = [];
	const stop = locale.subscribe(() => seen.push(locale.getLocale()));
	locale.initI18n();
	locale.initI18n();
	expect(registrations).toBe(2);
	expect(locale.getLocale()).toBe("zh");
	expect(document.documentElement.lang).toBe("zh");
	expect(flushes).toBe(0);
	expect(seen).toEqual(["zh"]);
	const translator = locale.t;
	expect(translator("missing.product.key")).toBe("missing.product.key");
	const zh = translator("errorBoundary.retry");
	locale.setLocale("en");
	expect(flushes).toBe(1);
	expect(values.get("forgeax.locale")).toBe("en");
	expect(translator("errorBoundary.retry")).not.toBe(zh);
	expect(locale.t).toBe(translator);
	locale.setLocale("en");
	expect(flushes).toBe(1);
	values.set("forgeax.locale", "zh");
	const storage = new Event("storage");
	Object.assign(storage, { key: "forgeax.locale" });
	window.dispatchEvent(storage);
	expect(locale.getLocale()).toBe("zh");
	expect(flushes).toBe(1);
	window.dispatchEvent(
		new CustomEvent("forgeax:locale-changed", { detail: "en" }),
	);
	expect(locale.getLocale()).toBe("en");
	expect(flushes).toBe(1);
	values.set("forgeax.locale", "invalid");
	const clear = new Event("storage");
	Object.assign(clear, { key: null });
	window.dispatchEvent(clear);
	expect(locale.getLocale()).toBe("en");
	const count = seen.length;
	stop();
	locale.setLocale("zh");
	expect(seen.length).toBe(count);
	expect(broadcasts).toBeGreaterThan(0);
	Object.defineProperty(window, "localStorage", {
		get() {
			throw new Error("denied");
		},
	});
	locale.initI18n();
	expect(locale.getLocale()).toBe("en");
	locale.setLocale("zh");
	expect(locale.getLocale()).toBe("zh");
});
