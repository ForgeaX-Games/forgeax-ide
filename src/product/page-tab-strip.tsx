import {
	isPageDirty,
	PagePlatformError,
	subscribePageDirty,
	unsavedChangesDialog,
	useHost,
} from "@forgeax/app-shell/application";
import type { PageInstance, PageMenuItem } from "@forgeax/app-shell/pages";
import {
	installElementResizeObservation,
	installPointerReorderSession,
} from "@forgeax/app-shell/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@forgeax/editor/ui/dropdown-menu";
import {
	AtSign,
	ChevronsRight,
	Copy,
	Crosshair,
	File,
	FolderSearch,
	type LucideIcon,
	Minus,
	Pin,
	Plus,
	Save,
	X,
} from "lucide-react";
import {
	type ReactElement,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { iconForPage } from "./page-tab-icons";
import { lucideIconOrBox } from "./page-tab-lucide-icon";
import { openablePageTypes } from "./page-tab-model";
import {
	SearchableMenu,
	type SearchableMenuItem,
} from "./page-tab-searchable-menu";
import { useTranslation } from "./product-locale";
import "./page-tab-strip.css";

// Lucide glyphs for controller-contributed menu items (kebab name → component),
// same glyph set as the design demo's data-lucide names.
const MENU_ICON: Record<string, LucideIcon> = {
	copy: Copy,
	"folder-search": FolderSearch,
	crosshair: Crosshair,
	"at-sign": AtSign,
	save: Save,
};

/** Render controller-contributed items with a divider before each new group
 *  (including the first, to split them from the platform's base close group). */
function renderMenuItems(items: readonly PageMenuItem[]): ReactElement[] {
	const out: ReactElement[] = [];
	let lastGroup: string | undefined;
	items.forEach((item, i) => {
		if (i === 0 || item.group !== lastGroup)
			out.push(<DropdownMenuSeparator key={`sep-${item.id}`} />);
		lastGroup = item.group;
		const Icon = MENU_ICON[item.icon ?? ""] ?? File;
		out.push(
			<DropdownMenuItem
				key={item.id}
				disabled={item.disabled}
				onSelect={() => void item.run()}
			>
				<Icon aria-hidden />
				{item.label}
			</DropdownMenuItem>,
		);
	});
	return out;
}

/** Leaf name shown on a tab: owner-set live title → resource leaf → type title. */
function tabTitle(
	page: PageInstance,
	fallbackTitle: string | undefined,
): string {
	return (
		page.title ??
		page.resource?.displayPath?.split("/").at(-1) ??
		page.resource?.uri.split("/").at(-1) ??
		fallbackTitle ??
		page.typeId
	);
}

export function IdePageTabStrip(): ReactElement | null {
	const host = useHost();
	const { t } = useTranslation();
	const snapshot = useSyncExternalStore(
		host.pages.subscribe,
		host.pages.getSnapshot,
		host.pages.getSnapshot,
	);
	const registry = useSyncExternalStore(
		host.pageRegistry.subscribe,
		host.pageRegistry.getSnapshot,
		host.pageRegistry.getSnapshot,
	);
	const activityCatalog = useSyncExternalStore(
		host.activities.subscribe,
		host.activities.getSnapshot,
		host.activities.getSnapshot,
	);

	const listRef = useRef<HTMLDivElement>(null);
	const [draggingKey, setDraggingKey] = useState<string | null>(null);
	const [overflowing, setOverflowing] = useState(false);
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		key: string;
	} | null>(null);
	// Dirty state lives outside the page snapshot — a registered probe (e.g. the
	// Material Instance staging buffer) owns it, so re-render on its signal.
	const [, setDirtyTick] = useState(0);

	const { instances, activeKey } = snapshot;
	const hasTabs = instances.length > 0;
	// The "+" menu lists types openable without a resource. Hide SINGLETON types
	// that already have an open instance in this strip: reopening one only
	// refocuses the existing tab, so it's a duplicate, dead option. Multi-instance
	// types stay — opening another is a valid action.
	const openTypeIds = new Set(instances.map((p) => p.typeId));
	const openableTypes = openablePageTypes(registry).filter(
		(pageType) =>
			pageType.cardinality !== "singleton" || !openTypeIds.has(pageType.id),
	);
	const activityByPageType = new Map<
		string,
		(typeof activityCatalog.activities)[number]
	>();
	for (const activity of activityCatalog.activities) {
		if (activity.pageTypeId && !activityByPageType.has(activity.pageTypeId)) {
			activityByPageType.set(activity.pageTypeId, activity);
		}
	}
	const newPageItems: SearchableMenuItem[] = openableTypes.map((pageType) => ({
		id: pageType.id,
		label: pageType.title,
		keywords: [pageType.id, pageType.cardinality],
		group: t("pageTabs.availableTypes"),
		icon: activityByPageType.has(pageType.id)
			? lucideIconOrBox(activityByPageType.get(pageType.id)?.icon)
			: iconForPage({ typeId: pageType.id }),
	}));

	const focus = useCallback(
		(key: string) => void host.pages.focus(key).catch(() => {}),
		[host],
	);

	// A page may refuse to close with unsaved staging; ask save / discard / cancel
	// and retry with the decision the platform expects.
	const closeKey = useCallback(
		(key: string) => {
			void (async () => {
				try {
					await host.pages.close(key);
				} catch (error) {
					if (
						!(error instanceof PagePlatformError) ||
						error.code !== "PAGE_CLOSE_REQUIRES_DECISION"
					)
						return;
					const page = host.pages
						.getSnapshot()
						.instances.find((p) => p.encodedKey === key);
					const resolved = page
						? host.pageRegistry.get(page.typeId)
						: undefined;
					const title = page
						? tabTitle(
								page,
								resolved?.status === "available"
									? resolved.definition.title
									: undefined,
							)
						: key;
					const decision = await unsavedChangesDialog({
						title: t("dialog.unsavedTitle"),
						body: error.message || t("dialog.unsavedBody", { title }),
						saveText: t("common.save"),
						discardText: t("dialog.discardChanges"),
						cancelText: t("common.cancel"),
					});
					if (decision === "cancel") return;
					await host.pages.close(key, { decision }).catch(() => {});
				}
			})();
		},
		[host, t],
	);

	useEffect(() => subscribePageDirty(() => setDirtyTick((n) => n + 1)), []);

	// Keep the active tab in view when the selection changes under overflow.
	useEffect(() => {
		if (!activeKey) return;
		listRef.current
			?.querySelector(`[data-page-key="${CSS.escape(activeKey)}"]`)
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [activeKey]);

	// The overflow dropdown appears only when tabs can't all fit.
	useEffect(() => {
		if (instances.length === 0) return;
		const el = listRef.current;
		if (!el) return;
		const measure = () => setOverflowing(el.scrollWidth - el.clientWidth > 1);
		measure();
		return installElementResizeObservation({
			getElements: () => [el],
			onResize: measure,
		});
	}, [instances.length]);

	useEffect(() => {
		if (!hasTabs) return;
		const list = listRef.current;
		if (!list) return;
		const lifecycle = installPointerReorderSession({
			element: list,
			target: window,
			resolveItem: (target) =>
				target instanceof Element
					? (target.closest<HTMLElement>("[data-page-key]")?.dataset.pageKey ??
						null)
					: null,
			canStart: (event) =>
				event.target instanceof Element &&
				!event.target.closest("[data-page-close]"),
			reorder: (draggedKey, overKey) => {
				const toIndex = host.pages
					.getSnapshot()
					.instances.findIndex((page) => page.encodedKey === overKey);
				if (toIndex >= 0) host.pages.reorder(draggedKey, toIndex);
			},
			onDraggingChange: setDraggingKey,
		});
		return () => lifecycle.dispose();
	}, [host, hasTabs]);

	const handleTabClick = useCallback(
		(key: string) => {
			// Clicking the already-active tab is a no-op (matches the demo).
			if (key === activeKey) return;
			focus(key);
		},
		[activeKey, focus],
	);

	if (instances.length === 0) return null;

	const menuPage = menu
		? instances.find((p) => p.encodedKey === menu.key)
		: undefined;
	const menuIndex = menu
		? instances.findIndex((p) => p.encodedKey === menu.key)
		: -1;
	// Controller-contributed items, evaluated fresh at open (live disabled/label).
	const menuItems =
		menu && menuPage ? host.pages.getContextMenuItems(menu.key) : [];

	return (
		<div className="page-tab-strip" data-fx-slot="PageTabs">
			<div className="page-tab-scope">
				<div
					ref={listRef}
					className="page-tab-list"
					role="tablist"
					aria-label={t("pageTabs.openPages")}
				>
					{instances.map((page) => {
						const resolved = host.pageRegistry.get(page.typeId);
						const title = tabTitle(
							page,
							resolved?.status === "available"
								? resolved.definition.title
								: undefined,
						);
						const active = activeKey === page.encodedKey;
						const dirty = isPageDirty(page);
						const Icon = iconForPage({
							typeId: page.typeId,
							resource: page.resource,
						});
						const path = page.resource?.displayPath ?? page.resource?.uri;
						const classes = [
							"page-tab",
							"no-motion-lift",
							active ? "is-active" : "",
							page.closable ? "" : "is-pinned",
							dirty ? "is-dirty" : "",
							draggingKey === page.encodedKey ? "is-drag" : "",
						]
							.filter(Boolean)
							.join(" ");
						return (
							<div
								key={page.encodedKey}
								className={classes}
								role="tab"
								tabIndex={0}
								aria-selected={active}
								data-page-key={page.encodedKey}
								data-dirty={dirty ? "1" : undefined}
								title={path ?? title}
								onClick={() => handleTabClick(page.encodedKey)}
								onKeyDown={(event) => {
									if (event.target !== event.currentTarget) return;
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										handleTabClick(page.encodedKey);
									}
								}}
								onAuxClick={(e) => {
									if (e.button === 1 && page.closable) {
										e.preventDefault();
										closeKey(page.encodedKey);
									}
								}}
								onContextMenu={(e) => {
									e.preventDefault();
									setMenu({ x: e.clientX, y: e.clientY, key: page.encodedKey });
								}}
							>
								<Icon className="page-tab__icon" aria-hidden />
								<span className="page-tab__label">{title}</span>
								{dirty && (
									<span className="page-tab__dirty" aria-hidden>
										*
									</span>
								)}
								{page.closable ? (
									<button
										type="button"
										className="page-tab__close no-motion-lift"
										aria-label={t("pageTabs.closeTab", { title })}
										data-page-close={page.encodedKey}
										onClick={(e) => {
											e.stopPropagation();
											closeKey(page.encodedKey);
										}}
									>
										<X className="page-tab__close-icon" aria-hidden />
									</button>
								) : (
									<Pin className="page-tab__pin" aria-hidden />
								)}
							</div>
						);
					})}
				</div>

				<SearchableMenu
					ariaLabel={t("pageTabs.newPage")}
					searchPlaceholder={t("pageTabs.searchPageTypes")}
					emptyText={
						openableTypes.length === 0
							? t("pageTabs.noOpenableTypes")
							: t("pageTabs.noMatchingTypes")
					}
					items={newPageItems}
					className="page-tab-new-menu"
					onSelect={(item) => {
						const pageType = openableTypes.find(
							(candidate) => candidate.id === item.id,
						);
						if (pageType)
							void host.pages.open({ typeId: pageType.id }).catch(() => {});
					}}
					trigger={
						<button
							type="button"
							className="page-tab-btn page-tab-new no-motion-lift"
							title={t("pageTabs.newPage")}
							aria-label={t("pageTabs.newPage")}
						>
							<Plus className="page-tab-btn__icon" aria-hidden />
						</button>
					}
				/>

				<div className="page-tab-actions">
					{overflowing && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									className="page-tab-btn no-motion-lift"
									title={t("pageTabs.allPages")}
								>
									<ChevronsRight className="page-tab-btn__icon" aria-hidden />
									<span>{instances.length}</span>
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="min-w-[200px]">
								{instances.map((page) => {
									const resolved = host.pageRegistry.get(page.typeId);
									const title = tabTitle(
										page,
										resolved?.status === "available"
											? resolved.definition.title
											: undefined,
									);
									const Icon = iconForPage({
										typeId: page.typeId,
										resource: page.resource,
									});
									return (
										<DropdownMenuItem
											key={page.encodedKey}
											onSelect={() => focus(page.encodedKey)}
										>
											<Icon aria-hidden />
											<span className="page-tab-menu__mark">
												{activeKey === page.encodedKey ? "●" : "○"}
											</span>
											<span className="page-tab-menu__label">
												{isPageDirty(page) ? `${title} *` : title}
											</span>
										</DropdownMenuItem>
									);
								})}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</div>

			{/* Dedicated per-tab context menu (opt-out of the global menu host). */}
			<DropdownMenu
				open={menu !== null}
				onOpenChange={(open) => !open && setMenu(null)}
			>
				<DropdownMenuTrigger asChild>
					<span
						aria-hidden
						style={{
							position: "fixed",
							left: menu?.x ?? 0,
							top: menu?.y ?? 0,
							width: 0,
							height: 0,
						}}
					/>
				</DropdownMenuTrigger>
				{menu && menuPage && (
					<DropdownMenuContent
						align="start"
						className="min-w-[186px]"
						onContextMenu={(e) => e.preventDefault()}
					>
						<DropdownMenuItem
							disabled={!menuPage.closable}
							onSelect={() => closeKey(menu.key)}
						>
							<X aria-hidden />
							{t("pageTabs.context.close")}
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => {
								for (const p of instances)
									if (p.encodedKey !== menu.key && p.closable)
										closeKey(p.encodedKey);
								focus(menu.key);
							}}
						>
							<Minus aria-hidden />
							{t("pageTabs.context.closeOthers")}
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => {
								for (const p of instances.slice(menuIndex + 1))
									if (p.closable) closeKey(p.encodedKey);
							}}
						>
							<ChevronsRight aria-hidden />
							{t("pageTabs.context.closeToRight")}
						</DropdownMenuItem>
						{renderMenuItems(menuItems)}
					</DropdownMenuContent>
				)}
			</DropdownMenu>
		</div>
	);
}
