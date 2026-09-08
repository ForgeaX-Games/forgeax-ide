import { adaptServiceHealth } from '../runtime/services/service-health-adapter';
import { resolveProductService } from '../runtime/services/product-service-resolver';
import { aggregateProductRuntimeReport } from '../runtime/product-report-aggregator';
import type { ProductRuntimeReportV1, RuntimeComponent } from '../runtime/product-runtime-report';
import { createProductProviders, type ProductMode } from '../runtime/providers';
import { ServiceSupervisor } from '../runtime/services/supervisor';

export const IDE_GAME_CARRIER_CONTRACT_VERSION = 'ide-game-carrier/v1' as const;
export const IDE_DEFAULT_GAME_ID = 'gta-route-dev' as const;

export type IdeCarrierSelectionError = {
  readonly code: 'game-selection-required' | 'game-not-found' | 'game-selection-ambiguous';
  readonly hint: string;
  readonly retryable: boolean;
  readonly recoveryActions: readonly string[];
};

export type IdeCarrierIdentity = {
  readonly runtimeId: string;
  readonly scope: { readonly projectId: string; readonly gameId: string };
  readonly pageIdentity: string;
  readonly canvasIdentity: string;
  readonly rendererGeneration: number;
};

export type IdeGameplayIdentity = IdeCarrierIdentity & {
  readonly carrierId: string;
  readonly rendererIdentity: string;
};

export type IdeHostSnapshot = Record<string, unknown>;

export type IdeHostInitialization =
  | { readonly ok: true; readonly gameId: string; readonly snapshot: IdeHostSnapshot }
  | { readonly ok: false; readonly code: string; readonly hint: string; readonly observed?: unknown };

export type IdeDurableSaveResult = {
  readonly ok: boolean;
  readonly requestId: string;
  readonly writerRealmId: string;
  readonly readerRealmId: string | null;
  readonly state: 'clean' | 'dirty' | 'unknown';
  readonly dirty: boolean;
  readonly authoritative: IdeHostSnapshot | null;
  readonly observed: IdeHostSnapshot | null;
  readonly error?: { readonly code: string; readonly hint: string; readonly retryable: boolean };
};

export type IdeCarrierDiscovery = {
  readonly version: typeof IDE_GAME_CARRIER_CONTRACT_VERSION;
  readonly productId: 'forgeax-ide';
  readonly directEngine: false;
  readonly selectedGame: string | null;
  readonly candidates: readonly string[];
  readonly readiness: 'unselected' | 'ready' | 'unavailable';
  readonly identity: IdeCarrierIdentity | null;
  readonly capabilities: readonly string[];
  readonly versions: {
    readonly editor: '0.1.0';
    readonly server: '0.1.0';
    readonly gameplay: '1';
  };
  readonly schemas: readonly string[];
  readonly recoveryActions: readonly string[];
};

export type IdeCarrierSelectionResult =
  | { readonly ok: true; readonly selectedGame: string; readonly discovery: IdeCarrierDiscovery }
  | { readonly ok: false; readonly error: IdeCarrierSelectionError; readonly discovery: IdeCarrierDiscovery };

export type IdeCarrierActivation = {
  readonly discover: () => IdeCarrierDiscovery;
  readonly select: (gameId: string) => IdeCarrierSelectionResult;
  readonly gameplayIdentity: () => IdeGameplayIdentity | null;
  readonly initializeHost: (gameId: string) => Promise<IdeHostInitialization>;
  readonly freshRead: () => Promise<{ readonly readerRealmId: string; readonly value: IdeHostSnapshot }>;
  readonly saveAndVerify: (requestId: string) => Promise<IdeDurableSaveResult>;
};

const IDE_CARRIER_CAPABILITIES = Object.freeze([
  'game.select',
  'gameplay.viewport',
  'carrier.identity',
  'carrier.capture',
]);
const IDE_CARRIER_SCHEMAS = Object.freeze([
  'editor-carrier/v1',
  'server-game-carrier/v1',
  'GameplayIdentity/v1',
  'GameplayOperationRequest/v1',
  'GameplayOperationResult/v1',
]);
const IDE_CARRIER_RECOVERY_ACTIONS = Object.freeze([
  'carrier.discover',
  'game.select',
  'carrier.focus',
  'request.retry',
  'carrier.stop',
]);

export function ideServerBaseUrl(): string {
  if (typeof globalThis.location !== 'undefined') {
    return `${globalThis.location.protocol}//${globalThis.location.hostname}:18900`;
  }
  return 'http://127.0.0.1:18900';
}

export function ideEditorTransportUrl(): string {
  return `${ideServerBaseUrl().replace(/^http/u, 'ws')}/ws/editor/transport`;
}

async function hostJson(path: string, init?: RequestInit): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(`${ideServerBaseUrl()}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

function hostFailure(code: string, hint: string, observed?: unknown): IdeHostInitialization {
  return { ok: false, code, hint, ...(observed === undefined ? {} : { observed }) };
}

function snapshotRecord(value: unknown): IdeHostSnapshot | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as IdeHostSnapshot : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function createIdeCarrierActivation(
  candidates: readonly string[] = [IDE_DEFAULT_GAME_ID],
  projectId = 'forgeax-ide',
): IdeCarrierActivation {
  let selectedGame: string | null = null;

  const identity = (): IdeCarrierIdentity | null => selectedGame === null
    ? null
    : {
      runtimeId: `runtime:${selectedGame}`,
      scope: { projectId, gameId: selectedGame },
      pageIdentity: '@forgeax/editor#page/level',
      canvasIdentity: 'ep:viewport',
      rendererGeneration: 1,
    };

  const discover = (): IdeCarrierDiscovery => ({
    version: IDE_GAME_CARRIER_CONTRACT_VERSION,
    productId: 'forgeax-ide',
    directEngine: false,
    selectedGame,
    candidates: [...candidates],
    readiness: selectedGame === null ? 'unselected' : identity() === null ? 'unavailable' : 'ready',
    identity: identity(),
    capabilities: IDE_CARRIER_CAPABILITIES,
    versions: { editor: '0.1.0', server: '0.1.0', gameplay: '1' },
    schemas: IDE_CARRIER_SCHEMAS,
    recoveryActions: IDE_CARRIER_RECOVERY_ACTIONS,
  });

  const select = (gameId: string): IdeCarrierSelectionResult => {
    const matches = candidates.filter((candidate) => candidate === gameId);
    if (matches.length === 0) return {
      ok: false,
      error: {
        code: 'game-not-found',
        hint: `Game "${gameId}" is not an available explicit selection.`,
        retryable: false,
        recoveryActions: IDE_CARRIER_RECOVERY_ACTIONS,
      },
      discovery: discover(),
    };
    if (matches.length !== 1) return {
      ok: false,
      error: {
        code: 'game-selection-ambiguous',
        hint: `Game "${gameId}" resolves to multiple candidates; selection was not changed.`,
        retryable: false,
        recoveryActions: IDE_CARRIER_RECOVERY_ACTIONS,
      },
      discovery: discover(),
    };
    selectedGame = gameId;
    return { ok: true, selectedGame, discovery: discover() };
  };

  const gameplayIdentity = (): IdeGameplayIdentity | null => {
    const current = identity();
    return current === null || selectedGame === null ? null : {
      ...current,
      carrierId: `editor-transport:game:${selectedGame}`,
      rendererIdentity: 'ide-public-gameplay-canvas',
    };
  };

  const initializeHost = async (gameId: string): Promise<IdeHostInitialization> => {
    try {
    const listed = await hostJson('/api/projects');
      const games = listed.body !== null && typeof listed.body === 'object' && Array.isArray((listed.body as { games?: unknown }).games)
        ? (listed.body as { games: unknown[] }).games
        : [];
      if (!games.some((game) => game !== null && typeof game === 'object' && (game as { slug?: unknown }).slug === gameId)) {
        const created = await hostJson('/api/projects', {
          method: 'POST',
          body: JSON.stringify({ slug: gameId, name: gameId }),
        });
        if (!created.response.ok) return hostFailure('host-game-create-failed', 'The server-owned Host could not create the explicitly selected game.', created.body);
      }
      const active = await hostJson('/api/projects/active');
      const activeSlug = active.body !== null && typeof active.body === 'object' ? (active.body as { activeSlug?: unknown }).activeSlug : null;
      if (activeSlug !== gameId) {
        const selected = await hostJson('/api/projects/active', { method: 'PUT', body: JSON.stringify({ slug: gameId }) });
        if (!selected.response.ok) return hostFailure('host-game-selection-failed', 'The server-owned Host rejected the explicit game selection.', selected.body);
      }
      const initialized = await hostJson('/api/version-control/commands/initializeGameRepository', {
        method: 'POST',
        body: JSON.stringify({ requestId: `host-init-${crypto.randomUUID()}` }),
      });
      if (!initialized.response.ok) return hostFailure('host-repository-init-failed', 'The server-owned Host could not initialize the selected game repository.', initialized.body);
      const snapshot = await hostJson('/api/version-control/snapshot');
      const value = snapshotRecord(snapshot.body);
      if (!snapshot.response.ok || value === null || value.status !== 'ready') return hostFailure('host-snapshot-unavailable', 'The selected server-owned Host did not publish a ready snapshot.', snapshot.body);
      return { ok: true, gameId, snapshot: value };
    } catch (error) {
      return hostFailure('host-unavailable', error instanceof Error ? error.message : String(error));
    }
  };

  const freshRead = async (): Promise<{ readonly readerRealmId: string; readonly value: IdeHostSnapshot }> => {
    const result = await hostJson('/api/version-control/snapshot', { headers: { 'cache-control': 'no-store', 'x-forgeax-reader-realm': `reader-${crypto.randomUUID()}` } });
    const value = snapshotRecord(result.body);
    if (!result.response.ok || value === null || value.status !== 'ready') throw new Error('fresh Host reader did not observe a ready snapshot');
    return { readerRealmId: `reader-${crypto.randomUUID()}`, value };
  };

  const saveAndVerify = async (requestId: string): Promise<IdeDurableSaveResult> => {
    const writerRealmId = `writer-${crypto.randomUUID()}`;
    if (!requestId.trim()) return { ok: false, requestId, writerRealmId, readerRealmId: null, state: 'unknown', dirty: true, authoritative: null, observed: null, error: { code: 'invalid-request', hint: 'Save requires a unique requestId.', retryable: false } };
    try {
      const saved = await hostJson('/api/version-control/commands/initializeGameRepository', { method: 'POST', body: JSON.stringify({ requestId }) });
      if (!saved.response.ok) return { ok: false, requestId, writerRealmId, readerRealmId: null, state: 'unknown', dirty: true, authoritative: null, observed: null, error: { code: 'save-failed', hint: 'The authoritative Host Save failed.', retryable: true } };
      const authoritativeResponse = await hostJson('/api/version-control/snapshot');
      const authoritative = snapshotRecord(authoritativeResponse.body);
      if (!authoritativeResponse.response.ok || authoritative === null) return { ok: false, requestId, writerRealmId, readerRealmId: null, state: 'unknown', dirty: true, authoritative: null, observed: null, error: { code: 'read-back-failed', hint: 'The authoritative Host snapshot was unavailable.', retryable: true } };
      const reader = await freshRead();
      const clean = sameSnapshot(authoritative, reader.value);
      return { ok: clean, requestId, writerRealmId, readerRealmId: reader.readerRealmId, state: clean ? 'clean' : 'dirty', dirty: !clean, authoritative, observed: reader.value, ...(clean ? {} : { error: { code: 'durability-mismatch', hint: 'The independent fresh reader differs from the authoritative Save.', retryable: true } }) };
    } catch (error) {
      return { ok: false, requestId, writerRealmId, readerRealmId: null, state: 'unknown', dirty: true, authoritative: null, observed: null, error: { code: 'save-failed', hint: error instanceof Error ? error.message : String(error), retryable: true } };
    }
  };

  return { discover, select, gameplayIdentity, initializeHost, freshRead, saveAndVerify };
}

export async function startProduct(
  mode: ProductMode,
  supervisor: ServiceSupervisor,
  extensionComponents: readonly RuntimeComponent[],
): Promise<ProductRuntimeReportV1> {
  createProductProviders(mode);
  const serviceContract = resolveProductService('forgeax-server');
  const service = await supervisor.start('forgeax-server');
  const serviceComponent = adaptServiceHealth('forgeax-server', serviceContract.version, {
    version: 1,
    serviceId: service.service,
    serviceVersion: service.version,
    status: service.ready ? 'ready' : 'failed',
    protocol: { min: '1', max: '1' },
    ready: service.ready,
    restartable: service.retryable,
  });
  return aggregateProductRuntimeReport(extensionComponents, [serviceComponent]);
}
