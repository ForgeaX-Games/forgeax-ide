export interface SessionMeta {
	sid: string;
	displayName?: string;
	defaultDir?: string;
	autoStart?: boolean;
	lastActivityAt?: number;
}

export interface ForgeaXAgentNode {
	path: string;
	display: string;
	depth: number;
	fullId: string;
	parent: string | null;
	hasLedger: boolean;
	running: boolean;
}

export interface SessionEvent {
	type: "session-event";
	sid: string;
	emitterId?: string;
	event: {
		source: string;
		type: string;
		payload: Record<string, unknown>;
		to?: string;
		ts: number;
	};
}

export type SessionEventHandler = (event: SessionEvent) => void;

export interface SessionClient {
	fetchSessionList: (game?: string) => Promise<SessionMeta[]>;
	createSession: (opts?: {
		displayName?: string;
		scope?: string;
		autoStart?: boolean;
		bootstrapAgent?: string | false | null;
	}) => Promise<{ sid: string; bootstrappedAgent: string | null }>;
	ensureSession: (opts?: {
		scope?: string;
		autoStart?: boolean;
		bootstrapAgent?: string | false | null;
	}) => Promise<{
		sid: string;
		bootstrappedAgent: string | null;
		created: boolean;
	}>;
	deleteSession: (sid: string) => Promise<void>;
	emitForgeaXMessage: (
		sid: string,
		content: string,
		opts?: {
			to?: string;
			type?: string;
			payload?: Record<string, unknown>;
			handoff?: "silent" | "passive" | "turn" | "innerLoop" | "steer";
		},
	) => Promise<{ ok: boolean; to?: string; msgId?: string; error?: string }>;
	listSessionAgents: (sid: string) => Promise<ForgeaXAgentNode[]>;
	connectForgeaXWs: (sid: string | null) => void;
	disconnectForgeaXWs: () => void;
	onSessionEvent: (key: string, handler: SessionEventHandler) => () => void;
}
