import {
  configureChatRuntime,
  type ChatRuntimeServices,
} from '@forgeax/chat/runtime';
import { openExtensionPage, useHost } from '@forgeax/app-shell/application';
import { useModelCatalog } from '@forgeax/interface/components/ModelPicker/useModelCatalog';
import { loadOnboarding, saveOnboarding } from '@forgeax/interface/components/Onboarding/types';
import { getLocale, setLocale, subscribe, t, useTranslation } from '@forgeax/interface/i18n';
import { subscribeBroadcast } from '@forgeax/interface/lib/broadcast-stream';
import { clearRetained, peek, publish, subscribe as subscribeBus } from '@forgeax/interface/lib/bus';
import {
  clearComposerPendingInsert,
  requestComposerInsert,
  useComposerPendingInsert,
} from '@forgeax/interface/lib/composer-bridge';
import { alertDialog } from '@forgeax/interface/lib/dialog';
import {
  initialSessionCatalogModel,
  preferredCatalogModel,
} from '@forgeax/interface/lib/model-route';
import { useShellStore } from '@forgeax/interface/store';
import { restExtensionCatalogClient } from '../integration/rest-extension-catalog-client';
import { fetchCliProviders } from '../integration/rest-cli-provider-client';
import {
  fetchCheckpoints,
  rewindCancel,
  rewindOverwriteDirty,
  rewindPreview,
  rewindTo,
  rewindUndoOverwrite,
} from '../integration/rest-checkpoint-client';
import {
  getAgentModel,
  listModels,
  setAgentModels,
} from '../integration/rest-model-config-client';
import {
  reportPassiveFeedbackRecovery,
  reportPassiveFeedbackSignal,
} from '../integration/dom-passive-feedback-bridge';
import { createUseBusSnapshot } from '../integration/react-bus-snapshot';
import { createRetainedDeepLinkBridge } from '../integration/retained-deep-link-bridge';
import { createModelReadinessCheck } from '../integration/model-readiness';
import agentIcon from '../assets/agent-icon.png';

const { emitDeepLink } = createRetainedDeepLinkBridge({ publish, clearRetained });
const useBusSnapshot = createUseBusSnapshot({ peek, subscribe: subscribeBus });
const checkModelReady = createModelReadinessCheck({
  getProviderOverride: () => useShellStore.getState().providerOverride,
});
type IdeChatRuntimeServices = Omit<
  ChatRuntimeServices,
  | 'appEvents'
  | 'useComposerPendingText'
  | 'clearComposerPendingText'
  | 'requestComposerText'
  | 'advanceComposerTextRevision'
  | 'usePendingPermission'
  | 'useResolvedPermission'
  | 'recordResolvedPermission'
  | 'clearPendingPermission'
  | 'replayPermissionEvents'
  | 'subscribePermissionStream'
  | 'resetActiveAgentModelToProviderDefault'
  | 'resolveAvatarGlyphId'
  | 'AgentAvatar'
  | 'accentForRoleTribe'
  | 'ModelPicker'
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
const useChatHost = useHost as unknown as ChatRuntimeServices['useHost'];

/**
 * Product composition boundary between the reusable Chat package and today's
 * Interface host implementation. Chat owns the contract; IDE chooses the
 * concrete host services and can replace them without another Chat migration.
 */
export function configureIdeChatRuntime(): void {
  configureIdeChatRuntimeServices({
    // IDE's ambient Interface declaration intentionally exposes only the
    // product fields used locally; the concrete store carries ChatHostState.
    hostStore: useShellStore as unknown as ChatRuntimeServices['hostStore'],
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
