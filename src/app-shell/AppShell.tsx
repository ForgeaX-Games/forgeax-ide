import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getProductManifest } from '../product/manifest';
import {
  createIdeCarrierActivation,
  IDE_DEFAULT_GAME_ID,
  ideEditorTransportUrl,
  type IdeCarrierDiscovery,
  type IdeGameplayIdentity,
} from '../product/start-product';
import '../styles.css';

type JsonRecord = Record<string, unknown>;
type TransportRequest = JsonRecord & { readonly id: string; readonly correlationId: string; readonly method: string; readonly params?: unknown };
type CarrierState = { playing: boolean; logs: JsonRecord[]; frames: { atMs: number; durationMs: number }[] };

const TRANSPORT_VERSION = 'editor-transport/v1' as const;
const RECOVERY_ACTIONS = ['carrier.discover', 'game.select', 'carrier.focus', 'request.retry', 'carrier.stop'] as const;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function identityRecord(identity: IdeGameplayIdentity | null): JsonRecord {
  return identity === null ? {} : { identity };
}

function failure(requestId: string, operation: string | null, code: string, hint: string, expected: JsonRecord = {}, observed: JsonRecord = {}): JsonRecord {
  return { version: 'GameplayOperationResult/v1', requestId, operation: operation || null, ok: false, error: { code, category: 'transport', hint, retryable: true, expected, observed, recoveryActions: RECOVERY_ACTIONS } };
}

function staleIdentityFailure(requestId: string, operation: string | null, expected: IdeGameplayIdentity, observed: unknown): JsonRecord {
  return {
    version: 'GameplayOperationResult/v1',
    requestId,
    operation: operation || null,
    ok: false,
    error: {
      code: 'stale-or-mismatched-identity',
      category: 'provenance',
      hint: 'Rediscover the current carrier before using this operation identity.',
      retryable: false,
      expected: { identity: expected },
      observed: { identity: observed },
      recoveryActions: RECOVERY_ACTIONS,
    },
  };
}

function sameIdentity(candidate: unknown, expected: IdeGameplayIdentity): boolean {
  const value = record(candidate);
  const scope = record(value?.scope);
  return value?.runtimeId === expected.runtimeId
    && scope?.projectId === expected.scope.projectId
    && scope?.gameId === expected.scope.gameId
    && value?.pageIdentity === expected.pageIdentity
    && value?.canvasIdentity === expected.canvasIdentity
    && value?.rendererGeneration === expected.rendererGeneration
    && value?.carrierId === expected.carrierId
    && value?.rendererIdentity === expected.rendererIdentity;
}

function success(requestId: string, operation: string, identity: IdeGameplayIdentity, data: JsonRecord = {}, state?: 'running' | 'stopped'): JsonRecord {
  return { version: 'GameplayOperationResult/v1', requestId, operation, ok: true, ...(state === undefined ? {} : { state }), identity, data };
}

function byteLength(dataUrl: string): number {
  const encoded = dataUrl.split(',', 2)[1] ?? '';
  return Math.floor(encoded.length * 3 / 4);
}

function boundedLogs(state: CarrierState, windowId: string): JsonRecord {
  const startIndex = Math.max(0, state.logs.length - 100);
  const entries = state.logs.slice(startIndex);
  return { windowId, entries, startIndex, endIndexExclusive: state.logs.length, totalEntries: state.logs.length, truncated: startIndex > 0, continuationToken: startIndex > 0 ? `${windowId}:${state.logs.length}` : null };
}

function frameStatistics(state: CarrierState, windowId: string): JsonRecord | null {
  const samples = state.frames.filter((sample) => Number.isFinite(sample.durationMs) && sample.durationMs > 0).slice(-120);
  if (samples.length < 2) return null;
  const startedAtMs = samples[0]!.atMs;
  const endedAtMs = samples[samples.length - 1]!.atMs + samples[samples.length - 1]!.durationMs;
  const durationMs = endedAtMs - startedAtMs;
  const averageFrameMs = samples.reduce((total, sample) => total + sample.durationMs, 0) / samples.length;
  return { windowId, startedAtMs, endedAtMs, durationMs, sampleCount: samples.length, averageFrameMs, fps: 1000 / averageFrameMs, samples };
}

export function AppShell() {
  const manifest = getProductManifest();
  const activation = useMemo(() => createIdeCarrierActivation(), []);
  const [discovery, setDiscovery] = useState<IdeCarrierDiscovery>(() => activation.discover());
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [hostState, setHostState] = useState<'initializing' | 'ready' | 'failed'>('initializing');
  const [hostError, setHostError] = useState<string | null>(null);
  const [transportState, setTransportState] = useState<'connecting' | 'ready' | 'closed'>('connecting');
  const [lastOperation, setLastOperation] = useState<string>('none');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<CarrierState>({ playing: false, logs: [], frames: [] });
  const identityRef = useRef<IdeGameplayIdentity | null>(null);

  const selectGame = useCallback((gameId: string) => {
    const result = activation.select(gameId);
    setDiscovery(result.discovery);
    setSelectionError(result.ok ? null : `${result.error.code}: ${result.error.hint}`);
    if (result.ok) identityRef.current = activation.gameplayIdentity();
  }, [activation]);

  useEffect(() => {
    let disposed = false;
    void activation.initializeHost(IDE_DEFAULT_GAME_ID).then((result) => {
      if (disposed) return;
      if (!result.ok) { setHostState('failed'); setHostError(`${result.code}: ${result.hint}`); return; }
      selectGame(result.gameId);
      setHostState('ready');
    });
    return () => { disposed = true; };
  }, [activation, selectGame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let previous = performance.now();
    let animationFrame = 0;
    const draw = (now: number) => {
      const durationMs = now - previous;
      previous = now;
      stateRef.current.frames.push({ atMs: now - durationMs, durationMs });
      if (stateRef.current.frames.length > 240) stateRef.current.frames.shift();
      const { width, height } = canvas;
      context.fillStyle = stateRef.current.playing ? '#101d1b' : '#11131d';
      context.fillRect(0, 0, width, height);
      context.strokeStyle = stateRef.current.playing ? '#2f6657' : '#2f3853';
      context.lineWidth = 1;
      for (let x = 0; x <= width; x += 32) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
      for (let y = 0; y <= height; y += 32) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
      context.fillStyle = '#a78bfa';
      context.font = '600 18px Inter, sans-serif';
      context.fillText(`${IDE_DEFAULT_GAME_ID} public carrier`, 24, 36);
      context.fillStyle = stateRef.current.playing ? '#b4ebbf' : '#d7d7e3';
      context.fillText(stateRef.current.playing ? 'PLAYING' : 'EDITING', 24, 68);
      animationFrame = requestAnimationFrame(draw);
    };
    animationFrame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  const handleGameplay = useCallback(async (request: JsonRecord): Promise<JsonRecord> => {
    const requestId = typeof request.requestId === 'string' ? request.requestId : `ide-${crypto.randomUUID()}`;
    const operation = typeof request.operation === 'string' ? request.operation : null;
    const identity = identityRef.current;
    if (identity === null) return failure(requestId, operation, 'identity-unavailable', 'The selected public carrier has not published a complete identity.');
    const scope = record(request.scope);
    if (scope !== null && (scope.gameId !== identity.scope.gameId || scope.projectId !== identity.scope.projectId)) return failure(requestId, operation, 'game-selection-mismatch', 'The gameplay request scope does not match the explicitly selected server-owned game.', { scope: identity.scope }, { scope });
    if (request.identity !== undefined && !sameIdentity(request.identity, identity)) return staleIdentityFailure(requestId, operation, identity, request.identity);
    const state = stateRef.current;
    const log = (event: string, details: JsonRecord = {}) => { state.logs.push({ atMs: performance.now(), event, ...details }); };
    if (operation === 'play') { state.playing = true; log('play'); return success(requestId, operation, identity, { status: 'playing', gameId: identity.scope.gameId }, 'running'); }
    if (operation === 'gameplayStop') { state.playing = false; log('gameplayStop'); return success(requestId, operation, identity, { status: 'stopped', gameId: identity.scope.gameId }, 'stopped'); }
    if (!state.playing) return failure(requestId, operation, 'gameplay-not-running', 'Start gameplay before issuing gameplay input, query, capture, or diagnostics.');
    if (operation === 'input') {
      const action = record(request.action);
      if (action === null) return failure(requestId, operation, 'malformed-input', 'Input requires a public action object.', { action: 'object' }, { action: request.action ?? null });
      log('input', { action });
      return success(requestId, operation, identity, { accepted: true, action });
    }
    if (operation === 'query') { log('query', { query: typeof request.query === 'string' ? request.query : 'gameplay.state' }); return success(requestId, operation, identity, { state: 'playing', gameId: identity.scope.gameId, inputAccepted: true }); }
    if (operation === 'capture') {
      const canvas = canvasRef.current;
      if (!canvas) return failure(requestId, operation, 'capture-unavailable', 'The public gameplay canvas is not mounted.');
      const dataUrl = String(canvas.toDataURL('image/png'));
      log('capture', { windowId: typeof request.windowId === 'string' ? request.windowId : 'default' });
      return success(requestId, operation, identity, { windowId: request.windowId ?? 'default', artifact: { dataUrl, bytes: byteLength(dataUrl), provenance: identity } });
    }
    if (operation === 'logs') {
      const windowId = typeof request.windowId === 'string' && request.windowId.trim() ? request.windowId : 'default';
      return success(requestId, operation, identity, boundedLogs(state, windowId));
    }
    if (operation === 'frames') {
      const windowId = typeof request.windowId === 'string' && request.windowId.trim() ? request.windowId : 'default';
      const statistics = frameStatistics(state, windowId);
      if (statistics === null) return failure(requestId, operation, 'invalid-frame-window', 'Frame statistics require at least two positive-duration samples.');
      return success(requestId, operation, identity, statistics);
    }
    return failure(requestId, operation, 'not-supported', 'The selected public carrier does not publish this gameplay operation.', { operation: 'published' }, { operation });
  }, []);

  const handlePublicRequest = useCallback(async (request: TransportRequest): Promise<JsonRecord> => {
    const params = record(request.params) ?? {};
    if (request.method === 'discover' || request.method === 'transport.describe') return { ...discovery, directEngine: false, identity: identityRef.current, transport: TRANSPORT_VERSION };
    if (request.method === 'gameplay') return handleGameplay(params);
    if (request.method === 'save' || request.method === 'reopen') {
      if (request.method === 'reopen') {
        try { const fresh = await activation.freshRead(); return { ok: true, value: fresh.value, readerRealmId: fresh.readerRealmId, ...identityRecord(identityRef.current) }; }
        catch (error) { return failure(typeof params.requestId === 'string' ? params.requestId : 'reopen', 'reopen', 'fresh-read-failed', error instanceof Error ? error.message : String(error)); }
      }
      const result = await activation.saveAndVerify(typeof params.requestId === 'string' ? params.requestId : '');
      return { ...result, ...identityRecord(identityRef.current) };
    }
    if (request.method === 'run.dispatch') {
      const operationId = typeof params.operationId === 'string' ? params.operationId : '';
      const input = record(params.input) ?? {};
      if (operationId === 'editor.game.select') {
        const slug = typeof input.slug === 'string' ? input.slug : '';
        const result = activation.select(slug);
        if (!result.ok) return { ok: false, error: result.error, discovery: result.discovery };
        identityRef.current = activation.gameplayIdentity();
        return { ok: true, selectedGame: result.selectedGame, discovery: result.discovery, ...identityRecord(identityRef.current) };
      }
      if (operationId === 'editor.persistence.save') return handlePublicRequest({ ...request, method: 'save', params: input });
      if (operationId === 'editor.persistence.fresh-read') return handlePublicRequest({ ...request, method: 'reopen', params: input });
      if (operationId === 'editor.lifecycle.play') return handleGameplay({ ...input, operation: 'play', requestId: input.requestId ?? `play-${crypto.randomUUID()}` });
      if (operationId === 'editor.lifecycle.stop') return handleGameplay({ ...input, operation: 'gameplayStop', requestId: input.requestId ?? `stop-${crypto.randomUUID()}` });
      if (operationId.startsWith('editor.gameplay.') || operationId.startsWith('editor.evidence.')) {
        const operation = operationId === 'editor.gameplay.input' ? 'input' : operationId === 'editor.gameplay.projection' ? 'query' : operationId === 'editor.evidence.capture' ? 'capture' : operationId === 'editor.evidence.logs' ? 'logs' : operationId === 'editor.evidence.performance' ? 'frames' : '';
        return handleGameplay({ ...input, operation, requestId: input.requestId ?? `${operation}-${crypto.randomUUID()}` });
      }
    }
    return failure(typeof params.requestId === 'string' ? params.requestId : 'transport', null, 'not-supported', 'The public Editor transport operation is not published.', { operation: 'discovered public operation' }, { method: request.method });
  }, [activation, discovery, handleGameplay]);

  useEffect(() => {
    if (hostState !== 'ready') return;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      setTransportState('connecting');
      const socket = new WebSocket(ideEditorTransportUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'editor-transport/ready', version: TRANSPORT_VERSION, role: 'interactive', scope: `game:${IDE_DEFAULT_GAME_ID}`, visibility: 'visible', focused: true, capabilities: { gameplay: true } }));
        setTransportState('ready');
      };
      socket.onmessage = (event) => {
        let value: unknown;
        try { value = JSON.parse(String(event.data)); } catch { return; }
        const message = record(value);
        const request = message?.type === 'editor-transport/request' ? record(message.request) as TransportRequest | null : null;
        if (request === null) return;
        void handlePublicRequest(request).then((result) => {
          socket.send(JSON.stringify({ type: 'editor-transport/response', response: { jsonrpc: '2.0', version: TRANSPORT_VERSION, id: request.id, correlationId: request.correlationId, result } }));
          setLastOperation(request.method);
        }).catch((error) => {
          socket.send(JSON.stringify({ type: 'editor-transport/response', response: { jsonrpc: '2.0', version: TRANSPORT_VERSION, id: request.id, correlationId: request.correlationId, result: failure('transport', null, 'carrier-operation-failed', error instanceof Error ? error.message : String(error)) } }));
        });
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        setTransportState('closed');
        reconnectRef.current = setTimeout(connect, 500);
      };
      socket.onerror = () => setTransportState('closed');
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectRef.current !== null) clearTimeout(reconnectRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [handlePublicRequest, hostState]);

  return (
    <main className="ide-shell" data-product={manifest.id} data-public-carrier="editor-transport">
      <header className="ide-shell__header"><div><p className="ide-shell__eyebrow">ForgeaX</p><h1>{manifest.displayName}</h1></div><span className="ide-shell__status" data-readiness={transportState}>{transportState === 'ready' ? 'Carrier ready' : 'Carrier connecting'}</span></header>
      <section className="ide-shell__content" aria-label="Gameplay carrier">
        <div className="ide-shell__welcome"><p className="ide-shell__eyebrow">Public gameplay carrier</p><h2>Play the selected game in the IDE.</h2><p>Editor and server discovery stay behind one released, identity-bound carrier.</p></div>
        <div className="ide-shell__carrier-layout">
          <div className="ide-shell__viewport-frame"><canvas ref={canvasRef} className="ide-shell__viewport" width="800" height="420" aria-label="gta-route-dev gameplay viewport" data-carrier="editor-gameplay" data-canvas-identity={discovery.identity?.canvasIdentity ?? 'unselected'} /></div>
          <aside className="ide-shell__discovery" aria-label="Carrier discovery">
            <label className="ide-shell__field"><span>Explicit game selection</span><select aria-label="Game selection" value={discovery.selectedGame ?? ''} onChange={(event) => selectGame(event.target.value)}><option value="">Select a game</option>{discovery.candidates.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label>
            <button type="button" className="ide-shell__invalid-selection" onClick={() => selectGame('missing-game')}>Try invalid selection</button>
            {selectionError ? <p className="ide-shell__error" role="alert">{selectionError}</p> : null}
            {hostError ? <p className="ide-shell__error">{hostError}</p> : null}
            <dl className="ide-shell__facts">
              <div><dt>Product</dt><dd data-product-identity={discovery.productId}>{discovery.productId}</dd></div><div><dt>Selected</dt><dd data-selected-game={discovery.selectedGame ?? 'none'}>{discovery.selectedGame ?? 'none'}</dd></div><div><dt>Host</dt><dd data-host-state={hostState}>{hostState}</dd></div><div><dt>Transport</dt><dd data-transport-state={transportState}>{transportState}</dd></div><div><dt>Identity</dt><dd data-gameplay-identity={identityRef.current?.runtimeId ?? 'unbound'}>{identityRef.current?.runtimeId ?? 'unbound'}</dd></div><div><dt>Versions</dt><dd>{discovery.versions.editor} / {discovery.versions.server} / gameplay {discovery.versions.gameplay}</dd></div><div><dt>Schemas</dt><dd>{discovery.schemas.join(', ')}</dd></div><div><dt>Last operation</dt><dd data-last-operation={lastOperation}>{lastOperation}</dd></div><div><dt>Recovery</dt><dd>{discovery.recoveryActions.join(', ')}</dd></div>
            </dl>
          </aside>
        </div>
        <div className="ide-shell__capabilities" aria-label="Carrier capabilities">{discovery.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>
      </section>
    </main>
  );
}
