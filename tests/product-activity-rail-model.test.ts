import { qualifyContributionId } from "@forgeax/types";
import { describe, expect, it } from "vitest";
import {
	type ActivityRailEntry,
	activityRailCategory,
	addDefaultPinnedActivity,
	DEFAULT_PINNED_ACTIVITY_SLUGS,
	defaultPinnedActivityIds,
	groupDiscoverableActivities,
	localizeActivityRailEntries,
	migrateLegacyPinnedActivityIds,
	pinnedActivities,
} from "../src/product/activity-rail-model";

function activity(
	owner: string,
	localId: string,
	overrides: Partial<ActivityRailEntry> = {},
): ActivityRailEntry {
	return {
		id: qualifyContributionId(owner, "activity", localId),
		owner,
		title: localId,
		sourceLayer: "installed",
		...overrides,
	};
}

describe("activityRailCategory", () => {
	it("uses declared product categories and sends invalid or missing values to general", () => {
		expect(
			activityRailCategory(
				activity("@forgeax-extension/character", "main", {
					category: "3D",
				}),
			),
		).toBe("3D");
		expect(
			activityRailCategory(
				activity("@forgeax-extension/gen3d", "main", {
					category: "legacy",
				}),
			),
		).toBe("general");
		expect(
			activityRailCategory(activity("@forgeax-extension/items", "main")),
		).toBe("general");
		expect(activityRailCategory(activity("@example/new-plugin", "main"))).toBe(
			"general",
		);
	});
});

describe("localizeActivityRailEntries", () => {
	it("re-resolves activity metadata when the locale changes", () => {
		const entry = activity("@forgeax-extension/character", "launcher", {
			title: "Character Editor",
			titleI18n: { zh: "角色编辑", en: "Character Editor" },
			description: "Edit a character",
			descriptionI18n: { zh: "编辑角色", en: "Edit a character" },
		});

		expect(localizeActivityRailEntries([entry], "zh-CN")[0]).toMatchObject({
			title: "角色编辑",
			description: "编辑角色",
		});
		expect(localizeActivityRailEntries([entry], "en")[0]).toMatchObject({
			title: "Character Editor",
			description: "Edit a character",
		});
	});
});

describe("groupDiscoverableActivities", () => {
	const entries = [
		activity("@forgeax/core", "editor", { sourceLayer: "builtin" }),
		activity("@example/general-first", "alpha", {
			title: "Alpha Tool",
			description: "Paint worlds",
		}),
		activity("@forgeax-extension/gen3d", "zeta", {
			title: "Zeta Mesh",
			category: "3D",
		}),
		activity("@forgeax-extension/skill", "beta", {
			title: "Beta VFX",
			category: "3D",
		}),
		activity("@forgeax-extension/items", "icons", {
			title: "Inventory",
			description: "Item atlas",
			category: "2D",
		}),
	];

	it("groups every non-builtin activity while preserving registry order inside groups", () => {
		expect(
			groupDiscoverableActivities(entries, "").map((group) => ({
				category: group.category,
				ids: group.items.map((item) => item.id),
			})),
		).toEqual([
			{
				category: "3D",
				ids: [entries[2]?.id, entries[3]?.id],
			},
			{
				category: "2D",
				ids: [entries[4]?.id],
			},
			{
				category: "general",
				ids: [entries[1]?.id],
			},
		]);
	});

	it("searches title, description, qualified id, and owner", () => {
		expect(
			groupDiscoverableActivities(entries, "paint").flatMap(
				(group) => group.items,
			),
		).toEqual([entries[1]]);
		expect(
			groupDiscoverableActivities(entries, "zeta").flatMap(
				(group) => group.items,
			),
		).toEqual([entries[2]]);
		expect(
			groupDiscoverableActivities(entries, "#activity/icons").flatMap(
				(group) => group.items,
			),
		).toEqual([entries[4]]);
		expect(
			groupDiscoverableActivities(entries, "skill").flatMap(
				(group) => group.items,
			),
		).toEqual([entries[3]]);
	});

	it("keeps the full discoverable catalog when every activity is pinned", () => {
		const allIds = entries.map((entry) => entry.id);
		expect(pinnedActivities(entries, allIds)).toEqual([
			entries[0],
			entries[3],
			entries[2],
			entries[4],
			entries[1],
		]);
		expect(
			groupDiscoverableActivities(entries, "").flatMap((group) => group.items),
		).toHaveLength(4);
	});
});

describe("migrateLegacyPinnedActivityIds", () => {
	it("preserves qualified IDs and resolves legacy owner slugs or activity IDs", () => {
		const gen3d = activity("@forgeax-extension/gen3d", "main");
		const custom = activity("@example/custom-plugin", "custom-rail");
		const staleQualified = "@missing/plugin#activity/main";

		expect(
			migrateLegacyPinnedActivityIds(
				["gen3d", "custom-rail", staleQualified, "does-not-exist", "gen3d"],
				[gen3d, custom],
			),
		).toEqual([gen3d.id, custom.id, staleQualified]);
	});
});

describe("defaultPinnedActivityIds", () => {
	it("preserves product activities when npm packages consolidate multiple launchers", () => {
		const skill = activity("@forgeax-extension/skill", "main");
		const gen3d = activity("@forgeax-extension/gen3d", "main");
		const sceneGenerator = activity(
			"@forgeax-extension/scene-generator",
			"scene-generator.launcher",
		);
		const lowpoly = activity(
			"@forgeax-extension/scene-generator",
			"scene-generator.3d-model.launcher",
		);
		const sceneAssetGenerator = activity(
			"@forgeax-extension/scene-generator",
			"scene-generator.2d-assets.launcher",
		);
		const character = activity("@forgeax-extension/character", "main");
		const items = activity("@forgeax-extension/items", "main");
		const anim = activity("@forgeax-extension/anim", "main");
		const ui = activity("@forgeax-extension/ui", "ui.launcher");
		const narrative = activity("@forgeax-extension/narrative", "main");
		const videoGame = activity(
			"@forgeax-extension/video-game",
			"video-game.launcher",
		);
		const reel = activity("@forgeax-extension/reel", "main");
		const bgm = activity("@forgeax-extension/bgm", "main");
		const newPlugin = activity("@example/new-plugin", "main");

		const catalog = [
			lowpoly,
			sceneAssetGenerator,
			sceneGenerator,
			skill,
			gen3d,
			character,
			items,
			anim,
			ui,
			narrative,
			videoGame,
			reel,
			bgm,
			newPlugin,
		];
		const expected = [
			skill.id,
			gen3d.id,
			lowpoly.id,
			character.id,
			items.id,
			anim.id,
			sceneAssetGenerator.id,
			ui.id,
			narrative.id,
			videoGame.id,
			reel.id,
			bgm.id,
			sceneGenerator.id,
		];

		expect(DEFAULT_PINNED_ACTIVITY_SLUGS).toHaveLength(13);
		expect(defaultPinnedActivityIds(catalog)).toEqual(expected);
		expect(
			pinnedActivities(catalog, expected).map((entry) => entry.id),
		).toEqual(expected);
	});

	it("can append a new curated default to an existing pinned list", () => {
		const skill = activity("@forgeax-extension/skill", "main");
		const videoGame = activity(
			"@forgeax-extension/video-game",
			"video-game.launcher",
		);
		const existing = [skill.id];

		expect(
			addDefaultPinnedActivity(existing, [skill, videoGame], "video-game"),
		).toEqual([skill.id, videoGame.id]);
		expect(
			addDefaultPinnedActivity(
				[skill.id, videoGame.id],
				[skill, videoGame],
				"video-game",
			),
		).toEqual([skill.id, videoGame.id]);
		expect(addDefaultPinnedActivity(existing, [skill], "video-game")).toEqual(
			existing,
		);
	});
});
