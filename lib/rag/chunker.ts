//
// Text + PDF chunking for the RAG indexer.
//
// Pure-text chunking is a sliding-window with sentence-boundary snap
// (so chunks don't end mid-word / mid-clause when the boundary happens
// to fall in the middle of prose).
//
// PDF extraction reuses the existing offscreen pdf.js pipeline via the
// `pdf-extract-bytes` IPC — same path that PdfTextAttachment uses, just
// with a much larger `maxChars` so we capture the full document for
// chunking (the attachment flow caps at 50 KB to protect prompt budget;
// indexing doesn't have that constraint).
//

export interface ChunkOptions {
  /** Target chunk size in characters. */
  size: number;
  /** Sliding-window overlap in characters. */
  overlap: number;
}

export class ChunkOptionsError extends Error {}

/** Split plain text into chunks of approximately `size` characters with
 *  sentence-boundary snap when possible.
 *
 *  Algorithm:
 *    1. End-normalize (\r\n → \n), trim.
 *    2. If total ≤ size → return as a single chunk.
 *    3. Otherwise: take the next `size` chars; if we're not at EOF, try
 *       to snap the cut to the last sentence terminator (`. ! ? \n`) in
 *       the last 20% of the window so we don't end mid-sentence.
 *    4. Advance `start` by `(end - overlap)` so the next chunk inherits
 *       the trailing overlap.
 *    5. Discard empty results (snap can produce zero-length slices if
 *       the source has a long run of whitespace). */
export function chunkText(text: string, opts: ChunkOptions): string[] {
  const { size, overlap } = opts;
  if (!Number.isFinite(size) || size <= 0) {
    throw new ChunkOptionsError('chunk size must be > 0');
  }
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= size) {
    throw new ChunkOptionsError('chunk overlap must be in [0, size)');
  }

  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (cleaned.length === 0) return [];
  if (cleaned.length <= size) return [cleaned];

  const chunks: string[] = [];
  let start = 0;
  // Hard cap on iterations — defensive against pathological inputs where
  // the snap window keeps landing at start+1.
  const maxIterations = Math.ceil(cleaned.length / Math.max(1, size - overlap)) + 16;
  let iter = 0;
  while (start < cleaned.length && iter++ < maxIterations) {
    let end = Math.min(start + size, cleaned.length);
    // Sentence-boundary snap: look in the last 20% of the window for the
    // most recent `. `, `! `, `? `, or `\n`. Snap there if found and the
    // snapped point is at least `start + 1` (otherwise we'd loop).
    if (end < cleaned.length) {
      const snapStart = start + Math.floor(size * 0.8);
      const slice = cleaned.slice(snapStart, end);
      const lastTerminator = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('\n'),
      );
      if (lastTerminator > 0) {
        end = snapStart + lastTerminator + 1;
      }
    }
    const piece = cleaned.slice(start, end).trim();
    if (piece.length > 0) chunks.push(piece);
    if (end >= cleaned.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** Extract text from a local PDF `File` via the offscreen pdf.js IPC.
 *  Same wire shape as the existing chat PDF-attachment flow but with a
 *  10 MB text cap (vs 50 KB for chat attachments) since we want the
 *  full document for chunking. */
export async function extractPdfTextFromFile(
  file: File,
): Promise<{ text: string; pageCount: number }> {
  // Lazy import so the Settings page doesn't pay for pdfjs-dist (~2 MB)
  // until the user actually picks a PDF.
  const { ensureOffscreen } = await import('@/lib/tools/offscreen');
  await ensureOffscreen();

  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked base64 — see ChatInput.tsx for the same trick (avoids
  // String.fromCharCode.apply blowing the stack on multi-MB buffers).
  // Push each chunk into an array and join once at the end: `binary += ...`
  // is O(n²) on the intermediate string length (each concat allocates a fresh
  // string), so a 10 MB PDF would otherwise spend most of its budget in GC.
  const parts: string[] = [];
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(
      String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK) as unknown as number[],
      ),
    );
  }
  const binary = parts.join('');
  const base64 = btoa(binary);
  const resp = (await chrome.runtime.sendMessage({
    type: 'pdf-extract-bytes',
    bytesBase64: base64,
    // 10 MB text cap — well above the typical 200-page book (~1 MB text)
    // and the existing chat attachment's 50 KB cap. Indexed text isn't
    // shipped to the LLM directly; only the top-K retrieved chunks are,
    // so prompt budget isn't at risk.
    maxChars: 10_000_000,
  })) as {
    result?: { text: string; pageCount: number; pages: number[]; truncated: boolean };
    error?: string;
  };
  if (resp.error) throw new Error(resp.error);
  if (!resp.result) throw new Error('PDF extraction returned no result');
  return { text: resp.result.text, pageCount: resp.result.pageCount };
}

/** FNV-1a 32-bit hash. Cheap, deterministic, good enough for content
 *  equality at the chunk level. Stored alongside each chunk so a future
 *  "is this chunk stale?" check is one int compare. */
export function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
