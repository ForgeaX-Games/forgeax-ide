// FsBrowser — server-side directory picker for an existing game directory.
//
// Folder-only navigation (the server endpoint only returns dirs). The caller
// binds the selected directory as the active game.

import { ArrowUp, Folder, FolderOpen, Home, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "./product-locale";
import "./project-directory-browser.css";

interface BrowseEntry {
	name: string;
	isDir: boolean;
	hasForgeaX: boolean;
	hasGame: boolean;
}
interface BrowseResp {
	dir: string;
	dirDisplay: string;
	parent: string | null;
	parentDisplay: string | null;
	name: string;
	selfHasForgeaX: boolean;
	selfHasGame: boolean;
	entries: BrowseEntry[];
	error?: string;
}

export interface ProjectDirectoryBrowserProps {
	initialDir?: string;
	onPick: (absPath: string) => void | Promise<void>;
	onCancel: () => void;
	busy?: boolean;
	externalError?: string | null;
}

export function ProjectDirectoryBrowser({
	initialDir = "~",
	onPick,
	onCancel,
	busy,
	externalError,
}: ProjectDirectoryBrowserProps) {
	const { t } = useTranslation();
	const [dir, setDir] = useState(initialDir);
	const [addrInput, setAddrInput] = useState(initialDir);
	const [data, setData] = useState<BrowseResp | null>(null);
	const [loadErr, setLoadErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [picking, setPicking] = useState(false);

	const load = useCallback(async (target: string) => {
		setLoading(true);
		setLoadErr(null);
		try {
			const r = await fetch(`/api/fs/browse?dir=${encodeURIComponent(target)}`);
			const j = (await r.json()) as BrowseResp;
			if (!r.ok || j.error) {
				setLoadErr(j.error ?? `HTTP ${r.status}`);
				setData(null);
			} else {
				setData(j);
				setAddrInput(j.dirDisplay);
			}
		} catch (e) {
			setLoadErr((e as Error).message);
			setData(null);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load(dir);
	}, [dir, load]);

	const enter = (name: string) => {
		if (!data) return;
		setDir(`${data.dir.replace(/\/$/, "")}/${name}`);
	};
	const goParent = () => {
		if (data?.parent) setDir(data.parent);
	};
	const goHome = () => setDir("~");
	const goAddr = () => {
		const v = addrInput.trim();
		if (v) setDir(v);
	};

	// OS-native folder dialog, same endpoint the onboarding project step uses.
	// The list stays authoritative afterwards: we only feed the picked path back
	// into `dir` so the footer's "select this directory" acts on it.
	const pickNative = async () => {
		setPicking(true);
		try {
			const r = await fetch("/api/fs/pick-directory", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ initialDir: data?.dir ?? dir }),
			});
			const j = (await r.json().catch(() => null)) as {
				ok?: boolean;
				cancelled?: boolean;
				path?: string;
				error?: string;
			} | null;
			if (j?.cancelled) return;
			if (!r.ok || !j?.ok || !j.path) {
				setLoadErr(j?.error ?? `HTTP ${r.status}`);
				return;
			}
			setLoadErr(null);
			// Same path as the current dir ⇒ no state change ⇒ no reload; that is the
			// correct outcome, the user re-picked where they already were.
			setDir(j.path);
		} catch (e) {
			setLoadErr((e as Error).message);
		} finally {
			setPicking(false);
		}
	};

	const onPickClick = () => {
		if (!data) return;
		void onPick(data.dir);
	};

	return (
		<div className="fsb">
			<div className="fsb-toolbar">
				<button
					type="button"
					className="fsb-icon-btn"
					onClick={goParent}
					disabled={!data?.parent || loading}
					title={t("fsBrowser.parentDir")}
				>
					<ArrowUp size={13} />
				</button>
				<button
					type="button"
					className="fsb-icon-btn"
					onClick={goHome}
					disabled={loading}
					title="HOME"
				>
					<Home size={13} />
				</button>
				<input
					className="fsb-addr"
					value={addrInput}
					onChange={(e) => setAddrInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") goAddr();
					}}
					spellCheck={false}
					placeholder="~/path/to/dir"
					title={t("fsBrowser.addrHint")}
				/>
				<button
					type="button"
					className="fsb-icon-btn"
					onClick={() => void pickNative()}
					disabled={loading || picking || busy}
					title={t("fsBrowser.browse")}
				>
					{picking ? (
						<Loader2 size={13} className="fsb-spin" />
					) : (
						<FolderOpen size={13} />
					)}
				</button>
			</div>

			<div className="fsb-list">
				{loading && (
					<div className="fsb-state">
						<Loader2 size={14} className="fsb-spin" /> {t("common.loading")}
					</div>
				)}
				{!loading && loadErr && (
					<div className="fsb-state fsb-err">{loadErr}</div>
				)}
				{!loading && !loadErr && data && data.entries.length === 0 && (
					<div className="fsb-state fsb-dim">{t("fsBrowser.emptyDir")}</div>
				)}
				{!loading &&
					!loadErr &&
					data?.entries.map((e) => (
						<button
							type="button"
							key={e.name}
							className="fsb-row"
							onClick={() => enter(e.name)}
							title={`${data.dir.replace(/\/$/, "")}/${e.name}`}
						>
							<Folder size={12} className="fsb-row-ico" />
							<span className="fsb-row-name">{e.name}</span>
							<span className="fsb-row-badges">
								{e.hasForgeaX && <span className="fsb-badge">.forgeax</span>}
								{e.hasGame && (
									<span className="fsb-badge fsb-badge-game">game</span>
								)}
							</span>
						</button>
					))}
			</div>

			<div className="fsb-footer">
				{externalError && <div className="fsb-ext-err">{externalError}</div>}
				<div className="fsb-actions">
					<button
						type="button"
						className="tb-modal-btn"
						onClick={onCancel}
						disabled={busy}
					>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						className="tb-modal-btn primary"
						onClick={onPickClick}
						disabled={busy || !data}
						title={
							data ? t("fsBrowser.selectDir", { dir: data.dirDisplay }) : ""
						}
					>
						{busy ? t("fsBrowser.processing") : t("fsBrowser.selectThisDir")}
					</button>
				</div>
			</div>
		</div>
	);
}
