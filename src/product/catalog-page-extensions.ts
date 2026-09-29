import type {
	ActivityRegistration,
	AppExtension,
	ApplicationExtensionControl,
	Cleanup,
	PageTypeRegistration,
	PanelTypeRegistration,
	ResourceEditorRegistration,
} from "@forgeax/app-shell/application";
import { ExtensionCleanupDeferredError } from "@forgeax/extension-platform/extensions";
import {
	encodePageKey,
	qualifyContributionId,
	resolveContributionRef,
} from "@forgeax/types";
import { type ComponentType, createElement } from "react";
import {
	type ExtensionCatalogInfo as ExtensionInfo,
	type ExtensionCatalogListResponse as ExtensionListResponse,
	restExtensionCatalogClient,
} from "../integration/rest-extension-catalog-client";
import { subscribeUiEvents } from "../integration/ui-event-stream";
import { getLocale } from "./product-locale";

export interface CatalogViews {
	ExtensionHostPanel: ComponentType<{
		extensionId: string;
		pane?: "left" | "center";
		manifest: ExtensionInfo;
	}>;
}

const EMBEDDED_EXTENSION_HOST_IDS = new Set([
	"@forgeax-extension/video-game",
	"@forgeax-extension/game-video",
]);

/** Product-owned placement policy for extensions hosted inside the IDE. */
export function isIdeExtensionHostExtension(id: string): boolean {
	return EMBEDDED_EXTENSION_HOST_IDS.has(id);
}

function title(
	value: string | { zh?: string; en?: string; ja?: string },
): string {
	if (typeof value === "string") return value;
	const locale = getLocale();
	return value[locale] ?? value.en ?? value.zh ?? value.ja ?? "";
}

export function catalogExtensionItems(
	payload: unknown,
): readonly ExtensionInfo[] {
	if (!payload || typeof payload !== "object") return [];
	const items = (payload as { items?: unknown }).items;
	return Array.isArray(items) ? (items as ExtensionInfo[]) : [];
}

type ExtensionPane = "left" | "center";

export function extensionPane(
	initialProps?: Readonly<Record<string, unknown>>,
): ExtensionPane | undefined {
	const pane = initialProps?.pane;
	return pane === "left" || pane === "center" ? pane : undefined;
}

/** Adapt scanner-normalized panel types into Page runtime registrations. */
function extensionHostPanelRegistration(
	item: ExtensionInfo,
	panelTypeId: PanelTypeRegistration["id"],
	views: CatalogViews,
): PanelTypeRegistration {
	return {
		id: panelTypeId,
		runtime: {
			kind: "inline",
			render: (context) =>
				createElement(views.ExtensionHostPanel, {
					extensionId: item.id,
					pane: extensionPane(context.initialProps),
					manifest: item,
				}),
		},
		...(item.entry?.standalone && !isIdeExtensionHostExtension(item.id)
			? {
					windowing: {
						createTarget: (context) => {
							const pane = extensionPane(context.initialProps);
							return {
								surface: {
									kind: "plugin" as const,
									id: item.id,
									...(pane ? { pane } : {}),
									instance: `${encodePageKey(context.pageKey)}::${context.placementId}`,
								},
								title: title(item.displayName),
								width: 960,
								height: 720,
								dockBehavior: "keep-anchor" as const,
							};
						},
					},
				}
			: {}),
	};
}

export function catalogPanelTypeRegistrations(
	item: ExtensionInfo,
	views: CatalogViews,
): PanelTypeRegistration[] {
	const byId = new Map<PanelTypeRegistration["id"], PanelTypeRegistration>();
	for (const panel of item.contributes?.panelTypes ?? []) {
		const id = qualifyContributionId(
			item.id,
			"panel",
			panel.id,
		) as PanelTypeRegistration["id"];
		byId.set(id, extensionHostPanelRegistration(item, id, views));
	}
	for (const page of item.contributes?.pages ?? []) {
		for (const placement of page.panels ?? []) {
			const id = resolveContributionRef(
				item.id,
				"panel",
				placement.panelType,
			) as PanelTypeRegistration["id"];
			if (!byId.has(id))
				byId.set(id, extensionHostPanelRegistration(item, id, views));
		}
	}
	return [...byId.values()];
}

/** Browser-side activation of scanner-normalized page contributions. Hosts may
 * override an extension with a richer in-process implementation by using the
 * same extension id; those ids are filtered before this adapter runs. */
export function catalogPageExtensions(
	items: readonly ExtensionInfo[],
	overriddenIds: ReadonlySet<string>,
	views: CatalogViews,
): readonly AppExtension[] {
	return items.flatMap((item): AppExtension[] => {
		const contributes = item.contributes;
		if (!contributes?.pages?.length || overriddenIds.has(item.id)) return [];

		const panelTypes = catalogPanelTypeRegistrations(item, views);
		const pages: PageTypeRegistration[] = contributes.pages.map((page) => {
			const placements = (page.panels ?? []).map((placement) => ({
				id: placement.id,
				panelTypeId: resolveContributionRef(
					item.id,
					"panel",
					placement.panelType,
				) as PanelTypeRegistration["id"],
				title: placement.title ? title(placement.title) : undefined,
				optional: placement.optional,
				initialProps: placement.initialProps,
			}));
			return {
				id: qualifyContributionId(
					item.id,
					"page",
					page.id,
				) as PageTypeRegistration["id"],
				title: title(page.title),
				cardinality: page.cardinality,
				restorePolicy: page.restorePolicy,
				layoutVersion: page.layoutVersion,
				panels: placements,
				layout: page.layout,
			};
		});
		const activities: ActivityRegistration[] = (
			contributes.activities ?? []
		).map((activity) => ({
			id: qualifyContributionId(
				item.id,
				"activity",
				activity.id,
			) as ActivityRegistration["id"],
			title: title(activity.title),
			titleI18n:
				typeof activity.title === "string" ? undefined : activity.title,
			description: item.description ? title(item.description) : undefined,
			descriptionI18n:
				item.description && typeof item.description !== "string"
					? item.description
					: undefined,
			icon: activity.icon,
			category: activity.category,
			order: activity.order,
			// Host-injected source layer — scanner-loaded extensions are all
			// installed-tier, so they sort AFTER builtin core nav regardless of the
			// `order` they declare (or omit). Never taken from the manifest.
			sourceLayer: "installed",
			pageTypeId: activity.pageType
				? (resolveContributionRef(
						item.id,
						"page",
						activity.pageType,
					) as PageTypeRegistration["id"])
				: undefined,
			commandId: activity.commandId,
		}));
		const resourceEditors: ResourceEditorRegistration[] = (
			contributes.resourceEditors ?? []
		).map((editor) => ({
			id: qualifyContributionId(
				item.id,
				"resource-editor",
				editor.id,
			) as ResourceEditorRegistration["id"],
			selector: editor.selector,
			pageTypeId: resolveContributionRef(
				item.id,
				"page",
				editor.pageType,
			) as PageTypeRegistration["id"],
			priority: editor.priority,
			sourceLayer: "installed",
		}));
		return [
			{
				id: item.id,
				version: item.version,
				requires: ["pages"],
				contributes: { panelTypes, pages, activities, resourceEditors },
			},
		];
	});
}

interface CatalogRuntimeRecord {
	readonly signature: string;
	readonly cleanup: Cleanup;
}

function catalogItemSignature(item: ExtensionInfo | undefined): string {
	if (!item) return "";
	const { registryGeneration: _registryGeneration, ...content } = item;
	return JSON.stringify(content);
}

export interface CatalogPageExtensionRuntime {
	refresh(): Promise<void>;
	start(): Promise<void>;
	dispose(): Promise<void>;
}

/** Registry-generation-driven lifecycle for scanner contributions. It only
 * owns catalog Page/Panel/Activity registrations; product overrides and
 * in-process extension setup remain under the main ExtensionLoader. */
export function createCatalogPageExtensionRuntime(options: {
	control: Pick<ApplicationExtensionControl, "contributePagePlatform">;
	overriddenIds: ReadonlySet<string>;
	views: CatalogViews;
	load?: () => Promise<ExtensionListResponse>;
	onError?: (
		error: unknown,
		extensionId: string,
		phase: "register" | "cleanup",
	) => void;
}): CatalogPageExtensionRuntime {
	// Reload events are authoritative: neither a short-lived cache nor an older
	// request from another consumer may swallow the only change notification.
	// This runtime already serializes its own reads through the refresh chain.
	const load =
		options.load ?? (() => restExtensionCatalogClient.listExtensions());
	const onError =
		options.onError ??
		((error, extensionId, phase) => {
			console.error(
				`[forgeax:extension-catalog] ${phase} failed for "${extensionId}"`,
				error,
			);
		});
	const active = new Map<string, CatalogRuntimeRecord>();
	let generation: number | undefined;
	let stopEvents: (() => void) | undefined;
	let chain = Promise.resolve();
	let disposed = false;

	const reportError = (
		error: unknown,
		id: string,
		phase: "register" | "cleanup",
	): void => {
		try {
			onError(error, id, phase);
		} catch {
			/* Isolate the diagnostic sink. */
		}
	};

	const retire = async (
		id: string,
		record: CatalogRuntimeRecord,
	): Promise<void> => {
		try {
			await record.cleanup();
		} catch (error) {
			reportError(error, id, "cleanup");
			if (error instanceof ExtensionCleanupDeferredError) throw error;
			// Ordinary teardown may already be destructive; never retry it.
		}
		active.delete(id);
		generation = undefined;
	};

	const reconcile = async (response: ExtensionListResponse): Promise<void> => {
		if (generation !== undefined && response.generation === generation) return;
		const itemsById = new Map(response.items.map((item) => [item.id, item]));
		const next = new Map(
			catalogPageExtensions(
				response.items,
				options.overriddenIds,
				options.views,
			).map((extension) => [extension.id, extension]),
		);

		for (const [id, record] of [...active].reverse()) {
			const item = itemsById.get(id);
			const signature = catalogItemSignature(item);
			if (!next.has(id) || signature !== record.signature) {
				try {
					await retire(id, record);
				} catch {
					// Keep the barrier and allow a later refresh of this same generation.
					generation = undefined;
					return;
				}
			}
		}
		for (const [id, extension] of next) {
			if (active.has(id)) continue;
			const contributes = extension.contributes;
			try {
				const cleanup = options.control.contributePagePlatform(id, {
					pageTypes: contributes?.pages,
					panelTypes: contributes?.panelTypes,
					activities: contributes?.activities,
					resourceEditors: contributes?.resourceEditors,
				});
				active.set(id, {
					signature: catalogItemSignature(itemsById.get(id)),
					cleanup,
				});
			} catch (error) {
				reportError(error, id, "register");
			}
		}
		generation = response.generation;
	};

	const refresh = (): Promise<void> => {
		chain = chain
			.catch(() => undefined)
			.then(async () => {
				if (!disposed) await reconcile(await load());
			});
		return chain;
	};

	return {
		refresh,
		async start() {
			await refresh().catch(() => undefined);
			if (!disposed) {
				try {
					stopEvents = subscribeUiEvents("plugin.reloaded", () => {
						void refresh().catch(() => undefined);
					});
				} catch {
					// The event transport is optional in non-browser/test hosts.
				}
			}
		},
		dispose() {
			chain = chain
				.catch(() => undefined)
				.then(async () => {
					if (disposed) return;
					for (const [id, record] of [...active].reverse())
						await retire(id, record);
					disposed = true;
					stopEvents?.();
					stopEvents = undefined;
				});
			return chain;
		},
	};
}
