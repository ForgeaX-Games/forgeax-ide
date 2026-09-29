export type NativeDesktopRuntimeState = {
	readonly status?: unknown;
	readonly profile?: unknown;
	readonly publicOrigin?: unknown;
	readonly portOffset?: unknown;
	readonly launcherPid?: unknown;
	readonly servicePids?: unknown;
	readonly managedPorts?: unknown;
	readonly readiness?: { readonly ready?: unknown };
};

export type NativeDesktopRuntimeContract = {
	readonly ports: readonly number[];
	readonly pids: readonly number[];
	readonly portOffset: number;
};

/**
 * Product state is an untrusted runtime boundary. Keep the exact desktop-prod
 * contract in one module so Mac and Windows adapters cannot drift apart.
 */
export function validateNativeDesktopRuntimeState(
	state: NativeDesktopRuntimeState,
): NativeDesktopRuntimeContract {
	if (
		state.profile !== "desktop-prod" ||
		state.status !== "ready" ||
		state.readiness?.ready !== true
	)
		throw new Error("runtime state is not a ready desktop-prod contract");
	if (
		!Number.isSafeInteger(state.portOffset) ||
		Number(state.portOffset) < 0 ||
		Number(state.portOffset) > 128
	)
		throw new Error("runtime state has an invalid desktop port offset");
	const portOffset = Number(state.portOffset);
	if (typeof state.publicOrigin !== "string")
		throw new Error("runtime state has no publicOrigin");
	let origin: URL;
	try {
		origin = new URL(state.publicOrigin);
	} catch {
		throw new Error("runtime state publicOrigin is invalid");
	}
	if (
		origin.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
		!origin.port
	)
		throw new Error(
			"runtime state publicOrigin must be HTTP loopback with an explicit port",
		);
	const managed = state.managedPorts as Record<string, unknown> | undefined;
	const server = managed?.server;
	const engine = managed?.engine;
	if (
		!Number.isSafeInteger(server) ||
		!Number.isSafeInteger(engine) ||
		Number(server) !== 18810 + portOffset ||
		Number(engine) !== 15273 + portOffset ||
		Number(origin.port) !== Number(server)
	)
		throw new Error("runtime state has incomplete managed port evidence");
	const services = state.servicePids as Record<string, unknown> | undefined;
	const pids = [
		state.launcherPid,
		services?.server,
		services?.engine,
		services?.["agent-host"],
	];
	if (
		pids.some((value) => !Number.isSafeInteger(value) || Number(value) <= 0) ||
		new Set(pids.map(Number)).size !== pids.length
	)
		throw new Error(
			"runtime state has incomplete launcher/service process evidence",
		);
	return {
		ports: [Number(server), Number(engine)],
		pids: pids.map(Number),
		portOffset,
	};
}
