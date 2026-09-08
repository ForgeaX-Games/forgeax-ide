import type { FilesClient, PreviewKind } from '@forgeax/files';

export function createRestFilesClient(): FilesClient {
  return {
    async readFile(path) {
      const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      if (!response.ok) {
        let error: string | undefined;
        try { error = ((await response.json()) as { error?: string }).error; } catch { /* non-JSON response */ }
        return { ok: false, status: response.status, statusText: response.statusText, error };
      }
      const body = (await response.json()) as { kind?: PreviewKind; mime?: string; size?: number; content?: string };
      return {
        ok: true,
        kind: body.kind ?? 'text',
        mime: body.mime ?? 'application/octet-stream',
        size: body.size ?? 0,
        content: body.content,
      };
    },
    async saveFile(path, content) {
      const response = await fetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content }),
      });
      const body = (await response.json()) as { bytes?: number; error?: string };
      return { ok: response.ok, bytes: body.bytes, error: body.error };
    },
    rawUrl(path) {
      return `/api/files/raw?path=${encodeURIComponent(path)}`;
    },
  };
}
