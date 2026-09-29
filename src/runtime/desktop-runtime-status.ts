export type DesktopRuntimeSnapshot = {
	revision: number;
	who?: string;
	state: "connecting" | "starting" | "restarting" | "ready" | "failed" | string;
	status?: string;
	error?: string | null;
	supervisorError?: string | null;
	restartExhausted?: boolean;
	attempt?: number;
	publicOrigin?: string;
	stateFile?: string;
	logFile?: string;
};

export const INITIAL_DESKTOP_RUNTIME_SNAPSHOT: DesktopRuntimeSnapshot = {
	revision: 0,
	state: "starting",
};

export type DesktopRuntimeStatusApi = {
	listen(
		handler: (snapshot: DesktopRuntimeSnapshot) => void,
	): Promise<() => void>;
	snapshot(): Promise<DesktopRuntimeSnapshot>;
};

export function applyDesktopRuntimeSnapshot(
	current: DesktopRuntimeSnapshot,
	incoming: DesktopRuntimeSnapshot,
): DesktopRuntimeSnapshot {
	if (
		!Number.isFinite(incoming.revision) ||
		incoming.revision < current.revision
	)
		return current;
	return { ...current, ...incoming };
}

export async function observeDesktopRuntimeStatus(
	api: DesktopRuntimeStatusApi,
	onSnapshot: (snapshot: DesktopRuntimeSnapshot) => void,
): Promise<() => void> {
	let current = INITIAL_DESKTOP_RUNTIME_SNAPSHOT;
	const apply = (incoming: DesktopRuntimeSnapshot) => {
		const next = applyDesktopRuntimeSnapshot(current, incoming);
		if (next === current) return;
		current = next;
		onSnapshot(current);
	};
	const unlisten = await api.listen(apply);
	try {
		apply(await api.snapshot());
	} catch (error) {
		unlisten();
		throw error;
	}
	return unlisten;
}

export function desktopRuntimeView(snapshot: DesktopRuntimeSnapshot) {
	const failed = snapshot.state === "failed";
	const ready = snapshot.state === "ready";
	return {
		failed,
		ready,
		showSpinner: !failed && !ready,
		error:
			snapshot.error ||
			snapshot.supervisorError ||
			"The local runtime failed without an error message.",
		detail: snapshot.restartExhausted
			? "Automatic restart attempts are exhausted."
			: snapshot.state === "restarting"
				? `Restarting local runtime${snapshot.attempt ? ` (attempt ${snapshot.attempt})` : ""}…`
				: ready
					? "Local runtime is ready. Opening Studio…"
					: "正在启动本地运行环境 · Starting local runtime…",
	};
}

export async function connectDesktopRuntimeStatus(
	onSnapshot: (snapshot: DesktopRuntimeSnapshot) => void,
): Promise<() => void> {
	const [{ listen }, { invoke }] = await Promise.all([
		import("@tauri-apps/api/event"),
		import("@tauri-apps/api/core"),
	]);
	return observeDesktopRuntimeStatus(
		{
			listen: async (handler) =>
				listen<DesktopRuntimeSnapshot>("backend-status", (event) =>
					handler(event.payload),
				),
			snapshot: () =>
				invoke<DesktopRuntimeSnapshot>("desktop_runtime_snapshot"),
		},
		onSnapshot,
	);
}

export async function openDesktopRuntimeLog(): Promise<void> {
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("open_desktop_runtime_log");
}

export async function retryDesktopRuntime(): Promise<void> {
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("retry_desktop_runtime");
}
