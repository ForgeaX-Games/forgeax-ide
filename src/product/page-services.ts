import { createPageServices } from "@forgeax/app-shell/pages";
import type { SerializedDockview } from "dockview";
import { ideProjectContext } from "./project-context";

/** One host lifetime, sharing the product project authority with compatibility UI. */
export function createIdePageServices(
	commands: Parameters<typeof createPageServices>[0],
) {
	return createPageServices<SerializedDockview>(commands, ideProjectContext);
}
