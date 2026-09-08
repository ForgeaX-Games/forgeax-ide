import { createElement, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Eye, File, FileCode, FileJson, FileText, Pencil, Save, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { AppExtension } from '@forgeax/app-shell/application';
import './files.css';

export interface FilesContributionRenderers {
  readonly FilesBrowser: ComponentType;
  readonly renderExplorer: () => ReactNode;
  readonly renderPreview: (context: { pageKey: { cardinality?: string; resourceId?: string } }) => ReactNode;
}

export function createFilesExtension(renderers: FilesContributionRenderers): AppExtension {
  return {
    id: '@forgeax/files',
    version: '0.1.0',
    requires: ['pages'],
    contributes: {
      panels: { detached: { FilesBrowser: renderers.FilesBrowser } },
      panelTypes: [
        {
          id: '@forgeax/files#panel/explorer',
          runtime: { kind: 'inline', render: renderers.renderExplorer },
        },
        {
          id: '@forgeax/files#panel/preview',
          runtime: { kind: 'inline', render: renderers.renderPreview },
        },
      ],
      pages: [
        {
          id: '@forgeax/files#page/explorer',
          title: 'Files',
          cardinality: 'singleton',
          restorePolicy: 'project',
          layoutVersion: 1,
          layout: {
            version: 1,
            root: { kind: 'tabs', placements: ['files-explorer'], active: 'files-explorer' },
          },
          panels: [{ id: 'files-explorer', panelTypeId: '@forgeax/files#panel/explorer' }],
        },
        {
          id: '@forgeax/files#page/preview',
          title: 'File',
          cardinality: 'resource',
          restorePolicy: 'project',
          layoutVersion: 1,
          layout: {
            version: 1,
            root: { kind: 'tabs', placements: ['file-preview'], active: 'file-preview' },
          },
          panels: [{ id: 'file-preview', panelTypeId: '@forgeax/files#panel/preview' }],
        },
      ],
      resourceEditors: [
        {
          id: '@forgeax/files#resource-editor/default',
          selector: { schemes: ['forgeax-file'] },
          pageTypeId: '@forgeax/files#page/preview',
          priority: 'default',
          sourceLayer: 'builtin',
        },
      ],
    },
  };
}

export type PreviewKind = 'text' | 'image' | 'audio' | 'video' | 'model' | 'binary';

export interface PreviewFile {
  path: string;
  kind: PreviewKind;
  mime: string;
  bytes: number;
  content?: string;
  dirty?: boolean;
  error?: string;
}

export interface FilePreviewSnapshot {
  openFiles: PreviewFile[];
  activeFilePath: string | null;
}

export type ReadFileResult =
  | { ok: true; kind: PreviewKind; mime: string; size: number; content?: string }
  | { ok: false; status: number; statusText: string; error?: string };

export interface FilesClient {
  readFile(path: string): Promise<ReadFileResult>;
  saveFile(path: string, content: string): Promise<{ ok: boolean; bytes?: number; error?: string }>;
  rawUrl(path: string): string;
}

export interface FilesRuntime {
  readonly client: FilesClient;
  peek(topic: string): unknown;
  publish(topic: string, payload: unknown, options?: { retain?: boolean }): void;
  subscribe(topic: string, listener: (payload: unknown) => void): () => void;
  useBusSnapshot(topic: string): unknown;
  openResource(resource: {
    canonicalId: string;
    uri: string;
    displayPath: string;
    mime: string;
    kind: PreviewKind;
  }): void | Promise<void>;
}

export const RESOURCE_FILES_TOPIC = 'resource-editor:files';
export const RESOURCE_OPEN_FILE_TOPIC = 'resource-editor:open-file';

const EMPTY: FilePreviewSnapshot = { openFiles: [], activeFilePath: null };
let runtime: FilesRuntime | null = null;

export function configureFilesRuntime(nextRuntime: FilesRuntime): void {
  runtime = nextRuntime;
}

function requireRuntime(): FilesRuntime {
  if (runtime === null) throw new Error('@forgeax/files runtime is not configured');
  return runtime;
}

function snapshot(): FilePreviewSnapshot {
  return (requireRuntime().peek(RESOURCE_FILES_TOPIC) as FilePreviewSnapshot | undefined) ?? EMPTY;
}

function commit(next: FilePreviewSnapshot): void {
  requireRuntime().publish(RESOURCE_FILES_TOPIC, next, { retain: true });
}

function enterFilesView(file: PreviewFile): void {
  void requireRuntime().openResource({
    canonicalId: file.path,
    uri: `forgeax-file://${file.path.replace(/^\/+/, '')}`,
    displayPath: file.path,
    mime: file.mime,
    kind: file.kind,
  });
}

function friendlyReadError(path: string, result: Extract<ReadFileResult, { ok: false }>): string {
  if (result.status === 400) return `${path} is outside the editable workspace${result.error ? ` — ${result.error}` : ''}`;
  if (result.status === 404) return `${path} no longer exists`;
  return `Could not open ${path}: HTTP ${result.status} ${result.statusText}${result.error ? ` — ${result.error}` : ''}`;
}

export async function openFile(path: string): Promise<void> {
  const current = snapshot();
  const existing = current.openFiles.find((file) => file.path === path);
  if (existing) {
    commit({ ...current, activeFilePath: path });
    enterFilesView(existing);
    return;
  }

  const addFile = (file: PreviewFile): void => {
    const latest = snapshot();
    commit({
      openFiles: [...latest.openFiles.filter((candidate) => candidate.path !== path), file],
      activeFilePath: path,
    });
    enterFilesView(file);
  };

  try {
    const result = await requireRuntime().client.readFile(path);
    if (!result.ok) {
      addFile({
        path,
        kind: 'text',
        mime: 'text/plain',
        bytes: 0,
        content: friendlyReadError(path, result),
        error: result.error ?? `${result.status} ${result.statusText}`,
      });
      return;
    }
    addFile({
      path,
      kind: result.kind,
      mime: result.mime,
      bytes: result.size,
      content: result.kind === 'text' ? (result.content ?? '') : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addFile({ path, kind: 'text', mime: 'text/plain', bytes: 0, content: `[error] ${message}`, error: message });
  }
}

export function activateFile(path: string): void {
  const current = snapshot();
  if (!current.openFiles.some((file) => file.path === path)) return;
  commit({ ...current, activeFilePath: path });
}

export function closeFile(path?: string): void {
  const current = snapshot();
  const target = path ?? current.activeFilePath;
  if (!target) return;
  const remaining = current.openFiles.filter((file) => file.path !== target);
  let nextActive = current.activeFilePath;
  if (current.activeFilePath === target) {
    const index = current.openFiles.findIndex((file) => file.path === target);
    nextActive = remaining[Math.max(0, index - 1)]?.path ?? remaining[0]?.path ?? null;
  }
  commit({ openFiles: remaining, activeFilePath: nextActive });
}

export function updatePreviewContent(content: string): void {
  const current = snapshot();
  if (!current.activeFilePath) return;
  const activeFile = current.openFiles.find((file) => file.path === current.activeFilePath);
  if (!activeFile || activeFile.kind !== 'text') return;
  commit({
    ...current,
    openFiles: current.openFiles.map((file) => (
      file.path === current.activeFilePath ? { ...file, content, dirty: true } : file
    )),
  });
}

export async function savePreviewFile(): Promise<{ ok: boolean; error?: string }> {
  const current = snapshot();
  const activeFile = current.openFiles.find((file) => file.path === current.activeFilePath);
  if (!activeFile) return { ok: false, error: 'no file open' };
  if (activeFile.kind !== 'text') return { ok: false, error: 'binary files are read-only' };

  try {
    const result = await requireRuntime().client.saveFile(activeFile.path, activeFile.content ?? '');
    if (!result.ok) return { ok: false, error: result.error ?? 'save failed' };
    const latest = snapshot();
    commit({
      ...latest,
      openFiles: latest.openFiles.map((file) => (
        file.path === activeFile.path ? { ...file, dirty: false, bytes: result.bytes ?? file.bytes } : file
      )),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function requestOpenFile(path: string): void {
  requireRuntime().publish(RESOURCE_OPEN_FILE_TOPIC, { path });
}

const INIT_FLAG = '__FORGEAX_FILES_INIT__';
type GlobalWithFiles = { [INIT_FLAG]?: boolean };

export function initFiles(): void {
  const globalState = globalThis as unknown as GlobalWithFiles;
  if (!requireRuntime().peek(RESOURCE_FILES_TOPIC)) commit(EMPTY);
  if (globalState[INIT_FLAG]) return;
  globalState[INIT_FLAG] = true;
  requireRuntime().subscribe(RESOURCE_OPEN_FILE_TOPIC, (payload) => {
    const path = (payload as { path?: unknown } | undefined)?.path;
    if (typeof path === 'string' && path.length > 0) void openFile(path);
  });
}

export function useFilePreview(): FilePreviewSnapshot {
  return (requireRuntime().useBusSnapshot(RESOURCE_FILES_TOPIC) as FilePreviewSnapshot | undefined) ?? EMPTY;
}

function rawUrl(path: string): string {
  return requireRuntime().client.rawUrl(path);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function iconFor(path: string): ComponentType<{ size?: number }> {
  if (path.endsWith('.json')) return FileJson;
  if (/\.(?:md|txt)$/i.test(path)) return FileText;
  if (/\.(?:ts|tsx|js|jsx|css|html|rs|toml|yaml|yml)$/i.test(path)) return FileCode;
  return File;
}

function FileTab({ file, active }: { file: PreviewFile; active: boolean }): ReactNode {
  const Icon = iconFor(file.path);
  const name = file.path.split('/').pop() ?? file.path;
  return (
    <button
      className={`fx-files-tab${active ? ' active' : ''}${file.dirty ? ' dirty' : ''}`}
      onClick={() => activateFile(file.path)}
      title={file.path}
      type="button"
    >
      <Icon size={13} />
      <span className="fx-files-tab-name">{name}</span>
      {file.dirty && <span className="fx-files-dirty" aria-label="Unsaved">●</span>}
      <span
        className="fx-files-close"
        role="button"
        tabIndex={0}
        aria-label={`Close ${name}`}
        onClick={(event) => { event.stopPropagation(); closeFile(file.path); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            closeFile(file.path);
          }
        }}
      ><X size={12} /></span>
    </button>
  );
}

function ModelPreview({ file }: { file: PreviewFile }): ReactNode {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    import('@google/model-viewer')
      .then(() => { if (!cancelled) setReady(true); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, []);
  if (error) return <BinaryPreview file={{ ...file, error }} />;
  if (!ready) return <div className="fx-files-centered">Loading 3D viewer…</div>;
  return (
    <div className="fx-files-asset fx-files-model">
      {createElement('model-viewer', {
        src: rawUrl(file.path),
        'camera-controls': true,
        'auto-rotate': true,
        'shadow-intensity': '0.8',
        exposure: '1',
      })}
      <AssetMeta file={file} />
    </div>
  );
}

function AssetMeta({ file }: { file: PreviewFile }): ReactNode {
  return <div className="fx-files-meta">{file.mime} · {formatBytes(file.bytes)}</div>;
}

function BinaryPreview({ file }: { file: PreviewFile }): ReactNode {
  return (
    <div className="fx-files-asset fx-files-binary">
      <div>{file.error ? `Preview unavailable: ${file.error}` : 'This binary file cannot be previewed.'}</div>
      <AssetMeta file={file} />
      <a href={rawUrl(file.path)} download>Download original</a>
    </div>
  );
}

function AssetPreview({ file, viewMode }: { file: PreviewFile; viewMode: 'source' | 'preview' }): ReactNode {
  if (file.kind === 'text') {
    if (file.path.endsWith('.md') && viewMode === 'preview') {
      return <div className="fx-files-markdown thin-scrollbar"><ReactMarkdown>{file.content ?? ''}</ReactMarkdown></div>;
    }
    return (
      <textarea
        className="fx-files-source thin-scrollbar"
        value={file.content ?? ''}
        spellCheck={false}
        onChange={(event) => updatePreviewContent(event.target.value)}
      />
    );
  }
  if (file.kind === 'image') {
    return <div className="fx-files-asset"><img src={rawUrl(file.path)} alt={file.path} /><AssetMeta file={file} /></div>;
  }
  if (file.kind === 'audio') {
    return <div className="fx-files-asset"><audio controls src={rawUrl(file.path)} preload="auto" /><AssetMeta file={file} /></div>;
  }
  if (file.kind === 'video') {
    return <div className="fx-files-asset"><video controls src={rawUrl(file.path)} preload="auto" /><AssetMeta file={file} /></div>;
  }
  if (file.kind === 'model') return <ModelPreview file={file} />;
  return <BinaryPreview file={file} />;
}

export function FilesEditor(): ReactNode {
  const { openFiles, activeFilePath } = useFilePreview();
  const activeFile = openFiles.find((file) => file.path === activeFilePath) ?? null;
  const isMarkdown = activeFile?.kind === 'text' && activeFile.path.endsWith('.md');
  const [viewMode, setViewMode] = useState<'source' | 'preview'>('source');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setViewMode(isMarkdown ? 'preview' : 'source');
    setSaveError(null);
  }, [activeFile?.path, isMarkdown]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    const result = await savePreviewFile();
    setSaving(false);
    if (!result.ok) setSaveError(result.error ?? 'save failed');
  };

  useEffect(() => {
    if (!activeFile?.dirty) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFile?.dirty, activeFile?.path]);

  return (
    <div className="fx-files">
      <div className="fx-files-tabs">
        {openFiles.map((file) => <FileTab key={file.path} file={file} active={file.path === activeFilePath} />)}
        {activeFile?.kind === 'text' && (
          <div className="fx-files-actions">
            {isMarkdown && (
              <div className="fx-files-toggle">
                <button type="button" className={viewMode === 'preview' ? 'active' : ''} onClick={() => setViewMode('preview')}><Eye size={12} /> Preview</button>
                <button type="button" className={viewMode === 'source' ? 'active' : ''} onClick={() => setViewMode('source')}><Pencil size={12} /> Source</button>
              </div>
            )}
            <button type="button" className="fx-files-save" onClick={() => void save()} disabled={!activeFile.dirty || saving}>
              <Save size={12} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
      <div className="fx-files-content">
        {!activeFile && <div className="fx-files-empty">Select a file from the explorer to preview or edit it.</div>}
        {activeFile && <AssetPreview file={activeFile} viewMode={viewMode} />}
        {saveError && <div className="fx-files-error">Save failed: {saveError}</div>}
      </div>
    </div>
  );
}

function FileResourcePanel({ pageKey }: { pageKey: { cardinality?: string; resourceId?: string } }): ReactNode {
  useEffect(() => {
    if (pageKey.cardinality === 'resource' && pageKey.resourceId) void openFile(pageKey.resourceId);
  }, [pageKey.cardinality, pageKey.resourceId]);
  return <FilesEditor />;
}

export function createFilesContribution(): AppExtension {
  return createFilesExtension({
    FilesBrowser: FilesEditor as ComponentType,
    renderExplorer: () => <FilesEditor />,
    renderPreview: (context) => <FileResourcePanel pageKey={context.pageKey} />,
  });
}
