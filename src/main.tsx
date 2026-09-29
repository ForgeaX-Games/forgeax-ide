import { configureTextClipboard } from "./product/text-edit-actions";
import { DesktopStartup } from "./runtime/DesktopStartup";
import { isDesktopStartupDocument } from "./runtime/desktop-startup";
import "./styles/desktop-startup.css";
import { ApplicationRecoveryBoundary } from "@forgeax/app-shell/react";
import { type ReactNode, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ideRecentProjectsRuntime } from "./product/recent-projects-runtime";
import { createIdeTrajectoryRuntime } from "./product/trajectory-runtime";
import "./styles/global.css";
import {
	configureApplicationLocaleRuntime,
	configureApplicationProjectContext,
	configureApplicationRecentProjectsRuntime,
	configureApplicationShellStore,
	configureApplicationTrajectoryRuntime,
	configureApplicationUiActionBridge,
	configureComposerInsertRuntime,
	configureSessionClientRuntime,
	configureStudioDomainClientRuntime,
	createApplicationShellStoreContext,
} from "@forgeax/interface/application";
import { reportError } from "./integration/error-reporting";
import { createRestStudioDomainClients } from "./integration/rest-studio-domain-clients";
import { IdeKeyboardRouter } from "./product/application-keyboard";
import { IdeApplicationLifecycleBoundary } from "./product/application-lifecycle-boundary";
import { createIdeNativeMenuBridge } from "./product/application-native-menu";
import { createIdeApplicationOwner } from "./product/application-owner";
import { IdeApplicationShell } from "./product/application-shell";
import { startIdeApplication } from "./product/application-startup";
import { toggleIdeCommandPalette } from "./product/command-palette-store";
import {
	configureStudioDomainClients,
	sessionClientRuntime,
	studioDomainClientRuntime,
} from "./product/product-clients";
import {
	createIdeLocaleRuntime,
	initI18n,
	useTranslation,
} from "./product/product-locale";
import { ideProjectContext } from "./product/project-context";
import { StudioProductRoot } from "./product/StudioProductRoot";
import {
	getIdeShellStore,
	initializeIdeShellStore,
} from "./product/shell-state-runtime";
import {
	bootIdeProductComposition,
	bootstrapIdeApplication,
	IDE_PRODUCT_OVERRIDES,
	IDE_SHELL_VIEWS,
} from "./product/studio-composition";
import { bootIdeUiActionBridge } from "./product/ui-action-bridge";

// forgeax-ide is the product assembly, not a replacement product UI. The
// gameplay carrier remains transport infrastructure; it is not the app entry.
document.documentElement.dataset.theme = "dark";
document.documentElement.classList.add("dark", "forgeax-ide");
configureApplicationProjectContext(ideProjectContext);
configureApplicationLocaleRuntime(createIdeLocaleRuntime);
configureApplicationTrajectoryRuntime(createIdeTrajectoryRuntime);
configureApplicationRecentProjectsRuntime(ideRecentProjectsRuntime);
configureSessionClientRuntime(sessionClientRuntime);
configureStudioDomainClientRuntime(studioDomainClientRuntime);
initializeIdeShellStore(createApplicationShellStoreContext());
configureApplicationShellStore(getIdeShellStore);
configureApplicationUiActionBridge(bootIdeUiActionBridge);
initI18n();
configureStudioDomainClients(createRestStudioDomainClients());

const IdeNativeMenuBridge = createIdeNativeMenuBridge(
	ideRecentProjectsRuntime.warm,
);

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

async function startStudioProductApplication() {
	if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
		const clipboard = await import("@tauri-apps/plugin-clipboard-manager");
		configureTextClipboard({
			readText: clipboard.readText,
			writeText: clipboard.writeText,
		});
	}
	await bootIdeProductComposition();
	return startIdeApplication(
		() => bootstrapIdeApplication(IDE_PRODUCT_OVERRIDES),
		{
			configureLocaleRuntime: configureApplicationLocaleRuntime,
			configureComposerInsertRuntime,
			toggleCommandPalette: toggleIdeCommandPalette,
		},
	);
}

function IdeApplicationRecoveryBoundary({ children }: { children: ReactNode }) {
	const { t } = useTranslation();

	return (
		<ApplicationRecoveryBoundary
			scope="studio-shell"
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
			onRevealError={() => {
				(
					window as unknown as { __forgeaxBoot?: { done(): void } }
				).__forgeaxBoot?.done();
			}}
		>
			{children}
		</ApplicationRecoveryBoundary>
	);
}

function IdeApplicationRoot() {
	const [owner] = useState(createIdeApplicationOwner);

	return (
		<IdeApplicationLifecycleBoundary owner={owner}>
			<IdeApplicationRecoveryBoundary>
				<StudioProductRoot owner={owner} start={startStudioProductApplication}>
					{(runtime) => (
						<IdeApplicationShell
							runtime={runtime}
							views={IDE_SHELL_VIEWS}
							KeyboardRouter={IdeKeyboardRouter}
							NativeMenuBridge={IdeNativeMenuBridge}
						/>
					)}
				</StudioProductRoot>
			</IdeApplicationRecoveryBoundary>
		</IdeApplicationLifecycleBoundary>
	);
}

createRoot(root).render(
	<StrictMode>
		{isDesktopStartupDocument(window.location) ? (
			<DesktopStartup />
		) : (
			<IdeApplicationRoot />
		)}
	</StrictMode>,
);
