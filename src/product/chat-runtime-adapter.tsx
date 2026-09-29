import {
	alertDialog,
	clearRetainedTopic as clearRetained,
	openExtensionPage,
	peekTopic as peek,
	publishTopic as publish,
	subscribeBroadcast,
	subscribeTopic as subscribeBus,
	useHost,
} from "@forgeax/app-shell/application";
import {
	type ChatRuntimeServices,
	configureChatRuntime,
} from "@forgeax/chat/runtime";
import agentIcon from "../assets/agent-icon.png";
import {
	clearComposerPendingInsert,
	requestComposerInsert,
	useComposerPendingInsert,
} from "../integration/composer-reference-queue";
import {
	reportPassiveFeedbackRecovery,
	reportPassiveFeedbackSignal,
} from "../integration/dom-passive-feedback-bridge";
import { createModelReadinessCheck } from "../integration/model-readiness";
import {
	initialSessionCatalogModel,
	preferredCatalogModel,
} from "../integration/model-selection";
import {
	loadOnboarding,
	saveOnboarding,
} from "../integration/onboarding-persistence";
import { createUseBusSnapshot } from "../integration/react-bus-snapshot";
import {
	fetchCheckpoints,
	rewindCancel,
	rewindOverwriteDirty,
	rewindPreview,
	rewindTo,
	rewindUndoOverwrite,
} from "../integration/rest-checkpoint-client";
import { fetchCliProviders } from "../integration/rest-cli-provider-client";
import { restExtensionCatalogClient } from "../integration/rest-extension-catalog-client";
import {
	getAgentModel,
	listModels,
	setAgentModels,
} from "../integration/rest-model-config-client";
import { createRetainedDeepLinkBridge } from "../integration/retained-deep-link-bridge";
import { useModelCatalog } from "../integration/use-model-catalog";
import {
	getLocale,
	setLocale,
	subscribe,
	t,
	useTranslation,
} from "./product-locale";
import { useShellStore } from "./shell-state-runtime";

const { emitDeepLink } = createRetainedDeepLinkBridge({
	publish,
	clearRetained,
});
const useBusSnapshot = createUseBusSnapshot({ peek, subscribe: subscribeBus });
const checkModelReady = createModelReadinessCheck({
	getProviderOverride: () => useShellStore.getState().providerOverride,
});
type IdeChatRuntimeServices = Omit<
	ChatRuntimeServices,
	| "appEvents"
	| "useComposerPendingText"
	| "clearComposerPendingText"
	| "requestComposerText"
	| "advanceComposerTextRevision"
	| "usePendingPermission"
	| "useResolvedPermission"
	| "recordResolvedPermission"
	| "clearPendingPermission"
	| "replayPermissionEvents"
	| "subscribePermissionStream"
	| "resetActiveAgentModelToProviderDefault"
	| "resolveAvatarGlyphId"
	| "AgentAvatar"
	| "accentForRoleTribe"
	| "ModelPicker"
> & {
	useModelCatalog: typeof useModelCatalog;
};

// Studio main can still materialize the previous Chat contract while this IDE
// consumer PR is in flight. Keep the call compatible with that source graph;
// the runtime value itself already uses the new hook-only boundary.
const configureIdeChatRuntimeServices = configureChatRuntime as unknown as (
	services: IdeChatRuntimeServices,
) => void;

// The runtime value comes from App Shell's shared context. Chat intentionally
// narrows the product host's activity snapshot beyond App Shell's neutral
// `unknown` shape, so the product adapter owns this erased type refinement.
const useChatHost = useHost as unknown as ChatRuntimeServices["useHost"];

/**
 * Product composition boundary between the reusable Chat package and today's
 * Interface host implementation. Chat owns the contract; IDE chooses the
 * concrete host services and can replace them without another Chat migration.
 */
export function configureIdeChatRuntime(): void {
	configureIdeChatRuntimeServices({
		// Chat narrows its host contract; the product supplies the shared IDE store.
		hostStore: useShellStore as unknown as ChatRuntimeServices["hostStore"],
		useHost: useChatHost,
		t,
		useTranslation,
		getLocale,
		setLocale,
		subscribeLocale: subscribe,
		listExtensions: restExtensionCatalogClient.listExtensions,
		openExtensionPage,
		emitDeepLink,
		useBusSnapshot,
		publish,
		reportPassiveFeedbackSignal,
		reportPassiveFeedbackRecovery,
		subscribeBroadcast,
		pushTelemetry: (records) => useShellStore.getState().pushTelemetry(records),
		fetchCheckpoints,
		rewindPreview,
		rewindTo,
		rewindCancel,
		rewindOverwriteDirty,
		rewindUndoOverwrite,
		getAgentModel,
		listModels,
		setAgentModels,
		checkModelReady,
		initialSessionCatalogModel,
		preferredCatalogModel,
		fetchCliProviders,
		useModelCatalog,
		agentIcon,
		alertDialog,
		loadOnboarding,
		saveOnboarding,
		useComposerPendingInsert,
		clearComposerPendingInsert,
		requestComposerInsert,
	} satisfies IdeChatRuntimeServices);
}
