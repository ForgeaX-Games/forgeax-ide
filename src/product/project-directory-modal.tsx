import { useState } from "react";
import { studioDomainClientRuntime } from "./product-clients";
import { useTranslation } from "./product-locale";
import { ProjectDirectoryBrowser } from "./project-directory-browser";
import type { StudioProjectClient } from "./shell-state-domain-contract";
import { useShellStore } from "./shell-state-runtime";
import "./project-modal-base.css";

export function IdeProjectDirectoryModalHost() {
	const open = useShellStore((state) => state.gameDirectoryModalOpen);
	const close = useShellStore((state) => state.closeGameDirectoryModal);
	const setActiveGame = useShellStore((state) => state.setActiveGame);
	if (!open) return null;
	return (
		<IdeProjectDirectoryModal
			onClose={close}
			linkProject={(path) => {
				const clients = studioDomainClientRuntime.read();
				if (!clients) throw new Error("Studio project client unavailable");
				return clients.projects.linkProject(path);
			}}
			setActiveGame={setActiveGame}
		/>
	);
}

export function IdeProjectDirectoryModal({
	onClose,
	linkProject,
	setActiveGame,
}: {
	onClose: () => void;
	linkProject: StudioProjectClient["linkProject"];
	setActiveGame: (slug: string) => Promise<unknown>;
}) {
	const { t } = useTranslation();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submitOpen = async (path: string) => {
		setBusy(true);
		setError(null);
		try {
			const result = await linkProject(path);
			if (!result.ok || !result.slug)
				throw new Error(result.error ?? "Unable to link project");
			onClose();
			await setActiveGame(result.slug);
		} catch (cause) {
			setError((cause as Error).message);
			setBusy(false);
		}
	};

	return (
		<div
			className="tb-modal-overlay"
			role="dialog"
			aria-modal="true"
			aria-label={t("gameDirectory.openTitle")}
			tabIndex={-1}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
		>
			<div className="tb-modal tb-modal-wide">
				<div className="tb-modal-title">{t("gameDirectory.openTitle")}</div>
				<ProjectDirectoryBrowser
					initialDir="~"
					onPick={submitOpen}
					onCancel={onClose}
					busy={busy}
					externalError={error}
				/>
			</div>
		</div>
	);
}
