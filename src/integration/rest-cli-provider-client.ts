export interface CliProviderInfo {
	id: string;
	displayName: string;
	health: { ok: boolean; detail?: string };
	capabilities: Record<string, boolean>;
}

export interface RestCliProviderClient {
	fetchCliProviders(force?: boolean): Promise<{
		providers: CliProviderInfo[];
		cachedAt: number;
	}>;
}

type FetchCliProviderHealth = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

interface RawCliHealth {
	providers?: Array<{
		id: string;
		ok?: boolean;
		detail?: string;
		capabilities?: Record<string, boolean>;
	}>;
}

const PROVIDER_DISPLAY: Record<string, string> = {
	"forgeax-core": "ForgeaX Kernel",
	"claude-code": "the reference agent CLI",
	codex: "OpenAI Codex",
	"cursor-agent": "Cursor Agent",
	codebuddy: "a peer agent CLI",
	"kimi-code": "Kimi Code",
	"deepseek-harness": "DeepSeek Harness",
};

const DISPLAYABLE_KERNEL_CAPABILITIES = new Set([
	"streaming",
	"thinking",
	"toolCalls",
	"midTurnInject",
	"forkExtract",
]);

export function displayableKernelCapabilities(
	capabilities: Record<string, boolean> | undefined,
): Record<string, boolean> {
	return Object.fromEntries(
		Object.entries(capabilities ?? {}).filter(([key]) =>
			DISPLAYABLE_KERNEL_CAPABILITIES.has(key),
		),
	);
}

export function createRestCliProviderClient(
	request: FetchCliProviderHealth = (input, init) => fetch(input, init),
): RestCliProviderClient {
	return {
		async fetchCliProviders(force = false) {
			void force;
			const response = await request("/api/cli/health");
			if (!response.ok) throw new Error(`/api/cli/health ${response.status}`);
			const payload = (await response.json()) as RawCliHealth;
			const providers = (payload.providers ?? []).map((provider) => ({
				id: provider.id,
				displayName: PROVIDER_DISPLAY[provider.id] ?? provider.id,
				health: { ok: !!provider.ok, detail: provider.detail },
				capabilities: displayableKernelCapabilities(provider.capabilities),
			}));
			return { providers, cachedAt: Date.now() };
		},
	};
}

export const restCliProviderClient = createRestCliProviderClient();
export const fetchCliProviders = restCliProviderClient.fetchCliProviders;
