import { createContributionRegistry } from "../../../interface/src/core/extension-foundation/contribution-registry";
import { createPageRegistry } from "../../../interface/src/core/page-platform/registry";
import type { PagePlatformContribution } from "../../../interface/src/core/page-platform/types";
import { createFilesExtension } from "../../packages/files/src/index";

const extension = createFilesExtension({
	FilesBrowser: (() => null) as never,
	renderExplorer: () => null,
	renderPreview: () => null,
});
const contribution = {
	pageTypes: extension.contributes?.pages,
	panelTypes: extension.contributes?.panelTypes,
	resourceEditors: extension.contributes?.resourceEditors,
} as PagePlatformContribution;
const contributions = createContributionRegistry<PagePlatformContribution>();
const registry = createPageRegistry(contributions);

registry.validateContribution(extension.id, contribution);
contributions.contribute(extension.id, contribution);

export const filesRegistration = {
	explorer: registry.get("@forgeax/files#page/explorer")?.status,
	preview: registry.get("@forgeax/files#page/preview")?.status,
	owner: registry.ownerOf("@forgeax/files#page/explorer"),
	resourceEditorId: contribution.resourceEditors?.[0]?.id,
};
