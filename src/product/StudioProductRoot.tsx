import {
  ApplicationRuntimeRoot,
  type ApplicationRuntime,
} from '@forgeax/app-shell/application';
import type { ReactNode } from 'react';

export interface StudioProductRootProps<Runtime extends ApplicationRuntime> {
  readonly start: () => Promise<Runtime>;
  readonly children: (runtime: Runtime) => ReactNode;
}

/** Product-owned assembly root for the Studio IDE. */
export function StudioProductRoot<Runtime extends ApplicationRuntime>({
  start,
  children,
}: StudioProductRootProps<Runtime>): React.ReactElement {
  return (
    <ApplicationRuntimeRoot start={start}>
      {children}
    </ApplicationRuntimeRoot>
  );
}
