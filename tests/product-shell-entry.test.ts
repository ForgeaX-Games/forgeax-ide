import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

describe('IDE product entry', () => {
  test('renders the established Studio shell instead of the carrier demo', async () => {
    const source = await Bun.file(new URL('../src/main.tsx', import.meta.url)).text();
    const productRoot = await Bun.file(
      new URL('../src/product/StudioProductRoot.tsx', import.meta.url),
    ).text();

    expect(source).toContain("from './product/StudioProductRoot'");
    expect(source).toContain("from '@forgeax/interface/application'");
    expect(source).toContain("from '@forgeax/interface/ApplicationShell'");
    expect(source).toContain("ApplicationRecoveryBoundary } from '@forgeax/app-shell/react'");
    expect(source).not.toContain("from '@forgeax/interface/components/ErrorBoundary'");
    expect(source).toContain("from './integration/interface-store'");
    expect(source).toContain("configureStudioDomainClients(createRestStudioDomainClients());");
    expect(source).toContain('<ApplicationRecoveryBoundary');
    expect(source).toContain('<StudioProductRoot start={startStudioProductApplication}>');
    expect(source).toContain('await bootIdeProductComposition();');
    expect(source).toContain('startInterfaceApplication(IDE_PRODUCT_OVERRIDES)');
    expect(source).toContain('<ApplicationShell runtime={runtime} onboarding={{ enabled: false }} />');
    expect(source).not.toContain("from '@forgeax/chat/runtime'");
    expect(source).not.toContain("from '@forgeax/interface/components/Onboarding'");
    expect(source).not.toContain("from './runtime/ide-onboarding'");
    expect(source).not.toContain("import './styles/ide-onboarding.css'");
    expect(source).toContain("classList.add('dark', 'forgeax-ide')");
    expect(source).not.toContain('APP_EVENTS.onboardingChanged');
    expect(source).not.toContain('normalizeIdeOnboardingAtStartup');
    expect(source).not.toContain("from '@forgeax/interface/App'");
    expect(source).not.toContain("from './app-shell/AppShell'");
    expect(source).toContain("import { initI18n, useTranslation } from '@forgeax/interface/i18n'");
    expect(source).toContain('function IdeApplicationRecoveryBoundary');
    expect(source).toContain('const { t } = useTranslation();');
    expect(source).not.toContain('const applicationRecoveryMessages =');
    expect(source).toContain("title: t('errorBoundary.fullscreenTitle')");
    expect(source).toContain("hint: t('errorBoundary.fullscreenHint')");
    expect(source).toContain("retry: t('errorBoundary.retry')");
    expect(source).toContain("remount: t('errorBoundary.reloadRegion')");
    expect(source).toContain("reloadApplication: t('errorBoundary.reloadStudio')");
    expect(source).toContain('scope="studio-shell"');
    expect(source).toContain("reportError(error, info.componentStack, scope)");
    expect(source).toContain('__forgeaxBoot?.done()');

    const ambientTypes = await Bun.file(
      new URL('../src/types/interface-integration.d.ts', import.meta.url),
    ).text();
    expect(ambientTypes).not.toContain(
      "declare module '@forgeax/interface/components/ErrorBoundary'",
    );
    expect(ambientTypes).toContain('onboarding?: { enabled?: boolean; tourEnabled?: boolean }');
    expect(ambientTypes).not.toContain(
      "declare module '@forgeax/interface/components/Onboarding'",
    );

    expect(productRoot).toContain("from '@forgeax/app-shell/application'");
    expect(productRoot).toContain('<ApplicationRuntimeRoot');
    expect(productRoot).not.toContain('@forgeax/interface');
  });

  test('removes the IDE compatibility owner after consuming Interface onboarding opt-out', async () => {
    expect(await Bun.file(new URL('../src/runtime/ide-onboarding.ts', import.meta.url)).exists()).toBe(false);
    expect(await Bun.file(new URL('../src/styles/ide-onboarding.css', import.meta.url)).exists()).toBe(false);
  });

  test('consumes source-integrated product packages from Studio and Agents from npm', async () => {
    const config = await Bun.file(new URL('../vite.config.ts', import.meta.url)).text();
    const runtimeContract = await Bun.file(new URL('../scripts/vite-runtime-contract.ts', import.meta.url)).text();
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();

    expect(config).toContain('FORGEAX_INTEGRATION_ROOT is required');
    expect(config).toContain("resolve(integrationRoot, 'packages/ide')");
    expect(config).toContain("studioPackage?.name !== 'forgeax-studio'");
    expect(config).toContain("resolve(integrationRoot, 'packages/interface')");
    expect(config).toContain('createIdeRuntimeAliases({ ideRoot, interfaceRoot })');
    expect(runtimeContract).toContain("'node_modules/@forgeax/app-shell/dist/window.js'");
    expect(runtimeContract).toContain("find: /^@forgeax\\/app-shell\\/window$/");
    expect(runtimeContract).toContain("src/integration/interface-store.ts");
    expect(config).not.toContain("src/integration/page-lang.ts");
    expect(config).toContain("resolve(packageRoot('chat'), 'src/index.ts')");
    expect(config).not.toContain("resolve(packageRoot('agents')");
    expect(config).not.toContain("id: '@forgeax/agents'");
    expect(packageJson.dependencies['@forgeax/agents']).toBe('0.1.0');
    expect(config).toContain("resolve(packageRoot('settings'), 'src/index.ts')");
    expect(config).toContain("resolve(editorRoot, 'packages/edit-runtime/src/bridge.ts')");
    expect(config).toContain('`@forgeax/editor/${subpath}`');
    expect(config).toContain('engineVitePreset({');
    expect(config).toContain("format: 'es'");
    expect(config).toContain('plugins: () => [sourcePackageResolve(), engineSourceRuntimeUrlResolve(), releaseSourcePathSanitize()]');
    expect(config).toContain("target: 'esnext'");
    expect(config).toContain("name: 'forgeax:ide-source-package-resolve'");
    expect(config).toContain("resolve(path, 'index.ts')");
    expect(config).toContain('discoverEngineSourcePackages');
    expect(config).toContain("manifest.name.startsWith('@forgeax/engine-')");
    expect(config).toContain('deriveExportSubpaths(sourceRoot, manifest.exports)');
    expect(config).toContain("distTargetToSourceBase(target)");
    expect(config).toContain("sourcePackage.subpaths?.[subpath]");
    expect(config).toContain("'@forgeax/engine-plugin'");
    expect(config).toContain('engine-plugin-browser.ts');
    expect(config).toContain("'@forgeax/engine-wgpu-wasm'");
    expect(config).toContain('engine-wgpu-wasm-unavailable.ts');
    expect(config).toContain("name: 'forgeax:engine-source-runtime-url-resolve'");
    expect(config).toContain('const enginePackagesViteRoot = `${normalizePath(enginePackagesRoot)}/`');
    expect(config).toContain('normalizePath(filePath).startsWith(enginePackagesViteRoot)');
    expect(config).toContain("new URL(${quote}./${specifier}.ts${quote}, import.meta.url)");
    expect(config).toContain("name: 'forgeax:ide-release-source-path-sanitize'");
    expect(config).toContain("from './scripts/release-source-path-sanitize'");
    expect(config).toContain('output.code = sanitizeReleaseSourcePaths(output.code, integrationRoot)');
    expect(config).toContain("resolve(options.dir, 'shaders/manifest.json')");
    expect(config).toContain("'@forgeax/app-shell/window'");
    expect(config).toContain('...IDE_OPTIMIZE_DEPS_EXCLUDE');
    expect(runtimeContract).toContain("const INTERFACE_PACKAGE_ID = ['@forgeax', 'interface'].join('/')");
    expect(runtimeContract).toContain('INTERFACE_STORE_ID');
    expect(runtimeContract).toContain('INTERFACE_SESSION_CLIENT_ID');
    expect(runtimeContract).toContain('INTERFACE_MENU_REGISTRY_ID');
  });

  test('composes the Editor-owned Vite preset through its public facade', async () => {
    const config = await Bun.file(new URL('../vite.config.ts', import.meta.url)).text();

    expect(config).toContain('@forgeax/editor/vite-preset');
    expect(config).toContain('engineVitePreset({');
    expect(config).toContain("createRequire(resolve(ideRoot, 'package.json'))");
    expect(config).toContain('ideRequire.resolve(editorVitePresetSpecifier)');
    expect(config).toContain('pathToFileURL(editorVitePresetEntry).href');
    expect(config).not.toContain("from '@forgeax/engine-vite-plugin-shader'");
    expect(config).not.toContain('forgeaxShader(');
    expect(config).not.toContain("loader: { '.wgsl': 'text' }");
    expect(config).not.toContain("loader: { '.wgsl': 'js' }");
    expect(config).not.toContain("identifier: 'editor::infinite-grid'");
  });

  test('keeps the public preset runtime import separate from the source-only type graph', async () => {
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
    const tsconfig = await Bun.file(new URL('../tsconfig.lint.json', import.meta.url)).json();

    expect(packageJson.scripts.lint).toContain('tsconfig.lint.json');
    expect(packageJson.scripts.typecheck).toContain('tsconfig.lint.json');
    expect(tsconfig.compilerOptions.paths['@forgeax/editor/*']).toEqual([
      'src/types/interface-integration.d.ts',
    ]);
  });

  test('loads the public Editor preset through Vite runner semantics in development', async () => {
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();

    expect(packageJson.scripts.dev).toContain('--configLoader runner');
    expect(packageJson.scripts['dev:web']).toContain('--configLoader runner');
  });

  test('restores Studio product composition instead of booting a bare Interface shell', async () => {
    const source = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const chatRuntimeAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();

    expect(source).toContain('IDE_PRODUCT_OVERRIDES');
    expect(source).toContain('ChatPanel');
    expect(source).toContain('createEditorPanelsExtension');
    expect(source).toContain('createEditorPanelContributionsExtension');
    expect(source).toContain('createExtensionGalleryContribution(extensionGalleryRuntime)');
    expect(source).toContain('ViewportComponent');
    expect(source).toContain('function StudioSceneEditor');
    expect(source).toContain('activeGameResolved');
    expect(source).toContain('activeGameRuntime?.binding');
    expect(source).toContain('activeGameSlug === null || runtimeBinding === undefined');
    expect(source).toContain('function hasCatalogRoots');
    expect(source).toContain('No scene assets are available for this game.');
    expect(source).toContain('resetEditRealm({ nextRuntimeGeneration: runtimeBinding?.generation })');
    expect(source).toContain('setViewportEpoch((epoch) => epoch + 1)');
    expect(source).toContain("gameRoot={`.forgeax/games/${activeGameSlug}`}");
    expect(source).toContain('createEditorPanelsExtension({ SceneEditor: StudioSceneEditor })');
    expect(source).not.toContain('createEditorPanelsExtension({ SceneEditor: ViewportComponent })');
    expect(source).toContain('configureSessionClient');
    expect(source).toContain('configureIdeChatRuntime();');
    expect(source.indexOf('configureIdeChatRuntime();')).toBeLessThan(source.indexOf('configureSessionClient({'));
    expect(chatRuntimeAdapter).toContain("from '@forgeax/chat/runtime'");
    expect(chatRuntimeAdapter).toContain('type IdeChatRuntimeServices = Omit<');
    expect(chatRuntimeAdapter).toContain("| 'appEvents'");
    expect(chatRuntimeAdapter).toContain('satisfies IdeChatRuntimeServices');
    expect(chatRuntimeAdapter).toContain('hostStore: useShellStore');
    expect(source).toContain("subscribePermissionStream } from '@forgeax/chat/runtime'");
    expect(source).not.toContain("from '@forgeax/interface/lib/permission-stream'");
    expect(chatRuntimeAdapter).not.toContain("from '@forgeax/interface/lib/permission-stream'");
    for (const service of [
      'usePendingPermission',
      'useResolvedPermission',
      'recordResolvedPermission',
      'clearPendingPermission',
      'replayPermissionEvents',
      'subscribePermissionStream',
    ]) {
      expect(chatRuntimeAdapter).not.toContain(`${service},`);
    }
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/permission-stream'");
    expect(source).toContain("from '@forgeax/agents/react'");
    expect(source).toContain("import '@forgeax/agents/style.css'");
    expect(source).not.toContain('0.0.0-retired');
    expect(source).not.toContain('RETIRED_EXTENSION_IDS');
    expect(source).toContain('createFilesContribution()');
    expect(source).toContain('configureFilesRuntime(filesRuntime);');
    expect(source).toContain('client: createRestFilesClient()');
    expect(source).toContain('SettingsRuntimeProvider');
    expect(source).toContain('listSharedCapabilities');
    expect(source).toContain('refreshAllModelCatalogs');
    expect(source).toContain('resetOpenSessionsModelToProviderDefault');
    expect(source).toContain('activeId={activeId}');
    expect(source).toContain('onActiveIdChange={setOverlayParam}');
    expect(source).toContain('initAgentPrefs({ publish, peek, subscribe })');
    expect(source).not.toContain('<SettingsPanel />');
    expect(source).not.toContain('WorkbenchModeDefault');
    expect(source).not.toContain('initFilePreview');
  });

  test('owns the product-neutral panel renderer type through App Shell', async () => {
    const composition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(composition).toMatch(/import type \{[^}]*PanelRenderers[^}]*\} from '@forgeax\/app-shell\/application'/);
    expect(composition).not.toContain("from '@forgeax/interface/components/DockShell/panelRenderers'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/components/DockShell/panelRenderers'");
    expect(ambientTypes).toContain("import type { SerializedDockview } from '@forgeax/app-shell/application'");
  });

  test('owns the product-neutral extension type through App Shell', async () => {
    const composition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(composition).toContain("import type { AppExtension, PanelRenderers } from '@forgeax/app-shell/application'");
    expect(composition).not.toContain("from '@forgeax/interface/core/app-shell/types'");
    expect(composition).not.toContain("tone: 'panel'");
    expect(composition.match(/tone: 'default'/g)).toHaveLength(2);
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/core/app-shell/types'");
  });

  test('leaves the model label hook fully owned by Chat', async () => {
    const chatAdapter = await Bun.file(
      new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url),
    ).text();

    expect(chatAdapter).not.toContain('useModelLabel');
    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/model'");
  });

  test('consumes Interface bootstrap overrides only through the public application seam', async () => {
    const composition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(composition).toContain("import type { AppHostBootstrapOverrides } from '@forgeax/interface/application'");
    expect(composition).not.toContain("from '@forgeax/interface/appHostBootstrap'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/appHostBootstrap'");
    expect(ambientTypes).toMatch(
      /declare module '@forgeax\/interface\/application' \{[\s\S]*export interface AppHostBootstrapOverrides/,
    );
  });

  test('owns extension catalog transport at the IDE integration boundary', async () => {
    const composition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const transport = await Bun.file(new URL('../src/integration/rest-extension-catalog-client.ts', import.meta.url)).text();

    expect(composition).not.toContain("from '@forgeax/interface/lib/extension-api'");
    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/extension-api'");
    expect(composition).toContain("from '../integration/rest-extension-catalog-client'");
    expect(chatAdapter).toContain("from '../integration/rest-extension-catalog-client'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/extension-api'");
    expect(transport).not.toContain('@forgeax/interface');
  });

  test('owns CLI provider health transport at the IDE integration boundary', async () => {
    const composition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const transport = await Bun.file(new URL('../src/integration/rest-cli-provider-client.ts', import.meta.url)).text();

    expect(composition).not.toContain("from '@forgeax/interface/lib/cli-providers'");
    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/cli-providers'");
    expect(composition).toContain("from '../integration/rest-cli-provider-client'");
    expect(chatAdapter).toContain("from '../integration/rest-cli-provider-client'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/cli-providers'");
    expect(transport).not.toContain('@forgeax/interface');
  });

  test('owns Chat checkpoint transport at the IDE integration boundary', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const transport = await Bun.file(new URL('../src/integration/rest-checkpoint-client.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/checkpoint-api'");
    expect(chatAdapter).toContain("from '../integration/rest-checkpoint-client'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/checkpoint-api'");
    expect(transport).not.toContain('@forgeax/interface');
  });

  test('owns Chat model config transport at the IDE integration boundary', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const transport = await Bun.file(new URL('../src/integration/rest-model-config-client.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/model-config'");
    expect(chatAdapter).toContain("from '../integration/rest-model-config-client'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/model-config'");
    expect(transport).not.toContain('@forgeax/interface');
  });

  test('owns the concrete Chat model-readiness policy at the IDE integration boundary', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const readiness = await Bun.file(new URL('../src/integration/model-readiness.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain('  checkModelReady,\n  initialSessionCatalogModel,');
    expect(chatAdapter).toContain("from '../integration/model-readiness'");
    expect(chatAdapter).toContain('checkModelReady,');
    expect(ambientTypes).not.toContain('export const checkModelReady:');
    expect(readiness).not.toContain('@forgeax/interface');
    expect(readiness).toContain("request('/api/settings')");
  });

  test('uses the Chat-owned active-agent model reset without an Interface runtime injection', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain('  resetActiveAgentModelToProviderDefault,');
    expect(chatAdapter).not.toContain('    resetActiveAgentModelToProviderDefault,');
    expect(ambientTypes).not.toContain('export const resetActiveAgentModelToProviderDefault:');
    expect(chatAdapter).toContain('  initialSessionCatalogModel,');
    expect(chatAdapter).toContain('  preferredCatalogModel,');
    expect(chatAdapter).toContain('    initialSessionCatalogModel,');
    expect(chatAdapter).toContain('    preferredCatalogModel,');
  });

  test('uses the Chat-owned avatar glyph resolver without an Interface runtime injection', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain('  resolveAvatarGlyphId,');
    expect(chatAdapter).not.toContain('    resolveAvatarGlyphId,');
    expect(chatAdapter).toContain("| 'resolveAvatarGlyphId'");
    expect(ambientTypes).not.toContain('export const resolveAvatarGlyphId:');
    expect(chatAdapter).toContain('    agentIcon,');
    expect(chatAdapter).toContain('  initialSessionCatalogModel,');
    expect(chatAdapter).toContain('  preferredCatalogModel,');
  });

  test('uses Chat-owned static agent avatar presentation without an Interface runtime injection', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain(
      "from '@forgeax/interface/components/AgentAvatar/AgentAvatar'",
    );
    expect(chatAdapter).not.toContain('  AgentAvatar,');
    expect(chatAdapter).not.toContain('  accentForRoleTribe,');
    expect(chatAdapter).not.toContain('    AgentAvatar,');
    expect(chatAdapter).not.toContain('    accentForRoleTribe,');
    expect(chatAdapter).toContain("| 'AgentAvatar'");
    expect(chatAdapter).toContain("| 'accentForRoleTribe'");
    expect(chatAdapter).toContain('    agentIcon,');
    expect(ambientTypes).not.toContain(
      "declare module '@forgeax/interface/components/AgentAvatar/AgentAvatar'",
    );
  });

  test('owns the product-branded Chat fallback icon without an Interface asset reach-in', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const agentIcon = Bun.file(new URL('../src/assets/agent-icon.png', import.meta.url));

    expect(chatAdapter).toContain("import agentIcon from '../assets/agent-icon.png';");
    expect(chatAdapter).not.toContain(
      "from '@forgeax/interface/assets/icons/agent-icon.png'",
    );
    expect(chatAdapter).toContain('    agentIcon,');
    expect(ambientTypes).not.toContain(
      "declare module '@forgeax/interface/assets/icons/agent-icon.png'",
    );
    expect(await agentIcon.exists()).toBeTrue();

    const digest = createHash('sha256')
      .update(new Uint8Array(await agentIcon.arrayBuffer()))
      .digest('hex');
    expect(digest).toBe('aa5d9825be0b058874be0cdbe71606b0f570256dee4d7d7577a9a43c709faeb4');
  });

  test('injects only the Interface model catalog hook into Chat-owned picker presentation', async () => {
    const chatRuntimeAdapter = await Bun.file(
      new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url),
    ).text();
    const ambientTypes = await Bun.file(
      new URL('../src/types/interface-integration.d.ts', import.meta.url),
    ).text();

    expect(chatRuntimeAdapter).toContain(
      "import { useModelCatalog } from '@forgeax/interface/components/ModelPicker/useModelCatalog'",
    );
    expect(chatRuntimeAdapter).toContain("| 'ModelPicker'");
    expect(chatRuntimeAdapter).toContain('useModelCatalog: typeof useModelCatalog;');
    expect(chatRuntimeAdapter).toContain(
      'const configureIdeChatRuntimeServices = configureChatRuntime as unknown as',
    );
    expect(chatRuntimeAdapter).toContain('configureIdeChatRuntimeServices({');
    expect(chatRuntimeAdapter).toContain('useModelCatalog,');
    expect(chatRuntimeAdapter).not.toContain(
      "from '@forgeax/interface/components/ModelPicker'",
    );
    expect(chatRuntimeAdapter).not.toContain('ModelPicker,');
    expect(ambientTypes).toContain('export function useModelCatalog(');
    expect(ambientTypes).toContain('export interface ModelCatalogState');
    expect(ambientTypes).not.toContain(
      "declare module '@forgeax/interface/components/ModelPicker'",
    );
  });

  test('uses the Chat-owned model label without an Interface runtime injection', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/model'");
    expect(chatAdapter).not.toContain('    useModelLabel,');
    expect(chatAdapter).not.toContain("'useModelLabel'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/model'");
  });

  test('uses the Chat-owned provider badge through lower-level product seams', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/provider-badge'");
    expect(chatAdapter).not.toContain('    ProviderBadgePill,');
    expect(chatAdapter).not.toContain("'ProviderBadgePill'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/provider-badge'");
    expect(chatAdapter).toContain('    t,');
    expect(chatAdapter).toContain('    listExtensions: restExtensionCatalogClient.listExtensions,');
  });

  test('owns Chat passive feedback emission at the IDE integration boundary', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const bridge = await Bun.file(new URL('../src/integration/dom-passive-feedback-bridge.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/passive-feedback'");
    expect(chatAdapter).toContain("from '../integration/dom-passive-feedback-bridge'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/passive-feedback'");
    expect(bridge).not.toContain('@forgeax/interface');
    expect(bridge).toContain("'forgeax:passive-feedback'");
  });

  test('owns product retained deep-link semantics at the IDE integration boundary', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const composition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const bridge = await Bun.file(new URL('../src/integration/retained-deep-link-bridge.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/deep-link-bus'");
    expect(composition).not.toContain("from '@forgeax/interface/lib/deep-link-bus'");
    expect(chatAdapter).toContain("from '../integration/retained-deep-link-bridge'");
    expect(composition).toContain("from '../integration/retained-deep-link-bridge'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/deep-link-bus'");
    expect(ambientTypes).toContain('export const clearRetained:');
    expect(bridge).not.toContain('@forgeax/interface');
    expect(bridge).toContain("'bus:filter-kind'");
    expect(bridge).toContain("'bus:expand-plugin'");
  });

  test('owns the non-Editor product session relays at the IDE integration boundary', async () => {
    const composition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const streams = await Bun.file(new URL('../src/integration/product-session-streams.ts', import.meta.url)).text();
    const lifecycle = await Bun.file(
      new URL('../src/integration/product-session-stream-lifecycle.ts', import.meta.url),
    ).text();

    expect(composition).not.toContain("from '@forgeax/interface/lib/narrative-copilot'");
    expect(composition).not.toContain("from '@forgeax/interface/lib/perception-stream'");
    expect(composition).toContain("from '../integration/product-session-streams'");
    expect(composition).toContain('subscribeNarrativeCopilot();');
    expect(composition).toContain('subscribePerceptionStream();');
    expect(composition).toContain("from '@forgeax/interface/lib/ui-bridge'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/narrative-copilot'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/perception-stream'");
    expect(streams).not.toContain('@forgeax/interface');
    expect(streams).toContain("'forgeax:perception-query'");
    expect(lifecycle).not.toContain('@forgeax/interface');
    expect(lifecycle).toContain("'narrative-copilot'");
    expect(lifecycle).toContain("'perception'");
  });

  test('does not boot the Workbench-owned file activity state in the IDE product shell', async () => {
    const composition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(composition).not.toContain("from '@forgeax/interface/lib/file-activity-stream'");
    expect(composition).not.toContain('subscribeFileActivityStream();');
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/file-activity-stream'");
    expect(composition).toContain("from '@forgeax/interface/lib/ui-bridge'");
    expect(composition).toContain('bootUiBridge();');
  });

  test('owns the injected React bus snapshot adapter at the IDE integration boundary', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const composition = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();
    const adapter = await Bun.file(new URL('../src/integration/react-bus-snapshot.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/use-bus-snapshot'");
    expect(composition).not.toContain("from '@forgeax/interface/lib/use-bus-snapshot'");
    expect(chatAdapter).toContain("from '../integration/react-bus-snapshot'");
    expect(composition).toContain("from '../integration/react-bus-snapshot'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/use-bus-snapshot'");
    expect(adapter).not.toContain('@forgeax/interface');
    expect(adapter).toContain('useSyncExternalStore');
  });

  test('keeps Chat-owned app events out of the onboarding-disabled product entry', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const productEntry = await Bun.file(new URL('../src/main.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/storageKeys'");
    expect(chatAdapter).not.toContain('appEvents: APP_EVENTS');
    expect(productEntry).not.toContain("from '@forgeax/interface/lib/storageKeys'");
    expect(productEntry).not.toContain("from '@forgeax/chat/runtime'");
    expect(productEntry).not.toContain('APP_EVENTS.onboardingChanged');
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/storageKeys'");
  });

  test('uses Chat-owned pure composer text transitions without product injection', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain('  appendComposerText,\n');
    expect(chatAdapter).not.toContain('  appendComposerTextOnce,\n');
    expect(ambientTypes).not.toContain('export const appendComposerText:');
    expect(ambientTypes).not.toContain('export const appendComposerTextOnce:');
  });

  test('uses the Chat-owned composer text bridge while retaining the Interface pill bridge', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    for (const symbol of [
      'useComposerPendingText',
      'clearComposerPendingText',
      'requestComposerText',
      'advanceComposerTextRevision',
    ]) {
      expect(chatAdapter).not.toContain(`\n  ${symbol},`);
      expect(chatAdapter).not.toContain(`\n    ${symbol},`);
      expect(ambientTypes).not.toContain(`export const ${symbol}:`);
    }
    expect(chatAdapter).toContain("| 'useComposerPendingText'");
    expect(chatAdapter).toContain("| 'clearComposerPendingText'");
    expect(chatAdapter).toContain("| 'requestComposerText'");
    expect(chatAdapter).toContain("| 'advanceComposerTextRevision'");
    expect(chatAdapter).toContain('useComposerPendingInsert,');
    expect(chatAdapter).toContain('clearComposerPendingInsert,');
    expect(chatAdapter).toContain('requestComposerInsert,');
    expect(ambientTypes).toContain('export const useComposerPendingInsert:');
  });

  test('uses the Chat-owned turn trace lifecycle with product-owned feedback sinks', async () => {
    const chatAdapter = await Bun.file(new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url)).text();
    const bridge = await Bun.file(new URL('../src/integration/dom-passive-feedback-bridge.ts', import.meta.url)).text();
    const ambientTypes = await Bun.file(new URL('../src/types/interface-integration.d.ts', import.meta.url)).text();

    expect(chatAdapter).not.toContain("from '@forgeax/interface/lib/trace'");
    expect(chatAdapter).not.toContain('    beginChatTurn,');
    expect(chatAdapter).not.toContain('    chatFirstToken,');
    expect(chatAdapter).not.toContain('    chatToolResult,');
    expect(chatAdapter).not.toContain('    chatTurnEnd,');
    expect(chatAdapter).toContain('reportPassiveFeedbackRecovery,');
    expect(bridge).toContain("'forgeax:passive-feedback-recovered'");
    expect(ambientTypes).not.toContain("declare module '@forgeax/interface/lib/trace'");
  });

  test('consumes the shared application host and page navigation directly from App Shell', async () => {
    const chatRuntimeAdapter = await Bun.file(
      new URL('../src/product/chat-runtime-adapter.tsx', import.meta.url),
    ).text();
    const composition = await Bun.file(
      new URL('../src/product/studio-composition.tsx', import.meta.url),
    ).text();
    const ambientTypes = await Bun.file(
      new URL('../src/types/interface-integration.d.ts', import.meta.url),
    ).text();
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();

    expect(chatRuntimeAdapter).toContain(
      "import { openExtensionPage, useHost } from '@forgeax/app-shell/application'",
    );
    expect(chatRuntimeAdapter).not.toContain(
      "from '@forgeax/interface/core/app-shell'",
    );
    expect(chatRuntimeAdapter).not.toContain(
      "from '@forgeax/interface/core/page-navigation'",
    );
    expect(composition).toMatch(
      /import \{[^}]*openResource[^}]*\} from '@forgeax\/app-shell\/application'/,
    );
    expect(composition).not.toContain(
      "from '@forgeax/interface/core/page-navigation'",
    );
    expect(chatRuntimeAdapter).toContain(
      "const useChatHost = useHost as unknown as ChatRuntimeServices['useHost']",
    );
    expect(chatRuntimeAdapter).toContain('useHost: useChatHost');
    expect(ambientTypes).not.toContain(
      "declare module '@forgeax/interface/core/app-shell'",
    );
    expect(ambientTypes).not.toContain(
      "declare module '@forgeax/interface/core/page-navigation'",
    );
    expect(packageJson.dependencies['@forgeax/app-shell']).toBe('0.85.0');
  });

  test('resolves only the staged Chat runtime contract from source', async () => {
    const config = await Bun.file(new URL('../tsconfig.json', import.meta.url)).json();
    const paths = config.compilerOptions.paths;

    expect(paths['@forgeax/chat/runtime']).toEqual(['../chat/src/runtime.tsx']);
    expect(paths['@forgeax/chat/*']).toBeUndefined();
  });

  test('keeps the Interface store as a single integration seam', async () => {
    const source = await Bun.file(new URL('../src/integration/interface-store.ts', import.meta.url)).text();
    expect(source).toContain("export * from '@forgeax/ide-integration/interface-store-source'");
  });

  test('keeps IDE tests scoped without a nested source tree', async () => {
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
    expect(packageJson.scripts.test).toBe('bun test tests src-tauri/tests');
  });

  test('prepares Engine shader compiler inputs before product compilation', async () => {
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
    const preparation = await Bun.file(new URL('../scripts/ensure-shader-build-inputs.ts', import.meta.url)).text();
    const provenance = await Bun.file(new URL('../scripts/shader-build-input-provenance.ts', import.meta.url)).text();

    expect(packageJson.scripts['prepare:shader-build-inputs']).toBe(
      'bun run scripts/ensure-shader-build-inputs.ts',
    );
    expect(packageJson.scripts['verify:shader-vite-contract']).toBe(
      'bun run scripts/verify-shader-vite-contract.ts',
    );
    expect(packageJson.scripts['build:web']).toStartWith('bun run prepare:shader-build-inputs &&');
    expect(packageJson.scripts['build:desktop']).toStartWith('bun run prepare:shader-build-inputs &&');
    expect(preparation).toContain('packages/vite-plugin-shader/dist/index.mjs');
    expect(preparation).toContain('packages/vite-plugin-pack/dist/index.mjs');
    expect(preparation).toContain('packages/vite-plugin-rhi-debug/dist/index.mjs');
    expect(preparation).toContain('packages/image/dist/image-importer.mjs');
    expect(preparation).toContain('packages/gltf/dist/index.mjs');
    expect(preparation).toContain('packages/fbx/dist/index.mjs');
    expect(preparation).toContain('packages/font/dist/font-importer.mjs');
    expect(preparation).toContain('packages/vfx-compiler/dist/index.mjs');
    expect(preparation).toContain('packages/shader-compiler/dist/index.mjs');
    expect(preparation).toContain('packages/audio-webaudio/dist/audio-importer.mjs');
    expect(preparation).toContain("['--filter', filter]");
    expect(preparation).toContain('shaderInputs.wgpuWasmGlue');
    expect(preparation).toContain("'@forgeax/engine-vite-plugin-shader...'");
    expect(preparation).toContain("'@forgeax/engine-vite-plugin-pack...'");
    expect(preparation).toContain('shaderBuildInputPaths(engineRoot)');
    expect(preparation).toContain('inspectShaderBuildProvenance');
    expect(preparation).toContain('writeShaderBuildProvenance');
    expect(preparation).toContain('FORGEAX_REQUIRE_PUBLISHABLE_SHADER_INPUTS');
    expect(preparation).toContain("['run', 'verify:shader-vite-contract']");
    expect(provenance).toContain("'--ignore-submodules=dirty'");
    expect(provenance).toContain("'--untracked-files=normal'");
    expect(preparation).toContain("filters.add('@forgeax/engine-vite-plugin-shader...')");
  });

  test('runs repository CI in a Studio integration checkout', async () => {
    const integrationInputs = await Bun.file(
      new URL('../product/integration-inputs.json', import.meta.url),
    ).json();
    expect(integrationInputs).toEqual({
      schemaVersion: 1,
      settings: {
        repository: 'ForgeaX-Games/forgeax-settings',
        revision: '98ce724cdadac7bb4e428c7ee72aae49c05907eb',
      },
    });
    for (const path of ['../.github/workflows/ci.yml', '../.github/workflows/desktop.yml']) {
      const workflow = await Bun.file(new URL(path, import.meta.url)).text();
      expect(workflow).toContain('ForgeaX-Games/forgeax-studio');
      expect(workflow).toContain('FORGEAX_INTEGRATION_ROOT');
      expect(workflow).toContain('Materialize Studio package inputs');
      expect(workflow).toContain('Sync direct Settings source input');
      expect(workflow).toContain("require('./forgeax-studio/packages/ide/product/integration-inputs.json').settings.revision");
      expect(workflow).toContain('git -C forgeax-studio/packages/settings fetch origin main');
      expect(workflow).toContain('merge-base --is-ancestor "$settings_revision" FETCH_HEAD');
      expect(workflow).toContain('checkout --detach "$settings_revision"');
      expect(workflow).toContain('Install Studio integration workspace');
      expect(workflow).toContain('Materialize Editor config dependencies');
      expect(workflow).toContain('working-directory: forgeax-studio/packages/editor');
      expect(workflow).toContain('bun install --frozen-lockfile --ignore-scripts');
      expect(workflow).toContain('Setup wasm-pack');
      expect(workflow).toContain('wasm-pack@0.14.0');
      expect(workflow).toContain('Read Engine pnpm version');
      expect(workflow).toContain('Setup pnpm');
      expect(workflow).toContain('packages/editor/packages/engine/.pnpm-version');
      expect(workflow).toContain('packages/cli');
      expect(workflow).toContain('packages/platform-io');
      expect(workflow).toContain('bun scripts/ci/install-ide-integration-workspace.ts');
      expect(workflow).not.toContain('node <<\'NODE\'');
    }
  });

  test('consumes the canonical extension transport SDK from npm', async () => {
    const source = await Bun.file(new URL('../src/product/studio-composition.tsx', import.meta.url)).text();
    const config = await Bun.file(new URL('../vite.config.ts', import.meta.url)).text();
    const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();

    expect(source).toContain("from '@forgeax/extension-platform/transport'");
    expect(source).not.toContain("from '@forgeax/host-sdk'");
    expect(source).not.toContain('hostSDK');
    expect(source).toContain('extensionTransport');
    expect(config).not.toContain("id: '@forgeax/host-sdk'");
    expect(config).not.toContain("find: /^@forgeax\\/host-sdk");
    expect(packageJson.dependencies['@forgeax/extension-platform']).toBe('0.4.0');
  });

  test('proxies every server-owned Extension surface instead of SPA-falling back to the IDE', async () => {
    const source = await Bun.file(new URL('../vite.config.ts', import.meta.url)).text();
    expect(source).toContain("runtimePort(process.env.FORGEAX_SERVER_PORT, 18900, 'FORGEAX_SERVER_PORT')");
    expect(source).toContain('`http://127.0.0.1:${studioServerPort}`');
    expect(source).toContain('`ws://127.0.0.1:${studioServerPort}`');
    expect(source).toContain("'/extensions': { target: studioServerTarget");
    expect(source).toContain("'/__extensions__': { target: studioServerTarget");
    expect(source).toContain("'/__ce-api__': { target: studioServerTarget");
  });

  test('proxies unprefixed engine shader resources to Play Runtime preview assets', async () => {
    const source = await Bun.file(new URL('../vite.config.ts', import.meta.url)).text();
    expect(source).toContain("runtimePort(process.env.FORGEAX_ENGINE_PORT, 15173, 'FORGEAX_ENGINE_PORT')");
    expect(source).toContain('`http://127.0.0.1:${playRuntimePort}`');
    expect(source).toContain("'/shaders': {");
    expect(source).toContain('rewrite: (path) => `/preview${path}`');
    expect(source).toContain('ShaderError: manifest-malformed');
  });

  test('documents the Studio-owned runtime boundary', async () => {
    const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();
    expect(readme).toContain('is not a standalone checkout');
    expect(readme).toContain('forgeax-studio/packages/interface');
    expect(readme).not.toContain('independently installable');
  });
});
