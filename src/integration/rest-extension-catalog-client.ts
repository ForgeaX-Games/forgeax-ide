export interface ExtensionCatalogInfo {
  id: string;
  name?: string;
  version?: string;
  displayName?: string | Record<string, string>;
  description?: string | Record<string, string>;
  preferredAgent?: string;
  icon?: string;
  experimental?: boolean;
  tools?: readonly unknown[];
  events?: readonly unknown[];
  contributes?: {
    pages?: readonly { id?: string; icon?: string }[];
    activities?: readonly { icon?: string }[];
  };
  [key: string]: unknown;
}

export interface ExtensionCatalogListResponse {
  kind: string | null;
  count: number;
  generation?: number;
  items: ExtensionCatalogInfo[];
}

export type SharedCapabilityKind =
  | 'skill'
  | 'command'
  | 'mcp'
  | 'extension'
  | 'memory'
  | 'tool';

export interface SharedCapabilityInfo {
  capabilityId: string;
  kind: SharedCapabilityKind;
  extensionId: string;
  extensionVersion: string;
  origin: 'builtin' | 'user' | 'project';
  localId: string;
  lifecycle: { requiresRestart: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SharedCapabilityListResponse {
  generation: number;
  loadedAt: number;
  capabilities: SharedCapabilityInfo[];
  issues: string[];
}

export interface RestExtensionCatalogClient {
  listExtensions(kind?: string): Promise<ExtensionCatalogListResponse>;
  listSharedCapabilities(): Promise<SharedCapabilityListResponse>;
}

type FetchExtensionCatalog = (input: string, init?: RequestInit) => Promise<Response>;

const EMPTY_SHARED_CAPABILITIES: SharedCapabilityListResponse = {
  generation: 0,
  loadedAt: 0,
  capabilities: [],
  issues: [],
};

export function createRestExtensionCatalogClient(
  request: FetchExtensionCatalog = (input, init) => fetch(input, init),
): RestExtensionCatalogClient {
  return {
    async listExtensions(kind) {
      const url = kind
        ? `/api/extensions/list?kind=${encodeURIComponent(kind)}`
        : '/api/extensions/list';
      const empty: ExtensionCatalogListResponse = {
        kind: kind ?? null,
        count: 0,
        items: [],
      };
      const response = await request(url);
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        return empty;
      }
      const payload = (await response.json()) as Partial<ExtensionCatalogListResponse>;
      if (!Array.isArray(payload.items)) return empty;
      return {
        kind: typeof payload.kind === 'string' || payload.kind === null
          ? payload.kind
          : empty.kind,
        count: typeof payload.count === 'number' ? payload.count : payload.items.length,
        ...(typeof payload.generation === 'number' ? { generation: payload.generation } : {}),
        items: payload.items,
      };
    },

    async listSharedCapabilities() {
      const response = await request('/api/extensions/capabilities');
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        return { ...EMPTY_SHARED_CAPABILITIES, capabilities: [], issues: [] };
      }
      return (await response.json()) as SharedCapabilityListResponse;
    },
  };
}

export const restExtensionCatalogClient = createRestExtensionCatalogClient();
