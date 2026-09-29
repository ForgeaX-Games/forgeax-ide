import {
	type AppHost,
	type ApplicationNativeMenuTransport,
	installApplicationNativeMenuBridge,
} from "@forgeax/app-shell/application";
import { useEffect } from "react";
import { subscribeLocale, t } from "./product-locale";

const IDE_MENU_IDS = [
	"brand",
	"file",
	"edit",
	"window",
	"build",
	"select",
	"help",
	"publish",
] as const;

async function loadIdeNativeMenuTransport(): Promise<ApplicationNativeMenuTransport> {
	const [core, events] = await Promise.all([
		import("@tauri-apps/api/core"),
		import("@tauri-apps/api/event"),
	]);
	return {
		publish: (payload) => core.invoke("set_app_menu", { payload }),
		listen: (listener) =>
			events.listen<{ id: string }>("menu:invoke", (event) =>
				listener(event.payload?.id),
			),
	};
}

/** Install native menus with the product-owned data warmer. */
export function createIdeNativeMenuBridge(prepare: () => Promise<void>) {
	return function IdeNativeMenuBridge({
		runtime,
	}: {
		readonly runtime: { readonly host: Pick<AppHost, "menus" | "commands"> };
	}): null {
		useEffect(() => {
			if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window))
				return;
			return installApplicationNativeMenuBridge({
				menus: runtime.host.menus,
				menuIds: IDE_MENU_IDS,
				title: (menu) => t(`menubar.${menu}`),
				execute: (id, args) => runtime.host.commands.execute(id, args),
				prepare,
				subscribeLabels: subscribeLocale,
				loadTransport: loadIdeNativeMenuTransport,
				reportError: (error) => console.warn("[native-menu-bridge]", error),
			});
		}, [runtime]);
		return null;
	};
}
