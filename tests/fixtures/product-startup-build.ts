import { resolve } from "node:path";
import { build, type Rollup } from "vite";

const ideRoot = resolve(import.meta.dirname, "../..");
let code: string;
const entry = resolve(ideRoot, "product-startup-fixture.ts");
const previousRoot = process.env.FORGEAX_INTEGRATION_ROOT;
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
process.env.FORGEAX_INTEGRATION_ROOT = resolve(ideRoot, "../..");
try {
	const output = await build({
		root: ideRoot,
		configFile: resolve(ideRoot, "vite.config.ts"),
		configLoader: "runner",
		logLevel: "silent",
		plugins: [
			{
				name: "product-startup-fixture",
				buildEnd(error) {
					if (error) return;
					const modules = [...this.getModuleIds()];
					const importRoot = "/engine/packages/import/src/";
					if (!modules.some((id) => id.endsWith(`${importRoot}browser.ts`))) {
						this.error(
							"Product build must load the Engine import browser entry",
						);
					}
					if (modules.some((id) => id.endsWith(`${importRoot}index.ts`))) {
						this.error(
							"Product build must not load the Engine import Node entry",
						);
					}
				},
				resolveId(id) {
					return id === entry ? id : null;
				},
				load(id) {
					return id === entry
						? `
        export * as engineImport from '@forgeax/engine-import';
        import { createApplicationShellStoreContext, configureApplicationShellStore, configureApplicationProjectContext } from '@forgeax/interface/application';
        import { initializeIdeShellStore, getIdeShellStore } from './src/product/shell-state-runtime';
        import { ideProjectContext } from './src/product/project-context';
        configureApplicationProjectContext(ideProjectContext);
        export const capturedStoreContext = createApplicationShellStoreContext();
        initializeIdeShellStore(capturedStoreContext);
        configureApplicationShellStore(getIdeShellStore);
        import { startIdeApplication as startProduct } from './src/product/application-startup';
        import { configureApplicationLocaleRuntime, configureComposerInsertRuntime, toggleCommandPalette, configureApplicationTrajectoryRuntime, configureSessionClientRuntime, configureStudioDomainClientRuntime } from '@forgeax/interface/application';
        import { configureApplicationRecentProjectsRuntime } from '@forgeax/interface/application';
        import { ideRecentProjectsRuntime } from './src/product/recent-projects-runtime';
        configureApplicationRecentProjectsRuntime(ideRecentProjectsRuntime);
        export { ideRecentProjectsRuntime };
        export { getRecentGames, getRecentGamesRevision, subscribeRecentGames } from '@forgeax/interface/lib/recent-games';
        import { sessionClientRuntime, studioDomainClientRuntime } from './src/product/product-clients';
        import { createIdeTrajectoryRuntime } from './src/product/trajectory-runtime';
        export { getIdeTrajectoryRuntime } from './src/product/trajectory-runtime';
        import { bootstrapIdeApplication as bootstrapAppHost, IDE_SHELL_VIEWS } from './src/product/studio-composition';
        export function bindProductClients() {
          configureApplicationTrajectoryRuntime(createIdeTrajectoryRuntime);
          configureSessionClientRuntime(sessionClientRuntime);
          configureStudioDomainClientRuntime(studioDomainClientRuntime);
        }
        export function startIdeApplication(overrides = {}, options = {}) {
          bindProductClients();
          return startProduct(() => bootstrapAppHost(overrides), {
            configureLocaleRuntime: configureApplicationLocaleRuntime,
            configureComposerInsertRuntime, toggleCommandPalette,
          }, options);
        }
        export function productBootstrap(overrides = {}) { bindProductClients(); return bootstrapAppHost(overrides); }
        export const productSession = sessionClientRuntime.read;
        export const productDomains = studioDomainClientRuntime.read;
        export { configureSessionClientRuntime as bindSessionRuntime, configureStudioDomainClientRuntime as bindDomainRuntime } from '@forgeax/interface/application';
        export { configureSessionClient as configureProductSession, configureStudioDomainClients as configureProductDomains } from './src/product/product-clients';
        export { createIdePageServices } from './src/product/page-services';
        export { configureIdeChatRuntime } from './src/product/chat-runtime-adapter';
        export { getIdeShellStore } from './src/product/shell-state-runtime';
        export { configureSessionClient as configureCompatibilitySession, getSessionClient as compatibilitySession } from '@forgeax/interface/store-parts/session-client';
        export { configureStudioDomainClients as configureCompatibilityDomains, getAgentCatalogClient as compatibilityAgents, getStudioProjectClient as compatibilityProjects, getStudioBuildClient as compatibilityBuilds } from '@forgeax/interface/store-parts/domain-clients';
        export { subscribeTopic, registerAction, dispatchAction, snapshotState, getAction, UI_ACTION_DISPATCH_EVENT } from '@forgeax/app-shell/application';
        export { readTrajectory as compatibilityTrajectory, recordTrajectory as compatibilityRecord, clearTrajectory as compatibilityClear, startTrajectoryRecording as compatibilityStartRecording } from '@forgeax/interface/lib/ui-trajectory';
        export { captureFeedbackContext } from '@forgeax/interface/components/Feedback/collect';
        export { chatWidthStore as compatibilityChatWidth } from '@forgeax/interface/components/ChatColumn/useChatWidth';
        export { useFeedbackStore as compatibilityFeedback } from '@forgeax/interface/components/Feedback/store';
        export { configureTextClipboard } from './src/product/text-edit-actions';
        export { getAnchor as viewportAnchor } from '@forgeax/interface/lib/surfaceAnchors';
        import { createRoot as createViewportRoot } from 'react-dom/client';

        import { createElement } from 'react';
        import { flushSync } from 'react-dom';
        export { createElement, flushSync as flushProductUpdates };
        import { PanelRenderersProvider as SharedRendererProvider, usePanelRenderers as useSharedRenderers, DEFAULT_PANEL_RENDERERS as sharedRendererDefaults, DEFAULT_EDITOR_PANEL_IDS as sharedEditorIds } from '@forgeax/app-shell/application';
        import { PanelRenderersProvider as CompatibilityRendererProvider, usePanelRenderers as useCompatibilityRenderers, DEFAULT_PANEL_RENDERERS as compatibilityRendererDefaults, DEFAULT_EDITOR_PANEL_IDS as compatibilityEditorIds } from '@forgeax/interface/components/DockShell/panelRenderers';
        export const rendererContextIdentity = {
          provider: SharedRendererProvider === CompatibilityRendererProvider,
          hook: useSharedRenderers === useCompatibilityRenderers,
          defaults: sharedRendererDefaults === compatibilityRendererDefaults,
          editorIds: sharedEditorIds === compatibilityEditorIds,
        };
        export { sharedRendererDefaults };
        export { peekTopic } from '@forgeax/app-shell/application';
        import { HostProvider as SharedHostProvider } from '@forgeax/app-shell/application';
        import { IdeStatusBar } from './src/product/status-bar';
        export { IdeStatusBar };
        export { idePulseStatusItems } from './src/product/status-pulse';
        import { IdeApplicationShell as ApplicationShell } from './src/product/application-shell';
        import { BrandProvider } from '@forgeax/interface/brand';
        export { APP_EVENTS as chatEvents } from '@forgeax/chat/runtime';
        export function mountProductConnectPrompt(element) {
          const root = createViewportRoot(element);
          flushSync(() => root.render(createElement(IDE_SHELL_VIEWS.ConnectModelPrompt)));
          return () => { flushSync(() => root.unmount()); };
        }
        export function mountProductShell(element, runtime) {
          const root = createViewportRoot(element);
          const NoRouter = () => null;
          flushSync(() => root.render(createElement(BrandProvider, null,
            createElement(SharedHostProvider, { value: runtime.host },
              createElement(ApplicationShell, { runtime, views: IDE_SHELL_VIEWS, KeyboardRouter: NoRouter, NativeMenuBridge: NoRouter })))));
          return () => { flushSync(() => root.unmount()); };
        }

        export function createStatusBarProbe(element, host) {
          const root = createViewportRoot(element);
          return {
            render(panels) {
              flushSync(() => root.render(createElement(SharedHostProvider, { value: host },
                createElement(SharedRendererProvider, { value: panels }, createElement(IdeStatusBar)))));
            },
            unmount() { flushSync(() => root.unmount()); },
          };
        }

        export function createRendererProbe(element, capture) {
          const root = createViewportRoot(element);
          function Probe({ compatibility }) {
            capture(compatibility ? useCompatibilityRenderers() : useSharedRenderers());
            return null;
          }
          return {
            render(value, compatibilityProvider = false, compatibilityReader = true, nested) {
              let child = createElement(Probe, { compatibility: compatibilityReader });
              if (nested) child = createElement(CompatibilityRendererProvider, { value: nested }, child);
              if (value) child = createElement(compatibilityProvider ? CompatibilityRendererProvider : SharedRendererProvider, { value }, child);
              flushSync(() => root.render(child));
            },
            unmount() { flushSync(() => root.unmount()); },
          };
        }
        export function mountViewport(host, element) {
          const root = createViewportRoot(element);
          root.render(host.panels.panels.viewport.render());
          return () => root.unmount();
        }

        import { ApplicationExtensionHostPanel } from '@forgeax/interface/application';
        import { ExtensionHostPanel } from '@forgeax/interface/components/DockShell/ExtensionHostPanel';
        import { catalogPanelTypeRegistrations } from './src/product/catalog-page-extensions';
        export const catalogPanelIdentity = ApplicationExtensionHostPanel === ExtensionHostPanel;
        export function productCatalogPanels(item) {
          return catalogPanelTypeRegistrations(item, { ExtensionHostPanel: ApplicationExtensionHostPanel });
        }
        export const sharedExtensionHostPanel = ExtensionHostPanel;

        export { buildAssetPill as compatibilityAssetPill } from '@forgeax/interface/lib/composer-bridge';
        export { createIdeApplicationOwner } from './src/product/application-owner';
        export { startInterfaceApplication as standalone } from '@forgeax/interface/application';
        export { qualifyContributionId } from '@forgeax/types/page';
        export { buildIdeShortcutDescriptions } from './src/integration/product-shortcuts';
        export { getLocale as productLocale } from './src/product/product-locale';
        export { changeLanguage as changeProductLanguage } from './src/product/product-locale';
        export { warmApplicationMenus } from '@forgeax/interface/application';
        export { getLocale as compatibilityLocale } from '@forgeax/interface/i18n';
        export { createIdeComposerInsertRuntime } from './src/integration/composer-reference-queue';
        export { requestComposerInsert as compatibilityInsert } from '@forgeax/interface/lib/composer-bridge';
      `
						: null;
				},
			},
		],
		build: {
			write: false,
			minify: false,
			rollupOptions: { output: { inlineDynamicImports: true } },
			lib: { entry, formats: ["iife"], name: "ProductStartup" },
		},
	});
	const result = (
		Array.isArray(output) ? output[0] : output
	) as Rollup.RollupOutput;
	code = result.output.find(
		(item): item is Rollup.OutputChunk => item.type === "chunk",
	)!.code;
} finally {
	if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = previousNodeEnv;
	if (previousRoot === undefined) delete process.env.FORGEAX_INTEGRATION_ROOT;
	else process.env.FORGEAX_INTEGRATION_ROOT = previousRoot;
}
process.stdout.write(`\nPRODUCT_STARTUP_BUNDLE:${JSON.stringify(code)}\n`, () =>
	process.exit(0),
);
