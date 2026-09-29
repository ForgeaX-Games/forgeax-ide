import { createIdeShellStore } from "./shell-state";
import type { IdeShellStoreContext } from "./shell-state-context";

// One product instance per page, created outside React mount/recovery lifecycles.
// Interface's deferred compatibility store is never constructed in this product.
export let useShellStore: ReturnType<typeof createIdeShellStore>;
export function initializeIdeShellStore(context: IdeShellStoreContext) {
	useShellStore ??= createIdeShellStore(context);
	return useShellStore;
}
export function getIdeShellStore() {
	if (!useShellStore)
		throw new Error("IDE shell store must be initialized before use");
	return useShellStore;
}
