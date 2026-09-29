import { useEffect, useState } from "react";
import {
	connectDesktopRuntimeStatus,
	type DesktopRuntimeSnapshot,
	desktopRuntimeView,
	INITIAL_DESKTOP_RUNTIME_SNAPSHOT,
	openDesktopRuntimeLog,
	retryDesktopRuntime,
} from "./desktop-runtime-status";

export function DesktopStartup() {
	const [snapshot, setSnapshot] = useState(INITIAL_DESKTOP_RUNTIME_SNAPSHOT);
	const [actionError, setActionError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void connectDesktopRuntimeStatus((next) => {
			if (!disposed) setSnapshot(next);
		})
			.then((stop) => {
				if (disposed) stop();
				else unlisten = stop;
			})
			.catch((error) => {
				if (!disposed) {
					setSnapshot(
						(current): DesktopRuntimeSnapshot => ({
							...current,
							revision: current.revision + 1,
							state: "failed",
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			});
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	const view = desktopRuntimeView(snapshot);
	const runAction = async (action: () => Promise<void>) => {
		setActionError(null);
		try {
			await action();
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		}
	};

	return (
		<div
			className="fx-desktop-startup"
			role={view.failed ? "alert" : "status"}
			aria-live="assertive"
		>
			<div className="fx-desktop-startup__content">
				{view.showSpinner && (
					<span className="fx-desktop-startup__spinner" aria-hidden="true" />
				)}
				<div className="fx-desktop-startup__title">ForgeaX Studio</div>
				<div className="fx-desktop-startup__message">{view.detail}</div>
				{view.failed && (
					<div className="fx-desktop-startup__failure">
						<pre className="fx-desktop-startup__error">{view.error}</pre>
						{snapshot.stateFile && (
							<div>
								State: <code>{snapshot.stateFile}</code>
							</div>
						)}
						{snapshot.logFile && (
							<div>
								Log: <code>{snapshot.logFile}</code>
							</div>
						)}
						<div className="fx-desktop-startup__actions">
							<button
								type="button"
								onClick={() => void runAction(openDesktopRuntimeLog)}
							>
								Open runtime log
							</button>
							<button
								type="button"
								onClick={() => void runAction(retryDesktopRuntime)}
							>
								Retry safely
							</button>
						</div>
						{actionError && (
							<div className="fx-desktop-startup__action-error">
								{actionError}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
