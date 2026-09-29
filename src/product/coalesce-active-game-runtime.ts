import type {
	ActiveProjectSelection,
	RuntimeScopeState,
} from "./shell-state-domain-contract";

/**
 * Server in-flight binds may publish `transitioning` without repeating the binding
 * payload. Keep the last usable binding for the same game so the viewport gate
 * does not drop back to "Preparing editor viewport…".
 */
export function coalesceIncomingActiveGameRuntime(
	slug: string | null,
	incoming: RuntimeScopeState,
	previous: RuntimeScopeState,
): RuntimeScopeState {
	if (incoming.binding !== undefined) return incoming;
	const retained = previous.binding;
	if (retained === undefined) return incoming;
	if (incoming.status !== "transitioning") return incoming;
	if (slug === null || retained.gameId !== slug) return incoming;
	return { ...incoming, binding: retained };
}

export function coalesceActiveProjectSelection(
	selection: ActiveProjectSelection,
	previous: RuntimeScopeState,
): ActiveProjectSelection {
	const runtime = selection.runtime ?? { status: "unbound" as const };
	return {
		...selection,
		runtime: coalesceIncomingActiveGameRuntime(
			selection.activeSlug,
			runtime,
			previous,
		),
	};
}
