// 会话回落挑选规则（SSOT）—— initSessions / refreshSessions / setActiveGame 共用。
//
// 历史与 game 绑定：刷新 / 切 game / 列表变更后，UI 应回到「上次明确停留的那条
// 会话（persisted sid，若仍存在）」，否则回到「该 game 最近活跃的一条」。server
// 的 /api/sessions 不保证按活跃度排序，所以这里显式按 lastActivityAt 挑，
// 而不是拿列表第 0 位。

export interface PickableSession {
	sid: string;
	lastActivityAt?: number;
}

/** 该 game 最近活跃的一条会话 sid；空列表 → null。 */
export function mostRecentSid(tabs: readonly PickableSession[]): string | null {
	let best: PickableSession | null = null;
	for (const t of tabs) {
		if (!best || (t.lastActivityAt ?? 0) > (best.lastActivityAt ?? 0)) best = t;
	}
	return best?.sid ?? null;
}

/** persisted sid 仍在列表里 → 尊重用户上次的停留；否则回落最近活跃。 */
export function pickActiveSid(
	tabs: readonly PickableSession[],
	persisted: string | null,
): string | null {
	if (persisted && tabs.some((t) => t.sid === persisted)) return persisted;
	return mostRecentSid(tabs);
}
