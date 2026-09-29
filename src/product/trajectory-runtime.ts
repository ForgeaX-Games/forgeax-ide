import {
	getAction,
	UI_ACTION_DISPATCH_EVENT,
} from "@forgeax/app-shell/application";
import { installCustomEventObservation } from "@forgeax/app-shell/react";

export interface TrajectoryEntry {
	seq: number;

	ts: number;

	id: string;

	title?: string;

	source: "human" | "ai";

	capability?: string;

	args?: Record<string, unknown>;
}

export const TRAJECTORY_MAX = 200;

type TrajectorySeed = {
	readonly entries: readonly TrajectoryEntry[];
	readonly sequence: number;
};

function createTrajectoryRuntime(seed: TrajectorySeed) {
	const MAX = TRAJECTORY_MAX;
	const buffer: TrajectoryEntry[] = [...seed.entries];
	let seq = seed.sequence;
	let stop: (() => void) | null = null;

	function redactArgs(
		args: Record<string, unknown> | undefined,
		capability?: string,
	): Record<string, unknown> | undefined {
		if (!args || Object.keys(args).length === 0) return undefined;
		if (capability === "credential") return { redacted: true };
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(args)) {
			if (typeof v === "string")
				out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v;
			else if (v === null || typeof v === "number" || typeof v === "boolean")
				out[k] = v;
			else out[k] = Array.isArray(v) ? `[array:${v.length}]` : `[${typeof v}]`;
		}
		return out;
	}

	function recordTrajectory(detail: {
		id: string;
		source: "human" | "ai";
		args?: Record<string, unknown>;
	}): void {
		if (!detail || typeof detail.id !== "string") return;
		if (detail.id.startsWith("trajectory.")) return;
		const def = getAction(detail.id);
		const entry: TrajectoryEntry = {
			seq: ++seq,
			ts: Date.now(),
			id: detail.id,
			source: detail.source === "ai" ? "ai" : "human",
		};
		if (def?.title) entry.title = def.title;
		if (def?.capability) entry.capability = def.capability;
		const args = redactArgs(detail.args, def?.capability);
		if (args) entry.args = args;
		buffer.push(entry);
		if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
	}

	function readTrajectory(
		opts: { limit?: number; source?: "human" | "ai" } = {},
	): {
		total: number;
		count: number;
		entries: TrajectoryEntry[];
	} {
		const src =
			opts.source === "human" || opts.source === "ai" ? opts.source : undefined;
		const filtered = src ? buffer.filter((e) => e.source === src) : buffer;
		const limit = Math.min(
			opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 50,
			MAX,
		);
		const entries = filtered.slice(-limit);
		return { total: filtered.length, count: entries.length, entries };
	}

	function clearTrajectory(): number {
		const n = buffer.length;
		buffer.length = 0;
		return n;
	}

	function startTrajectoryRecording(): () => void {
		if (typeof window === "undefined") return () => {};
		if (stop) return stop;
		const onDispatch = (e: Event) => {
			const d = (e as CustomEvent).detail as
				| { id: string; source: "human" | "ai"; args?: Record<string, unknown> }
				| undefined;
			if (d) recordTrajectory(d);
		};
		const disposeDispatchObservation = installCustomEventObservation({
			target: window,
			eventType: UI_ACTION_DISPATCH_EVENT,
			onEvent: onDispatch,
		});
		stop = () => {
			disposeDispatchObservation();
			stop = null;
		};
		return stop;
	}
	return {
		record: recordTrajectory,
		read: readTrajectory,
		clear: clearTrajectory,
		start: startTrajectoryRecording,
	};
}

let runtime: ReturnType<typeof createTrajectoryRuntime> | undefined;

// The product keeps one history for the page, across host disposal and recovery.
export function createIdeTrajectoryRuntime(seed: TrajectorySeed) {
	if (!runtime) runtime = createTrajectoryRuntime(seed);
	return runtime;
}

export function getIdeTrajectoryRuntime() {
	if (!runtime) throw new Error("IDE trajectory runtime is not configured");
	return runtime;
}
