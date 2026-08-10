/**
 * Lazy loader for Mozilla's pdf.js engine.
 *
 * Why a dedicated module: `pdfjs-dist` is ~2 MB and only needed when the
 * user actually opens a PDF. Importing it from a top-level module would
 * fatten every entry point's main chunk. By isolating the import here
 * behind `await import('pdfjs-dist')`, Vite/Rollup splits pdf.js into its
 * own chunk that is fetched on first call only.
 *
 * Worker registration is the other thing that must happen exactly once.
 * The worker file lives inside the installed pdfjs-dist package; we ask
 * Vite to emit it as a content-hashed asset via the `?url` import
 * (`pdfjs-dist/build/pdf.worker.mjs?url`). This guarantees the API and
 * Worker versions stay in lock-step — `pnpm update pdfjs-dist` refreshes
 * both at once. pdf.js v5 actively enforces this match and throws
 * `UnknownErrorException: API version does not match Worker version`
 * when they drift.
 *
 * Designed to be called from the offscreen document. Calling from a
 * Service Worker context will fail because pdf.js needs DOM-only APIs
 * (DOMMatrix, OffscreenCanvas, etc.).
 */

// `?url` import: Vite resolves the file inside `node_modules/pdfjs-dist/...`
// at build time and emits it as an asset, returning a URL string. WXT
// brings in `vite/client` types, which declares this module shape.
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

type PdfJs = typeof import('pdfjs-dist');

type PdfEngine = Pick<PdfJs, 'getDocument'>;
type PdfLoadingTask = ReturnType<PdfEngine['getDocument']>;
type PdfDocument = Awaited<PdfLoadingTask['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;
type PdfRenderTask = ReturnType<PdfPage['render']>;

export interface PdfPreviewController {
  load(onPassword: (updatePassword: (password: string) => void, reason: number) => void): Promise<number>;
  renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    scale: number,
  ): Promise<{ width: number; height: number }>;
  destroy(): Promise<void>;
}

export interface PdfIntrinsicMeasurement {
  document: object;
  page: number;
  width: number;
}

/** Fit measurements are valid only for the exact PDF object and page. */
export function resolvePdfRenderScale(
  fitWidth: boolean,
  containerWidth: number,
  zoom: number,
  current: { document: object; page: number },
  measurement: PdfIntrinsicMeasurement | null,
): number {
  if (
    !fitWidth ||
    !containerWidth ||
    !measurement ||
    measurement.document !== current.document ||
    measurement.page !== current.page ||
    measurement.width <= 0
  ) {
    return zoom;
  }
  return Math.max(0.25, Math.min(3, (containerWidth - 24) / measurement.width));
}

/** Singleton promise — concurrent callers share the same initialization. */
let modulePromise: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      // Setting `workerSrc` is the canonical way to register a worker URL;
      // pdf.js itself does `new Worker(workerSrc, { type: 'module' })`
      // when a document is opened. Setting it more than once is a no-op
      // (last write wins) but our singleton guarantees we set it once.
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })().catch((err) => {
      // Allow retry on next call instead of permanently caching a
      // rejected promise — a transient chunk-fetch failure shouldn't
      // permanently disable PDF support for the session.
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}

/** Owns one viewer document and its current single-page render. Keeping this
 * lifecycle outside React makes navigation and StrictMode cleanup explicit. */
export function createPdfPreviewController(
  data: Uint8Array,
  loadEngine: () => Promise<PdfEngine> = loadPdfJs,
): PdfPreviewController {
  let loadingTask: PdfLoadingTask | null = null;
  let document: PdfDocument | null = null;
  let active: { page: PdfPage; task: PdfRenderTask } | null = null;
  let destroyed = false;
  let renderGeneration = 0;

  function cancelActive(): void {
    if (!active) return;
    active.task.cancel();
    active.page.cleanup();
    active = null;
  }

  return {
    async load(onPassword) {
      if (destroyed) throw new Error('PDF preview has been destroyed');
      if (document) return document.numPages;
      const engine = await loadEngine();
      if (destroyed) throw new Error('PDF preview has been destroyed');
      // pdf.js may transfer the supplied buffer to its worker. Give it an
      // isolated copy so FileMedia remains valid for retries and downloads.
      loadingTask = engine.getDocument({ data: data.slice(), verbosity: 0 });
      loadingTask.onPassword = onPassword;
      document = await loadingTask.promise;
      if (destroyed) {
        await loadingTask.destroy();
        throw new Error('PDF preview has been destroyed');
      }
      return document.numPages;
    },

    async renderPage(pageNumber, canvas, scale) {
      if (!document || destroyed) throw new Error('PDF document is not loaded');
      const generation = ++renderGeneration;
      cancelActive();
      const page = await document.getPage(pageNumber);
      if (destroyed || generation !== renderGeneration) {
        page.cleanup();
        if (destroyed) throw new Error('PDF preview has been destroyed');
        return { width: 0, height: 0 };
      }
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const canvasContext = canvas.getContext('2d');
      if (!canvasContext) {
        page.cleanup();
        throw new Error('Canvas 2D context is unavailable');
      }
      const task = page.render({ canvas, canvasContext, viewport });
      active = { page, task };
      try {
        await task.promise;
      } catch (error) {
        // Superseded and teardown renders reject after cancel(). Their caller
        // has no error to display; real render failures still surface.
        if (active?.task === task) throw error;
      }
      return { width: viewport.width, height: viewport.height };
    },

    async destroy() {
      if (destroyed) return;
      destroyed = true;
      renderGeneration++;
      cancelActive();
      if (loadingTask) {
        await loadingTask.destroy();
      }
      document = null;
      loadingTask = null;
    },
  };
}
