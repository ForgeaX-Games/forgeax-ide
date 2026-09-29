import type { ActivityRegistration } from "@forgeax/app-shell/pages";

export type ActivityRailCategory = "3D" | "2D" | "general";
export type ActivityRailEntry = ActivityRegistration & {
	readonly owner: string;
};

const CATEGORY_ORDER: readonly ActivityRailCategory[] = ["3D", "2D", "general"];
export const DEFAULT_PINNED_ACTIVITY_SLUGS = [
	"skill",
	"gen3d",
	"scene-generator.3d-model",
	"character",
	"items",
	"anim",
	"scene-generator.2d-assets",
	"ui",
	"narrative",
	"video-game",
	"reel",
	"bgm",
	"scene-generator",
] as const;

function contributionLocalId(id: string): string | undefined {
	return id.match(/#activity\/(.+)$/)?.[1];
}

function ownerSlug(owner: string): string {
	return (
		owner.split("/").filter(Boolean).at(-1)?.toLowerCase() ??
		owner.toLowerCase()
	);
}

function localizedText(
	value: ActivityRegistration["titleI18n"],
	locale: string,
	fallback: string,
): string {
	if (!value) return fallback;
	const language = locale.toLowerCase().split("-")[0];
	if (language === "zh") return value.zh ?? value.en ?? value.ja ?? fallback;
	if (language === "ja") return value.ja ?? value.en ?? value.zh ?? fallback;
	return value.en ?? value.zh ?? value.ja ?? fallback;
}

export function localizeActivityRailEntries(
	activities: readonly ActivityRailEntry[],
	locale: string,
): readonly ActivityRailEntry[] {
	return activities.map((activity) => ({
		...activity,
		title: localizedText(activity.titleI18n, locale, activity.title),
		description:
			localizedText(
				activity.descriptionI18n,
				locale,
				activity.description ?? "",
			) || undefined,
	}));
}

function ownerAliases(activity: ActivityRailEntry): string[] {
	const owner = ownerSlug(activity.owner);
	return [activity.owner, owner];
}

function localActivityAliases(activity: ActivityRailEntry): string[] {
	const localId = contributionLocalId(activity.id);
	const localIdWithoutLauncher = localId?.replace(/\.launcher$/, "");
	return [activity.id, localId, localIdWithoutLauncher].filter(
		(value): value is string => Boolean(value),
	);
}

function legacyAliases(activity: ActivityRailEntry): string[] {
	return [...localActivityAliases(activity), ...ownerAliases(activity)];
}

export function activityRailCategory(
	activity: ActivityRailEntry,
): ActivityRailCategory {
	const declared = activity.category?.trim().toLowerCase();
	if (declared === "3d") return "3D";
	if (declared === "2d") return "2D";
	if (declared === "general") return "general";
	return "general";
}

export function discoverableActivities(
	activities: readonly ActivityRailEntry[],
): readonly ActivityRailEntry[] {
	return activities.filter((activity) => activity.sourceLayer !== "builtin");
}

export interface ActivityRailGroup {
	readonly category: ActivityRailCategory;
	readonly items: readonly ActivityRailEntry[];
}

export function groupDiscoverableActivities(
	activities: readonly ActivityRailEntry[],
	query: string,
): readonly ActivityRailGroup[] {
	const normalizedQuery = query.trim().toLowerCase();
	const groups = new Map<ActivityRailCategory, ActivityRailEntry[]>(
		CATEGORY_ORDER.map((category) => [category, []]),
	);

	for (const activity of discoverableActivities(activities)) {
		if (
			normalizedQuery &&
			![
				activity.title,
				activity.description ?? "",
				activity.id,
				activity.owner,
			].some((value) => value.toLowerCase().includes(normalizedQuery))
		) {
			continue;
		}
		groups.get(activityRailCategory(activity))?.push(activity);
	}

	return CATEGORY_ORDER.map((category) => ({
		category,
		items: groups.get(category) ?? [],
	})).filter((group) => group.items.length > 0);
}

export function pinnedActivities(
	activities: readonly ActivityRailEntry[],
	pinnedIds: readonly string[],
): readonly ActivityRailEntry[] {
	const pinned = new Set(pinnedIds);
	const selected = activities.filter(
		(activity) => activity.sourceLayer === "builtin" || pinned.has(activity.id),
	);
	const defaultRank = (activity: ActivityRailEntry): number => {
		const aliases = new Set(
			legacyAliases(activity).map((alias) => alias.toLowerCase()),
		);
		const rank = DEFAULT_PINNED_ACTIVITY_SLUGS.findIndex((slug) =>
			aliases.has(slug),
		);
		return rank < 0 ? Number.POSITIVE_INFINITY : rank;
	};
	return selected
		.map((activity, registryIndex) => ({ activity, registryIndex }))
		.sort((left, right) => {
			if (
				left.activity.sourceLayer === "builtin" ||
				right.activity.sourceLayer === "builtin"
			) {
				return left.registryIndex - right.registryIndex;
			}
			return (
				defaultRank(left.activity) - defaultRank(right.activity) ||
				left.registryIndex - right.registryIndex
			);
		})
		.map(({ activity }) => activity);
}

export function migrateLegacyPinnedActivityIds(
	legacyIds: readonly string[],
	activities: readonly ActivityRailEntry[],
): string[] {
	const aliasToQualifiedId = new Map<string, string>();
	for (const activity of activities) {
		for (const alias of ownerAliases(activity)) {
			const normalized = alias.toLowerCase();
			if (!aliasToQualifiedId.has(normalized))
				aliasToQualifiedId.set(normalized, activity.id);
		}
	}
	for (const activity of activities) {
		for (const alias of localActivityAliases(activity)) {
			aliasToQualifiedId.set(alias.toLowerCase(), activity.id);
		}
	}

	const migrated: string[] = [];
	const seen = new Set<string>();
	for (const legacyId of legacyIds) {
		const qualifiedId = legacyId.includes("#activity/")
			? legacyId
			: aliasToQualifiedId.get(legacyId.toLowerCase());
		if (qualifiedId && !seen.has(qualifiedId)) {
			seen.add(qualifiedId);
			migrated.push(qualifiedId);
		}
	}
	return migrated;
}

export function defaultPinnedActivityIds(
	activities: readonly ActivityRailEntry[],
): string[] {
	return migrateLegacyPinnedActivityIds(
		DEFAULT_PINNED_ACTIVITY_SLUGS,
		activities,
	);
}

export function addDefaultPinnedActivity(
	pinnedIds: readonly string[],
	activities: readonly ActivityRailEntry[],
	slug: string,
): string[] {
	const [qualifiedId] = migrateLegacyPinnedActivityIds([slug], activities);
	if (!qualifiedId || pinnedIds.includes(qualifiedId)) return [...pinnedIds];
	return [...pinnedIds, qualifiedId];
}
