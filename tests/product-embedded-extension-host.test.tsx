import type { ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionCatalogInfo } from "../src/integration/rest-extension-catalog-client";
import { IdeExtensionHostPanel } from "../src/product/embedded-extension-host";

const fixture = vi.hoisted(() => ({
	inlinePanels: {} as Record<string, ComponentType>,
	gameId: "game-one" as string | null,
	gameResolved: true,
	runtime: {
		descriptor: {
			extensionId: "@forgeax-extension/video-game",
			runtimeId: "runtime-one",
			title: "Video Game",
			runtimeUrl: "/__extension__/v1/runtime/one",
		},
		loading: false,
		error: null,
		retry: () => {},
	},
}));

vi.mock("@forgeax/app-shell/application", () => ({
	usePanelRenderers: () => ({
		extensionPanels: fixture.inlinePanels,
		editor: {},
	}),
}));
vi.mock("@forgeax/extension-host/react", () => ({
	ExtensionFrame: ({
		runtimeUrl,
		context,
	}: {
		runtimeUrl: string;
		context: unknown;
	}) => (
		<div
			data-frame-url={runtimeUrl}
			data-frame-context={JSON.stringify(context)}
		/>
	),
}));
vi.mock("../src/product/embedded-extension-catalog", () => ({
	useExtensionCatalogEntry: () => fixture.runtime,
}));
vi.mock("../src/product/product-locale", () => ({
	getLocale: () => "en",
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../src/product/shell-state-runtime", () => ({
	useShellStore: (select: (state: unknown) => unknown) =>
		select({
			activeGameSlug: fixture.gameId,
			activeGameResolved: fixture.gameResolved,
		}),
}));

const embedded: ExtensionCatalogInfo = {
	id: "@forgeax-extension/video-game",
	version: "1",
	displayName: "Video Game",
	frontendUrl: "/video-game/",
};
const LegacyPanel = () => <div data-panel="legacy" />;

beforeEach(() => {
	vi.stubGlobal("window", { location: { href: "https://studio.example/app" } });
});
afterEach(() => {
	vi.unstubAllGlobals();
	fixture.inlinePanels = {};
	fixture.gameId = "game-one";
	fixture.gameResolved = true;
});

describe("IDE embedded extension host view", () => {
	test("uses the IDE frame for embedded iframe pages with the active game", () => {
		const html = renderToString(
			<IdeExtensionHostPanel
				extensionId={embedded.id}
				pane="center"
				manifest={embedded}
				LegacyPanel={LegacyPanel}
			/>,
		);
		expect(html).toContain(
			'data-frame-url="/__extension__/v1/runtime/one?pane=center"',
		);
		expect(html).toContain("game-one");
		expect(html).not.toContain('data-panel="legacy"');
	});

	test("renders inline contributions in IDE and retains native module fallback", () => {
		fixture.inlinePanels = {
			[embedded.id]: () => <span data-panel="inline" />,
		};
		const inline = renderToString(
			<IdeExtensionHostPanel
				extensionId={embedded.id}
				manifest={embedded}
				LegacyPanel={LegacyPanel}
			/>,
		);
		expect(inline).toContain('data-panel="inline"');
		expect(inline).not.toContain('data-panel="legacy"');
		fixture.inlinePanels = {};
		expect(
			renderToString(
				<IdeExtensionHostPanel
					extensionId={embedded.id}
					manifest={{ ...embedded, runtimeMode: "native-module" }}
					LegacyPanel={LegacyPanel}
				/>,
			),
		).toContain('data-panel="legacy"');
	});

	test("renders non-runtime catalog entries as IDE placeholders", () => {
		const html = renderToString(
			<IdeExtensionHostPanel
				extensionId="example-extension"
				manifest={{
					id: "example-extension",
					version: "1",
					displayName: { en: "Example Extension", zh: "示例扩展" },
					description: "No standalone view",
				}}
				LegacyPanel={LegacyPanel}
			/>,
		);
		expect(html).toContain("Example Extension");
		expect(html).toContain("No standalone view");
		expect(html).not.toContain('data-panel="legacy"');
	});
});
