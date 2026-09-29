const START_NARRATIVE_TOOL = "narrative:start-pipeline";
const NARRATIVE_POLL_MS = 5_000;
const MAX_NARRATIVE_WATCH_MS = 40 * 60 * 1_000;

export interface NarrativeHistoryEntry {
	key: string;
	id: string | null;
	status?: string;
}

export interface ProductSessionEvent {
	sid: string;
	emitterId?: string;
	event: {
		type: string;
		payload: Record<string, unknown>;
	};
}

export interface PerceptionQueryDetail {
	sid: string;
	reqId: string;
	kind: "world" | "frame";
	query?: unknown;
}

export interface ProductSessionStreamDependencies {
	onSessionEvent(
		key: string,
		handler: (event: ProductSessionEvent) => void,
	): (() => void) | void;
	emitMessage(
		sid: string,
		content: string,
		options: {
			to: string;
			type: "user_input";
			payload: {
				narrativeAutoNudge: true;
				runKey: string;
				runStatus: string;
			};
		},
	): Promise<unknown>;
	fetchNarrativeHistory(): Promise<readonly NarrativeHistoryEntry[]>;
	now(): number;
	setInterval(callback: () => void, delay: number): unknown;
	clearInterval(handle: unknown): void;
	dispatchPerception(detail: PerceptionQueryDetail): void;
}

export interface ProductSessionStreams {
	subscribeNarrativeCopilot(): void;
	subscribePerceptionStream(): void;
}

/**
 * Creates the IDE-owned session side effects that coordinate independent
 * product services. Chat owns the session transport; callers retain the
 * concrete browser and HTTP boundaries.
 */
export function createProductSessionStreams(
	dependencies: ProductSessionStreamDependencies,
): ProductSessionStreams {
	const activeNarrativeWatchers = new Set<string>();

	async function nudgeNarrativeAgent(
		sid: string,
		agent: string,
		runKey: string,
		status: string,
	): Promise<void> {
		const content =
			status === "completed"
				? `【叙事工坊 · 系统通知】你刚启动的管线已完成（输出目录：${runKey}）。请用 narrative:get-run-status / narrative:get-story-tree / narrative:read-file 看一下产出，按你剧情师的视角给用户一段完成总结：跑了哪些环节、产出是什么、是否符合用户需求（默认符合，明显跑偏才指出并建议 narrative:regenerate-step）。`
				: `【叙事工坊 · 系统通知】你刚启动的管线已结束，状态为「${status}」（输出目录：${runKey}）。请用 narrative:get-run-status 看一下停在哪一步、为什么，给用户一句说明并建议下一步（narrative:resume-pipeline 续跑 / 重新启动等）。`;

		await dependencies
			.emitMessage(sid, content, {
				to: agent,
				type: "user_input",
				payload: {
					narrativeAutoNudge: true,
					runKey,
					runStatus: status,
				},
			})
			.catch(() => undefined);
	}

	function watchNarrativeRun(sid: string, agent: string): void {
		const watcherKey = `${sid}::${agent}`;
		if (activeNarrativeWatchers.has(watcherKey)) return;
		activeNarrativeWatchers.add(watcherKey);

		const startedAt = dependencies.now();
		let seenRunningKey: string | null = null;
		let timer: unknown;
		const stop = (): void => {
			dependencies.clearInterval(timer);
			activeNarrativeWatchers.delete(watcherKey);
		};

		timer = dependencies.setInterval(() => {
			void (async () => {
				if (dependencies.now() - startedAt > MAX_NARRATIVE_WATCH_MS) {
					stop();
					return;
				}

				const history = await dependencies.fetchNarrativeHistory();
				if (history.length === 0) return;
				const running = history.find(
					(entry) => entry.status === "running" && Boolean(entry.id),
				);
				if (running) {
					seenRunningKey = running.key;
					return;
				}

				if (seenRunningKey === null) return;
				const entry = history.find(
					(candidate) => candidate.key === seenRunningKey,
				);
				const status = entry?.status ?? "completed";
				stop();
				await nudgeNarrativeAgent(sid, agent, seenRunningKey, status);
			})();
		}, NARRATIVE_POLL_MS);
	}

	function subscribeNarrativeCopilot(): void {
		dependencies.onSessionEvent("narrative-copilot", (envelope) => {
			if (envelope.event.type !== "hook:toolCall") return;
			const payload = envelope.event.payload as {
				name?: string;
				toolCall?: { name?: string };
			};
			const toolName = payload.name ?? payload.toolCall?.name;
			if (toolName !== START_NARRATIVE_TOOL || !envelope.emitterId) return;
			watchNarrativeRun(envelope.sid, envelope.emitterId);
		});
	}

	function subscribePerceptionStream(): void {
		dependencies.onSessionEvent("perception", (envelope) => {
			if (envelope.event.type !== "perception:query") return;
			const payload = envelope.event.payload as {
				reqId?: string;
				kind?: string;
				query?: unknown;
			};
			if (typeof payload.reqId !== "string") return;
			try {
				dependencies.dispatchPerception({
					sid: envelope.sid,
					reqId: payload.reqId,
					kind: payload.kind === "frame" ? "frame" : "world",
					query: payload.query,
				});
			} catch {
				// Browserless and retained-listener failures do not block the session stream.
			}
		});
	}

	return { subscribeNarrativeCopilot, subscribePerceptionStream };
}
