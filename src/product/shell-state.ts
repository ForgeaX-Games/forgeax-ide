import { alertDialog, peekTopic as peek } from "@forgeax/app-shell/application";
import { installStorageObservation } from "@forgeax/app-shell/react";
import { create } from "zustand";
import { coalesceActiveProjectSelection } from "./coalesce-active-game-runtime";
import { t } from "./product-locale";
import type { IdeShellStoreContext } from "./shell-state-context";

const STORAGE_KEYS = {
	replyLanguage: "forgeax.replyLanguage",
	followInput: "forgeax.followInput",
};

import type {
	ApplyActiveGameResult,
	AppState,
	ChatTab,
	SetActiveGameResult,
} from "./shell-state-contract";
import type {
	ActiveProjectSelection,
	StudioProjectClient,
} from "./shell-state-domain-contract";
import { createObservabilityState } from "./shell-state-observability";
import {
	cleanupLegacySessionKeys,
	loadActiveSid,
	loadAgentBySid,
	loadProviderOverride,
	persistActiveSid,
	persistAgentBySid,
	saveProviderOverride,
} from "./shell-state-persistence";
import { mostRecentSid, pickActiveSid } from "./shell-state-session-pick";
import { createShellState } from "./shell-state-shell";

/** IDE product state owner. Compatibility consumers bind to this same instance. */
export function createIdeShellStore(context: IdeShellStoreContext) {
	const {
		resolveKernelForAgent,
		setCurrentProject,
		getStudioProjectClient,
		hasStudioDomainClients,
		getSessionClient,
	} = context;
	// Chat message/event-engine logic lives in @forgeax/chat. The interface foundation keeps only the
	// session registry and injected session-client contract used by shell chrome.

	// turnsToChatMessages removed — replay no longer goes through batch
	// onTurn/CompletedTurn flatten. Both live and replay now feed events into
	// TurnAccumulator in arrival order; the callbacks (buildMain/SubCallbacks)
	// mutate the ChatMessage model through MessageEffects (live: store; replay:
	// in-memory). This is the only way `tc.at` placement matches live, because
	// onMessage(tool_call) sees the same m.text.length snapshot in both paths.

	// Cross-tab sync: when a sibling tab writes to PROVIDER_OVERRIDE_KEY, push
	// the new value into our zustand state so the cli-selector button rerenders
	// without a manual reload. Without this, two open tabs drift — tab A shows
	// 'auto' even though localStorage already says 'claude-code' (tick 224 hunt).
	// The 'storage' event only fires for sibling tabs, not the writer tab; that
	// path uses setProviderOverride directly.
	if (typeof window !== "undefined") {
		const onProviderOverrideStorage = (e: StorageEvent): void => {
			if (e.key !== "forgeax.providerOverride") return;
			const next = e.newValue && e.newValue !== "null" ? e.newValue : null;
			if (useShellStore.getState().providerOverride !== next) {
				useShellStore.setState((state) => ({
					providerOverride: next,
					tabs: state.tabs.map((tab) =>
						tab.sid === state.activeSid
							? { ...tab, providerOverride: next }
							: tab,
					),
				}));
			}
		};
		void installStorageObservation({
			target: window,
			onStorage: onProviderOverrideStorage,
		});
	}

	// ── Agent chat reply language (global + persisted, cross-tab synced) ──────────
	function loadReplyLanguage(): "en" | "zh" {
		try {
			return localStorage.getItem(STORAGE_KEYS.replyLanguage) === "zh"
				? "zh"
				: "en";
		} catch {
			return "en";
		}
	}
	function saveReplyLanguage(lang: "en" | "zh"): void {
		try {
			localStorage.setItem(STORAGE_KEYS.replyLanguage, lang);
		} catch {
			/* ignore */
		}
	}
	function loadFollowInput(): boolean {
		try {
			// Default ON: only an explicit '0' disables it.
			return localStorage.getItem(STORAGE_KEYS.followInput) !== "0";
		} catch {
			return true;
		}
	}
	function saveFollowInput(on: boolean): void {
		try {
			localStorage.setItem(STORAGE_KEYS.followInput, on ? "1" : "0");
		} catch {
			/* ignore */
		}
	}
	if (typeof window !== "undefined") {
		const onReplyPreferenceStorage = (e: StorageEvent): void => {
			if (e.key === STORAGE_KEYS.replyLanguage) {
				const next = e.newValue === "zh" ? "zh" : "en";
				if (useShellStore.getState().replyLanguage !== next)
					useShellStore.setState({ replyLanguage: next });
			} else if (e.key === STORAGE_KEYS.followInput) {
				const next = e.newValue !== "0";
				if (useShellStore.getState().followInput !== next)
					useShellStore.setState({ followInput: next });
			}
		};
		void installStorageObservation({
			target: window,
			onStorage: onReplyPreferenceStorage,
		});
	}

	// agent 安装偏好（DEFAULT_INSTALLED_AGENT_IDS / uninstalled / bootstrap / seed）已
	// 整体抽到 @forgeax/settings/agent-prefs（① · 走 bus 'prefs:agents'）—— interface 不再持有。

	// R5/P1 — the broadcast `/ws` daemon socket moved OUT of the store's module-load
	// side-effect into the shared `lib/broadcast-stream` primitive, wired at boot by
	// `boot/broadcast.ts` (`bootBroadcast()`). Importing the store no longer opens a
	// socket. telemetry handling lives in bootBroadcast; daemon-tick
	// is chat's (subscribeDaemonTick). See docs 17b §7.2.

	// ── Sessions persistence ───────────────────────────────────────────────────
	// 2026-05-20 重做：不再持久化 tabs 数组本身（tabs = GET /api/sessions 派生）。
	// 只持久化 activeSid（用户上次看的是哪条），boot 时再 init。同时一次性清掉
	// 老 key (forgeax.tabs / forgeax.activeTabId) 防止旧数据残留。
	cleanupLegacySessionKeys();

	/** Persisted per-sid agent cache —— ref ink-renderer `agentByInstance` 移植。
	 *  对外只暴露 read / write 两个动作；boot 时一次性 load 当 init state，runtime
	 *  写盘交给 `setTabAgent` 的副作用。 */
	/** Patch a session tab's registry field (key = sid). Mirrors providerOverride
	 *  to the top-level default when the patched tab is active. Chat message state
	 *  no longer lives on the tab — it's owned by the chat app's session store. */
	function patchTabField(
		state: AppState,
		sid: string,
		patch: Partial<Pick<ChatTab, "providerOverride" | "displayName">>,
	): Partial<AppState> {
		const tabs = state.tabs.map((t) =>
			t.sid === sid ? { ...t, ...patch } : t,
		);
		const out: Partial<AppState> = { tabs };
		if (state.activeSid === sid && patch.providerOverride !== undefined) {
			out.providerOverride = patch.providerOverride;
		}
		return out;
	}

	/** initSessions in-flight dedupe —— React StrictMode 双 mount / HMR 重载时 effect
	 *  会跑两次，避免对 server 发两次重复 POST。promise 完成后清回 null，下次有需要
	 *  可重新初始化（手动 reset 等）。 */
	let _initSessionsPending: Promise<void> | null = null;
	let _sessionsInitialized = false;
	let _activeGameUnsubscribe: (() => void) | null = null;
	let _activeGameTransition: {
		key: string;
		promise: Promise<ApplyActiveGameResult>;
	} | null = null;
	let _activeGameTransitionRevision = 0;
	let _activeGameRequestRevision = 0;
	let _sessionSwitchRevision = 0;
	const _activeGameGenerationByScope = new Map<string, number>();
	const _busyMutationVersionBySid = new Map<string, number>();
	const _runningSyncGenerationBySid = new Map<string, number>();
	let _activeGameBindingPollId = 0;
	let _activeGameBindingPollTimer: ReturnType<typeof setInterval> | undefined;

	function clearActiveGameBindingPoll(): void {
		_activeGameBindingPollId += 1;
		if (_activeGameBindingPollTimer !== undefined) {
			clearInterval(_activeGameBindingPollTimer);
			_activeGameBindingPollTimer = undefined;
		}
	}

	function stopActiveGameBindingPoll(_reason: string): void {
		clearActiveGameBindingPoll();
	}

	function scheduleActiveGameBindingPoll(
		client: StudioProjectClient,
		getState: () => AppState,
	): void {
		clearActiveGameBindingPoll();
		const pollId = _activeGameBindingPollId;
		const startedAt = Date.now();
		const timeoutMs = 120_000;
		const intervalMs = 2_000;
		_activeGameBindingPollTimer = setInterval(() => {
			if (pollId !== _activeGameBindingPollId) return;
			const runtime = getState().activeGameRuntime;
			if (runtime.binding !== undefined) {
				stopActiveGameBindingPoll("binding-present");
				return;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				stopActiveGameBindingPoll("timeout");
				return;
			}
			void client
				.getActiveProject()
				.then((selection) => {
					if (pollId !== _activeGameBindingPollId) return;
					void getState().applyActiveGame(
						coalesceActiveProjectSelection(
							selection,
							getState().activeGameRuntime,
						),
					);
				})
				.catch(() => {
					/* poll is best-effort; next tick retries */
				});
		}, intervalMs);
	}

	function needsActiveGameBindingPoll(
		selection: ActiveProjectSelection,
	): boolean {
		return (
			selection.activeSlug !== null &&
			selection.runtime?.binding === undefined &&
			(selection.runtime?.status === "transitioning" ||
				selection.runtime?.status === "unbound")
		);
	}

	/**
	 * Invalidate every async switch that began before another activation decision.
	 * Returning the new revision lets switchToSession use the same gate for
	 * switch→switch ordering without maintaining a second source of truth.
	 */
	function invalidatePendingSessionSwitches(): number {
		return ++_sessionSwitchRevision;
	}

	function bumpBusyMutationVersion(sid: string): void {
		_busyMutationVersionBySid.set(
			sid,
			(_busyMutationVersionBySid.get(sid) ?? 0) + 1,
		);
	}

	/** Pull active agent's running 真值并同步到 tab.isStreaming —— 解决"前端 ws 连上
	 *  时后端 agent 早就在跑（错过 turnStart）→ UI 仍以为 idle"这种臆想态。
	 *
	 *  调用时机：boot / refresh / 切 active session / 新建 session / 关闭兜底新建 ——
	 *  即每次 `connectForgeaXWs(sid)` 的紧后面。增量靠 hook:turnStart/turnEnd 事件，
	 *  这里只补"WS 连上一刻的快照"。
	 *
	 *  失败 / sid null 静默 —— 网络/server 抖动时 UI 维持上一份状态，下次切换再拉。 */
	async function _syncActiveAgentRunning(sid: string | null): Promise<void> {
		if (!sid) return;
		const generation = (_runningSyncGenerationBySid.get(sid) ?? 0) + 1;
		_runningSyncGenerationBySid.set(sid, generation);
		const busyVersionAtStart = _busyMutationVersionBySid.get(sid) ?? 0;
		try {
			const { listSessionAgents } = getSessionClient();
			const agents = await listSessionAgents(sid);
			const commitBusySnapshot = (): void => {
				// A WS turnStart/turnEnd received while this REST request was in flight is
				// newer truth. Likewise, only the newest overlapping REST sync may commit.
				if (
					_runningSyncGenerationBySid.get(sid) !== generation ||
					(_busyMutationVersionBySid.get(sid) ?? 0) !== busyVersionAtStart
				)
					return;
				const nextBusy = Object.fromEntries(
					agents.filter((a) => a.running).map((a) => [a.path, true]),
				);
				useShellStore.setState((s) => ({
					busyByAgentBySid: {
						...s.busyByAgentBySid,
						[sid]: nextBusy,
					},
				}));
				bumpBusyMutationVersion(sid);
			};
			if (agents.length === 0) {
				commitBusySnapshot();
				return;
			}
			// tab.agentId 还没绑（cached === null）→ 用 depth=1 root 兜底。
			//
			// 已绑但 cached id 不在 list_agents 里（典型场景：用户刚点了 mochi/iro
			// 这种 marketplace persona，server 端还没收到首条消息触发自动 scaffold，
			// session.tree 暂时见不到该 agent）—— **保留** 用户的 pin，不要 kick 回 root。
			// 这条规则与 AgentSwitcher 的 auto-pin 逻辑（line 202-208）保持一致：pin
			// 是 user intent，list_agents 没观察到 ≠ 该 pin 无效。早先这里强制重指 root
			// 正是用户报的「点击 mochi 头像但 forge/root 接管对话」bug 的源头之一。
			const root = agents.find((a) => a.depth === 1)?.path ?? agents[0]!.path;
			const tab = useShellStore.getState().tabs.find((t) => t.sid === sid);
			const cached = tab?.agentId ?? null;
			const wantPath = cached ? cached : root;
			// Marketplace pin not yet observed in tree (cached but not in agents):
			// wantPath === cached even when the agent is absent. We still keep
			// the pin and show running:false until the auto-scaffold lands. No
			// tab.messagesByAgent rewiring needed since the pin is unchanged.
			useShellStore.setState((s) => {
				// Only update agentBySid when we're filling a previously-empty slot.
				// Keeping a marketplace pin: cached !== null already => leave as-is.
				const agentBySid = cached
					? s.agentBySid
					: { ...s.agentBySid, [sid]: wantPath };
				const tabs = s.tabs.map((t) =>
					t.sid === sid ? { ...t, agentId: wantPath } : t,
				);
				return { tabs, agentBySid };
			});
			if (!cached) persistAgentBySid(useShellStore.getState().agentBySid);
			// 把 blackboard.RUNNING 同步到 interface busy —— Composer 的 useActiveStreaming 会 OR 这份
			// 标志。缺 turnStart/snapshot 时(刷新中途加入)仍显示 Stop 而非可发送。
			commitBusySnapshot();
		} catch (e) {
			console.warn("[syncActiveAgentRunning] failed", (e as Error).message);
		}
	}

	// Initial top-level mirror at module load. boot 时 tabs 是空的、activeSid 来自
	// localStorage 但还没验证（initSessions 跑完才知道这个 sid 还在不在）。React
	// 启动后第一次 effect 调 initSessions() 拉 server / 必要时 createSession，
	// 然后 set tabs + activeSid，UI 才真亮起来（ChatPanel 在 tabs 为空时渲染空态/
	// loading）。
	const _initialActiveSid = loadActiveSid();
	const _initialMirror = {
		tabs: [] as ChatTab[],
		activeSid: _initialActiveSid,
		currentSessionId: _initialActiveSid,
		providerOverride: loadProviderOverride(),
	};

	// R5/P1 — daemon-tick/telemetry WS handling moved off the store module-load
	// side-effect. telemetry is wired via `boot/broadcast.ts`; daemon-tick is chat's.

	const useShellStore = create<AppState>((set, get) => ({
		...createShellState(set, get, context.getSurfaceWindowingController),
		// R5/P2 — deep-link slots moved to the interface bus (lib/deep-link-bus.ts); removed from store.
		setTabAgent: (sid, agentId) => {
			set((s) => {
				const tabs = s.tabs.map((t) => (t.sid === sid ? { ...t, agentId } : t));
				// sid 总是有效（=tab 主键），直接写 agentBySid 缓存。agentId=null 时显式
				// delete 这个 key，保持 map 紧凑（避免 stale 残留）。
				const agentBySid = { ...s.agentBySid };
				if (agentId) agentBySid[sid] = agentId;
				else delete agentBySid[sid];
				persistAgentBySid(agentBySid);
				return { tabs, agentBySid };
			});
			if (agentId) {
				void resolveKernelForAgent(agentId).then((kernelId) => {
					// 只有解析出具体 CLI 内核 id 的显式 CLI persona(cc-coder /
					// claude-code-default / codex-default 等)才反写全局 provider ——
					// 这是"CLI as subagent persona"要的行为。kernelId === null 意味着
					// `forgeax-native` 或无偏好,而 forgeax-native 是几乎所有普通 agent
					// (forge / iori / suzu…)manifest 里的脚手架默认值,不是用户意图:
					// 把它当权威偏好会在 AgentSwitcher 自动 pin root、或点普通 agent
					// 页签时,把用户在 Settings › Providers 手选的内核静默冲回 native
					// 并写盘(体感即"内核设置没有持久化")。全局 provider 的 SSOT 是
					// 用户的 Settings 选择,native 缺省不覆盖它。
					if (!kernelId) return;
					useShellStore.setState((s) => {
						const tab = s.tabs.find((t) => t.sid === sid);
						if (!tab || tab.agentId !== agentId) return {};
						const patch = patchTabField(s, sid, { providerOverride: kernelId });
						if (s.activeSid === sid) {
							saveProviderOverride(kernelId);
							return { ...patch, providerOverride: kernelId };
						}
						return patch;
					});
				});
			}
		},

		agentBySid: loadAgentBySid(),
		getCachedAgentForSid: (sid) => {
			if (!sid) return null;
			return get().agentBySid[sid] ?? null;
		},
		// providerOverride 是全局单一设置（Settings › Providers）：写盘当默认 + mirror 到
		// active tab 仅作记录。switchToSession 不再从 tab 反向拉 provider（会让 Settings 激活值
		// 随 session 乱跳），切 session 只对齐模型、不动全局 provider。
		replyLanguage: loadReplyLanguage(),
		followInput: loadFollowInput(),
		setReplyLanguage: (lang) => {
			saveReplyLanguage(lang);
			set({ replyLanguage: lang });
		},
		setFollowInput: (on) => {
			saveFollowInput(on);
			set({ followInput: on });
		},
		pinReplyLanguage: (lang) => {
			// Manual pick wins: pin the language and stop following the input language.
			saveReplyLanguage(lang);
			saveFollowInput(false);
			set({ replyLanguage: lang, followInput: false });
		},

		setProviderOverride: (id) => {
			saveProviderOverride(id);
			set((s) => {
				if (!s.activeSid) return { providerOverride: id };
				return {
					providerOverride: id,
					...patchTabField(s, s.activeSid, { providerOverride: id }),
				};
			});
		},
		// ① agent 安装偏好的写操作已移到 @forgeax/settings/agent-prefs（toggleAgentInstalled /
		// setAgentInstalled / setDefaultBootstrapAgent），走 bus 'prefs:agents'。interface 不再持有。
		// currentSessionId 在重做后等价 activeSid（一一对应），setter 保留只是为了不
		// 破已有 import surface —— 但实际真正切 session 应该走 switchToSession()。这里
		// 只 mirror top-level 字段、不动 activeSid（防止误用导致状态机错乱）。
		setCurrentSessionId: (id) => {
			set({ currentSessionId: id });
		},

		busyByAgentBySid: {},
		setAgentBusy: (sid, agentId, busy) =>
			set((s) => {
				if (!sid || !agentId) return {};
				const perSid = s.busyByAgentBySid[sid] ?? {};
				if (Boolean(perSid[agentId]) === busy) return {};
				bumpBusyMutationVersion(sid);
				const nextPerSid = { ...perSid };
				if (busy) nextPerSid[agentId] = true;
				else delete nextPerSid[agentId];
				return {
					busyByAgentBySid: { ...s.busyByAgentBySid, [sid]: nextPerSid },
				};
			}),

		...createObservabilityState(set, context.recordLog),

		liveAgents: {},
		agentFileActivity: {},
		setLiveAgents: (sid, agents) =>
			set((s) => ({
				liveAgents: { ...s.liveAgents, [sid]: agents },
			})),
		pushFileTouch: (sid, agentPath, touch) =>
			set((s) => {
				const perSid = s.agentFileActivity[sid] ?? {};
				const prev = perSid[agentPath] ?? [];
				const deduped = prev.filter(
					(f) => f.path !== touch.path || f.callId === touch.callId,
				);
				return {
					agentFileActivity: {
						...s.agentFileActivity,
						[sid]: { ...perSid, [agentPath]: [...deduped, touch] },
					},
				};
			}),
		updateFileTouchStatus: (sid, agentPath, callId, status) =>
			set((s) => {
				const perSid = s.agentFileActivity[sid];
				if (!perSid) return s;
				const prev = perSid[agentPath];
				if (!prev) return s;
				const next = prev.map((f) =>
					f.callId === callId ? { ...f, status } : f,
				);
				return {
					agentFileActivity: {
						...s.agentFileActivity,
						[sid]: { ...perSid, [agentPath]: next },
					},
				};
			}),

		activeGameSlug: null,
		activeGameRuntime: { status: "unbound" },
		activeGameResolved: false,
		initActiveGame: async () => {
			if (!hasStudioDomainClients()) {
				set({ activeGameResolved: true });
				return;
			}
			const client = getStudioProjectClient();
			if (!_activeGameUnsubscribe) {
				_activeGameUnsubscribe = client.subscribeActiveProject((selection) => {
					void get().applyActiveGame(
						coalesceActiveProjectSelection(selection, get().activeGameRuntime),
					);
				});
			}
			const selection = coalesceActiveProjectSelection(
				await client.getActiveProject(),
				get().activeGameRuntime,
			);
			if (!get().activeGameResolved) {
				const initialBinding = selection.runtime?.binding;
				if (initialBinding !== undefined) {
					_activeGameGenerationByScope.set(
						initialBinding.scopeId,
						initialBinding.generation,
					);
				}
				set({
					activeGameSlug: selection.activeSlug,
					activeGameRuntime: selection.runtime ?? { status: "unbound" },
					activeGameResolved: true,
				});
				setCurrentProject(selection.activeSlug ?? "default");
				try {
					localStorage.removeItem("forgeax.pinnedSlug");
				} catch {
					/* legacy cleanup */
				}
				if (needsActiveGameBindingPoll(selection)) {
					scheduleActiveGameBindingPoll(client, get);
				}
				return;
			}
			await get().applyActiveGame(selection);
			if (needsActiveGameBindingPoll(selection)) {
				scheduleActiveGameBindingPoll(client, get);
			}
		},
		applyActiveGame: async (selection) => {
			const coalesced = coalesceActiveProjectSelection(
				selection,
				get().activeGameRuntime,
			);
			const slug = coalesced.activeSlug;
			const runtime = coalesced.runtime ?? { status: "unbound" as const };
			const incomingBinding = runtime.binding;
			if (incomingBinding !== undefined) {
				stopActiveGameBindingPoll("binding-received");
				const knownGeneration = _activeGameGenerationByScope.get(
					incomingBinding.scopeId,
				);
				if (
					knownGeneration !== undefined &&
					incomingBinding.generation < knownGeneration
				) {
					return { status: "superseded" };
				}
				if (
					knownGeneration === undefined ||
					incomingBinding.generation > knownGeneration
				) {
					_activeGameGenerationByScope.set(
						incomingBinding.scopeId,
						incomingBinding.generation,
					);
				}
			}
			const key = `${slug ?? "_none"}:${runtime.binding?.scopeId ?? "_unbound"}:${runtime.binding?.generation ?? 0}:${runtime.status}`;
			const currentRuntime = get().activeGameRuntime;
			const currentKey = `${get().activeGameSlug ?? "_none"}:${currentRuntime.binding?.scopeId ?? "_unbound"}:${currentRuntime.binding?.generation ?? 0}:${currentRuntime.status}`;
			if (get().activeGameResolved && currentKey === key) {
				return {
					status: "applied",
					sessionCount: _sessionsInitialized ? get().tabs.length : null,
				};
			}
			if (_activeGameTransition?.key === key)
				return _activeGameTransition.promise;
			// A switch started in the previous game scope must never reconnect or
			// persist its sid after this accepted transition begins.
			invalidatePendingSessionSwitches();
			const revision = ++_activeGameTransitionRevision;
			const promise = (async () => {
				if (revision !== _activeGameTransitionRevision)
					return { status: "superseded" } as const;
				set({
					activeGameSlug: slug,
					activeGameRuntime: runtime,
					activeGameResolved: true,
				});
				setCurrentProject(slug ?? "default");
				if (!_sessionsInitialized) {
					return {
						status: "degraded",
						sessionCount: null,
						warning:
							"active game changed, but the session projection is not initialized yet",
					} as const;
				}
				const refreshed = await get().refreshSessions({
					scope: slug ?? undefined,
					transitionRevision: revision,
				});
				if (
					refreshed.status === "superseded" ||
					revision !== _activeGameTransitionRevision
				) {
					return { status: "superseded" } as const;
				}
				if (refreshed.status === "failed") {
					return {
						status: "degraded",
						sessionCount: null,
						warning: `active game changed, but sessions could not be refreshed: ${refreshed.error.message}`,
					} as const;
				}
				if (!slug)
					return { status: "applied", sessionCount: refreshed.count } as const;
				const tabs = get().tabs;
				if (tabs.length === 0) {
					// Observers project authority; they never manufacture downstream state.
					// The server-side active-game transition ensures the default session
					// before publishing its change event, so an empty result is a real
					// degraded state rather than permission for every open page to race.
					getSessionClient().connectForgeaXWs(null);
					return {
						status: "degraded",
						sessionCount: 0,
						warning:
							"active game changed, but no session is available in the new game scope",
					} as const;
				}
				const recent = mostRecentSid(tabs);
				if (recent) await get().switchToSession(recent);
				if (revision !== _activeGameTransitionRevision)
					return { status: "superseded" } as const;
				return {
					status: "applied" as const,
					sessionCount: refreshed.count,
				};
			})();
			_activeGameTransition = { key, promise };
			try {
				return await promise;
			} finally {
				if (_activeGameTransition?.promise === promise)
					_activeGameTransition = null;
			}
		},

		// File preview state belongs to @forgeax/files.

		// ── Tab-aware messages/streaming state (P6 step 1) ──
		// The data lives in `tabs[active].messages` etc.; these top-level fields
		// are a *mirror* of the active tab for back-compat with components that
		// already do `useShellStore(s => s.messages)`. Initial values come from the
		// persisted-tabs loader so the first render sees the right tab content.
		//
		// Note: TS narrows spread types to optional; we re-state the literal fields
		// below so all required AppState slots are present at init time. The earlier
		// `providerOverride: null` / `currentSessionId: null` declarations are then
		// overridden by the spread.
		..._initialMirror,

		initSessions: async () => {
			if (_initSessionsPending) return _initSessionsPending;
			_initSessionsPending = (async () => {
				const { fetchSessionList, ensureSession, connectForgeaXWs } =
					getSessionClient();
				try {
					await get().initActiveGame();
					const scope = get().activeGameSlug ?? undefined;
					let metas = await fetchSessionList(scope);
					if (metas.length === 0) {
						// 真空态：调用 server 的幂等 ensure；多个页面同时启动也只会建一条。
						// 不传 displayName，让 UI 用 tabLabel 占位规则反映"无名"真值。
						const { sid } = await ensureSession({ scope, autoStart: true });
						metas = await fetchSessionList(scope);
						// 兜底：如果 list 里居然没看到刚建的（应该不会，但 fs-watcher race 等
						// 极端情况），手动补一条 meta 进去保证 UI 有 tab。
						if (!metas.some((m) => m.sid === sid)) {
							metas = [{ sid }, ...metas];
						}
					}
					const newTabs: ChatTab[] = metas.map((m) => ({
						sid: m.sid,
						displayName: m.displayName,
						agentId: get().agentBySid[m.sid] ?? null,
						providerOverride: get().providerOverride,
						lastActivityAt: m.lastActivityAt,
					}));
					// localStorage 上次的 active sid 优先（如果还在 list 里），否则最近活跃的
					// 一条（规则见 session-pick.ts）。
					const active = pickActiveSid(newTabs, loadActiveSid());
					// provider 是全局设置，绝不从 tab 反推（会随 active session 乱跳）。
					set({
						tabs: newTabs,
						activeSid: active,
						currentSessionId: active,
					});
					persistActiveSid(active);
					connectForgeaXWs(active);
					void _syncActiveAgentRunning(active);
					_sessionsInitialized = true;
					if ((get().activeGameSlug ?? undefined) !== scope)
						await get().refreshSessions();
				} catch (e) {
					console.error("[initSessions] failed", e);
					// boot 失败：UI 维持空 tabs，ChatPanel 渲染空态 + 让用户手点"重试 / 新建"。
					set({ tabs: [], activeSid: null });
				}
			})();
			try {
				await _initSessionsPending;
			} finally {
				_initSessionsPending = null;
			}
		},

		refreshSessions: async (options) => {
			const { fetchSessionList } = getSessionClient();
			const scope = options?.scope ?? get().activeGameSlug ?? undefined;
			try {
				const metas = await fetchSessionList(scope);
				const staleScope = (get().activeGameSlug ?? undefined) !== scope;
				const staleTransition =
					options?.transitionRevision !== undefined &&
					options.transitionRevision !== _activeGameTransitionRevision;
				if (staleScope || staleTransition) return { status: "superseded" };
				set((s) => {
					const byOldSid = new Map(s.tabs.map((t) => [t.sid, t] as const));
					const merged: ChatTab[] = metas.map((m) => {
						const existing = byOldSid.get(m.sid);
						if (existing) {
							// server 端 displayName / lastActivityAt 可能改了 —— 同步更新；
							// 其余 in-flight 状态保留。
							const stale =
								existing.displayName === m.displayName &&
								existing.lastActivityAt === m.lastActivityAt;
							return stale
								? existing
								: {
										...existing,
										displayName: m.displayName,
										lastActivityAt: m.lastActivityAt,
									};
						}
						return {
							sid: m.sid,
							displayName: m.displayName,
							agentId: s.agentBySid[m.sid] ?? null,
							providerOverride: s.providerOverride,
							lastActivityAt: m.lastActivityAt,
						};
					});
					// 如果 active 还在新 list 里就保留，否则掉到最近活跃的一条（规则见
					// session-pick.ts）。空 list → null。
					const active = pickActiveSid(merged, s.activeSid);
					persistActiveSid(active);
					// provider 全局，不从 tab 反推。
					return {
						tabs: merged,
						activeSid: active,
						currentSessionId: active,
					};
				});
				return { status: "ok", count: metas.length };
			} catch (e) {
				console.warn("[refreshSessions] failed", e);
				return {
					status: "failed",
					error: {
						code: "SESSION_LIST_FAILED",
						message: e instanceof Error ? e.message : String(e),
					},
				};
			}
		},

		setActiveGame: async (slug) => {
			const requestRevision = ++_activeGameRequestRevision;
			const client = getStudioProjectClient();
			const applySelection = async (
				selection: ActiveProjectSelection,
			): Promise<SetActiveGameResult> => {
				if (requestRevision !== _activeGameRequestRevision)
					return { superseded: true };
				const applied = await get().applyActiveGame(
					coalesceActiveProjectSelection(selection, get().activeGameRuntime),
				);
				if (requestRevision !== _activeGameRequestRevision)
					return { superseded: true };
				if (applied.status === "superseded") {
					throw new Error(
						`game switch to "${slug}" was superseded by a newer active-game selection`,
					);
				}
				const runtime = selection.runtime ?? { status: "unbound" as const };
				const runtimeWarning =
					runtime.status === "ready" || runtime.status === "unbound"
						? undefined
						: (runtime.error ?? `runtime status is ${runtime.status}`);
				const warning =
					runtimeWarning ??
					(applied.status === "degraded" ? applied.warning : undefined);
				if (warning) {
					void alertDialog({
						title: t("gameSwitcher.activateFailedTitle"),
						body: t("gameSwitcher.activatePartialBody", {
							slug,
							message: warning,
						}),
					});
					return { warning };
				}
				return {};
			};

			let selection: ActiveProjectSelection;
			try {
				selection = await client.setActiveProject(slug);
				if (requestRevision !== _activeGameRequestRevision)
					return { superseded: true };
			} catch (e) {
				if (
					requestRevision !== _activeGameRequestRevision ||
					(e !== null &&
						typeof e === "object" &&
						(e as { code?: unknown }).code ===
							"ACTIVE_PROJECT_SWITCH_SUPERSEDED")
				)
					return { superseded: true };
				const message = e instanceof Error ? e.message : String(e);
				let authority: ActiveProjectSelection | null = null;
				try {
					authority = await client.getActiveProject();
				} catch {
					authority = null;
				}
				if (requestRevision !== _activeGameRequestRevision)
					return { superseded: true };
				if (authority?.activeSlug === slug) {
					return applySelection(authority);
				}
				if (authority && authority.activeSlug !== null) {
					const activeSlug = authority.activeSlug;
					void alertDialog({
						title: t("gameSwitcher.activateFailedTitle"),
						body: t("gameSwitcher.activateFailedBody", {
							slug,
							activeSlug,
							message,
						}),
					});
					throw new Error(
						`game switch to "${slug}" was not applied; active game remains "${activeSlug}" (${message})`,
					);
				}
				void alertDialog({
					title: t("gameSwitcher.activateFailedTitle"),
					body: t("gameSwitcher.activateUnknownBody", { slug, message }),
				});
				throw new Error(
					`game switch to "${slug}" could not be confirmed (${message})`,
				);
			}
			return applySelection(selection);
		},

		createNewSession: async (opts) => {
			const { createSession, connectForgeaXWs } = getSessionClient();
			try {
				// ① defaultBootstrapAgent 来自 settings/agent-prefs 的 bus 快照（interface 不再持有）。
				const bootstrap =
					(
						peek("prefs:agents") as
							| { defaultBootstrapAgent?: string | null }
							| undefined
					)?.defaultBootstrapAgent ?? null;
				const { sid, bootstrappedAgent } = await createSession({
					// 用户主动在 UI 里建 session（点 + 新建），可以传一个语义化的 displayName。
					// 不传时让 server 端落 undefined（UI 自己用 tabLabel 占位反映"无名"）。
					displayName: opts?.displayName,
					scope: opts?.scope ?? get().activeGameSlug ?? undefined,
					autoStart: true,
					// 用户在 Settings → Agents 里指定的「新 session 默认 agent」。null 时让
					// server 走 DEFAULT_BOOTSTRAP_AGENT='root'。是 marketplace persona id
					// 时 sessions.ts 解析 personaFile 注入到新 scaffold 的 agent.json。
					...(bootstrap ? { bootstrapAgent: bootstrap } : {}),
				});
				const seedOverride =
					opts?.providerOverride !== undefined
						? opts.providerOverride
						: get().providerOverride;
				// Activate as soon as POST /api/sessions succeeds. Composer already owns
				// the model-catalog reconciliation (with a loading placeholder), so doing
				// the same network work here would serialize tab activation behind a
				// second request and create two competing model writers.
				invalidatePendingSessionSwitches();
				set((s) => {
					const newTab: ChatTab = {
						sid,
						displayName: opts?.displayName,
						agentId: null,
						providerOverride: seedOverride,
						...(bootstrappedAgent
							? { initialModelSeedAgentId: bootstrappedAgent }
							: {}),
					};
					const tabs = [...s.tabs, newTab];
					persistActiveSid(sid);
					return {
						tabs,
						activeSid: sid,
						currentSessionId: sid,
						providerOverride: seedOverride,
					};
				});
				connectForgeaXWs(sid);
				void _syncActiveAgentRunning(sid);
				return { sid };
			} catch (e) {
				void alertDialog({
					title: t("store.createSession.failedTitle"),
					body: (e as Error).message,
				});
				return null;
			}
		},

		switchToSession: async (sid) => {
			// Session activation includes async model reconciliation. Multiple UI
			// surfaces can request switches concurrently, so only the latest intent
			// may commit activeSid/persistence/WS side effects after an await.
			const revision = invalidatePendingSessionSwitches();
			const tab = get().tabs.find((t) => t.sid === sid);
			if (!tab) {
				// 不在 tabs 里 —— 可能其它地方刚建好但本地 list 还没刷新，refresh 再试。
				await get().refreshSessions();
				if (revision !== _sessionSwitchRevision) return;
				const t2 = get().tabs.find((tb) => tb.sid === sid);
				if (!t2) return;
			}
			const target = get().tabs.find((t) => t.sid === sid)!;
			// 切 session：把该 session 的模型对齐到「当前设置的 provider」。provider 是全局
			// 单一设置（Settings › Providers），但从盘上加载的 session（如切 game 带出的历史
			// 会话）其 agent.json 模型可能仍属于旧 provider。若不在当前 provider 的 catalog 里
			// → 切到该 provider 上次手选模型（model-prefs）或默认；已属于则不动。在翻 activeSid
			// 之前做，好让 composer 首帧 fetch 直接画对齐后的值（不闪旧模型）。best-effort，
			// 绝不因对齐失败阻断切换。
			const agentPath = target.agentId ?? get().agentBySid[sid] ?? null;
			if (agentPath) {
				try {
					await context.reconcileSessionModelToActiveProvider(sid, agentPath);
				} catch {
					/* never block a session switch on model reconcile */
				}
			}
			if (
				revision !== _sessionSwitchRevision ||
				!get().tabs.some((t) => t.sid === sid)
			)
				return;
			// provider 是全局单一设置（Settings › Providers；chat 内切换器已隐藏），切
			// session 绝不改动它——否则 Settings 的激活 provider 会跟着目标 tab 的历史值乱跳。
			// session 与全局 provider 的错配只对齐「模型」（上面 reconcile 已做），不动 provider。
			set({
				activeSid: sid,
				currentSessionId: sid,
			});
			persistActiveSid(sid);
			const { connectForgeaXWs } = getSessionClient();
			connectForgeaXWs(sid);
			void _syncActiveAgentRunning(sid);
		},

		closeSession: async (sid) => {
			// liveAgents / agentFileActivity 是按 sid 累积的 write-only map(session-stream
			// 与 AgentsPanel 轮询只增不删);关 session 必须随 tab 一起摘除,否则每个关闭的
			// session 都把整棵 agent 树 + 文件活动记录永久滞留在 store 里(内存泄漏 case-05)。
			const omitSessionResidue = (
				s: Pick<
					AppState,
					"liveAgents" | "agentFileActivity" | "agentBySid" | "busyByAgentBySid"
				>,
			) => {
				const { [sid]: _la, ...liveAgents } = s.liveAgents;
				const { [sid]: _fa, ...agentFileActivity } = s.agentFileActivity;
				// case-06: agentBySid 也按 sid 累积,且 setTabAgent 把它持久化进 localStorage
				// ('forgeax.agentBySid')。关 session 不摘 → 孤儿条目在内存 + 磁盘双重无界
				// 累积、跨刷新永不回收。随 tab 一起摘掉并回写盘(与 setTabAgent 一致)。
				const { [sid]: _ab, ...agentBySid } = s.agentBySid;
				persistAgentBySid(agentBySid);
				// busy 镜像(chat 写)随 tab 一起摘,避免关闭 session 残留 spinner 标记。
				const { [sid]: _bb, ...busyByAgentBySid } = s.busyByAgentBySid;
				return { liveAgents, agentFileActivity, agentBySid, busyByAgentBySid };
			};
			// 2. 真删盘 —— DELETE /api/sessions/:sid。只有 server 确认删除后，才允许
			//    摘掉本地 tab 与所有 per-sid 残留；否则刷新历史会把服务端仍存在的 session
			//    "复活"，并且用户会无从得知删除未成功。
			const { deleteSession, connectForgeaXWs, createSession } =
				getSessionClient();
			try {
				await deleteSession(sid);
			} catch (e) {
				console.warn("[closeSession] DELETE failed", e);
				void alertDialog({
					title: t("store.closeSession.failedTitle"),
					body: t("store.closeSession.failedBody", {
						message: (e as Error).message,
					}),
				});
				return {
					status: "not-deleted",
					activeSid: get().activeSid,
					error: {
						code: "SESSION_DELETE_FAILED",
						message: e instanceof Error ? e.message : String(e),
					},
				};
			}

			// DELETE is now authoritative. Cancel any switch that still targets the
			// removed tab before the last-session replacement request can await.
			invalidatePendingSessionSwitches();

			// case-10: file-activity-stream 的模块级 _state Map 按 sid 累积(file-activity
			// 事件触发 getOrInit),只增不删 → 每个关闭的 session 永久滞留一个条目。只有
			// DELETE 成功后才随 tab 一起摘除(与 closeThreadHistoryTails 同为 per-sid 模块清理)。
			void context.dropFileActivitySession(sid);

			// 3. 从 tabs 里摘掉。如果删的是最后一条 → server 立即再 createSession 兜底
			//    保证 UI 永远有一条可用 session，跟 initSessions 的"空就建一条"一致。
			const remainingMetas = get().tabs.filter((t) => t.sid !== sid);
			if (remainingMetas.length === 0) {
				// The server has already deleted the final sid. Remove it from every
				// client-facing state before awaiting the replacement POST so composer,
				// tabs, and WS cannot keep using a session that no longer exists.
				set((s) => ({
					tabs: [],
					activeSid: null,
					currentSessionId: null,
					...omitSessionResidue(s),
				}));
				persistActiveSid(null);
				connectForgeaXWs(null);
				try {
					const { sid: newSid } = await createSession({ autoStart: true });
					const fresh: ChatTab = {
						sid: newSid,
						displayName: undefined,
						agentId: null,
						providerOverride: loadProviderOverride(),
					};
					set({
						tabs: [fresh],
						activeSid: newSid,
						currentSessionId: newSid,
					});
					persistActiveSid(newSid);
					connectForgeaXWs(newSid);
					void _syncActiveAgentRunning(newSid);
					return { status: "deleted", activeSid: newSid };
				} catch (e) {
					console.error("[closeSession] auto-create after empty failed", e);
					return {
						status: "deleted-without-active-session",
						activeSid: null,
						error: {
							code: "SESSION_REPLACEMENT_FAILED",
							message: e instanceof Error ? e.message : String(e),
						},
					};
				}
			}

			set((s) => {
				const oldIdx = s.tabs.findIndex((t) => t.sid === sid);
				const newIdx = Math.max(0, oldIdx - 1);
				const next =
					remainingMetas[Math.min(newIdx, remainingMetas.length - 1)]!;
				persistActiveSid(next.sid);
				return {
					tabs: remainingMetas,
					activeSid: next.sid,
					currentSessionId: next.sid,
					...omitSessionResidue(s),
				};
			});
			connectForgeaXWs(get().activeSid);
			void _syncActiveAgentRunning(get().activeSid);
			return { status: "deleted", activeSid: get().activeSid };
		},

		renameTab: (sid, displayName) => {
			set((s) => patchTabField(s, sid, { displayName }));
			// TODO: 等 server 加 PATCH /api/sessions/:sid { displayName } 后写盘。当前
			// 只是 UI 临时改名，刷新会 revert 到 server 真值。
		},

		setActiveEmitter: async (emitterId) => {
			// 重做后 activeSid 就是 server-side thread id（一一对应，不再有"tab 没绑
			// session"中间态），所以直接用 activeSid 当 PATCH /api/threads/:id 的 key。
			const { activeSid } = get();
			if (!activeSid) {
				console.warn("[setActiveEmitter] no active session");
				return;
			}
			try {
				const r = await fetch(`/api/threads/${encodeURIComponent(activeSid)}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ activeEmitterId: emitterId }),
				});
				if (!r.ok) {
					console.warn(`[setActiveEmitter] PATCH failed: HTTP ${r.status}`);
					return;
				}
				get().setTabAgent(activeSid, emitterId);
			} catch (e) {
				console.warn(`[setActiveEmitter] error: ${(e as Error).message}`);
			}
		},
	}));

	/**
	 * @deprecated Renamed to `useShellStore` (T24 · ADR 0024). Kept as an alias
	 * so out-of-tree consumers (chat / editor / page / dashboard / settings
	 * / studio / harness — 74 callsites across 7 submodules) keep booting while
	 * they migrate. Both names point to the SAME store instance; there is no
	 * behavior difference. Remove this line once every submodule has been
	 * repointed and pin-bumped in root.
	 */
	return useShellStore;
}
