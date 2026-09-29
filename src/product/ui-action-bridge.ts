import {
	buildManifest,
	dispatchAction,
	onRegistryChange,
	snapshotActions,
	snapshotState,
} from "@forgeax/app-shell/application";
export interface UiActionBridgeEvent {
	readonly sid: string;
	readonly event: {
		readonly type: string;
		readonly payload: Record<string, unknown>;
	};
}

/** Presentation and domain adapters remain with their existing owners. */
export interface UiActionBridgeContext {
	getActiveSid(): string | null | undefined;
	subscribeActiveSid(listener: (sid: string | null | undefined) => void): void;
	subscribeSessionEvents(listener: (event: UiActionBridgeEvent) => void): void;
	installPresentation(): void;
	buildA11ySummary(): unknown;
	captureUiScreenshot(query: unknown): Promise<unknown>;
}

/** Page-lifetime lease authority. The entry binding guarantees one boot. */
export function bootIdeUiActionBridge(context: UiActionBridgeContext): void {
	const clientId = (() => {
		try {
			return crypto.randomUUID();
		} catch {
			return `tab-${Math.random().toString(36).slice(2)}`;
		}
	})();

	interface LeaseRecord {
		leaseId: string;
		expiresAt: number;
	}

	const leases = new Map<string, LeaseRecord>();
	/** 见过的 sid(store activeSid + 收到过 ui_* 查询的)——心跳续期的范围。 */
	const knownSids = new Set<string>();

	function holdingLease(sid: string): string | null {
		const l = leases.get(sid);
		return l && l.expiresAt > Date.now() ? l.leaseId : null;
	}

	async function acquireLease(
		sid: string,
		opts: { skipPush?: boolean; renew?: boolean; claimOnly?: boolean } = {},
	): Promise<string | null> {
		const existing = leases.get(sid);
		if (opts.renew ? !existing : !document.hasFocus()) return null;
		try {
			const r = await fetch(
				`/api/sessions/${encodeURIComponent(sid)}/ui-lease`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						clientId,
						...(opts.renew ? { leaseId: existing!.leaseId } : {}),
						...(opts.claimOnly ? { claimOnly: true } : {}),
					}),
				},
			);
			const j = (await r.json().catch(() => ({}))) as {
				ok?: boolean;
				leaseId?: string;
				ttlMs?: number;
			};
			if (opts.renew && leases.get(sid) !== existing) return holdingLease(sid);
			if (!j.ok || typeof j.leaseId !== "string") {
				leases.delete(sid);
				return null;
			}
			leases.set(sid, {
				leaseId: j.leaseId,
				expiresAt: Date.now() + (j.ttlMs ?? 30_000),
			});
			knownSids.add(sid);
			// 每次 acquire 成功都重推 manifest(幂等整表替换,payload 很小)。顺序约束:trust-gate
			// 的查表在 invoke 往返**之前**发生,manifest 必须先于第一次 ui_invoke 到位,否则
			// fail-closed ask;「只在首次推」曾在会话切换场景留下一次竞态缺口(e2e Test D),
			// 无条件重推把这类缺口整类消掉。skipPush 防 pushManifest→acquireLease 递归。
			if (!opts.skipPush) void pushManifest(sid);
			return j.leaseId;
		} catch {
			return null;
		}
	}

	async function pushManifest(sid: string): Promise<void> {
		const leaseId =
			holdingLease(sid) ??
			(await acquireLease(sid, { skipPush: true, claimOnly: true }));
		if (!leaseId) return; // 拿不到 lease(别的 tab 持有)→ 不推,由持有者推
		try {
			await fetch(`/api/sessions/${encodeURIComponent(sid)}/ui-manifest`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ leaseId, actions: buildManifest() }),
			});
		} catch {
			/* fail-soft:下次 registry 变更 / lease 续期再推 */
		}
	}

	// ─── ui_* 查询应答 ───────────────────────────────────────────────────────────

	interface UiQueryPayload {
		reqId?: string;
		kind?: string;
		query?: unknown;
	}

	async function answerUiQuery(evt: UiActionBridgeEvent): Promise<void> {
		if (evt.event.type !== "perception:query") return;
		const p = evt.event.payload as UiQueryPayload;
		const kind = p.kind;
		if (
			kind !== "ui_snapshot" &&
			kind !== "ui_invoke" &&
			kind !== "ui_screenshot"
		)
			return; // world/frame 归 preview surface
		if (typeof p.reqId !== "string") return;
		const sid = evt.sid;
		knownSids.add(sid);

		// lease 检查:非持有者不应答。本 tab 可见而无 lease → 机会式 acquire(displace)。
		let leaseId = holdingLease(sid);
		if (
			!leaseId &&
			typeof document !== "undefined" &&
			document.visibilityState === "visible" &&
			document.hasFocus()
		) {
			leaseId = await acquireLease(sid, { claimOnly: true });
		}
		if (!leaseId) return;

		let snapshot: unknown;
		if (kind === "ui_snapshot") {
			const q = (p.query ?? {}) as { detail?: unknown; ids?: unknown };
			const detail = typeof q.detail === "string" ? q.detail : undefined;
			snapshot = {
				actions: snapshotActions(
					detail,
					Array.isArray(q.ids)
						? q.ids.filter((x): x is string => typeof x === "string")
						: undefined,
				),
				state: snapshotState(),
				// P1-13 a11y 兜底:未注册区域的只读定向摘要(detail:'a11y' 按需拉,默认不带)。
				...(detail === "a11y" ? { a11y: context.buildA11ySummary() } : {}),
			};
		} else if (kind === "ui_screenshot") {
			// P3 兜底证据:DOM→canvas 栅格化(失败 fail-soft captured:false,见 ui-screenshot.ts)。
			snapshot = await context.captureUiScreenshot(p.query);
		} else {
			const q = (p.query ?? {}) as { actionId?: unknown; args?: unknown };
			if (typeof q.actionId !== "string" || !q.actionId) {
				snapshot = {
					status: "rejected",
					reason: "ui_invoke requires actionId (string)",
				};
			} else {
				snapshot = await dispatchAction(
					q.actionId,
					q.args && typeof q.args === "object"
						? (q.args as Record<string, unknown>)
						: {},
					{ source: "ai" },
				);
			}
		}

		try {
			await fetch(`/api/sessions/${encodeURIComponent(sid)}/perception-reply`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ reqId: p.reqId, snapshot, leaseId }),
			});
		} catch {
			/* fail-soft:server 侧超时兜底 */
		}
	}

	let repushTimer: ReturnType<typeof setTimeout> | null = null;
	context.installPresentation();
	// ui_* 查询应答(onSessionEvent 按 key 幂等,HMR 安全;world/frame 由 perception-stream 继续中转)。
	context.subscribeSessionEvents((evt) => void answerUiQuery(evt));

	// registry 变更 → debounce 重推 manifest(只推本 tab 持 lease 的 sid)。
	onRegistryChange(() => {
		if (repushTimer) clearTimeout(repushTimer);
		repushTimer = setTimeout(() => {
			repushTimer = null;
			for (const sid of knownSids)
				if (holdingLease(sid)) void pushManifest(sid);
		}, 300);
	});

	// 获焦 / 可见 → acquire(displace:「最后获焦 tab」成为权威 surface)。
	const onFocus = (): void => {
		const sid = context.getActiveSid();
		if (sid) void acquireLease(sid);
	};
	window.addEventListener("focus", onFocus);
	document.addEventListener(
		"pointerdown",
		(event) => {
			if (event.isTrusted) onFocus();
		},
		true,
	);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") onFocus();
	});

	// activeSid 变化 → 对新会话建 lease + 推 manifest。
	let lastSid: string | null = null;
	context.subscribeActiveSid((value) => {
		const sid = value ?? null;
		if (sid && sid !== lastSid) {
			lastSid = sid;
			void acquireLease(sid);
		}
	});
	onFocus(); // boot 时若已可见,立即建 lease

	// 心跳续期(TTL 30s → 每 10s;仅本 tab 可见时续,失焦让位给获焦 tab)。
	setInterval(() => {
		if (document.visibilityState !== "visible") return;
		for (const sid of knownSids)
			if (holdingLease(sid)) void acquireLease(sid, { renew: true });
	}, 10_000);
}
