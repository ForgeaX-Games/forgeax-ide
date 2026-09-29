import type {
	ActiveProjectSelection,
	RuntimeScopeState,
} from "./shell-state-domain-contract";

// File preview state belongs to @forgeax/files; the foundation store keeps no copy.

export interface ToolCall {
	callId: string;
	name: string;
	args: unknown;
	status: "running" | "done" | "error";
	/**
	 * The external CLI permission bridge owns this AskUserQuestion interaction.
	 * It is rendered by PermissionPrompt, not by the native ask_user card.
	 * Keeping the provenance on the call makes live, replay and multi-tab
	 * projections agree without guessing from provider names or result text.
	 */
	permissionPrompt?: boolean;
	/** Display text; may be truncated and must not carry protocol data. */
	result?: string;
	/** Complete structured tool result for protocol consumers. */
	resultData?: unknown;
	/** Complete display text when `result` was truncated. */
	fullResultContent?: string;
	error?: string;
	// Snapshot of m.text.length when this tool-call event arrived. Lets the UI
	// render tool chips inline at their chronological position in the response
	// (mimicking vag_web's parts[] flow) instead of dumping all chips at the end.
	at?: number;
	/** When this tool_call is `name='subagent'`, the launched sub-agent's id.
	 *  ForgeCard uses this to associate the chip with the inline SubAgentCard
	 *  rendered from chatMsg.subAgents[subagentId]. */
	subagentId?: string;
}

export interface LiveAgent {
	path: string;
	display: string;
	parent: string | null;
	running: boolean;
	depth: number;
}

export interface AgentFileTouch {
	callId: string;
	path: string;
	name: string;
	op: string;
	ts: number;
	status: "running" | "done" | "error";
}

export interface ConsoleEntry {
	level: "log" | "warn" | "error" | "info" | "debug";
	text: string;
	ts: number;
}

export interface NetworkEntry {
	kind: "fetch" | "xhr" | "ws";
	method: string;
	url: string;
	status: number;
	ms: number;
	ok: boolean;
	ts: number;
}

// ── Observability (trace + log) telemetry ───────────────────────────────────
// Wire shapes MIRROR `@forgeax/types`'s observability schema (SpanData /
// LogRecord / TelemetryRecord). interface has no dep on @forgeax/types, so the
// line shape is re-declared locally as plain TS (Schema-as-Contract lives in
// packages/types; this is the consumer-side view). Both信道 feed the SAME slice:
//   - node→server→WS  `{ type:'telemetry',     records }`  (bootBroadcast, R5/P1)
//   - iframe→shell     `{ type:'VAG_TELEMETRY', records }`  (healthBridge)
// 见 .claude/docs/架构设计/forgeax-os/可观测性-trace-log-v3-B档-并行执行计划-2026-06-24.md §B。
export interface TelemetrySpan {
	kind: "span";
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTs: number;
	/** 缺失 = provisional(onStart 临时态),渲染成「进行中」。 */
	endTs?: number;
	provisional?: boolean;
	attrs?: Record<string, unknown>;
	events?: Array<{ name: string; ts: number; attrs?: Record<string, unknown> }>;
	status?: { code: "ok" | "error"; message?: string };
	sid?: string;
	agentId?: string;
}

export interface TelemetryLog {
	kind: "log";
	ts: number;
	level: "debug" | "info" | "warn" | "error";
	msg: string;
	fields?: Record<string, unknown>;
	traceId?: string;
	spanId?: string;
	sid?: string;
	agentId?: string;
}

export type TelemetryRecord = TelemetrySpan | TelemetryLog;

export interface SubAgentRun {
	emitterId: string;
	text: string;
	thinking?: string;
	toolCalls: ToolCall[];
	status: "streaming" | "done" | "error";
	startedAt: number;
	/** Which CliProvider streamed this run (forgeax, claude-code, ...).
	 *  Surfaced as a badge on <SubAgentCard>. Per docs/CLI-PROVIDERS-DESIGN.md. */
	providerId?: string;
}

/**
 * Time-ordered segment of an assistant message — text / thinking / tool —
 * rendered in arrival order so reasoning, tool calls and prose interleave
 * the way they actually streamed.
 *
 *   ts             arrival timestamp (ms epoch); sort key for the render
 *   kind=text      append-only markdown chunk
 *   kind=thinking  append-only reasoning/thinking chunk
 *   kind=tool      tool call (lifecycle: running → done/error); same id is
 *                  reused as args/result deltas land
 *
 * Adjacent same-kind segments (text/thinking) are coalesced into one chunk
 * by `appendChatSegment`, so the array stays short even on multi-thousand
 * token streams.  Tool segments never coalesce — each call gets its own.
 */
export type ChatSegment =
	| { kind: "text"; ts: number; text: string }
	/**
	 * Thinking is not user-visible by default.  A provider/host must explicitly
	 * mark a segment as `public_summary` before the Chat app may project it into
	 * the process trace.  Missing/unknown visibility is intentionally fail-closed.
	 */
	| {
			kind: "thinking";
			ts: number;
			text: string;
			visibility?: "public_summary" | "private_reasoning";
	  }
	| { kind: "tool"; ts: number; tool: ToolCall };

/** System message visual categories — matches ink-renderer's SystemLine.
 *  Used when role === 'system' to drive icon/color in ChatPanel.
 *
 *  - direction: 来信(incoming, 📨) / 出信(outgoing, 📤) — inter-agent traffic
 *  - level:     info / warning(⚠) / error(✖)
 *  - source:    short tag e.g. "agent:foo(inbound_message)", rendered before ':'
 *  - from / to: agent ids (purely informational; UI may show as subtitle) */
export type SystemLevel = "info" | "warning" | "error";
export type SystemDirection = "incoming" | "outgoing";

/** One client-side queued message awaiting its turn (Cursor-style queue). */
export interface QueuedMessage {
	id: string;
	text: string;
	ts: number;
}

/** Options for sendMessage. `handoff: 'steer'` performs an interrupt-send:
 *  the message is delivered immediately with EventQueue handoff 'steer', which
 *  aborts the running turn and processes the new message next — instead of
 *  queueing it behind the current turn. */
export interface SendMessageOpts {
	handoff?: "steer";
	/** 多模态附件(图片)。每项 `{ kind:'image', mediaType, data(base64 或 dataUrl) }`。
	 *  透传进 /api/sessions/:sid/messages 的 payload → 内核 facade 组 image block(forgeax-core)。 */
	attachments?: Array<Record<string, unknown>>;
}

/** User-message multimodal attachment kept for transcript display + wire send. */
export interface ChatAttachment {
	kind: "image" | "document" | "file" | string;
	name?: string;
	mediaType?: string;
	/** Base64 payload (no data: URL prefix) or a data: URL — live send only. */
	data?: string;
	/** Durable upload path after server materialize — used on history reload. */
	path?: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	/** checkpoint 回退点外键(role='user' 才有;server /messages 注入并回传)。
	 *  有它且 server 侧存在对应 checkpoint 记录时,气泡 hover 出「回到这里」。 */
	msgId?: string;
	/** Stable host turn identity. Legacy WAL rows may omit it. */
	turnId?: string;
	text: string;
	/** role='user' — pasted / picked attachments shown in the bubble (images inline). */
	attachments?: ChatAttachment[];
	thinking?: string;
	toolCalls: ToolCall[];
	/** role='system' visual classification — drives icon / color in ChatPanel. */
	level?: SystemLevel;
	direction?: SystemDirection;
	/** role='system' — short source tag (e.g. `admin(message)`) printed inline. */
	source?: string;
	/** role='system' — emitter agent id, for inter-agent traffic. */
	from?: string;
	/** role='system' — recipient agent id, for inter-agent traffic. */
	to?: string;
	/** Time-ordered render units — text / thinking / tool interleaved.  When
	 *  populated ForgeCard renders from this instead of the legacy
	 *  text+thinking+toolCalls three-field layout, fixing the bug where tools
	 *  visually "jump" because their position is anchored to a snapshot of
	 *  text length rather than to their own timestamp.  Built by both the
	 *  live SSE pipeline and the replay path. */
	segments?: ChatSegment[];
	/** Sub-agent runs that spawned during this turn — keyed by emitterId. */
	subAgents?: Record<string, SubAgentRun>;
	status: "streaming" | "done" | "error";
	ts: number;
	errorMessage?: string;
	/** Which CliProvider streamed the main message (forgeax / claude-code / ...).
	 *  Captured from payload.providerId on the first main-emitter event. */
	providerId?: string;
	/** Final cost (USD) of this turn — populated from SSE 'done' if provider
	 *  surfaced it (currently only claude-code's result.total_cost_usd). */
	cost?: number;
	/** Wall-clock duration (ms) of this turn — populated from SSE 'done' when
	 *  provider includes duration_ms. Falls back to local elapsed otherwise. */
	durationMs?: number;
	/** Distinguishes a user stop/cancel from a provider/tool error for process UI. */
	turnAborted?: boolean;
	/** Host-owned artifact resolved after the turn's final settle. */
	artifact?: import("@forgeax/types/artifact-summary").ArtifactSummary;
	/** Persisted artifact resolution anchor used to keep late recovery ordered. */
	artifactAnchorSeq?: number;
}

/**
 * One chat thread tab.
 *
 * 2026-05-20 重做（彻底版）：
 *  - 此前 tab 是独立前端实体（id 是前端 newId、threadId/sessionId 可为 null、
 *    localStorage 持久化整张 tabs 数组），跟后端 sessions 形成「双重账本」——
 *    session 删了 tab 还在、boot 创了 session 但 tab.threadId 还是 null、
 *    `?? 'forgeax'` fallback 等一切恶心问题的根源。
 *  - 新模型：**每个 tab 就是一个 server session 的视图**。`sid` 是非空主键、
 *    DOM key、`_abortByTab` key、WS routing key —— 单一标识。
 *    - `id / threadId / sessionId / title` 字段全部下线。
 *    - boot 时不再造任何"无 sid scratch tab"。tabs 完全等于 GET /api/sessions
 *      的派生 view；空 → store action `initSessions` 通过幂等 ensure 自动建一条；
 *      CRUD 全部走后端 REST（POST /api/sessions/ensure、POST/DELETE /api/sessions）。
 *    - localStorage 只缓存 `forgeax.activeSid`，不再持久化 tabs 数组本身。
 *      老 key (`forgeax.tabs`/`forgeax.activeTabId`) 启动一次性 cleanup。
 */
export interface ChatTab {
	/** Server session id —— 唯一主键。tab 与 session 一一对应。 */
	sid: string;
	/** Server 端 session.json::displayName。可能 undefined（boot-time auto-create
	 *  / 用户没传名）—— UI 渲染规则：`tabLabel(tab)`（无名时走 i18n「新对话 / New Session」）。
	 *  改名等 server 端 PATCH 接口落地后接，先只读。 */
	displayName: string | undefined;
	/** Which agent this tab is bound to. First-class key for chat state:
	 *  every WAL replay, every live-SSE routing decision, the AgentSwitcher
	 *  highlight, the Composer hint — all derive from this. null means
	 *  "fresh tab, no agent chosen yet"; the AgentSwitcher fills it in once
	 *  list_agents resolves (defaulting to the root agent). */
	agentId: string | null;
	providerOverride: string | null;
	/** Transient handoff to Composer: a freshly scaffolded agent still needs its
	 * provider-scoped remembered/default model applied. Never persisted or
	 * reconstructed from GET /api/sessions. */
	initialModelSeedAgentId?: string;
	/** Epoch ms of the session's last on-disk activity (server-side: newest
	 *  mtime under `<session>/agents/`). Mirrored from GET /api/sessions on
	 *  initSessions / refreshSessions. Drives SessionSwitcher dropdown's
	 *  recency sort + "X 分钟前" meta. Undefined for tabs that came back
	 *  without the field (older server / pre-write race). */
	lastActivityAt?: number;
}

export interface SessionOperationError {
	code:
		| "SESSION_DELETE_FAILED"
		| "SESSION_REPLACEMENT_FAILED"
		| "SESSION_LIST_FAILED";
	message: string;
}

export type CloseSessionResult =
	| { status: "deleted"; activeSid: string | null }
	| {
			status: "deleted-without-active-session";
			activeSid: null;
			error: SessionOperationError;
	  }
	| {
			status: "not-deleted";
			activeSid: string | null;
			error: SessionOperationError;
	  };

export type RefreshSessionsResult =
	| { status: "ok"; count: number }
	| { status: "failed"; error: SessionOperationError }
	| { status: "superseded" };

export type ApplyActiveGameResult =
	| { status: "applied"; sessionCount: number | null }
	| { status: "degraded"; sessionCount: number | null; warning: string }
	| { status: "superseded" };

export interface SetActiveGameResult {
	superseded?: boolean;
	warning?: string;
}

export interface AppState {
	// ── Windowing (detached OS windows) ──
	// App Shell owns floating state and redock convergence; these product actions
	// retain the existing store-facing command seam for callers.
	detachSurface: (
		d: import("@forgeax/app-shell/window").SurfaceDescriptor,
		opts?: {
			title?: string;
			x?: number;
			y?: number;
			width?: number;
			height?: number;
		},
	) => Promise<boolean>;
	redockSurface: (
		d: import("@forgeax/app-shell/window").SurfaceDescriptor,
	) => Promise<void>;
	// R5/P2 — 跨-surface 深链槽（原 ~7 个 pending*）已全部移出 store，改走 interface bus
	// （lib/deep-link-bus.ts：emitDeepLink / useDeepLink，retain 快照语义）。producer
	// `emitDeepLink('bus:expand-plugin'|'bus:filter-kind'|'sidebar:focus-plugin'|
	// 'sidebar:flash-kind'|'chat:flash-bus-chip', ...)`；consumer `useDeepLink(topic)`。
	// 彻底死掉的 pendingRunsDateFilter（无 producer/consumer）直接删除。
	// Composer 的 "右键 → 在对话中引用" 桥在 lib/composer-bridge.ts；chat 消息流在 chat app。

	activeSession: string;
	setActiveSession: (s: string) => void;

	/** Pin an agent to a tab (key = sid). The single mutator for tab↔agent
	 *  binding; every history-replay / live-routing / UI-highlight derives from
	 *  `tabs.find(t => t.sid === activeSid)?.agentId`.
	 *
	 *  Side effect: also writes into `agentBySid[sid]` so the next time anyone
	 *  navigates to that sid (tab switch / session pick / boot restore) we
	 *  restore this exact agent, parity with ref ink-renderer
	 *  `dataSource.writeCachedAgent(instanceId, agent)`. */
	setTabAgent: (sid: string, agentId: string | null) => void;

	/** Per-sid agentPath cache, mirror of ref's `agentByInstance` (renderer-cache-store).
	 *  Restored on boot from localStorage so switching back to a session
	 *  re-selects the agent the user last chose for that session, instead of
	 *  defaulting to root (or worse — leaking the previous session's pick). */
	agentBySid: Record<string, string>;
	/** Read cache w/ guarded null fallback. */
	getCachedAgentForSid: (sid: string | null) => string | null;

	// File preview state belongs to @forgeax/files. The shell only publishes
	// resource-editor bus intents and reads its retained projection.

	// ── Active game projection. The server binding is authoritative. ──
	activeGameSlug: string | null;
	activeGameRuntime: RuntimeScopeState;
	activeGameResolved: boolean;
	initActiveGame: () => Promise<void>;
	applyActiveGame: (
		selection: ActiveProjectSelection,
	) => Promise<ApplyActiveGameResult>;

	// ── Current chat session id (bug #2 fix). null = let server auto-generate
	//    a fresh `sess-<timestamp>` for the next message. Set when we receive
	//    agent-start (echoed by server) or via the SessionSwitcher / NewMenu.
	currentSessionId: string | null;
	setCurrentSessionId: (id: string | null) => void;

	/** Per-(sid, agentId) streaming/busy flag, mirrored from the chat app so the interface foundation
	 *  registry surfaces (SessionSwitcher / AgentsPanel) can render a spinner
	 *  without importing chat message state. Owned by chat via setAgentBusy. */
	busyByAgentBySid: Record<string, Record<string, boolean>>;
	setAgentBusy: (sid: string, agentId: string, busy: boolean) => void;

	// ── Console buffer from engine iframe (VAG_CONSOLE postMessage) ──
	consoleLog: ConsoleEntry[];
	pushConsole: (entry: ConsoleEntry) => void;
	clearConsole: () => void;

	// ── Network buffer from engine iframe (VAG_NETWORK postMessage) ──
	networkLog: NetworkEntry[];
	pushNetwork: (entry: NetworkEntry) => void;
	clearNetwork: () => void;

	// ── Telemetry buffer (trace spans + structured logs) ──
	//  Fed by two信道 into ONE slice: node telemetry over WS
	//  (`{type:'telemetry'}`, bootBroadcast R5/P1) and iframe telemetry over
	//  postMessage (`{type:'VAG_TELEMETRY'}`, healthBridge). Span + log records
	//  live together (split by `kind` in the viewer). Capped at 500 (S4).
	telemetry: TelemetryRecord[];
	pushTelemetry: (records: TelemetryRecord[]) => void;
	clearTelemetry: () => void;

	// ── Persistent cli provider override (composer cli-selector) ──
	/** When set, every chat turn is routed via this CliProvider id regardless of
	 *  the agent's manifest-declared provider. Stays until user explicitly
	 *  switches back to 'forgeax' (null) via the dropdown —— null 即 R3 之后的
	 *  默认原生路径（POST /api/sessions/:sid/messages 直发 EventBus）。 */
	providerOverride: string | null;
	setProviderOverride: (id: string | null) => void;

	// ── Agent chat reply language (global, persisted; decoupled from UI locale) ──
	/** Language the agent is asked to reply in. Global across sessions, persisted.
	 *  Default 'en'. When `followInput` is on, the detected language of each user
	 *  message takes precedence (resolved per-turn in the chat send path). */
	replyLanguage: "en" | "zh";
	/** Highest-priority rule: reply language follows the detected language of the
	 *  user's input. Global, persisted, default true. */
	followInput: boolean;
	/** Pure setter for the reply language (keeps followInput as-is). */
	setReplyLanguage: (lang: "en" | "zh") => void;
	setFollowInput: (on: boolean) => void;
	/** Explicit language pick from the quick switcher / three-dot menu: pins the
	 *  reply language AND turns followInput OFF (the user's manual choice wins). */
	pinReplyLanguage: (lang: "en" | "zh") => void;

	// ── Agent install prefs（① 已抽到 @forgeax/settings/agent-prefs，走 bus 'prefs:agents'）──
	// defaultBootstrapAgent / uninstalledAgentIds 不再进 interface store —— 见 settings/agent-prefs.ts。

	// ── Live agent state (driven by WS events + list_agents poll) ──
	liveAgents: Record<string, LiveAgent[]>;
	agentFileActivity: Record<string, Record<string, AgentFileTouch[]>>;
	setLiveAgents: (sid: string, agents: LiveAgent[]) => void;
	pushFileTouch: (
		sid: string,
		agentPath: string,
		touch: AgentFileTouch,
	) => void;
	updateFileTouchStatus: (
		sid: string,
		agentPath: string,
		callId: string,
		status: "done" | "error",
	) => void;

	// ── Sessions（= tabs，2026-05-20 重做后是同一个东西）──
	/** All open sessions, rendered as chat tabs. Strictly derived from server
	 *  `GET /api/sessions`. boot 调用 initSessions 拉 list / 必要时建一条；之后
	 *  的 CRUD（新建 / 删除 / 切换 / pin agent）都通过 store actions，store 是
	 *  唯一真值源 —— 没有"无 sid 的 scratch tab"，没有"session 没了 tab 还在"。 */
	tabs: ChatTab[];
	/** 当前活跃的 sid。tabs 至少有一个时，必落在 tabs.map(t=>t.sid) 里。
	 *  null 仅在 boot 中间态 / server 端 sessions 真为空 + auto-create 失败时出现。 */
	activeSid: string | null;
	/** boot-time 初始化：先同步 active-game projection，再按 scope 拉 GET /api/sessions；
	 *  列表为空就 POST /api/sessions/ensure { scope, autoStart: true } 幂等建一条。
	 *  完成后调 connectForgeaXWs 把 WS 连上 active sid。可重入 —— 多次调只跑一次
	 *  （_initSessionsPending 内部 dedupe，server ensure 负责跨页面 dedupe）。 */
	initSessions: () => Promise<void>;
	/** 新建 session = POST /api/sessions → push 进 tabs → 切过去。`displayName` 不
	 *  传时让 server 端落 undefined（UI 走 tabLabel 占位规则）。失败返回 null。 */
	createNewSession: (opts?: {
		displayName?: string;
		scope?: string;
		providerOverride?: string | null;
	}) => Promise<{ sid: string } | null>;
	/** 切到指定 sid。tab 必须已存在（不存在就先 refreshSessions 拉一下）。
	 *  内部触发：mirror 切换 / WS 重连 / persist activeSid / agentBySid 缓存恢复。 */
	switchToSession: (sid: string) => Promise<void>;
	/** 关闭并删除 session。DELETE 成功后才 remove 本地 tab；空了会尝试补建。
	 *  返回结构区分“未删除”“删除完成”“删除完成但补建失败”，避免把部分成功
	 *  压成布尔后诱导调用方重删。 */
	closeSession: (sid: string) => Promise<CloseSessionResult>;
	/** 重新拉一遍 server sessions 列表，merge 进 tabs（保留本地 messages / 各 tab
	 *  in-flight 状态）。手动刷新 / 切换后兜底用。 */
	refreshSessions: (options?: {
		scope?: string;
		transitionRevision?: number;
	}) => Promise<RefreshSessionsResult>;
	/** 唯一 active-game 写入口。Server 更新权威绑定，所有页面从变更通知重建投影。 */
	setActiveGame: (slug: string) => Promise<SetActiveGameResult>;
	renameTab: (sid: string, displayName: string) => void;
	/** Product-assembly sub-agent switcher (P6d step d). For tabs with a server-side thread,
	 *  PATCH /api/threads/:id { activeEmitterId } so the next /api/chat turn
	 *  in this tab gets routed to the picked emitter. Side-effect-only — no
	 *  immediate UI change beyond a status indication. */
	setActiveEmitter: (emitterId: string) => Promise<void>;

	// ── Overlay（通用壳级 overlay 槽 · R5/P5 去名化）──
	//  interface 壳只有一个通用 overlay 槽，不 hardcode app 名：
	//   - `activeOverlay` = 当前打开的 overlay id（调用方传 'settings' / 'dashboard' / …；
	//      store 不认识这些具体值，只当字符串存）。null = 无 overlay。
	//   - `overlayParam` = 该 overlay 的可选参数（如 settings 的 section nav id）。
	//  取代原按 app 命名的 `dashboardOpen` / `settingsOpen` / `settingsSection`。
	//  section 的持久化（关掉再开回到上次 tab）保留在壳级 pref 里。
	activeOverlay: string | null;
	overlayParam: string | null;
	/** 打开一个 overlay（可带参数；param 省略时沿用上次，主要给 settings section 用）。 */
	openOverlay: (id: string, param?: string) => void;
	/** 改当前 overlay 的参数（如 settings 面板里切换 nav section）。 */
	setOverlayParam: (param: string | null) => void;
	closeOverlay: () => void;

	// ── Open-game-directory modal ──
	// File → 打开游戏目录 binds one game directory as the active game.
	gameDirectoryModalOpen: boolean;
	openGameDirectoryModal: () => void;
	closeGameDirectoryModal: () => void;

	// ── Game switcher / new-game modal (driven from the File menu) ──
	//  `openGameModal` → the new-game dialog; `gameSwitcherOpen` → the "open game"
	//  list modal (its body is the game list). Game flows remain separate from
	//  the game-directory modal above and are rendered by GameModalHost.
	gameSwitcherOpen: boolean;
	setGameSwitcherOpen: (v: boolean) => void;
	gameModalOpen: boolean;
	openGameModal: () => void;
	closeGameModal: () => void;

	// ── Fullscreen ("immersive" mode) ──
	//
	// Hides TopBar / Sidebar / ChatPanel / StatusBar so MainArea fills the
	// viewport. Toggled via Ctrl+Shift+F (see lib/global-shortcuts.ts) or
	// the Settings → Shortcuts section. Esc also exits.
	fullscreen: boolean;
	setFullscreen: (v: boolean) => void;
	toggleFullscreen: () => void;

	// ── Sidebar / ChatPanel collapse (kept separate from width drag) ──
	//
	// Toggled via Ctrl+Shift+B / Ctrl+Shift+C. The actual width is owned by
	// useLocalSize hooks in App.tsx — these flags layer on top and hide the
	// pane via CSS without losing the drag-restored width.
	sidebarCollapsed: boolean;
	chatpanelCollapsed: boolean;
	toggleSidebar: () => void;
	toggleChatpanel: () => void;
}
