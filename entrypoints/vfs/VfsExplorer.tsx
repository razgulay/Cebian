import { useState, useEffect, useRef, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { vfs } from '@/lib/persistence/vfs';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference, vfsOpenPreferenceV1 } from '@/lib/persistence/storage';
import { downloadFile } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { t } from '@/lib/i18n';
import { applyTheme, resolveTheme } from './lib/theme';
import { MAX_PREVIEW_BYTES, classifyFile, decodePreviewText, fileExtension, getHashPath, getRequestedAnchor, isWorkspacesRoot, navigateTo, workspaceUuidOf } from './lib/path-utils';
import { mimeFor } from '@/lib/content/mime';
import { zipDirectory, zipNameFor } from './lib/download';
import { resolveWorkspaceLabels } from './lib/session-labels';
import { Breadcrumbs } from './ui/Breadcrumbs';
import { DirView } from './ui/DirView';
import { FileView } from './ui/FileView';
import type { FileMedia, ViewState } from './types';

export function VfsExplorer({
  /**
   * Optional host-aware exit handler. When provided, a back button is
   * rendered at the start of the header so users can leave the file
   * browser without reaching for the sidepanel's browser back.
   *
   * Standalone `vfs.html` (no Router ancestor) leaves this undefined and
   * skips the button — the host page already has its own close affordance.
   * The sidepanel mount passes `() => navigate(-1)` so the back action
   * returns to whichever route preceded `/vfs` in MemoryRouter history
   * (typically `/chat/<sessionId>` or `/chat/new`).
   */
  onClose,
}: {
  onClose?: () => void;
} = {}) {
  const [theme] = useStorageItem(themePreference, 'system');
  const [openPreference, setOpenPreference] = useStorageItem(vfsOpenPreferenceV1, 'smart');
  const [themeReady, setThemeReady] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  // Global busy flag for the download button. Kept outside `view` because a
  // download started on `/prompts` MUST keep running even if the user
  // navigates away mid-zip (decision A: don't interrupt explicit downloads).
  // The handler captures its target path from the closure at click time, so
  // the in-flight task is independent of subsequent view changes.
  const [isDownloading, setIsDownloading] = useState(false);

  // ── Theme sync ──
  useEffect(() => {
    themePreference.getValue().then((val) => {
      applyTheme(resolveTheme(val ?? 'system'));
      setThemeReady(true);
    });
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    applyTheme(resolveTheme(theme));
  }, [theme, themeReady]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // ── Load path from hash ──
  //
  // Two pieces of cross-call state live in refs:
  //
  // 1. `loadIdRef` — every call to loadPath() captures a monotonically
  //    increasing id at entry and re-checks it after each await. A rapid
  //    sequence of hashchange events (or a hashchange that fires while a
  //    previous load is still resolving) would otherwise let a stale
  //    setView win the race. The old `let stale` flag only flipped on
  //    effect unmount, so it could not protect against this.
  //
  // 2. `blobUrlRef` — image/video/audio media is exposed as `URL.createObjectURL`.
  //    We revoke the previous URL before issuing a new one (and on unmount)
  //    to keep memory bounded across many navigations.
  const loadIdRef = useRef(0);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!themeReady) return;

    function revokeBlobUrl() {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    }

    async function loadPath() {
      const myId = ++loadIdRef.current;
      const p = getHashPath();
      revokeBlobUrl();
      setView({ kind: 'loading' });

      try {
        const st = await vfs.stat(p);
        if (myId !== loadIdRef.current) return;

        if (st.isDirectory()) {
          const names = await vfs.readdir(p);
          if (myId !== loadIdRef.current) return;
          const entries = await Promise.all(
            names.map(async (name) => {
              const childPath = p === '/' ? `/${name}` : `${p}/${name}`;
              try {
                const childStat = await vfs.stat(childPath);
                return { name, isDir: childStat.isDirectory(), size: childStat.size };
              } catch {
                return { name, isDir: false, size: 0 };
              }
            }),
          );
          if (myId !== loadIdRef.current) return;

          // 工作区根 `/workspaces`：把 UUID 子目录翻译成「会话标题 · 日期」。
          // 工作区目录 `/workspaces/<uuid>`：解析顶部信息条。两者共用一次批量查库。
          if (isWorkspacesRoot(p)) {
            const uuids = entries.filter((e) => e.isDir).map((e) => e.name);
            const workspaceLabels = await resolveWorkspaceLabels(uuids);
            if (myId !== loadIdRef.current) return;
            setView({ kind: 'dir', path: p, entries, workspaceLabels });
            return;
          }
          const uuid = workspaceUuidOf(p);
          if (uuid) {
            const labels = await resolveWorkspaceLabels([uuid]);
            if (myId !== loadIdRef.current) return;
            setView({ kind: 'dir', path: p, entries, workspaceRow: labels.get(uuid) });
            return;
          }

          setView({ kind: 'dir', path: p, entries });
          return;
        }

        // File branch. One blanket size guard for every type — a 50 MB
        // markdown file is just as painful to render as a 50 MB image,
        // and the placeholder still lets the user fall back to Download.
        if (st.size > MAX_PREVIEW_BYTES) {
          setView({ kind: 'file', path: p, media: { type: 'tooLarge', size: st.size } });
          return;
        }

        const name = p.split('/').pop() ?? '';
        const ext = fileExtension(name);
        const klass = classifyFile(name);
        let media: FileMedia;

        if (klass === 'text' || klass === 'markdown') {
          const raw = (await vfs.readFile(p)) as unknown as Uint8Array;
          if (myId !== loadIdRef.current) return;
          const content = decodePreviewText(raw);
          media = content === null
            ? { type: 'unknown', size: st.size }
            : { type: klass, content, size: st.size };
        } else if (klass === 'pdf') {
          const data = (await vfs.readFile(p)) as unknown as Uint8Array;
          if (myId !== loadIdRef.current) return;
          media = { type: 'pdf', data, size: st.size };
        } else if (klass === 'image' || klass === 'video' || klass === 'audio') {
          const data = (await vfs.readFile(p)) as unknown as Uint8Array;
          if (myId !== loadIdRef.current) return;
          const mime = mimeFor(ext);
          // `as BlobPart` for the same reason as the download path: the TS
          // DOM lib types Uint8Array<ArrayBufferLike> which BlobPart's
          // ArrayBufferView constraint won't accept directly, but the vfs
          // always hands us a plain ArrayBuffer-backed view.
          const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
          blobUrlRef.current = url;
          media = { type: klass, mime, size: st.size, url };
        } else if (klass === 'binary' || klass === 'unknown') {
          // No read — just surface size. Download still works independently.
          media = { type: klass, size: st.size };
        } else {
          // Exhaustiveness guard — matches FileView's pattern. If
          // classifyFile's return union ever grows, TS will flag this.
          const _exhaustive: never = klass;
          throw new Error(`unreachable file class: ${_exhaustive}`);
        }

        setView({ kind: 'file', path: p, media });
      } catch (err: any) {
        if (myId !== loadIdRef.current) return;
        const message =
          err?.code === 'ENOENT'
            ? t('vfs.pathNotFound', [p])
            : err?.message ?? t('vfs.unknownError');
        setView({ kind: 'error', path: p, message });
      }
    }

    loadPath();
    window.addEventListener('hashchange', loadPath);
    return () => {
      // Invalidate any in-flight load and revoke the last blob URL so we
      // don't leak object URLs across remounts.
      loadIdRef.current++;
      revokeBlobUrl();
      window.removeEventListener('hashchange', loadPath);
    };
  }, [themeReady]);

  useEffect(() => {
    if (view.kind !== 'file' || view.media.type !== 'markdown') return;
    const anchor = getRequestedAnchor();
    if (!anchor) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [view]);

  // ── Download (file or zipped folder) ──
  //
  // Snapshots `view` into a const before the first await so a concurrent
  // hashchange that flips us to a different path can't redirect the
  // download to the wrong content. We intentionally do NOT abort on
  // navigation — see the `isDownloading` declaration comment.
  async function handleDownload() {
    if (isDownloading) return;
    const snapshot = view;
    if (snapshot.kind !== 'file' && snapshot.kind !== 'dir') return;

    setIsDownloading(true);
    try {
      if (snapshot.kind === 'file') {
        const data = (await vfs.readFile(snapshot.path)) as unknown as Uint8Array;
        const name = snapshot.path.split('/').pop() || 'file';
        // Wrap in Blob — `downloadFile` accepts ArrayBuffer/Blob/string but
        // not Uint8Array directly. The `as BlobPart` cast is required: the
        // current TS DOM lib types `Uint8Array<ArrayBufferLike>` which
        // includes SharedArrayBuffer, but BlobPart only accepts plain
        // ArrayBuffer-backed views. The vfs always hands us regular
        // ArrayBuffer, so the cast is sound. Generic octet-stream mime
        // keeps the browser from rewriting the extension (e.g. .md → .txt).
        downloadFile(name, new Blob([data as BlobPart], { type: 'application/octet-stream' }), 'application/octet-stream');
      } else {
        const data = await zipDirectory(snapshot.path);
        downloadFile(zipNameFor(snapshot.path), new Blob([data as BlobPart], { type: 'application/zip' }), 'application/zip');
      }
    } catch (err) {
      console.error('[vfs.download]', err);
      toast.error(t('common.downloadFailed'));
    } finally {
      setIsDownloading(false);
    }
  }

  // ── Render ──

  if (!themeReady) return null;

  const currentPath = view.kind !== 'loading' ? view.path : getHashPath();

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen bg-background text-foreground">
        {/* Header */}
        <header className="flex flex-wrap items-center gap-2 sm:gap-4 px-3 sm:px-5 py-3 border-b border-border shrink-0">
          {onClose && (
            <button
              type="button"
              onClick={(e: MouseEvent<HTMLButtonElement>) => {
                // blur so the focus ring doesn't linger on the button after
                // the route change removes it from DOM
                e.currentTarget.blur();
                onClose();
              }}
              title={t('common.back')}
              aria-label={t('common.back')}
              className="shrink-0 size-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-base font-semibold tracking-tight">VFS</span>
            <span className="hidden sm:inline text-xs text-muted-foreground/50 font-mono">cebian</span>
          </div>
          <div className="h-4 w-px bg-border shrink-0" />
          <div className="flex-1 min-w-0">
            <Breadcrumbs path={currentPath} />
          </div>
          <select
            value={openPreference}
            onChange={(event) => setOpenPreference(event.target.value as typeof openPreference)}
            aria-label={t('vfs.defaultOpen')}
            title={t('vfs.defaultOpen')}
            className="h-7 min-w-0 max-w-28 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            <option value="smart">{t('vfs.openSmart')}</option>
            <option value="preview">{t('vfs.preview')}</option>
            <option value="source">{t('vfs.source')}</option>
          </select>
          {/* Keep the button mounted while a download is in flight, even if
           *  `view` has flipped to `loading` because the user navigated
           *  away — otherwise the spinner unmounts and the user loses the
           *  busy indicator until the download finishes. Hidden only on
           *  `error` (nothing to download) and on a clean `loading` state
           *  with no active download. */}
          {(view.kind === 'file' || view.kind === 'dir' || isDownloading) && (
            <button
              onClick={handleDownload}
              disabled={isDownloading}
              title={isDownloading ? t('vfs.zipping') : t('common.download')}
              aria-label={isDownloading ? t('vfs.zipping') : t('common.download')}
              className="shrink-0 size-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              {isDownloading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
            </button>
          )}
        </header>

        {/* Main content */}
        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-3 sm:px-5 py-5">
            {view.kind === 'loading' && (
              <div className="flex items-center justify-center py-20">
                <div className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            )}

            {view.kind === 'dir' && (
              <DirView
                path={view.path}
                entries={view.entries}
                workspaceLabels={view.workspaceLabels}
                workspaceRow={view.workspaceRow}
              />
            )}

            {view.kind === 'file' && (
              <FileView path={view.path} media={view.media} openPreference={openPreference} />
            )}

            {view.kind === 'error' && (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <span className="text-destructive text-lg">!</span>
                </div>
                <p className="text-sm text-muted-foreground">{view.message}</p>
                <button
                  onClick={() => navigateTo('/')}
                  className="mt-2 text-xs text-primary hover:underline"
                >
                  {t('vfs.backToRoot')}
                </button>
              </div>
            )}
          </div>
        </main>
        <Toaster theme={resolveTheme(theme)} />
      </div>
    </TooltipProvider>
  );
}
