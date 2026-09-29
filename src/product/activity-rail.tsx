import { useHost } from "@forgeax/app-shell/application";
import type { QualifiedActivityId } from "@forgeax/types";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { MoreHorizontal, Pin, Search } from "lucide-react";
import {
	type ComponentProps,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { lucideIconOrBox } from "./activity-lucide-icon";
import {
	activityRailCategory,
	addDefaultPinnedActivity,
	defaultPinnedActivityIds,
	groupDiscoverableActivities,
	localizeActivityRailEntries,
	migrateLegacyPinnedActivityIds,
	pinnedActivities,
} from "./activity-rail-model";
import { useTranslation } from "./product-locale";
import "./activity-rail.css";

const STORAGE_KEYS = {
	activityRailPinned: "forgeax.activityRail.pinned.v3",
	activityRailPinnedVideoGameDefault:
		"forgeax.activityRail.pinned.videoGameDefault.v1",
	activityRailPinnedLegacyV1: "forgeax.activityRail.pinned.v1",
} as const;

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function PopoverContent(
	props: ComponentProps<typeof PopoverPrimitive.Content>,
) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Content
				{...props}
				style={{ zIndex: "var(--z-menu)", ...props.style }}
				className={`ide-activity-popover ${props.className ?? ""}`}
			/>
		</PopoverPrimitive.Portal>
	);
}

function TooltipContent(
	props: ComponentProps<typeof TooltipPrimitive.Content>,
) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				{...props}
				style={{ pointerEvents: "none", ...props.style }}
				className={`ide-activity-tooltip ${props.className ?? ""}`}
			/>
		</TooltipPrimitive.Portal>
	);
}

function readStoredIds(key: string): string[] | null {
	try {
		const value = localStorage.getItem(key);
		if (value === null) return null;
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string")
			: null;
	} catch {
		return null;
	}
}

function writePinned(ids: readonly string[]): void {
	try {
		localStorage.setItem(STORAGE_KEYS.activityRailPinned, JSON.stringify(ids));
	} catch {
		/* quota */
	}
}

function readMigrationFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}

function writeMigrationFlag(key: string): void {
	try {
		localStorage.setItem(key, "1");
	} catch {
		/* quota */
	}
}

export function IdeActivityRail() {
	const { t, i18n } = useTranslation();
	const host = useHost();
	const catalog = useSyncExternalStore(
		host.activities.subscribe,
		host.activities.getSnapshot,
		host.activities.getSnapshot,
	);
	const pages = useSyncExternalStore(
		host.pages.subscribe,
		host.pages.getSnapshot,
		host.pages.getSnapshot,
	);
	const [savedPinned, setSavedPinned] = useState<string[] | null>(() =>
		readStoredIds(STORAGE_KEYS.activityRailPinned),
	);
	const [moreOpen, setMoreOpen] = useState(false);
	const [moreQuery, setMoreQuery] = useState("");
	const [rovingId, setRovingId] = useState<string>();
	const moreSearchRef = useRef<HTMLInputElement | null>(null);
	const firstMoreActionRef = useRef<HTMLButtonElement | null>(null);
	const pinnedRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const migrationComplete = useRef(savedPinned !== null);
	const videoGameDefaultMigrationComplete = useRef(
		readMigrationFlag(STORAGE_KEYS.activityRailPinnedVideoGameDefault),
	);
	const activities = useMemo(
		() => localizeActivityRailEntries(catalog.activities, i18n.language),
		[catalog.activities, i18n.language],
	);
	const defaultPinnedIds = useMemo(
		() => defaultPinnedActivityIds(activities),
		[activities],
	);
	const pinnedIds = savedPinned ?? defaultPinnedIds;
	const pinned = useMemo(
		() => pinnedActivities(activities, pinnedIds),
		[activities, pinnedIds],
	);
	const builtinPinned = useMemo(
		() => pinned.filter((activity) => activity.sourceLayer === "builtin"),
		[pinned],
	);
	const pluginPinned = useMemo(
		() => pinned.filter((activity) => activity.sourceLayer !== "builtin"),
		[pinned],
	);
	const groups = useMemo(
		() => groupDiscoverableActivities(activities, moreQuery),
		[activities, moreQuery],
	);
	const activeTypeId = pages.instances.find(
		(page) => page.encodedKey === pages.activeKey,
	)?.typeId;
	const activeActivityId = activities.find(
		(activity) => activity.pageTypeId === activeTypeId,
	)?.id;
	const activePinned = pinned.some(
		(activity) => activity.id === activeActivityId,
	);
	const moreActive = moreOpen || Boolean(activeActivityId && !activePinned);

	useEffect(() => {
		if (migrationComplete.current || activities.length === 0) return;
		const legacyIds = readStoredIds(STORAGE_KEYS.activityRailPinnedLegacyV1);
		if (legacyIds === null) {
			migrationComplete.current = true;
			return;
		}
		if (!activities.some((activity) => activity.sourceLayer !== "builtin"))
			return;
		const next = migrateLegacyPinnedActivityIds(legacyIds, activities);
		migrationComplete.current = true;
		setSavedPinned(next);
		writePinned(next);
	}, [activities]);

	useEffect(() => {
		if (
			videoGameDefaultMigrationComplete.current ||
			savedPinned === null ||
			activities.length === 0
		)
			return;
		const next = addDefaultPinnedActivity(
			savedPinned,
			activities,
			"video-game",
		);
		videoGameDefaultMigrationComplete.current = true;
		writeMigrationFlag(STORAGE_KEYS.activityRailPinnedVideoGameDefault);
		if (next.length === savedPinned.length) return;
		setSavedPinned(next);
		writePinned(next);
	}, [activities, savedPinned]);

	useEffect(() => {
		if (pinned.length === 0) {
			setRovingId(undefined);
			return;
		}
		if (rovingId && pinned.some((activity) => activity.id === rovingId)) return;
		setRovingId(
			pinned.find((activity) => activity.id === activeActivityId)?.id ??
				pinned[0]?.id,
		);
	}, [activeActivityId, pinned, rovingId]);

	const togglePin = useCallback(
		(id: string): void => {
			setSavedPinned((current) => {
				const resolved = current ?? defaultPinnedIds;
				const next = resolved.includes(id)
					? resolved.filter((candidate) => candidate !== id)
					: [...resolved, id];
				writePinned(next);
				return next;
			});
		},
		[defaultPinnedIds],
	);

	const onPinnedKeyDown = (
		event: KeyboardEvent<HTMLButtonElement>,
		index: number,
	): void => {
		const count = pinned.length;
		if (count === 0) return;
		let target: number;
		if (event.key === "ArrowDown" || event.key === "ArrowRight")
			target = (index + 1) % count;
		else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
			target = (index - 1 + count) % count;
		else if (event.key === "Home") target = 0;
		else if (event.key === "End") target = count - 1;
		else return;
		event.preventDefault();
		const activity = pinned[target];
		if (!activity) return;
		setRovingId(activity.id);
		pinnedRefs.current[target]?.focus();
	};

	const pinnedButton = (
		activity: (typeof activities)[number],
		index: number,
	) => {
		const active = activity.pageTypeId === activeTypeId;
		const Icon = lucideIconOrBox(activity.icon);
		const category = activityRailCategory(activity);
		return (
			<Tooltip key={activity.id}>
				<TooltipTrigger asChild>
					<button
						ref={(element) => {
							pinnedRefs.current[index] = element;
						}}
						type="button"
						className={`activity-rail-item${active ? " active" : ""}`}
						aria-label={activity.title}
						aria-current={active ? "page" : undefined}
						tabIndex={activity.id === rovingId ? 0 : -1}
						data-activity-id={activity.id}
						onFocus={() => setRovingId(activity.id)}
						onKeyDown={(event) => onPinnedKeyDown(event, index)}
						onClick={() =>
							void host.activities.launch(activity.id as QualifiedActivityId)
						}
					>
						<span className="activity-rail-item-ic" aria-hidden>
							<Icon size={22} strokeWidth={1.7} />
						</span>
						<span className="activity-rail-item-lb">{activity.title}</span>
					</button>
				</TooltipTrigger>
				<TooltipContent
					side="right"
					sideOffset={10}
					className="activity-rail-plugin-tip"
				>
					<div className="activity-rail-plugin-tip-title">{activity.title}</div>
					<div className="activity-rail-plugin-tip-category">
						{t(`sidebar.categories.${category}`)}
					</div>
					{activity.description ? (
						<div className="activity-rail-plugin-tip-description">
							{activity.description}
						</div>
					) : null}
				</TooltipContent>
			</Tooltip>
		);
	};

	return (
		<TooltipProvider delayDuration={260} skipDelayDuration={80}>
			<nav
				className="activity-rail thin-scrollbar"
				aria-label={t("sidebar.extensionsHint")}
				data-fx-slot="ActivityRail"
			>
				<div
					className="activity-rail-group"
					data-category="builtin"
					role="toolbar"
					aria-orientation="vertical"
					aria-label={t("sidebar.extensionsHint")}
				>
					{builtinPinned.map((activity) =>
						pinnedButton(activity, pinned.indexOf(activity)),
					)}
				</div>
				<div
					className="activity-rail-group"
					data-category="pinned"
					role="toolbar"
					aria-orientation="vertical"
					aria-label={t("sidebar.extensionsHint")}
				>
					{pluginPinned.map((activity) =>
						pinnedButton(activity, pinned.indexOf(activity)),
					)}
				</div>
				<div className="activity-rail-group activity-rail-group--more">
					<Popover
						open={moreOpen}
						onOpenChange={(open) => {
							setMoreOpen(open);
							if (!open) setMoreQuery("");
						}}
					>
						<PopoverTrigger asChild>
							<button
								type="button"
								className={`activity-rail-item${moreActive ? " active" : ""}`}
								title={t("sidebar.morePluginsHint")}
								aria-label={t("sidebar.morePluginsHint")}
								aria-haspopup="dialog"
								aria-expanded={moreOpen}
								data-rail-action="more-plugins"
							>
								<span className="activity-rail-item-ic" aria-hidden>
									<MoreHorizontal size={22} strokeWidth={1.7} />
								</span>
								<span className="activity-rail-item-lb">
									{t("sidebar.morePlugins")}
								</span>
							</button>
						</PopoverTrigger>
						<PopoverContent
							side="right"
							align="end"
							sideOffset={10}
							className="activity-rail-more"
							onOpenAutoFocus={(event) => {
								event.preventDefault();
								moreSearchRef.current?.focus();
							}}
						>
							<div className="activity-rail-more-hd">
								{t("sidebar.morePlugins")}
							</div>
							<div className="activity-rail-more-search">
								<Search size={14} strokeWidth={1.8} aria-hidden />
								<input
									ref={moreSearchRef}
									type="search"
									className="activity-rail-more-search-input"
									value={moreQuery}
									onChange={(event) => setMoreQuery(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "ArrowDown") {
											event.preventDefault();
											firstMoreActionRef.current?.focus();
										}
									}}
									placeholder={t("sidebar.searchPlugins")}
									aria-label={t("sidebar.searchPlugins")}
								/>
							</div>
							<div className="activity-rail-more-body thin-scrollbar">
								{groups.length === 0 ? (
									<div className="activity-rail-more-empty">
										{t("sidebar.noMatchingPlugins")}
									</div>
								) : (
									groups.map((group, groupIndex) => (
										<section
											className="activity-rail-more-sec"
											key={group.category}
										>
											<div className="activity-rail-more-sec-hd">
												{t(`sidebar.categories.${group.category}`)}
											</div>
											{group.items.map((activity, itemIndex) => {
												const isPinned = pinnedIds.includes(activity.id);
												const active = activity.pageTypeId === activeTypeId;
												const Icon = lucideIconOrBox(activity.icon);
												return (
													<div
														key={activity.id}
														className={`activity-rail-more-row${active ? " active" : ""}${isPinned ? " pinned" : ""}`}
													>
														<button
															ref={
																groupIndex === 0 && itemIndex === 0
																	? firstMoreActionRef
																	: undefined
															}
															type="button"
															className="activity-rail-more-open"
															onClick={async () => {
																await host.activities.launch(
																	activity.id as QualifiedActivityId,
																);
																setMoreOpen(false);
															}}
															title={activity.description || activity.title}
															aria-current={active ? "page" : undefined}
														>
															<span
																className="activity-rail-more-ic"
																aria-hidden
															>
																<Icon size={16} strokeWidth={1.7} />
															</span>
															<span className="activity-rail-more-meta">
																<span className="activity-rail-more-name">
																	{activity.title}
																</span>
																{activity.description ? (
																	<span className="activity-rail-more-desc">
																		{activity.description}
																	</span>
																) : null}
															</span>
														</button>
														<button
															type="button"
															className={`activity-rail-more-pin${isPinned ? " on" : ""}`}
															onClick={() => togglePin(activity.id)}
															title={
																isPinned
																	? t("sidebar.unpinPlugin")
																	: t("sidebar.pinPlugin")
															}
															aria-label={`${isPinned ? t("sidebar.unpinPlugin") : t("sidebar.pinPlugin")}: ${activity.title}`}
															aria-pressed={isPinned}
														>
															<Pin
																size={14}
																strokeWidth={isPinned ? 2.2 : 1.6}
															/>
														</button>
													</div>
												);
											})}
										</section>
									))
								)}
							</div>
						</PopoverContent>
					</Popover>
				</div>
			</nav>
		</TooltipProvider>
	);
}
