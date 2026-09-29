interface ProductBootApi {
	progress(value: { pct: number; label?: string }): void;
	done(): void;
}

/** Preserve the existing splash handshake until the first composited paint. */
export function bootIdeAppMounted(): void {
	if (typeof window === "undefined") return;
	const api = (window as unknown as { __forgeaxBoot?: ProductBootApi })
		.__forgeaxBoot;
	if (!api) return;
	api.progress({ pct: 92, label: "wiring panels" });
	if (typeof window.requestAnimationFrame !== "function") {
		api.done();
		return;
	}
	window.requestAnimationFrame(() => {
		window.requestAnimationFrame(() => {
			api.progress({ pct: 100, label: "ready" });
			api.done();
		});
	});
}
