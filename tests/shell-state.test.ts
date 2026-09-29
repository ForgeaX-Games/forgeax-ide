// @vitest-environment happy-dom
import { applicationDialogs } from "@forgeax/app-shell/application";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createIdeShellStore } from "../src/product/shell-state";
import type { IdeShellStoreContext } from "../src/product/shell-state-context";
import type { SessionClient } from "../src/product/shell-state-session-contract";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let client: SessionClient;
let context: IdeShellStoreContext;
let store: ReturnType<typeof createIdeShellStore>;
beforeEach(() => {
	localStorage.clear();
	client = {
		fetchSessionList: vi.fn(async () => []),
		createSession: vi.fn(async () => ({
			sid: "new",
			bootstrappedAgent: "root",
		})),
		ensureSession: vi.fn(async () => ({
			sid: "new",
			bootstrappedAgent: "root",
			created: true,
		})),
		deleteSession: vi.fn(async () => {}),
		emitForgeaXMessage: vi.fn(async () => ({ ok: true })),
		listSessionAgents: vi.fn(async () => []),
		connectForgeaXWs: vi.fn(),
		disconnectForgeaXWs: vi.fn(),
		onSessionEvent: () => () => {},
	};
	context = {
		getSessionClient: () => client,
		getStudioProjectClient: () => {
			throw new Error("unexpected project client access");
		},
		hasStudioDomainClients: () => false,
		getSurfaceWindowingController: () => {
			throw new Error("unexpected window access");
		},
		setCurrentProject: vi.fn(),
		resolveKernelForAgent: async () => null,
		recordLog: vi.fn(),
		reconcileSessionModelToActiveProvider: vi.fn(async () => {}),
		dropFileActivitySession: async () => {},
	};
	store = createIdeShellStore(context);
	store.setState({
		tabs: ["before", "a", "b"].map((sid) => ({
			sid,
			displayName: undefined,
			agentId: "root",
			providerOverride: null,
		})),
		activeSid: "before",
		currentSessionId: "before",
		providerOverride: null,
	});
});
afterEach(() => {
	applicationDialogs.cancelAll();
	localStorage.clear();
});

async function initializeSessions() {
	const initial = store.getState();
	client.fetchSessionList = vi.fn(async () =>
		initial.tabs.map(({ sid }) => ({ sid })),
	);
	await store.getState().initSessions();
	store.setState(initial, true);
	vi.clearAllMocks();
}

test("a late model reconciliation cannot overwrite a newer session switch", async () => {
	const first = deferred<void>();
	const second = deferred<void>();
	context.reconcileSessionModelToActiveProvider = vi
		.fn()
		.mockReturnValueOnce(first.promise)
		.mockReturnValueOnce(second.promise);
	const switchingA = store.getState().switchToSession("a");
	const switchingB = store.getState().switchToSession("b");
	second.resolve();
	await switchingB;
	first.resolve();
	await switchingA;
	expect(store.getState().activeSid).toBe("b");
	expect(store.getState().currentSessionId).toBe("b");
	expect(localStorage.getItem("forgeax.activeSid")).toBe("b");
	expect(client.connectForgeaXWs).toHaveBeenCalledExactlyOnceWith("b");
	expect(client.listSessionAgents).toHaveBeenCalledExactlyOnceWith("b");
});

test("creating a session activates it without waiting for the model catalog", async () => {
	context.reconcileSessionModelToActiveProvider = vi.fn(
		() => new Promise(() => {}),
	);
	expect(await store.getState().createNewSession()).toEqual({ sid: "new" });
	expect(store.getState().activeSid).toBe("new");
	expect(store.getState().tabs.at(-1)?.initialModelSeedAgentId).toBe("root");
	expect(context.reconcileSessionModelToActiveProvider).not.toHaveBeenCalled();
});

test("a pending switch cannot override a newly created session", async () => {
	const pending = deferred<void>();
	context.reconcileSessionModelToActiveProvider = () => pending.promise;
	const switching = store.getState().switchToSession("a");
	await store.getState().createNewSession();
	pending.resolve();
	await switching;
	expect(store.getState().activeSid).toBe("new");
	expect(client.connectForgeaXWs).toHaveBeenCalledExactlyOnceWith("new");
});

test.each(["delete", "refresh"])(
	"a pending switch cannot revive a session removed by %s",
	async (operation) => {
		const pending = deferred<void>();
		context.reconcileSessionModelToActiveProvider = () => pending.promise;
		const switching = store.getState().switchToSession("a");
		if (operation === "delete") await store.getState().closeSession("a");
		else {
			client.fetchSessionList = async () => [{ sid: "before" }];
			await store.getState().refreshSessions();
		}
		pending.resolve();
		await switching;
		expect(store.getState().tabs.some((tab) => tab.sid === "a")).toBe(false);
		expect(store.getState().activeSid).toBe("before");
		expect(vi.mocked(client.connectForgeaXWs).mock.calls.flat()).not.toContain(
			"a",
		);
	},
);

test.each([true, false])(
	"a preserved switch survives refresh (previous active retained: %s)",
	async (retainActive) => {
		const pending = deferred<void>();
		context.reconcileSessionModelToActiveProvider = () => pending.promise;
		client.fetchSessionList = async () => [
			...(retainActive ? [{ sid: "before", lastActivityAt: 3 }] : []),
			{ sid: "a", lastActivityAt: 1 },
			{ sid: "b", lastActivityAt: 2 },
		];
		const switching = store.getState().switchToSession("a");
		await store.getState().refreshSessions();
		pending.resolve();
		await switching;
		expect(store.getState().activeSid).toBe("a");
		expect(localStorage.getItem("forgeax.activeSid")).toBe("a");
		expect(client.connectForgeaXWs).toHaveBeenCalledExactlyOnceWith("a");
	},
);

test("rejected deletion preserves session state and queues an error dialog", async () => {
	client.deleteSession = async () => {
		throw new Error("DELETE failed: HTTP 503");
	};
	store.setState({
		liveAgents: { before: [] },
		agentFileActivity: { before: { root: [] } },
		agentBySid: { before: "root" },
		busyByAgentBySid: { before: { root: true } },
	});
	await store.getState().closeSession("before");
	expect(store.getState()).toMatchObject({
		activeSid: "before",
		currentSessionId: "before",
		liveAgents: { before: [] },
		agentFileActivity: { before: { root: [] } },
		agentBySid: { before: "root" },
		busyByAgentBySid: { before: { root: true } },
	});
	expect(store.getState().tabs.map((tab) => tab.sid)).toEqual([
		"before",
		"a",
		"b",
	]);
	expect(applicationDialogs.getSnapshot()).toMatchObject([
		{
			kind: "alert",
			options: {
				title: "Failed to delete conversation",
				body: "The conversation was kept. DELETE failed: HTTP 503",
			},
		},
	]);
});

test("deleting the last session clears it before awaiting its replacement", async () => {
	const replacement = deferred<{ sid: string; bootstrappedAgent: null }>();
	client.createSession = vi.fn(() => replacement.promise);
	store.setState({
		tabs: [
			{
				sid: "before",
				displayName: undefined,
				agentId: "root",
				providerOverride: null,
			},
		],
		agentBySid: { before: "root" },
	});
	const closing = store.getState().closeSession("before");
	await vi.waitFor(() => expect(client.createSession).toHaveBeenCalledOnce());
	expect(store.getState()).toMatchObject({
		tabs: [],
		activeSid: null,
		currentSessionId: null,
	});
	expect(store.getState().agentBySid.before).toBeUndefined();
	expect(localStorage.getItem("forgeax.activeSid")).toBeNull();
	replacement.resolve({ sid: "replacement", bootstrappedAgent: null });
	await closing;
	expect(store.getState().activeSid).toBe("replacement");
	expect(vi.mocked(client.connectForgeaXWs).mock.calls).toEqual([
		[null],
		["replacement"],
	]);
});

test("an accepted game transition fences an old switch before refresh completes", async () => {
	await initializeSessions();
	const pending = deferred<void>();
	const sessions = deferred<Array<{ sid: string }>>();
	context.reconcileSessionModelToActiveProvider = () => pending.promise;
	client.fetchSessionList = vi.fn(() => sessions.promise);
	store.setState({
		activeGameSlug: "old",
		activeGameRuntime: { status: "unbound" },
		activeGameResolved: true,
	});
	const switching = store.getState().switchToSession("a");
	const transition = store.getState().applyActiveGame({
		activeSlug: "new-game",
		runtime: { status: "unbound" },
	});
	await vi.waitFor(() => expect(client.fetchSessionList).toHaveBeenCalled());
	pending.resolve();
	await switching;
	expect(store.getState().activeGameSlug).toBe("new-game");
	expect(client.connectForgeaXWs).not.toHaveBeenCalled();
	sessions.resolve([{ sid: "before" }]);
	await transition;
	expect(store.getState().activeSid).toBe("before");
});

test("a late session list cannot replace the newer game's projection", async () => {
	await initializeSessions();
	const first = deferred<Array<{ sid: string }>>();
	const second = deferred<Array<{ sid: string }>>();
	client.fetchSessionList = vi.fn((scope) =>
		scope === "game-a" ? first.promise : second.promise,
	);
	const transitionA = store
		.getState()
		.applyActiveGame({ activeSlug: "game-a", runtime: { status: "ready" } });
	const transitionB = store
		.getState()
		.applyActiveGame({ activeSlug: "game-b", runtime: { status: "ready" } });
	second.resolve([{ sid: "session-b" }]);
	await transitionB;
	first.resolve([{ sid: "session-a" }]);
	await transitionA;
	expect(store.getState().activeGameSlug).toBe("game-b");
	expect(store.getState().tabs.map((tab) => tab.sid)).toEqual(["session-b"]);
	expect(store.getState().activeSid).toBe("session-b");
	expect(client.connectForgeaXWs).toHaveBeenCalledExactlyOnceWith("session-b");
});

test("sibling provider changes update active-tab send routing", () => {
	window.dispatchEvent(
		new StorageEvent("storage", {
			key: "forgeax.providerOverride",
			newValue: "codex",
		}),
	);
	expect(store.getState().providerOverride).toBe("codex");
	expect(
		store.getState().tabs.find((tab) => tab.sid === "before")?.providerOverride,
	).toBe("codex");
	expect(
		store.getState().tabs.find((tab) => tab.sid === "a")?.providerOverride,
	).toBeNull();
});

test("late project selection cannot overwrite a newer request", async () => {
	const older = deferred<{ activeSlug: string }>();
	const newer = deferred<{ activeSlug: string }>();
	context.getStudioProjectClient = () =>
		({
			setActiveProject: vi.fn((slug: string) =>
				slug === "older" ? older.promise : newer.promise,
			),
		}) as unknown as ReturnType<IdeShellStoreContext["getStudioProjectClient"]>;
	// The factory captures its injected getters, so construct after injection.
	const candidate = createIdeShellStore(context);
	const apply = vi.fn(async (_selection: { activeSlug: string | null }) => ({
		status: "applied" as const,
		sessionCount: 0,
	}));
	candidate.setState({ applyActiveGame: apply });
	const first = candidate.getState().setActiveGame("older");
	const second = candidate.getState().setActiveGame("newer");
	newer.resolve({ activeSlug: "newer" });
	expect(await second).toEqual({});
	older.resolve({ activeSlug: "older" });
	expect(await first).toEqual({ superseded: true });
	expect(apply).toHaveBeenCalledTimes(1);
	expect(apply.mock.calls[0]?.[0]).toMatchObject({ activeSlug: "newer" });
});

test("server superseded errors do not fall back to a stale project", async () => {
	const read = vi.fn();
	context.getStudioProjectClient = () =>
		({
			setActiveProject: vi.fn(async () => {
				throw Object.assign(new Error("superseded"), {
					code: "ACTIVE_PROJECT_SWITCH_SUPERSEDED",
				});
			}),
			getActiveProject: read,
		}) as unknown as ReturnType<IdeShellStoreContext["getStudioProjectClient"]>;
	const candidate = createIdeShellStore(context);
	expect(await candidate.getState().setActiveGame("older")).toEqual({
		superseded: true,
	});
	expect(read).not.toHaveBeenCalled();
});
