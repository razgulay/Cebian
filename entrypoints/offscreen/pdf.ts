// PDF service for the offscreen document.
//
// All pdf.js usage lives here so the file stays cohesive (the offscreen
// `main.ts` only dispatches messages). Handlers are intentionally
// straightforward functions returning the response payload; `main.ts`
// wraps them with the `sendResponse` plumbing.
//
// 注意：pdf.js 必须在 offscreen 这种带 DOM 的上下文里跑（需要
// DOMMatrix / OffscreenCanvas 等）；从 Service Worker 调 `loadPdfJs()` 会失败。

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdfJs } from '@/lib/content/pdf-loader';
import { escapeRegExp } from '@/lib/utils';

/** Structural slice of pdf.js's `TextItem` covering only the fields we
 *  actually read. Avoids importing from the package's internal subpath
 *  (`pdfjs-dist/types/src/display/api`) which isn't part of the public
 *  surface and can move on minor bumps. `getTextContent().items` also
 *  contains `TextMarkedContent` entries that lack `str` — we discriminate
 *  with `'str' in item` at the use site. */
interface PdfTextItemLike {
  str: string;
  hasEOL: boolean;
}

// ─── Types exposed to callers (background / agent tool) ───

/** Result of `pdf-info`. */
export interface PdfInfo {
  pageCount: number;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creationDate?: string;
  /** Flattened outline entries (≤ 2 levels deep, ≤ 50 entries). Empty when
   *  the document has no outline. `truncated` is true when entries were
   *  dropped to honor the cap. */
  outline: PdfOutlineEntry[];
  outlineTruncated: boolean;
}

export interface PdfOutlineEntry {
  title: string;
  /** 1-based target page; missing when the destination cannot be resolved
   *  to a numbered page (rare for normal documents). */
  page?: number;
  /** Indent level (0 for top-level, 1 for one level deep). */
  level: number;
}

/** Result of `pdf-text`. */
export interface PdfTextResult {
  /** Joined text for the resolved page range. Page boundaries are marked
   *  by a `\f\n=== Page N ===\n` separator so downstream consumers can
   *  re-split if needed. */
  text: string;
  /** Pages actually included (in iteration order, after page-range
   *  resolution and any early stop from `maxChars`). */
  pages: number[];
  /** Total resolved pages requested (before truncation). */
  requestedPages: number;
  /** True if the response was cut short by `maxChars`. The character
   *  count of what was actually returned is just `text.length`; we don't
   *  separately compute the would-be total — callers can re-request
   *  remaining pages by page range if they need more. */
  truncated: boolean;
}

/** Result of `pdf-search`. */
export interface PdfSearchResult {
  hits: PdfSearchHit[];
  /** True when the hit cap was reached and more matches exist. */
  truncated: boolean;
  /** Number of pages actually scanned (matches the resolved page range,
   *  even if a hit-cap-induced early stop occurred — for transparency). */
  pagesScanned: number;
}

export interface PdfSearchHit {
  /** 1-based page number. */
  page: number;
  /** Character offset inside the joined page text. */
  index: number;
  /** Length of the match in characters. */
  length: number;
  /** Surrounding text, with the match in the middle. Truncated to roughly
   *  ±80 chars on each side. Leading/trailing `…` marks indicate the
   *  snippet was cut at that end. */
  snippet: string;
}

// ─── Document cache (URL → loaded PDF) ───

/** Bounded LRU cache. Stores promises so concurrent requests for the same
 *  URL share one fetch + parse. Cap chosen small because each entry can
 *  retain tens of MB of decoded structures. */
const MAX_CACHE = 3;
const documentCache = new Map<string, Promise<PDFDocumentProxy>>();

function touchCache(url: string, promise: Promise<PDFDocumentProxy>): void {
  // Re-insert moves the key to the end of insertion order, marking it MRU.
  documentCache.delete(url);
  documentCache.set(url, promise);

  while (documentCache.size > MAX_CACHE) {
    // First key by insertion order = least recently used.
    const oldest = documentCache.keys().next().value;
    if (oldest === undefined) break;
    documentCache.delete(oldest);
    // 不主动调 doc.destroy()：沉睡 listener 可能同时还拿着被淘汰项的
    // `PDFDocumentProxy` 在跨 page 迭代，提前 destroy 会让该调用脚下报错。
    // 现在是 LRU 表上取不到了，上下文释放后 GC 会回收；cap 是 3，卷不起来。
  }
}

async function getOrLoadDocument(url: string): Promise<PDFDocumentProxy> {
  const cached = documentCache.get(url);
  if (cached) {
    // Move to MRU position on hit.
    touchCache(url, cached);
    return cached;
  }

  const loadingPromise = (async () => {
    const pdfjs = await loadPdfJs();
    const bytes = await fetchPdf(url);
    const task = pdfjs.getDocument({
      // pdf.js v5 wants a typed-array view, not a raw ArrayBuffer —
      // see parseBytes() for rationale. Wrapping is zero-copy.
      data: new Uint8Array(bytes),
      // Disable pdf.js's built-in font fetching attempts (no network access
      // for sub-resources needed for text extraction).
      disableFontFace: true,
      // Keep the worker chatter quiet — we don't need stream progress.
      verbosity: 0,
    });
    return task.promise;
  })();

  touchCache(url, loadingPromise);

  // If the load fails, evict so subsequent calls can retry from scratch
  // instead of replaying the cached rejection.
  loadingPromise.catch(() => {
    if (documentCache.get(url) === loadingPromise) {
      documentCache.delete(url);
    }
  });

  return loadingPromise;
}

/** Parse a PDF from an in-memory byte buffer (no fetch, no cache). Used by
 *  the attachment flow where the user picked a local file — we already
 *  have the ArrayBuffer and just need text out of it. Skips the URL
 *  cache because each upload is one-shot; caching by URL would be a no-op
 *  anyway since there's no URL to key on. */
async function parseBytes(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfJs();
  // pdf.js v5 rejects raw `ArrayBuffer` — it wants a typed-array view
  // (`Uint8Array` / `Uint8ClampedArray`) per the "TypedArray, string, or
  // array-like object" contract. Chrome's structured-clone often gives us
  // an `ArrayBuffer` (e.g. the result of `FileReader.readAsArrayBuffer`),
  // so we wrap it. The wrapper is a zero-copy view — no bytes copied.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    verbosity: 0,
  });
  return task.promise;
}

// ─── Fetch ───

/** Hard cap on a single PDF's bytes. Anything larger likely chokes the
 *  offscreen document anyway (pdf.js holds the full ArrayBuffer plus
 *  decoded structures in memory); failing fast with a clear message is
 *  better than the page silently going OOM. */
const PDF_MAX_BYTES = 100 * 1024 * 1024;

async function fetchPdf(url: string): Promise<ArrayBuffer> {
  // URL 仅做可 parse 校验。不再做协议白名单 —— Chrome 沙箱对 file://、blob: 等
  // 协议本来就有它自己的策略，让 fetch 直接说话比工具层去猜更诚实。
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Extension fetches with `<all_urls>` host_permissions are privileged for
  // http(s) — bypassing CORS and attaching cookies. For file:// the request
  // only succeeds when the user has toggled "Allow access to file URLs"
  // for Cebian at chrome://extensions; otherwise fetch throws naturally and
  // we surface that. For blob: URLs scoped to a page, fetch also fails
  // naturally because the blob is not in this context's URL store.
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: HTTP ${response.status} ${response.statusText}`);
  }

  // 大小预检：若 Content-Length 已知且超限，提前拒绝；未知就靠 arrayBuffer
  // 之后再补一次校验，避免缓冲整个超大文件。
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > PDF_MAX_BYTES) {
    throw new Error(
      `PDF is too large to process (${(declaredLength / 1024 / 1024).toFixed(1)} MB; ` +
      `cap is ${PDF_MAX_BYTES / 1024 / 1024} MB). Open a smaller range or download the file ` +
      `to disk first.`,
    );
  }

  // 内容类型校验：放过 application/pdf / application/x-pdf （老服务器）和
  // 常见的 octet-stream 兜底；空 Content-Type 也放过（部分私有部署服务器
  // 不下发该头）。
  const rawCt = response.headers.get('content-type') ?? '';
  const contentType = rawCt.split(';')[0]!.trim().toLowerCase();
  if (
    contentType
    && !contentType.startsWith('application/pdf')
    && contentType !== 'application/x-pdf'
    && contentType !== 'application/octet-stream'
    && contentType !== 'binary/octet-stream'
  ) {
    throw new Error(`URL did not return a PDF (Content-Type: ${contentType}).`);
  }

  const buf = await response.arrayBuffer();
  if (buf.byteLength > PDF_MAX_BYTES) {
    throw new Error(
      `PDF is too large to process (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB; ` +
      `cap is ${PDF_MAX_BYTES / 1024 / 1024} MB).`,
    );
  }
  return buf;
}

// ─── Page range parsing ───

/** Resolve a `pageRange` spec ("1-3,7,10-12" / "5" / undefined) into a
 *  sorted, unique, 1-based page-number list clamped to `[1, pageCount]`.
 *  `undefined` / empty input returns all pages. Throws on syntactic
 *  garbage; returns `[]` if the spec is well-formed but matches no pages. */
export function parsePageRange(spec: string | undefined, pageCount: number): number[] {
  if (!spec || !spec.trim()) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const out = new Set<number>();
  const parts = spec.split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      // 正则已保证 m[1] / m[2] 是纯数字，不需 isFinite 象征性检查。
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      a = Math.max(1, a);
      b = Math.min(pageCount, b);
      for (let i = a; i <= b; i++) out.add(i);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= pageCount) out.add(n);
      continue;
    }
    throw new Error(`Invalid page range part: "${part}"`);
  }
  return Array.from(out).sort((a, b) => a - b);
}

// ─── Page text extraction ───

/** Join a page's text items into a single string. `hasEOL` items end the
 *  current line; other items are separated by a single space. Marked-
 *  content items (no `str` field) are skipped. Final string is trimmed
 *  and whitespace-normalized. */
async function extractPageText(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    let out = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const textItem = item as PdfTextItemLike;
      out += textItem.str;
      out += textItem.hasEOL ? '\n' : ' ';
    }
    // Normalize: collapse internal runs of spaces/tabs, tidy line breaks.
    return out
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } finally {
    // `cleanup()` releases page-level decoded resources without destroying
    // the document. Helps keep memory bounded across long extractions.
    page.cleanup();
  }
}

// ─── Outline (table of contents) ───

const OUTLINE_MAX_ENTRIES = 50;
const OUTLINE_MAX_DEPTH = 2;

interface RawOutlineNode {
  title: string;
  dest?: unknown;
  items?: RawOutlineNode[];
}

async function extractOutline(doc: PDFDocumentProxy): Promise<{
  entries: PdfOutlineEntry[];
  truncated: boolean;
}> {
  let raw: RawOutlineNode[] | null = null;
  try {
    raw = (await doc.getOutline()) as RawOutlineNode[] | null;
  } catch {
    raw = null;
  }
  if (!raw || raw.length === 0) return { entries: [], truncated: false };

  const out: PdfOutlineEntry[] = [];
  let truncated = false;

  const walk = async (nodes: RawOutlineNode[], level: number): Promise<void> => {
    for (const node of nodes) {
      if (out.length >= OUTLINE_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const page = await resolveOutlineDestination(doc, node.dest);
      out.push({
        title: (node.title ?? '').trim().slice(0, 200),
        page,
        level,
      });
      if (node.items && node.items.length > 0 && level + 1 < OUTLINE_MAX_DEPTH) {
        await walk(node.items, level + 1);
        if (out.length >= OUTLINE_MAX_ENTRIES) {
          truncated = true;
          return;
        }
      } else if (node.items && node.items.length > 0) {
        // Deeper levels exist but are dropped per cap; mark truncated.
        truncated = true;
      }
    }
  };

  await walk(raw, 0);
  return { entries: out, truncated };
}

/** Best-effort outline destination → 1-based page number resolution.
 *  pdf.js outline entries carry either a named destination (string) or an
 *  explicit destination array; we try both and return undefined on any
 *  failure so the caller can still show the title. */
async function resolveOutlineDestination(
  doc: PDFDocumentProxy,
  dest: unknown,
): Promise<number | undefined> {
  try {
    let explicit: unknown[] | null = null;
    if (Array.isArray(dest)) {
      explicit = dest;
    } else if (typeof dest === 'string') {
      const resolved = await doc.getDestination(dest);
      if (Array.isArray(resolved)) explicit = resolved;
    }
    if (!explicit || explicit.length === 0) return undefined;
    const ref = explicit[0];
    const pageIndex = await doc.getPageIndex(ref as any);
    if (typeof pageIndex === 'number') return pageIndex + 1; // 0-based → 1-based
    return undefined;
  } catch {
    return undefined;
  }
}

// ─── Handlers (invoked from main.ts dispatcher) ───

export async function handlePdfInfo(url: string): Promise<PdfInfo> {
  const doc = await getOrLoadDocument(url);
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, string | undefined>;
  const { entries, truncated } = await extractOutline(doc);

  return {
    pageCount: doc.numPages,
    title: info.Title,
    author: info.Author,
    subject: info.Subject,
    keywords: info.Keywords,
    creationDate: info.CreationDate,
    outline: entries,
    outlineTruncated: truncated,
  };
}

export async function handlePdfText(
  url: string,
  pageRangeSpec: string | undefined,
  maxChars: number | undefined,
): Promise<PdfTextResult> {
  const doc = await getOrLoadDocument(url);
  const pages = parsePageRange(pageRangeSpec, doc.numPages);
  if (pages.length === 0) {
    throw new Error(
      `Page range "${pageRangeSpec}" matched no pages (document has ${doc.numPages} page(s)).`,
    );
  }

  const segments: string[] = [];
  const includedPages: number[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const pageNumber of pages) {
    const pageText = await extractPageText(doc, pageNumber);
    // Page boundary marker: form-feed + heading so it's both human- and
    // regex-friendly. Doesn't count against `maxChars` budget tracking
    // (kept simple — caller sees a coherent break either way).
    const segment = (segments.length > 0 ? '\n\f\n' : '')
      + `=== Page ${pageNumber} ===\n`
      + pageText;

    if (maxChars !== undefined && totalChars + segment.length > maxChars) {
      // Slice the current segment to fit, then stop.
      const remaining = Math.max(0, maxChars - totalChars);
      if (remaining > 0) {
        segments.push(segment.slice(0, remaining));
        includedPages.push(pageNumber);
        totalChars += remaining;
      }
      truncated = true;
      break;
    }

    segments.push(segment);
    includedPages.push(pageNumber);
    totalChars += segment.length;
  }

  const result: PdfTextResult = {
    text: segments.join(''),
    pages: includedPages,
    requestedPages: pages.length,
    truncated,
  };
  return result;
}

const SEARCH_SNIPPET_CONTEXT = 80;
const SEARCH_DEFAULT_MAX_HITS = 50;
const SEARCH_HARD_MAX_HITS = 500;

/** Result of `pdf-extract-bytes` (attachment flow). Same shape as
 *  `PdfTextResult` but `pageCount` is surfaced separately so the UI
 *  can show "PDF · 12 pages" without re-querying. */
export interface PdfBytesExtractResult {
  pageCount: number;
  /** Joined text for the resolved page range (or all pages when no range
   *  given). Page boundaries marked with `\f\n=== Page N ===\n`. Same
   *  conventions as `handlePdfText`. */
  text: string;
  pages: number[];
  truncated: boolean;
}

/** Hard ceiling on extracted text characters per PDF attachment. Matches
 *  the inline-preview cap of the `pdf` tool (20 KB default) so a single
 *  attachment can't balloon the prompt budget. Users who want more can
 *  ask the agent to call the `pdf` tool explicitly with `outputPath`. */
const PDF_BYTES_DEFAULT_MAX_CHARS = 50_000;

/** Extract text from a PDF the user attached (bytes already in hand —
 *  no URL fetch, no cache). Used by the ChatInput attachment flow so a
 *  PDF picked from disk is rendered into a text attachment the LLM can
 *  read. Honours the same `maxChars` budget as the tool's `read` action
 *  so a single PDF can't bloat the prompt; exceeding the budget sets
 *  `truncated: true` and stops at the page boundary. */
export async function handlePdfExtractBytes(
  bytes: ArrayBuffer,
  pageRangeSpec: string | undefined,
  maxChars: number | undefined,
): Promise<PdfBytesExtractResult> {
  // Defensive: if base64 decode went wrong upstream we'd land here with
  // a zero-length buffer; bail with a useful error rather than letting
  // pdf.js's terse "file is empty" message bubble up.
  if (!bytes || bytes.byteLength === 0) {
    throw new Error('PDF attachment bytes are empty (IPC transfer failed)');
  }
  const doc = await parseBytes(bytes);
  const pages = parsePageRange(pageRangeSpec, doc.numPages);
  if (pages.length === 0) {
    throw new Error(
      `Page range "${pageRangeSpec}" matched no pages (document has ${doc.numPages} page(s)).`,
    );
  }

  const limit = maxChars ?? PDF_BYTES_DEFAULT_MAX_CHARS;

  const segments: string[] = [];
  const includedPages: number[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const pageNumber of pages) {
    const pageText = await extractPageText(doc, pageNumber);
    const segment = (segments.length > 0 ? '\n\f\n' : '')
      + `=== Page ${pageNumber} ===\n`
      + pageText;

    if (totalChars + segment.length > limit) {
      const remaining = Math.max(0, limit - totalChars);
      if (remaining > 0) {
        segments.push(segment.slice(0, remaining));
        includedPages.push(pageNumber);
        totalChars += remaining;
      }
      truncated = true;
      break;
    }

    segments.push(segment);
    includedPages.push(pageNumber);
    totalChars += segment.length;
  }

  return {
    pageCount: doc.numPages,
    text: segments.join(''),
    pages: includedPages,
    truncated,
  };
}

export async function handlePdfSearch(
  url: string,
  query: string,
  pageRangeSpec: string | undefined,
  options: { regex?: boolean; caseInsensitive?: boolean; maxHits?: number } = {},
): Promise<PdfSearchResult> {
  if (!query || !query.trim()) {
    throw new Error('Search query is empty.');
  }
  const doc = await getOrLoadDocument(url);
  const pages = parsePageRange(pageRangeSpec, doc.numPages);
  if (pages.length === 0) {
    throw new Error(
      `Page range "${pageRangeSpec}" matched no pages (document has ${doc.numPages} page(s)).`,
    );
  }

  const flags = (options.caseInsensitive ?? true) ? 'gi' : 'g';
  let matcher: RegExp;
  try {
    matcher = options.regex
      ? new RegExp(query, flags)
      : new RegExp(escapeRegExp(query), flags);
  } catch (err) {
    throw new Error(`Invalid regex query: ${(err as Error).message}`);
  }

  const maxHits = Math.min(
    SEARCH_HARD_MAX_HITS,
    Math.max(1, options.maxHits ?? SEARCH_DEFAULT_MAX_HITS),
  );

  const hits: PdfSearchHit[] = [];
  let truncated = false;
  let pagesScanned = 0;

  outer: for (const pageNumber of pages) {
    pagesScanned++;
    const pageText = await extractPageText(doc, pageNumber);
    matcher.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.exec(pageText)) !== null) {
      const index = m.index;
      const length = m[0].length;
      const start = Math.max(0, index - SEARCH_SNIPPET_CONTEXT);
      const end = Math.min(pageText.length, index + length + SEARCH_SNIPPET_CONTEXT);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < pageText.length ? '…' : '';
      hits.push({
        page: pageNumber,
        index,
        length,
        snippet: prefix + pageText.slice(start, end) + suffix,
      });
      if (hits.length >= maxHits) {
        truncated = true;
        break outer;
      }
      // Defensive guard against zero-width regex matches infinite-looping.
      if (length === 0) matcher.lastIndex++;
    }
  }

  return { hits, truncated, pagesScanned };
}
