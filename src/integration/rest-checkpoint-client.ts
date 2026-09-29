export interface CheckpointEntry {
	msgId: string;
	ts: number;
	hasCode: boolean;
}

export interface PendingRewindInfo {
	boundaryId: string;
	targetMsgId: string;
	mode: "both" | "conversation" | "code";
	preManifestId: string | null;
	keptDirty: string[];
	overwrite: { safetyManifestId: string; files: string[] } | null;
}

export interface FileDiffStat {
	path: string;
	status: "added" | "deleted" | "modified";
	insertions: number;
	deletions: number;
	binary: boolean;
}

export interface RewindPreview {
	filesChanged: string[];
	insertions: number;
	deletions: number;
	binaryOrLarge: number;
	files?: FileDiffStat[];
}

export interface RestCheckpointClient {
	fetchCheckpoints(
		sid: string,
		signal?: AbortSignal,
	): Promise<{
		checkpoints: CheckpointEntry[];
		pending: PendingRewindInfo | null;
	}>;
	rewindPreview(sid: string, msgId: string): Promise<RewindPreview>;
	rewindTo(
		sid: string,
		msgId: string,
		mode: "both" | "conversation" | "code",
	): Promise<{
		boundaryId: string;
		filesChanged: string[];
		keptDirty: string[];
	}>;
	rewindCancel(
		sid: string,
		boundaryId: string,
	): Promise<{ keptDirty: string[] }>;
	rewindOverwriteDirty(
		sid: string,
		boundaryId: string,
	): Promise<{ files: string[] }>;
	rewindUndoOverwrite(
		sid: string,
		boundaryId: string,
	): Promise<{ files: string[] }>;
}

type FetchCheckpointRequest = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export function createRestCheckpointClient(
	request: FetchCheckpointRequest = (input, init) => fetch(input, init),
): RestCheckpointClient {
	async function post<T>(
		url: string,
		body: Record<string, unknown>,
	): Promise<T> {
		const response = await request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			let detail: string;
			try {
				detail =
					((await response.json()) as { error?: string }).error ??
					`HTTP ${response.status}`;
			} catch {
				detail = `HTTP ${response.status}`;
			}
			throw new Error(detail);
		}
		return (await response.json()) as T;
	}

	return {
		async fetchCheckpoints(sid, signal) {
			const response = await request(
				`/api/sessions/${encodeURIComponent(sid)}/checkpoints`,
				{ signal },
			);
			if (!response.ok) throw new Error(`GET checkpoints ${response.status}`);
			return (await response.json()) as {
				checkpoints: CheckpointEntry[];
				pending: PendingRewindInfo | null;
			};
		},

		rewindPreview(sid, msgId) {
			return post(`/api/sessions/${encodeURIComponent(sid)}/rewind/preview`, {
				msgId,
			});
		},

		rewindTo(sid, msgId, mode) {
			return post(`/api/sessions/${encodeURIComponent(sid)}/rewind`, {
				msgId,
				mode,
			});
		},

		rewindCancel(sid, boundaryId) {
			return post(`/api/sessions/${encodeURIComponent(sid)}/rewind/cancel`, {
				boundaryId,
			});
		},

		rewindOverwriteDirty(sid, boundaryId) {
			return post(
				`/api/sessions/${encodeURIComponent(sid)}/rewind/overwrite-dirty`,
				{ boundaryId },
			);
		},

		rewindUndoOverwrite(sid, boundaryId) {
			return post(
				`/api/sessions/${encodeURIComponent(sid)}/rewind/undo-overwrite`,
				{ boundaryId },
			);
		},
	};
}

export const restCheckpointClient = createRestCheckpointClient();
export const {
	fetchCheckpoints,
	rewindPreview,
	rewindTo,
	rewindCancel,
	rewindOverwriteDirty,
	rewindUndoOverwrite,
} = restCheckpointClient;
