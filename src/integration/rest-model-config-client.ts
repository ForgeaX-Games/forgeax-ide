export interface ModelCatalogEntry {
  id: string;
  [key: string]: unknown;
  input?: string[];
  reasoning?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  defaultTemperature?: number;
  spec?: unknown;
  source?: 'disk' | 'live' | 'driver';
  live?: boolean;
  driverId?: string;
  driverLabel?: string;
  costMetering?: 'none' | 'gateway';
  hidden?: boolean;
}

export interface AgentModelState {
  sid: string;
  agentPath: string;
  selected: string | null;
  chain: string[];
  raw: string | string[] | null;
}

export interface RestModelConfigClient {
  listModels(providerId?: string | null): Promise<ModelCatalogEntry[]>;
  getAgentModel(sid: string, agentPath: string): Promise<AgentModelState>;
  setAgentModels(
    sid: string,
    agentPath: string,
    models: string[],
  ): Promise<{ selected: string; chain: string[]; restarted: boolean }>;
}

interface CommandResponse<T> {
  result?: { ok: boolean; data?: T; error?: string };
}

type ModelConfigRequest = (input: string, init?: RequestInit) => Promise<Response>;

export function createRestModelConfigClient(
  request: ModelConfigRequest = (input, init) => fetch(input, init),
): RestModelConfigClient {
  async function call<T>(
    name: string,
    operation: 'query' | 'execute',
    args: string[],
  ): Promise<T> {
    const response = await request(`/api/commands/${name}/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    const payload = (await response.json()) as CommandResponse<T>;
    if (!payload.result?.ok) {
      throw new Error(payload.result?.error ?? `${name} failed (HTTP ${response.status})`);
    }
    return payload.result.data as T;
  }

  return {
    async listModels(providerId) {
      const data = await call<{ models: ModelCatalogEntry[] }>(
        'list_models',
        'query',
        providerId ? [providerId] : [],
      );
      return data.models ?? [];
    },

    getAgentModel(sid, agentPath) {
      return call<AgentModelState>('get_agent_model', 'query', [sid, agentPath]);
    },

    setAgentModels(sid, agentPath, models) {
      if (models.length === 0) {
        return Promise.reject(new Error('setAgentModels: at least one model required'));
      }
      return call<{ selected: string; chain: string[]; restarted: boolean }>(
        'set_agent_models',
        'execute',
        [sid, agentPath, ...models],
      );
    },
  };
}

export const restModelConfigClient = createRestModelConfigClient();
export const {
  getAgentModel,
  listModels,
  setAgentModels,
} = restModelConfigClient;
