export type RuntimeScopeState = Record<string, unknown>;

export interface ActiveProjectSelection {
  activeSlug: string | null;
  runtime?: RuntimeScopeState;
}

export interface RestStudioDomainClients {
  agents: {
    listAgents(options?: { lang?: 'zh' | 'en' }): Promise<{ agents: Array<Record<string, unknown>> }>;
  };
  projects: {
    getActiveProject(): Promise<ActiveProjectSelection>;
    setActiveProject(slug: string): Promise<ActiveProjectSelection>;
    subscribeActiveProject(listener: (selection: ActiveProjectSelection) => void): () => void;
    listProjects(): Promise<{ games: Array<{ slug: string; [key: string]: unknown }>; activeSlug: string | null }>;
    createProject(input: { slug: string; name: string; brief: string; template?: string }): Promise<{ ok: boolean; error?: string }>;
    linkProject(path: string): Promise<{ ok: boolean; error?: string; slug?: string }>;
    deleteProject(slug: string): Promise<void>;
  };
  builds: {
    buildProject(slug: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
    pollBuildJob(jobId: string): Promise<Record<string, unknown>>;
    getEngineRoots(): Promise<{ roots: Array<Record<string, unknown>> }>;
    cleanBuilds(): Promise<Record<string, unknown>>;
    listBuildHistory(): Promise<{ records: Array<Record<string, unknown>> }>;
    deleteBuildHistory(id: string, options?: { clean?: boolean }): Promise<void>;
  };
}

const ACTIVE_PROJECT_STREAM_URL = '/api/events/stream?topic=projects.active.changed';
const TRANSIENT_RETRIES = 8;
const TRANSIENT_RETRY_DELAY_MS = 250;

function apiErrorMessage(raw: unknown, status: number): string {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (raw !== null && typeof raw === 'object') {
    const error = raw as { hint?: unknown; message?: unknown; code?: unknown };
    for (const value of [error.hint, error.message, error.code]) {
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  return `HTTP ${status}`;
}

function normalizeActiveProject(raw: unknown): ActiveProjectSelection | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as { activeSlug?: unknown; runtime?: unknown };
  if (!(candidate.activeSlug === null || typeof candidate.activeSlug === 'string')) return null;
  return candidate.runtime !== undefined && candidate.runtime !== null && typeof candidate.runtime === 'object'
    ? { activeSlug: candidate.activeSlug, runtime: candidate.runtime as RuntimeScopeState }
    : { activeSlug: candidate.activeSlug };
}

function activeProjectFromEnvelope(raw: string): ActiveProjectSelection | null {
  try {
    return normalizeActiveProject((JSON.parse(raw) as { payload?: unknown }).payload);
  } catch {
    return null;
  }
}

async function followActiveProjectStream(
  response: Response,
  listener: (selection: ActiveProjectSelection) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.ok || !response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data = '';
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (event === 'event' && data) {
            const selection = activeProjectFromEnvelope(data);
            if (selection) listener(selection);
          }
          event = '';
          data = '';
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data += `${data ? '\n' : ''}${line.slice(5).trim()}`;
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
  }
}

export function createRestStudioDomainClients(): RestStudioDomainClients {
  return {
    agents: {
      async listAgents(options) {
        const response = await fetch(options?.lang === 'zh'
          ? '/api/agents?lang=zh'
          : '/api/agents');
        if (!response.ok) throw new Error(`listAgents → HTTP ${response.status}`);
        return response.json();
      },
    },
    projects: {
    async getActiveProject() {
      const response = await fetch('/api/projects/active');
      if (!response.ok) return { activeSlug: null };
      return normalizeActiveProject(await response.json()) ?? { activeSlug: null };
    },
    async setActiveProject(slug) {
      let response: Response;
      for (let attempt = 0; ; attempt += 1) {
        response = await fetch('/api/projects/active', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug }),
        });
        if (response.status !== 503 || attempt >= TRANSIENT_RETRIES) break;
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      }
      if (!response.ok) throw new Error(`setActiveProject → HTTP ${response.status}`);
      const selection = normalizeActiveProject(await response.json());
      if (!selection) throw new Error('setActiveProject → invalid active-project response');
      return selection;
    },
    subscribeActiveProject(listener) {
      const readAuthority = () => fetch('/api/projects/active')
        .then((response) => response.ok ? response.json() : null)
        .then((raw: unknown) => {
          const selection = normalizeActiveProject(raw);
          if (selection) listener(selection);
        })
        .catch(() => undefined);

      if (typeof EventSource === 'undefined') {
        let closed = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let controller: AbortController | undefined;
        const connect = async (): Promise<void> => {
          controller = new AbortController();
          try {
            const response = await fetch(ACTIVE_PROJECT_STREAM_URL, { signal: controller.signal });
            if (closed) return;
            await readAuthority();
            await followActiveProjectStream(response, listener, controller.signal);
          } catch { /* reconnect below */ }
          if (!closed) retryTimer = setTimeout(() => void connect(), 1_000);
        };
        void connect();
        return () => {
          closed = true;
          if (retryTimer !== undefined) clearTimeout(retryTimer);
          controller?.abort();
        };
      }

      const source = new EventSource(ACTIVE_PROJECT_STREAM_URL);
      const onOpen = () => void readAuthority();
      const onEvent = (event: Event) => {
        const selection = activeProjectFromEnvelope((event as MessageEvent<string>).data);
        if (selection) listener(selection);
      };
      source.addEventListener('open', onOpen);
      source.addEventListener('event', onEvent);
      return () => {
        source.removeEventListener('open', onOpen);
        source.removeEventListener('event', onEvent);
        source.close();
      };
    },
    async listProjects() {
      const response = await fetch('/api/projects');
      if (!response.ok) throw new Error(`listProjects → HTTP ${response.status}`);
      return response.json();
    },
    async createProject(input) {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; error?: unknown } | null;
      const ok = Boolean(response.ok && body?.ok);
      return { ok, error: ok ? undefined : apiErrorMessage(body?.error, response.status) };
    },
    async linkProject(path) {
      const response = await fetch('/api/projects/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; error?: unknown; slug?: string } | null;
      const ok = Boolean(response.ok && body?.ok);
      return {
        ok,
        error: ok ? undefined : apiErrorMessage(body?.error, response.status),
        slug: body?.slug,
      };
    },
    async deleteProject(slug) {
      const response = await fetch(`/api/projects/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`deleteProject → HTTP ${response.status}`);
    },
    },
    builds: {
    async buildProject(slug, options) {
      const hasBody = options != null;
      const response = await fetch(`/api/projects/${encodeURIComponent(slug)}/builds`, {
        method: 'POST',
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(options) : undefined,
      });
      if (!response.ok) throw new Error(`buildProject → HTTP ${response.status}`);
      return response.json();
    },
    async pollBuildJob(jobId) {
      const response = await fetch(`/api/project-builds/jobs/${encodeURIComponent(jobId)}`);
      if (!response.ok) throw new Error(`pollBuildJob → HTTP ${response.status}`);
      return response.json();
    },
    async getEngineRoots() {
      const response = await fetch('/api/project-builds/engine-roots');
      return response.ok ? response.json() : { roots: [] };
    },
    async cleanBuilds() {
      const response = await fetch('/api/project-builds/clean', { method: 'POST' });
      if (!response.ok) throw new Error(`cleanBuilds → HTTP ${response.status}`);
      return response.json();
    },
    async listBuildHistory() {
      const response = await fetch('/api/project-builds/history');
      return response.ok ? response.json() : { records: [] };
    },
    async deleteBuildHistory(id, options) {
      const suffix = options?.clean ? '?clean=1' : '';
      const response = await fetch(`/api/project-builds/history/${encodeURIComponent(id)}${suffix}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(`deleteBuildHistory → HTTP ${response.status}`);
    },
    },
  };
}
