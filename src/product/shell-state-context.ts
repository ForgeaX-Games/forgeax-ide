import type { createSurfaceWindowingController } from "@forgeax/app-shell/window";
import type { StudioProjectClient } from "./shell-state-domain-contract";
import type { SessionClient } from "./shell-state-session-contract";

/** Existing domain and presentation services injected by application composition. */
export interface IdeShellStoreContext {
	getSessionClient(): SessionClient;
	getStudioProjectClient(): StudioProjectClient;
	hasStudioDomainClients(): boolean;
	getSurfaceWindowingController(): ReturnType<
		typeof createSurfaceWindowingController
	>;
	setCurrentProject(projectId: string): void;
	resolveKernelForAgent(agentId: string): Promise<string | null>;
	recordLog(stream: "console" | "network" | "info", entry: unknown): void;
	reconcileSessionModelToActiveProvider(
		sid: string,
		agentPath: string,
	): Promise<unknown>;
	dropFileActivitySession(sid: string): Promise<void>;
}
