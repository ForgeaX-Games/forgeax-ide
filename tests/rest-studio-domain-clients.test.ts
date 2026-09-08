import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRestStudioDomainClients } from '../src/integration/rest-studio-domain-clients';

const response = (body: unknown, status = 200) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
} as Response);

describe('IDE REST Studio domain integration', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(() => response({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('owns its transport contract without importing Interface', async () => {
    const source = await Bun.file(new URL('../src/integration/rest-studio-domain-clients.ts', import.meta.url)).text();

    expect(source).not.toContain('@forgeax/interface');
    expect(source).toContain('export interface RestStudioDomainClients');
  });

  test('lists games through the server authority', async () => {
    fetchMock.mockReturnValueOnce(response({ games: [{ slug: 'demo' }], activeSlug: null }));
    const result = await createRestStudioDomainClients().projects.listProjects();

    expect(fetchMock).toHaveBeenCalledWith('/api/projects');
    expect(result.games[0]?.slug).toBe('demo');
  });

  test('creates a game through the established JSON contract', async () => {
    fetchMock.mockReturnValueOnce(response({ ok: true }));
    const result = await createRestStudioDomainClients().projects.createProject({
      slug: 'demo',
      name: 'Demo',
      brief: '',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'demo', name: 'Demo', brief: '' }),
    });
    expect(result.ok).toBe(true);
  });

  test('renders a structured create error as useful text', async () => {
    fetchMock.mockReturnValueOnce(response({
      ok: false,
      error: {
        code: 'origin-not-allowed',
        hint: 'Only the local public IDE origin is allowed.',
      },
    }, 403));

    const result = await createRestStudioDomainClients().projects.createProject({
      slug: 'demo',
      name: 'Demo',
      brief: '',
    });

    expect(result).toEqual({
      ok: false,
      error: 'Only the local public IDE origin is allowed.',
    });
  });

  test('selects a game through the canonical active-game resource', async () => {
    fetchMock.mockReturnValueOnce(response({ activeSlug: 'demo' }));
    const result = await createRestStudioDomainClients().projects.setActiveProject('demo');

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/active', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'demo' }),
    });
    expect(result.activeSlug).toBe('demo');
  });

  test('links a project directory through the existing server contract', async () => {
    fetchMock.mockReturnValueOnce(response({ ok: true, slug: 'linked' }));
    const result = await createRestStudioDomainClients().projects.linkProject('/games/linked');

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/games/linked' }),
    });
    expect(result).toMatchObject({ ok: true, slug: 'linked' });
  });
});
