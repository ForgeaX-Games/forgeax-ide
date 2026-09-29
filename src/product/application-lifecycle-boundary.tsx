import type { ApplicationRuntimeOwner } from "@forgeax/app-shell/application";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { reportError } from "../integration/error-reporting";
import { useTranslation } from "./product-locale";

function toError(error: unknown): Error {
	try {
		// Snapshot the message: unknown values and Error getters can both throw.
		const message = error instanceof Error ? error.message : String(error);
		return new Error(
			typeof message === "string" ? message : "Application shutdown failed",
			{ cause: error },
		);
	} catch {
		return new Error("Application shutdown failed", { cause: error });
	}
}

export function IdeApplicationLifecycleBoundary({
	owner,
	children,
}: {
	readonly owner: ApplicationRuntimeOwner;
	readonly children: ReactNode;
}) {
	const { t } = useTranslation();
	const snapshot = useSyncExternalStore(
		owner.subscribe,
		owner.getSnapshot,
		owner.getSnapshot,
	);

	useEffect(() => {
		if (snapshot.status === "blocked") {
			(
				window as unknown as { __forgeaxBoot?: { done(): void } }
			).__forgeaxBoot?.done();
		}
	}, [snapshot.status]);

	if (snapshot.status === "ready") return children;

	const error = toError(snapshot.error);
	const retryShutdown = () => {
		void owner.retryShutdown().catch((retryError) => {
			reportError(toError(retryError), null, "studio-shell-shutdown");
		});
	};

	return (
		<div
			role="alert"
			style={{
				position: "fixed",
				inset: 0,
				zIndex: "var(--z-toplevel)",
				overflow: "auto",
				padding: 32,
				background: "var(--fx-bg, #0d0d0d)",
				color: "var(--fx-fg, #fff)",
				font: "13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
			}}
		>
			<h1
				style={{
					margin: "0 0 8px",
					fontSize: 18,
					color: "var(--fx-danger, #f87171)",
				}}
			>
				{error.message}
			</h1>
			<div
				style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "16px 0" }}
			>
				{snapshot.retryable ? (
					<button
						type="button"
						disabled={snapshot.retrying}
						onClick={retryShutdown}
						style={{
							padding: "6px 14px",
							borderRadius: 6,
							cursor: snapshot.retrying ? "wait" : "pointer",
							border: "1px solid var(--fx-border, #333)",
							background: "var(--fx-accent, #4f7cff)",
							color: "#fff",
						}}
					>
						{t("errorBoundary.retry")}
					</button>
				) : null}
				<button
					type="button"
					onClick={() => window.location.reload()}
					style={{
						padding: "6px 14px",
						borderRadius: 6,
						cursor: "pointer",
						border: "1px solid var(--fx-border, #333)",
						background: "var(--fx-bg-elev2, #1d1d1d)",
						color: "var(--fx-fg, #eee)",
					}}
				>
					{t("errorBoundary.reloadStudio")}
				</button>
			</div>
		</div>
	);
}
