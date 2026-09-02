import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Code, Eye, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { CopyButton } from '@/components/common/CopyButton';
import { MarkdownRenderer } from '@/components/common/MarkdownRenderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { parseFrontmatter } from '@/lib/content/frontmatter';
import { createPdfPreviewController, resolvePdfRenderScale, type PdfIntrinsicMeasurement } from '@/lib/content/pdf-loader';
import { t } from '@/lib/i18n';
import { fileExtension, formatSize, pickFileIcon, resolvePreviewOpenMode, type VfsOpenPreference } from '../lib/path-utils';
import type { FileMedia } from '../types';

export function FileView({ path, media, openPreference }: { path: string; media: FileMedia; openPreference: VfsOpenPreference }) {
  const name = path.split('/').pop() ?? path;
  const ext = fileExtension(name);
  const Icon = pickFileIcon(ext);

  // Header is shared across all media types. Each branch passes only the
  // bits that apply to its type (copy / line count / size / toggle), keeping
  // the per-type header rules colocated with the body.
  const renderHeader = (right: React.ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-2.5 bg-card border-b border-border">
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon size={18} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium truncate">{name}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{right}</div>
    </div>
  );

  const sizeBadge = (
    <span className="text-xs text-muted-foreground tabular-nums">{formatSize(media.size)}</span>
  );

  switch (media.type) {
    case 'text': {
      const lineCount = media.content.length === 0 ? 0 : media.content.split('\n').length;
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(
            <>
              <CopyButton text={media.content} />
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">{t('vfs.lines', [lineCount])}</span>
                <span className="text-border">·</span>
                <span className="tabular-nums">{formatSize(media.size)}</span>
              </div>
            </>,
          )}
          <div className="relative overflow-auto max-h-[calc(100vh-12rem)]">
            <pre className="p-4 text-[13px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap wrap-break-word selection:bg-primary/20">
              {media.content}
            </pre>
          </div>
        </div>
      );
    }
    case 'markdown':
      return <MarkdownFileView key={`${path}:${openPreference}`} path={path} media={media} openPreference={openPreference} renderHeader={renderHeader} />;
    case 'html':
      return <HtmlFileView key={`${path}:${openPreference}`} name={name} media={media} openPreference={openPreference} renderHeader={renderHeader} />;
    case 'pdf':
      return <PdfFileView media={media} renderHeader={renderHeader} />;
    case 'image':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="bg-muted/30 flex items-center justify-center overflow-auto max-h-[calc(100vh-12rem)]">
            <img
              src={media.url}
              alt={name}
              className="max-w-full max-h-[calc(100vh-12rem)] object-contain"
            />
          </div>
        </div>
      );
    case 'video':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="bg-muted/30 flex items-center justify-center">
            <video
              src={media.url}
              controls
              className="max-w-full max-h-[calc(100vh-12rem)]"
            />
          </div>
        </div>
      );
    case 'audio':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="bg-muted/30 flex items-center justify-center p-6">
            <audio src={media.url} controls className="w-full max-w-md" />
          </div>
        </div>
      );
    case 'binary':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="p-4 text-[13px] text-muted-foreground italic">
            {t('vfs.binaryFile', [formatSize(media.size)])}
          </div>
        </div>
      );
    case 'unknown':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="p-4 text-[13px] text-muted-foreground">
            {t('vfs.unknownFile', [formatSize(media.size)])}
          </div>
        </div>
      );
    case 'tooLarge':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="p-4 text-[13px] text-muted-foreground">
            {t('vfs.tooLargeToPreview', [formatSize(media.size)])}
          </div>
        </div>
      );
    default: {
      // Exhaustiveness guard — if a new FileMedia variant is added without
      // a matching case, TS will flag this assignment at compile time
      // rather than letting React silently render `undefined` at runtime.
      const _exhaustive: never = media;
      return _exhaustive;
    }
  }
}

/** Shell for any "preview / view source" file viewer. Owns the toggle
 *  state (so it persists across navigations to the same file class), the
 *  shared header chrome (toggle + copy + lines/size), and the source `<pre>`
 *  fallback. Callers supply only the preview body — Markdown pipes through
 *  `<MarkdownRenderer>` (with frontmatter), HTML pipes through a sandboxed
 *  `<iframe>` pointed at `entrypoints/html-preview.sandbox/`.
 *
 *  Toggle state persistence: like `MarkdownFileView` before it, React keeps
 *  this component mounted at the same JSX slot for a given file class, so
 *  `useState` survives a media-only change. State naturally resets only
 *  when leaving the file class entirely (different file / dir / error).
 *
 *  `previewPersistent`: when true, `renderPreview()` is mounted in BOTH
 *  modes (hidden via `display:none` when not active). Use this when the
 *  preview is expensive to remount — e.g. an `<iframe>` whose document is
 *  driven by postMessage, where remounting would lose script state. The
 *  default (`false`) unmounts `renderPreview()` on source-mode toggle, which
 *  is fine for cheap previews like Markdown (cheap to re-render). */
function PreviewSourceFrame({
  media,
  openPreference,
  renderHeader,
  renderPreview,
  previewPersistent = false,
}: {
  media: { content: string; size: number };
  openPreference: VfsOpenPreference;
  renderHeader: (right: React.ReactNode) => React.ReactNode;
  renderPreview: () => React.ReactNode;
  previewPersistent?: boolean;
}) {
  const [mode, setMode] = useState<'preview' | 'source'>(() => resolvePreviewOpenMode(openPreference));
  const lineCount = media.content.length === 0 ? 0 : media.content.split('\n').length;
  const showingPreview = mode === 'preview';

  const toggle = (
    <div className="flex items-center rounded-md border border-border p-0.5">
      <ModeButton active={showingPreview} label={t('vfs.preview')} onClick={() => setMode('preview')}><Eye className="size-3.5" /></ModeButton>
      <ModeButton active={!showingPreview} label={t('vfs.viewSource')} onClick={() => setMode('source')}><Code className="size-3.5" /></ModeButton>
    </div>
  );

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {renderHeader(
        <>
          {toggle}
          {/* Copy always copies the raw source, regardless of mode — that's
           *  what users want to paste elsewhere. */}
          <CopyButton text={media.content} />
          {/* Line count + size always shown in both modes — hiding lines in
           *  preview mode would shift the toggle button horizontally on every
           *  click, which makes repeated toggling a frustrating moving target. */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{t('vfs.lines', [lineCount])}</span>
            <span className="text-border">·</span>
            <span className="tabular-nums">{formatSize(media.size)}</span>
          </div>
        </>,
      )}
      <div className="relative overflow-auto max-h-[calc(100vh-12rem)]">
        {previewPersistent && (
          // Persistent preview — always mounted, hidden via display when in
          // source mode. Rendered FIRST so the <pre> stacks on top via DOM
          // order (later sibling paints on top with same z-index). Keeps the
          // preview's internal state (e.g. iframe scripts) intact across
          // toggle clicks.
          <div className={showingPreview ? 'block' : 'hidden'}>{renderPreview()}</div>
        )}
        {showingPreview ? (
          !previewPersistent && renderPreview()
        ) : (
          <pre className="p-4 text-[13px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap wrap-break-word selection:bg-primary/20">
            {media.content}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Markdown variant — pipes the preview body through `<MarkdownRenderer>`
 *  with a GitHub-style frontmatter table prepended when present. */
function MarkdownFileView({
  path,
  media,
  openPreference,
  renderHeader,
}: {
  path: string;
  media: Extract<FileMedia, { type: 'markdown' }>;
  openPreference: VfsOpenPreference;
  renderHeader: (right: React.ReactNode) => React.ReactNode;
}) {
  // Split frontmatter out so we can render it as a GitHub-style table in
  // preview mode. Memoize because parsing scans the whole document.
  const { frontmatterData, body } = useMemo(() => {
    const { data, body: rest } = parseFrontmatter(media.content);
    return { frontmatterData: data, body: rest };
  }, [media.content]);
  const hasFrontmatter = Object.keys(frontmatterData).length > 0;

  return (
    <PreviewSourceFrame
      media={media}
      openPreference={openPreference}
      renderHeader={renderHeader}
      renderPreview={() => (
        // Prose neutralizers (prose-code: + prose-pre:) cancel out
        // typography defaults that conflict with MarkdownRenderer's own
        // styling: prose injects literal backticks around inline <code>
        // and gives <pre> a dark slate background that overrides our
        // CodeBlock's container. We keep typography for headings / lists
        // / blockquotes / tables, but hand code rendering back to
        // MarkdownRenderer.
        <div
          className={
            'prose prose-sm dark:prose-invert max-w-none p-4 ' +
            'prose-code:before:content-none prose-code:after:content-none prose-code:font-normal ' +
            'prose-pre:bg-transparent prose-pre:text-inherit prose-pre:p-0 prose-pre:m-0 prose-pre:rounded-none prose-pre:font-normal'
          }
        >
          {hasFrontmatter && <FrontmatterTable data={frontmatterData} />}
          <MarkdownRenderer content={body} currentVfsPath={path} />
        </div>
      )}
    />
  );
}

function ModeButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} aria-pressed={active} onClick={onClick} className={`size-6 inline-flex items-center justify-center rounded ${active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** HTML preview variant — pipes the preview body through a sandboxed
 *  `<iframe>` pointed at the dedicated `entrypoints/html-preview.sandbox/`
 *  entrypoint. The host (this page) ships the document via postMessage;
 *  the sandbox page renders it inside an inner iframe with its own
 *  `sandbox="allow-scripts allow-same-origin allow-forms"` so the rendered
 *  HTML actually runs.
 *
 *  Why a dedicated sandbox entrypoint instead of `<iframe srcDoc>` here:
 *  srcdoc iframes inherit the parent's CSP. Extension pages run under
 *  Chrome's strict `script-src 'self'` (MV3 forbids `'unsafe-inline'` for
 *  `extension_pages`), so inline `<script>`, `onclick=`, and DOMContentLoaded
 *  handlers in the previewed HTML all get blocked. Sandbox pages are
 *  served from a separate origin under the manifest `sandbox` CSP, which
 *  allows `'unsafe-inline'`. The trade-off is one extra hop — but the
 *  opaque origin of the sandbox page means the previewed script's "same
 *  origin" is a unique opaque one, so the Chrome warning about
 *  `allow-scripts + allow-same-origin` escaping the sandbox does not apply:
 *  there's nothing to escape into.
 *
 *  Outer iframe `sandbox` tokens: same as the inner iframe's (so modals
 *  triggered inside the previewed document work end-to-end — without
 *  `allow-modals` Chrome drops `alert()`/`confirm()`/`prompt()` calls
 *  with "document is sandboxed, and the 'allow-modals' keyword is not
 *  set"). `allow-popups` and `allow-top-navigation` are deliberately
 *  excluded so a hostile previewed document can't navigate the parent
 *  tab or spawn windows via `window.open`.
 *
 *  Trust model: the rendered file is the user's own VFS content (hand-
 *  written or generated by an agent they control), same as the existing
 *  download-then-open-in-Chrome workflow. The opaque sandbox origin
 *  contains the blast radius — a misbehaving script can't reach the
 *  extension's storage, IPC, or DOM.
 *
 *  Source mode: `PreviewSourceFrame` keeps the outer iframe mounted but
 *  hides it (`previewPersistent: true`); switching back to preview mode is
 *  instant and preserves the preview's internal state. Without this, each
 *  toggle would re-mount the iframe and re-srcdoc the document, which
 *  resets script state — frustrating for interactive previews like
 *  dashboards where the user expects their clicks to persist across
 *  a quick source peek.
 *
 *  Handshake: the host mounts the outer iframe and can compute the
 *  `postMessage` call before the sandbox's top-level script has had a
 *  chance to register its `message` listener. Chromium does NOT
 *  reliably buffer cross-document messages sent before listeners attach —
 *  under load the first `set` is silently dropped, leaving the inner
 *  iframe blank. The sandbox announces itself with a `{ type:
 *  'sandbox:ready' }` event once its DOMContentLoaded has fired (i.e.
 *  its listener is live), and we cache the latest payload in refs and
 *  flush it on that signal. `onLoad` on the outer iframe is also a
 *  safe fallback (load fires after the inner page's deferred scripts
 *  have executed), used if the `ready` event is somehow lost.
 */
const HTML_PREVIEW_FRAME_URL = browser.runtime.getURL('/html-preview.html');

interface HtmlPreviewSetMessage {
  type: 'html-preview:set';
  html: string;
  name: string;
}
interface HtmlPreviewClearMessage {
  type: 'html-preview:clear';
}
interface SandboxReadyMessage {
  type: 'sandbox:ready';
}

function HtmlFileView({
  name,
  media,
  openPreference,
  renderHeader,
}: {
  name: string;
  media: Extract<FileMedia, { type: 'html' }>;
  openPreference: VfsOpenPreference;
  renderHeader: (right: React.ReactNode) => React.ReactNode;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Latest payload cached in refs (not state) so a media change during
  // the handshake window doesn't trigger a React re-render — we only
  // need the most recent values when the sandbox is finally ready to
  // receive. Using state here would force a re-render + remount of the
  // outer iframe, which would re-trigger the race we're trying to avoid.
  const pendingHtmlRef = useRef<string>('');
  const pendingNameRef = useRef<string>('');
  // Track whether we have unflushed payload — saves us posting a stale
  // message if the sandbox reloads (e.g. via devtools "reload frame").
  const hasPendingRef = useRef(false);

  // Keep the refs synced with the latest media. The actual `postMessage`
  // is gated on `sandbox:ready` (or the iframe's onLoad fallback), so
  // updating these refs does NOT cause a re-render.
  pendingHtmlRef.current = media.content;
  pendingNameRef.current = name;
  hasPendingRef.current = true;

  // Flush the cached payload to the sandbox. Safe to call multiple times
  // — the sandbox hot-replaces its inner iframe on each `set`.
  const flushPending = (reason: string) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    // eslint-disable-next-line no-console
    console.log('[html-preview host] flushing payload', {
      reason,
      name: pendingNameRef.current,
      bytes: pendingHtmlRef.current.length,
    });
    const message: HtmlPreviewSetMessage = {
      type: 'html-preview:set',
      html: pendingHtmlRef.current,
      name: pendingNameRef.current,
    };
    iframe.contentWindow.postMessage(message, '*');
    hasPendingRef.current = false;
  };

  // Subscribe to the sandbox's ready announcement. The listener lives on
  // `window` (host side), not on the iframe directly — there's no
  // `onmessage` on an HTMLIFrameElement. We authenticate by comparing
  // `event.source` to the iframe's `contentWindow` so a foreign window
  // posting the same `{ type: 'sandbox:ready' }` payload can't trick us.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as SandboxReadyMessage | null | undefined;
      if (!data || typeof data !== 'object' || data.type !== 'sandbox:ready') return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      // eslint-disable-next-line no-console
      console.log('[html-preview host] received sandbox:ready');
      flushPending('sandbox:ready');
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount: tell the sandbox to drop its inner iframe so it
  // doesn't keep running the script in the background after the user
  // navigates away from the HTML branch.
  useEffect(() => {
    return () => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;
      const clear: HtmlPreviewClearMessage = { type: 'html-preview:clear' };
      iframe.contentWindow.postMessage(clear, '*');
    };
  }, []);

  // Fallback flush: if the outer iframe fires `onLoad` before the
  // `sandbox:ready` event arrives (e.g. we missed it because of a
  // navigation away and back, or the sandbox's listener somehow lost
  // the first event), re-send the payload. Idempotent on the sandbox
  // side — `set` just hot-replaces the inner iframe.
  const handleIframeLoad = () => {
    if (!hasPendingRef.current) return;
    // eslint-disable-next-line no-console
    console.log('[html-preview host] iframe onLoad, flushing as fallback');
    flushPending('iframe.onLoad');
  };

  return (
    <PreviewSourceFrame
      media={media}
      openPreference={openPreference}
      renderHeader={renderHeader}
      previewPersistent
      renderPreview={() => (
        <iframe
          ref={iframeRef}
          src={HTML_PREVIEW_FRAME_URL}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          title={name}
          onLoad={handleIframeLoad}
          className="w-full h-[calc(100vh-12rem)] bg-white block border-0"
        />
      )}
    />
  );
}

function PdfFileView({ media, renderHeader }: {
  media: Extract<FileMedia, { type: 'pdf' }>;
  renderHeader: (right: React.ReactNode) => React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ReturnType<typeof createPdfPreviewController> | null>(null);
  const loadedDocumentRef = useRef<Uint8Array | null>(null);
  const passwordUpdateRef = useRef<((password: string) => void) | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'password' | 'error'>('loading');
  const [error, setError] = useState('');
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [containerWidth, setContainerWidth] = useState(0);
  const [intrinsicMeasurement, setIntrinsicMeasurement] = useState<PdfIntrinsicMeasurement | null>(null);
  const [rendering, setRendering] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordReason, setPasswordReason] = useState(1);

  useEffect(() => {
    let live = true;
    const controller = createPdfPreviewController(media.data);
    controllerRef.current = controller;
    loadedDocumentRef.current = null;
    setIntrinsicMeasurement(null);
    setStatus('loading');
    controller.load((updatePassword, reason) => {
      if (!live) return;
      passwordUpdateRef.current = updatePassword;
      setPasswordReason(reason);
      setStatus('password');
    }).then((count) => {
      if (!live) return;
      loadedDocumentRef.current = media.data;
      setPageCount(count);
      setPage(1);
      setStatus('ready');
    }).catch((reason) => {
      if (!live) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus('error');
    });
    return () => {
      live = false;
      controllerRef.current = null;
      loadedDocumentRef.current = null;
      void controller.destroy();
    };
  }, [media.data]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => setContainerWidth(container.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [status]);

  const renderScale = resolvePdfRenderScale(
    fitWidth,
    containerWidth,
    zoom,
    { document: media.data, page },
    intrinsicMeasurement,
  );

  useEffect(() => {
    if (
      status !== 'ready' ||
      !canvasRef.current ||
      !controllerRef.current ||
      loadedDocumentRef.current !== media.data
    ) return;
    let live = true;
    setRendering(true);
    controllerRef.current.renderPage(page, canvasRef.current, renderScale).then(({ width }) => {
      if (!live || width <= 0) return;
      setIntrinsicMeasurement({ document: media.data, page, width: width / renderScale });
    }).catch((reason) => {
      if (!live) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus('error');
    }).finally(() => {
      if (live) setRendering(false);
    });
    return () => { live = false; };
  }, [status, page, renderScale, media.data]);

  function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!password || !passwordUpdateRef.current) return;
    setStatus('loading');
    passwordUpdateRef.current(password);
    setPassword('');
  }

  const toolbar = status === 'ready' ? (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
      <IconButton label={t('vfs.previousPage')} disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft className="size-4" /></IconButton>
      <input aria-label={t('vfs.pageNumber')} type="number" min={1} max={pageCount} value={page} onChange={(event) => setPage(Math.min(pageCount, Math.max(1, Number(event.target.value) || 1)))} className="h-7 w-12 rounded border border-border bg-background px-1 text-center text-xs tabular-nums" />
      <span className="text-xs text-muted-foreground tabular-nums">/ {pageCount}</span>
      <IconButton label={t('vfs.nextPage')} disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}><ChevronRight className="size-4" /></IconButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <IconButton label={t('vfs.zoomOut')} disabled={!fitWidth && zoom <= 0.5} onClick={() => { setFitWidth(false); setZoom((value) => Math.max(0.5, value - 0.25)); }}><ZoomOut className="size-4" /></IconButton>
      <span className="w-10 text-center text-xs tabular-nums">{Math.round(renderScale * 100)}%</span>
      <IconButton label={t('vfs.zoomIn')} disabled={!fitWidth && zoom >= 3} onClick={() => { setFitWidth(false); setZoom((value) => Math.min(3, value + 0.25)); }}><ZoomIn className="size-4" /></IconButton>
      <IconButton label={t('vfs.fitWidth')} active={fitWidth} onClick={() => setFitWidth(true)}><Maximize2 className="size-4" /></IconButton>
    </div>
  ) : <span className="text-xs text-muted-foreground">{formatSize(media.size)}</span>;

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border">
      {renderHeader(toolbar)}
      <div ref={containerRef} className="relative min-h-48 min-w-0 overflow-auto bg-muted/30 p-3 max-h-[calc(100vh-10rem)]">
        {status === 'loading' && <div role="status" className="flex h-48 items-center justify-center text-sm text-muted-foreground">{t('common.loading')}</div>}
        {status === 'password' && (
          <form onSubmit={submitPassword} className="mx-auto flex min-h-48 max-w-sm flex-col items-stretch justify-center gap-3">
            <p className="text-sm text-muted-foreground">{t(passwordReason === 2 ? 'vfs.pdfWrongPassword' : 'vfs.pdfPasswordRequired')}</p>
            <div className="flex min-w-0 gap-2">
              <input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="h-8 min-w-0 flex-1 rounded border border-border bg-background px-2 text-sm" />
              <button type="submit" className="h-8 shrink-0 rounded bg-primary px-3 text-xs text-primary-foreground">{t('common.confirm')}</button>
            </div>
          </form>
        )}
        {status === 'error' && <div role="alert" className="flex min-h-48 items-center justify-center p-4 text-center text-sm text-destructive">{t('vfs.pdfLoadFailed', [error])}</div>}
        <canvas ref={canvasRef} className={`mx-auto block max-w-none bg-white shadow-sm ${status === 'ready' ? '' : 'hidden'} ${rendering ? 'opacity-60' : ''}`} />
      </div>
    </div>
  );
}

function IconButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={`size-7 inline-flex shrink-0 items-center justify-center rounded-md disabled:opacity-40 ${active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}>{children}</button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** GitHub-style frontmatter renderer.
 *
 *  Scalars render as plain text in the right column; nested values (objects
 *  and arrays) fall back to a `<pre>` that shows the value as JSON-formatted
 *  text so the structure stays readable without pulling in a YAML
 *  serializer at render time. The `not-prose` opt-out keeps `@tailwindcss/
 *  typography`'s defaults from re-styling our table padding / borders. */
function FrontmatterTable({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="not-prose mb-4 overflow-hidden rounded-md border border-border">
      <table className="w-full text-[13px] table-fixed">
        <tbody>
          {Object.entries(data).map(([key, value], i, arr) => (
            <tr key={key} className={i < arr.length - 1 ? 'border-b border-border' : undefined}>
              <th className="w-1/3 px-3 py-2 text-left font-mono text-muted-foreground align-top bg-muted/30">
                {key}
              </th>
              <td className="px-3 py-2 align-top wrap-break-word">
                {renderFrontmatterValue(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderFrontmatterValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span>{String(value)}</span>;
  }
  // Objects and arrays: pretty-print as JSON inside a pre. Wrapping in
  // <pre> keeps newlines/indentation; `whitespace-pre-wrap` lets very long
  // lines wrap instead of pushing the table wider than the viewport.
  // (yaml@2 follows YAML 1.2, so bare `date: 2024-05-15` parses to the
  // string "2024-05-15" and falls into the `string` branch above —
  // explicit `!!timestamp` tags still produce `Date` instances and route
  // through the JSON branch, which `JSON.stringify`s them to ISO format
  // inside the <pre>.)
  return (
    <pre className="font-mono text-xs text-foreground/80 whitespace-pre-wrap wrap-break-word">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
