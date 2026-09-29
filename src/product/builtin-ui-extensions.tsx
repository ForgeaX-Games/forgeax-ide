import type {
	AppExtension,
	StatusItemContribution,
} from "@forgeax/app-shell/application";
import type { ComponentType } from "react";
import { IdeStatusBar } from "./status-bar";

export function createIdeViewportExtension(
	ViewportPanel: ComponentType,
): AppExtension {
	return {
		id: "panels.viewport",
		version: "1.0.0",
		contributes: {
			panels: {
				panels: {
					viewport: {
						title: "Viewport",
						order: 0,
						header: { visible: true, showTitle: false },
						content: { padding: "none", scroll: "none", tone: "tool" },
						dockChrome: { singleTab: "hideTitle" },
						render: () => <ViewportPanel />,
					},
				},
			},
		},
	};
}

export function createIdeStatusBarExtension(
	items: readonly StatusItemContribution[],
): AppExtension {
	const stripItems: Record<string, StatusItemContribution> = {};
	for (const item of items) stripItems[item.id] = item;
	return {
		id: "chrome.statusbar",
		version: "1.0.0",
		contributes: { panels: { stripItems, slots: { StatusBar: IdeStatusBar } } },
	};
}
