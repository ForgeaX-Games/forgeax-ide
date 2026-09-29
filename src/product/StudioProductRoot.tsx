import {
	type ApplicationRuntime,
	type ApplicationRuntimeOwner,
	ApplicationRuntimeRoot,
} from "@forgeax/app-shell/application";
import type { ReactNode } from "react";

export interface StudioProductRootProps<Runtime extends ApplicationRuntime> {
	readonly owner: ApplicationRuntimeOwner;
	readonly start: () => Promise<Runtime>;
	readonly children: (runtime: Runtime) => ReactNode;
}

/** Product-owned assembly root for the Studio IDE. */
export function StudioProductRoot<Runtime extends ApplicationRuntime>({
	owner,
	start,
	children,
}: StudioProductRootProps<Runtime>): React.ReactElement {
	return (
		<ApplicationRuntimeRoot owner={owner} start={start}>
			{children}
		</ApplicationRuntimeRoot>
	);
}
