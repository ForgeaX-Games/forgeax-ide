import { createApplicationRuntimeOwner } from "@forgeax/app-shell/application";
import { PageClosePreparationDeferredError } from "@forgeax/app-shell/pages";
import {
	ExtensionCleanupDeferredError,
	ExtensionUnloadDeferredError,
} from "@forgeax/extension-platform/extensions";

/** The product keeps this owner above its replaceable recovery subtree. */
export function createIdeApplicationOwner() {
	return createApplicationRuntimeOwner({
		isCleanupDeferred: (error) =>
			error instanceof ExtensionCleanupDeferredError ||
			error instanceof ExtensionUnloadDeferredError ||
			error instanceof PageClosePreparationDeferredError,
	});
}
