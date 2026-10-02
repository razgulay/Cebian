//
// Text + PDF chunking for the RAG indexer.
//
// 两条切分路径：结构感知（`chunkDocument`，按 Chương/Điều/Khoản 等边界切，
// 见 `structure.ts`）与纯文本滑动窗口（`chunkByWindow`，作为结构不可用或
// 单个结构单元仍过长时的降级）。`chunkText` 是 `chunkDocument` 的投影。
//
// PDF extraction reuses the existing offscreen pdf.js pipeline via the
// `pdf-extract-bytes` IPC — same path that PdfTextAttachment uses, just
// with a much larger `maxChars` so we capture the full document for
// chunking (the attachment flow caps at 50 KB to protect prompt budget;
// indexing doesn't have that constraint).
//

import { canSplitByClause, splitByClause, splitHeadingSections } from './structure';

export interface ChunkOptions {
  /** Target chunk size in characters. */
  size: number;
  /** Sliding-window overlap in characters. */
  overlap: number;
}

export class ChunkOptionsError extends Error {}

/** 一个 chunk 及其所处的 heading 路径。 */
export interface DocumentChunk {
  /** 原文的逐字切片（仅两端 trim），长度 ≤ `size`。
   *  **绝不**把 heading 塞进来——见下方 `chunkDocument` 的说明。 */
  text: string;
  /** 祖先 heading，最外层在前。无结构时为 `[]`。 */
  headingPath: string[];
}

/** 校验切分选项。`chunkDocument` 与 `chunkByWindow` 共用，保证两者对非法
 *  选项的判定一致（既有测试依赖 `ChunkOptionsError` 的语义）。 */
function assertChunkOptions(size: number, overlap: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    throw new ChunkOptionsError('chunk size must be > 0');
  }
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= size) {
    throw new ChunkOptionsError('chunk overlap must be in [0, size)');
  }
}

/** 滑动窗口切分——**不感知结构，且假定入参已归一化并 trim 过**。
 *
 *  这是 `chunkText` 的原始实现，抽出来供 `chunkDocument` 在结构无法切分时降级
 *  调用。归一化**不在这里做**：调用方已经 `\r\n → \n` 过一遍，再归一化一次会
 *  让 `\r\r\n` 这类输入被折叠两次，输出与旧实现不再逐字一致。 */
function chunkByWindow(text: string, opts: ChunkOptions): string[] {
  const { size, overlap } = opts;
  if (text.length === 0) return [];
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  let start = 0;
  // Hard cap on iterations — defensive against pathological inputs where
  // the snap window keeps landing at start+1.
  const maxIterations = Math.ceil(text.length / Math.max(1, size - overlap)) + 16;
  let iter = 0;
  while (start < text.length && iter++ < maxIterations) {
    let end = Math.min(start + size, text.length);
    // Sentence-boundary snap: look in the last 20% of the window for the
    // most recent `. `, `! `, `? `, or `\n`. Snap there if found and the
    // snapped point is at least `start + 1` (otherwise we'd loop).
    if (end < text.length) {
      const snapStart = start + Math.floor(size * 0.8);
      const slice = text.slice(snapStart, end);
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
    const piece = text.slice(start, end).trim();
    if (piece.length > 0) chunks.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/**
 * 按结构切分文档，每个 chunk 带上它所属的 heading 路径。
 *
 * **`text` 始终是原文的逐字切片**，heading 只出现在 `headingPath` 里。
 * 原因：`extractSlimContext`（`contextual-generator.ts`）用
 * `document.indexOf(chunkText.slice(0, 60))` 在原文中定位 chunk，其注释明确
 * 写着 *"chunkText is a verbatim substring of document by construction"*。
 * 把 heading 拼进 `content` 会破坏这个锚点，让 Contextual Retrieval 静默退化。
 *
 * 降级链：整个 section 放得下 → 一个 chunk；放不下 → 按 `Khoản` 拆；仍放不下
 * → 落到滑动窗口。窗口是唯一使用 `overlap` 的地方——两个结构单元之间不重叠，
 * 否则会把整个 `Điều` 复制进相邻 chunk，既撑大 embedding 又让 BM25 重复计分。
 */
export function chunkDocument(text: string, opts: ChunkOptions): DocumentChunk[] {
  assertChunkOptions(opts.size, opts.overlap);

  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (cleaned.length === 0) return [];

  // 注意：这里**没有** `cleaned.length <= size → 单个 chunk` 的短路。
  // 那条件是按「整篇」判断的，而结构切分要按「每个 section」判断：一篇 250
  // 字的文档含 3 个 `Điều` 时，整篇小于 size，但按 `Điều` 切开对检索明显更好。
  // 无结构时 `splitHeadingSections` 会返回单个 `headingPath: []` 的 section，
  // 再走下面的 `≤ size` 分支——输出与旧实现逐字一致（归一化只在这里做一次，
  // `chunkByWindow` 不再重复归一化），所以短路是多余的。

  const out: DocumentChunk[] = [];
  for (const section of splitHeadingSections(cleaned)) {
    const path = section.headingPath;

    if (section.text.length <= opts.size) {
      out.push({ text: section.text.trim(), headingPath: path });
      continue;
    }

    // 过长 section → 按 Khoản 拆（仅当最内层是 Điều，见 `canSplitByClause`）。
    const pieces = canSplitByClause(section) ? splitByClause(section.text) : [section.text];
    for (const piece of pieces) {
      if (piece.trim().length === 0) continue;
      if (piece.length <= opts.size) {
        out.push({ text: piece.trim(), headingPath: path });
        continue;
      }
      // 单个 Khoản 仍然过长 → 最后手段：滑动窗口。
      for (const w of chunkByWindow(piece, opts)) {
        out.push({ text: w, headingPath: path });
      }
    }
  }

  // 丢掉「只有 heading、没有正文」的 chunk。容器型 heading（`Chương`）后面直接
  // 跟子 `Điều` 是常态，此时它的正文就是空的——留着它只会白耗一次 embedding
  // 与一行 BM25，而祖先信息已经由每个子 chunk 的 `headingPath` 携带。
  //
  // 但**必须**兜底：一份只有 `Chương` 没有 `Điều` 的文档会因此清空，那等于
  // 静默什么都没索引。真到那一步就原样保留，宁可留冗余 chunk 也不能空手而归。
  const withBody = out.filter((c) => {
    const innermost = c.headingPath[c.headingPath.length - 1];
    return innermost === undefined || c.text.trim() !== innermost.trim();
  });
  return withBody.length > 0 ? withBody : out;
}

/** 只要文本的便捷入口。`chunkDocument` 的投影。 */
export function chunkText(text: string, opts: ChunkOptions): string[] {
  return chunkDocument(text, opts).map((c) => c.text);
}

/** 把 heading 路径渲染成一行：`['Chương II', 'Điều 4']` → `'Chương II > Điều 4'`；
 *  空路径 → `''`。单一实现，供 indexer 写入 metadata 与 UI 展示共用。 */
export function formatHeadingPath(path: string[]): string {
  return path.join(' > ');
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
