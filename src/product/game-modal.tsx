// IDE-owned game modal host + New Game modal + timeSince helper.
//
// 2026-07-23 — the always-on GameSwitcher dropdown was removed from the TopBar.
// Game-specific commands still drive the new-game dialog and game list modal;
// File → 打开游戏目录 is handled by the game-directory modal separately.
// This file exports `IdeGameModalHost` (mounted once in the product shell);
// `NewGameModal` + `timeSince` stay internal. The store flag `gameSwitcherOpen`
// now means "the open-game list modal is open".

import { alertDialog, confirmDialog } from "@forgeax/app-shell/application";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type GameTemplate, listGameTemplates } from "./game-templates";
import {
	sessionClientRuntime,
	studioDomainClientRuntime,
} from "./product-clients";
import { useTranslation } from "./product-locale";
import type { StudioProjectClient } from "./shell-state-domain-contract";
import { useShellStore } from "./shell-state-runtime";
import type { SessionClient } from "./shell-state-session-contract";
import "./project-modal-base.css";
import "./game-modal.css";

interface GameRow {
	slug: string;
	name: string;
	fileCount: number;
	mtime: number;
}

export function ProjectSessionRows({
	games,
	currentSlug,
	onPick,
	onNewSession,
	onDelete,
	labels,
}: {
	readonly games: readonly GameRow[];
	readonly currentSlug: string | null;
	readonly onPick: (slug: string) => void;
	readonly onNewSession: (slug: string) => void;
	readonly onDelete: (slug: string) => void;
	readonly labels: {
		readonly empty: string;
		readonly switchTo: (slug: string) => string;
		readonly newSession: (slug: string) => string;
		readonly delete: string;
		readonly meta: (mtime: number) => string;
	};
}) {
	if (games.length === 0)
		return <div className="tb-game-empty">{labels.empty}</div>;
	return games.map((game) => (
		<div
			key={game.slug}
			className={`tb-game-row ${game.slug === currentSlug ? "active" : ""}`}
			data-game-slug={game.slug}
		>
			<button
				type="button"
				className="tb-game-pick"
				onClick={() => onPick(game.slug)}
				title={labels.switchTo(game.slug)}
			>
				<span className="tb-game-name">{game.name}</span>
				<span className="tb-game-meta">{labels.meta(game.mtime)}</span>
			</button>
			<button
				type="button"
				className="tb-game-del tb-game-add-session"
				onClick={() => onNewSession(game.slug)}
				title={labels.newSession(game.slug)}
				aria-label={labels.newSession(game.slug)}
			>
				<Plus size={13} />
			</button>
			<button
				type="button"
				className="tb-game-del"
				onClick={() => onDelete(game.slug)}
				title={labels.delete}
			>
				<Trash2 size={11} />
			</button>
		</div>
	));
}

export async function createSessionForProject(
	slug: string,
	dependencies: {
		readonly setActiveGame: (slug: string) => Promise<unknown>;
		readonly createNewSession: (options: {
			readonly scope: string;
		}) => Promise<unknown>;
	},
): Promise<boolean> {
	await dependencies.setActiveGame(slug);
	return Boolean(await dependencies.createNewSession({ scope: slug }));
}

function getStudioProjectClient(): StudioProjectClient {
	const clients = studioDomainClientRuntime.read();
	if (!clients) throw new Error("Studio project client unavailable");
	return clients.projects;
}

function getSessionClient(): SessionClient {
	const client = sessionClientRuntime.read();
	if (!client) throw new Error("IDE session client unavailable");
	return client;
}

// Mounted once in the IDE shell. Renders the new-game dialog (game.new)
// and the "open game" list modal (game.open), both driven by the shell store so
// the File-menu commands can open them.
export function IdeGameModalHost() {
	const { t } = useTranslation();
	const listOpen = useShellStore((s) => s.gameSwitcherOpen);
	const setListOpen = useShellStore((s) => s.setGameSwitcherOpen);
	const gameModalOpen = useShellStore((s) => s.gameModalOpen);
	const closeGameModal = useShellStore((s) => s.closeGameModal);
	const [games, setGames] = useState<GameRow[]>([]);
	const activeGameSlug = useShellStore((s) => s.activeGameSlug);
	const setActiveGame = useShellStore((s) => s.setActiveGame);
	const createNewSession = useShellStore((s) => s.createNewSession);

	const currentSlug = activeGameSlug;

	const reload = useCallback(async () => {
		try {
			const j = await getStudioProjectClient().listProjects();
			setGames((j.games as unknown as GameRow[]) ?? []);
		} catch {
			/* ignore */
		}
	}, []);

	// Load the game list when the "open game" modal opens (was a 6s poll on the
	// always-on switcher; now on-demand since the list only shows in the modal).
	useEffect(() => {
		if (listOpen) void reload();
	}, [listOpen, reload]);

	// Picking a game goes through the one authoritative active-game mutation.
	const onPick = async (slug: string) => {
		setListOpen(false);
		await setActiveGame(slug);
	};

	const onDelete = async (slug: string) => {
		if (
			!(await confirmDialog({
				body: t("gameSwitcher.deleteConfirm", { slug }),
				danger: true,
			}))
		)
			return;
		try {
			await getStudioProjectClient().deleteProject(slug);
			await reload();
		} catch (e) {
			void alertDialog({
				title: t("gameSwitcher.deleteFailedTitle"),
				body: (e as Error).message,
			});
		}
	};

	const onNewSession = async (slug: string) => {
		const created = await createSessionForProject(slug, {
			setActiveGame,
			createNewSession,
		});
		if (created) setListOpen(false);
	};

	return (
		<>
			{gameModalOpen && (
				<NewGameModal
					onClose={() => {
						closeGameModal();
					}}
				/>
			)}
			{listOpen && (
				<div
					className="tb-modal-overlay"
					role="dialog"
					aria-modal="true"
					aria-label={t("gameSwitcher.listTitle")}
					tabIndex={-1}
					onClick={(event) => {
						if (event.target === event.currentTarget) setListOpen(false);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") setListOpen(false);
					}}
				>
					<div className="tb-modal">
						<div className="tb-modal-title">{t("gameSwitcher.listTitle")}</div>
						{/* Plain in-modal flow container — NOT `.tb-game-dropdown` (that class
                is absolutely positioned for the old popover and would jump to the
                corner). The modal card supplies the chrome; rows style themselves. */}
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: 1,
								maxHeight: "60vh",
								overflowY: "auto",
								marginTop: 4,
							}}
						>
							<ProjectSessionRows
								games={games}
								currentSlug={currentSlug}
								onPick={(slug) => void onPick(slug)}
								onNewSession={(slug) => void onNewSession(slug)}
								onDelete={(slug) => void onDelete(slug)}
								labels={{
									empty: t("gameSwitcher.empty"),
									switchTo: (slug) =>
										t("gameSwitcher.switchToTooltip", { slug }),
									newSession: (slug) =>
										t("gameSwitcher.newSessionTooltip", { slug }),
									delete: t("gameSwitcher.deleteTooltip"),
									meta: (mtime) =>
										t("gameSwitcher.gameMeta", { time: timeSince(mtime) }),
								}}
							/>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

// Game-directory modal and game binding are extracted → ./ProjectSwitcher (§D).

function timeSince(ms: number): string {
	const d = (Date.now() - ms) / 1000;
	if (d < 60) return `${Math.floor(d)}s`;
	if (d < 3600) return `${Math.floor(d / 60)}m`;
	if (d < 86400) return `${Math.floor(d / 3600)}h`;
	return `${Math.floor(d / 86400)}d`;
}

function NewGameModal({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation();
	const slugInputId = useId();
	const nameInputId = useId();
	const templateInputId = useId();
	const briefInputId = useId();
	const slugInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		slugInputRef.current?.focus();
	}, []);
	const [slug, setSlug] = useState("");
	const [name, setName] = useState("");
	const [brief, setBrief] = useState("");
	const [templates, setTemplates] = useState<GameTemplate[] | null>(null);
	const [templateSlug, setTemplateSlug] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const setActiveGame = useShellStore((s) => s.setActiveGame);

	useEffect(() => {
		let cancelled = false;
		void listGameTemplates()
			.then((items) => {
				if (cancelled) return;
				setTemplates(items);
				setTemplateSlug((current) =>
					items.some((item) => item.slug === current)
						? current
						: (items[0]?.slug ?? ""),
				);
			})
			.catch(() => {
				if (!cancelled) setTemplates([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const submit = async () => {
		const cleaned = slug
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/^-+|-+$/g, "");
		if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(cleaned)) {
			setErr(t("gameSwitcher.slugError"));
			return;
		}
		setBusy(true);
		setErr(null);
		try {
			const j = await getStudioProjectClient().createProject({
				slug: cleaned,
				name: name.trim() || cleaned,
				brief: brief.trim(),
				...(templateSlug ? { template: templateSlug } : {}),
			});
			if (!j.ok) {
				setErr(j.error ?? "create failed");
				setBusy(false);
				return;
			}
			await setActiveGame(cleaned);
			onClose();
			// Kick Forge with the brief so the design pipeline starts immediately.
			// Emit straight onto the new session's EventBus (server reflects
			// user_input → chat session-stream renders it). The shell never imports
			// chat — the bus IS the app-agnostic send channel.
			if (brief.trim()) {
				const st = useShellStore.getState();
				const sid = st.activeSid;
				if (sid) {
					const to = st.tabs.find((tb) => tb.sid === sid)?.agentId ?? undefined;
					void getSessionClient().emitForgeaXMessage(
						sid,
						t("gameSwitcher.kickoffMessage", {
							slug: cleaned,
							brief: brief.trim(),
						}),
						to ? { to } : {},
					);
				}
			}
		} catch (e) {
			setErr((e as Error).message);
			setBusy(false);
		}
	};

	return (
		<div
			className="tb-modal-overlay"
			role="dialog"
			aria-modal="true"
			aria-label={t("gameSwitcher.modalTitle")}
			tabIndex={-1}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
		>
			<div className="tb-modal">
				<div className="tb-modal-title">{t("gameSwitcher.modalTitle")}</div>
				<label className="tb-modal-label" htmlFor={slugInputId}>
					{t("gameSwitcher.slugLabel")}
				</label>
				<input
					id={slugInputId}
					ref={slugInputRef}
					className="tb-modal-input"
					placeholder="e.g. roguelike-deckbuilder"
					value={slug}
					onChange={(e) => setSlug(e.target.value)}
				/>
				<label className="tb-modal-label" htmlFor={nameInputId}>
					{t("gameSwitcher.nameLabel")}
				</label>
				<input
					id={nameInputId}
					className="tb-modal-input"
					placeholder={t("gameSwitcher.namePlaceholder")}
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<label className="tb-modal-label" htmlFor={templateInputId}>
					{t("gameSwitcher.templateLabel")}
				</label>
				{templates === null && (
					<div className="tb-modal-help">
						{t("gameSwitcher.templateLoading")}
					</div>
				)}
				{templates !== null && templates.length > 0 && (
					<select
						id={templateInputId}
						className="tb-modal-select"
						value={templateSlug}
						onChange={(e) => setTemplateSlug(e.target.value)}
						disabled={busy}
					>
						{templates.map((template) => (
							<option key={template.slug} value={template.slug}>
								{template.name}
							</option>
						))}
					</select>
				)}
				{templates !== null && templates.length === 0 && (
					<div className="tb-modal-help">{t("gameSwitcher.templateEmpty")}</div>
				)}
				<label className="tb-modal-label" htmlFor={briefInputId}>
					{t("gameSwitcher.briefLabel")}
				</label>
				<textarea
					id={briefInputId}
					className="tb-modal-textarea"
					placeholder={t("gameSwitcher.briefPlaceholder")}
					rows={3}
					value={brief}
					onChange={(e) => setBrief(e.target.value)}
				/>
				{err && <div className="tb-modal-error">{err}</div>}
				<div className="tb-modal-actions">
					<button
						type="button"
						className="tb-modal-btn"
						onClick={onClose}
						disabled={busy}
					>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						className="tb-modal-btn primary"
						onClick={submit}
						disabled={busy}
					>
						{busy ? t("gameSwitcher.creating") : t("gameSwitcher.create")}
					</button>
				</div>
			</div>
		</div>
	);
}
