/**
 * IDE drawer host for App Shell `drawerPanels` contributions.
 *
 * Renders the expandable panel overlay. The footer remains a single row.
 *
 * Geometry (ADR-0030 §1 drawer capabilities): left edge = screen left, right
 * edge = flush against the plugin rail (`.activity-rail`, measured at runtime),
 * bottom = just above the status bar. Height persists via useIdeDrawerStore.
 *
 * Data planes stay separate (ADR-0030 §4): structural = drawerPanels snapshot;
 * UI layout = useIdeDrawerStore (open/active/height); business = each panel's own
 * store. A panel unregistered while active collapses gracefully (no dangling).
 */

import {
	type DrawerPanelContribution,
	usePanelRenderers,
} from "@forgeax/app-shell/application";
import {
	AnchoredResizeHandle,
	ApplicationRecoveryBoundary,
	installElementResizeObservation,
	installViewportResizeObservation,
} from "@forgeax/app-shell/react";
import { PanelBottomClose } from "lucide-react";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { reportError } from "../integration/error-reporting";
import { useIdeDrawerStore } from "./drawer-store";
import { useTranslation } from "./product-locale";
import "./drawer-host.css";

export function IdeDrawerHost(): ReactElement | null {
	const { t } = useTranslation();
	const renderers = usePanelRenderers();
	const activeId = useIdeDrawerStore((s) => s.activeId);
	const height = useIdeDrawerStore((s) => s.height);
	const close = useIdeDrawerStore((s) => s.close);
	const setHeight = useIdeDrawerStore((s) => s.setHeight);

	const panels = useMemo<DrawerPanelContribution[]>(() => {
		const list = Object.values(renderers.drawerPanels ?? {});
		return list
			.filter((p) => !p.when || p.when())
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
	}, [renderers.drawerPanels]);

	const active = activeId
		? (panels.find((p) => p.id === activeId) ?? null)
		: null;

	// Exit animation: when activeId clears we keep the last panel mounted with an
	// `is-closing` class (reverse reveal) and unmount on animationend, so collapse
	// animates instead of vanishing. Panel→panel switches swap immediately.
	const [displayPanel, setDisplayPanel] =
		useState<DrawerPanelContribution | null>(active);
	const [closing, setClosing] = useState(false);
	useEffect(() => {
		if (active) {
			setDisplayPanel(active);
			setClosing(false);
		} else if (displayPanel) {
			setClosing(true);
		}
	}, [active, displayPanel]);

	// Graceful degrade (ADR-0030 §6): the active panel was unregistered → collapse.
	useEffect(() => {
		if (activeId && !panels.some((p) => p.id === activeId)) close();
	}, [activeId, panels, close]);

	// Right edge flush against the plugin rail — measured (chat column width is
	// user-resizable, so a static inset would drift).
	const [rightInset, setRightInset] = useState(0);
	useEffect(() => {
		const measure = () => {
			const rail = document.querySelector(".activity-rail");
			if (!rail) {
				setRightInset(0);
				return;
			}
			const rect = rail.getBoundingClientRect();
			setRightInset(Math.max(0, Math.round(window.innerWidth - rect.left)));
		};
		measure();
		const disposeBodyResize = installElementResizeObservation({
			getElements: () => [document.body],
			onResize: measure,
		});
		const disposeViewportResize = installViewportResizeObservation({
			onResize: measure,
		});
		return () => {
			disposeViewportResize();
			disposeBodyResize();
		};
	}, []);

	if (!displayPanel) return null;

	return (
		<div
			className={`fx-drawer-panel${closing ? " is-closing" : ""}`}
			data-fx-slot="Drawer"
			style={{ height, ["--fx-drawer-right" as string]: `${rightInset}px` }}
			onAnimationEnd={() => {
				if (closing) {
					setDisplayPanel(null);
					setClosing(false);
				}
			}}
		>
			<AnchoredResizeHandle
				orientation="row"
				className="fx-drawer-resizer"
				ariaLabel="Resize drawer"
				direction="subtract"
				readSize={() => useIdeDrawerStore.getState().height}
				writeSize={setHeight}
				resizingBodyClassName="fx-drawer-resizing"
			/>
			<div className="fx-drawer-header">
				<span className="fx-drawer-title">
					{displayPanel.titleKey
						? t(displayPanel.titleKey)
						: displayPanel.title}
				</span>
				<button
					type="button"
					className="fx-drawer-collapse"
					onClick={close}
					title="Collapse"
					aria-label="Collapse drawer"
				>
					<PanelBottomClose size={14} />
				</button>
			</div>
			<div className="fx-drawer-body">
				<ApplicationRecoveryBoundary
					scope={`drawer:${displayPanel.id}`}
					messages={{
						title: t("errorBoundary.fullscreenTitle"),
						hint: t("errorBoundary.fullscreenHint"),
						retry: t("errorBoundary.retry"),
						remount: t("errorBoundary.reloadRegion"),
						reloadApplication: t("errorBoundary.reloadStudio"),
					}}
					onError={(error, info, scope) =>
						reportError(error, info.componentStack, scope)
					}
				>
					{displayPanel.render()}
				</ApplicationRecoveryBoundary>
			</div>
		</div>
	);
}
