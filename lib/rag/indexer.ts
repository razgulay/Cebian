//
// RAG indexer — reads files, chunks, embeds, persists to Neon.
//
// Reindexing is idempotent via `ON CONFLICT (collection, source_path,
// chunk_index) DO UPDATE`. Adding new files adds rows; deleting files
// from disk leaves orphan rows in Neon (cleanup is a follow-up — not a
// blocker for personal use at this scale).
//

import { getFileExtension } from '@/lib/agent/attachments';
import { chunkDocument, contentHash, extractPdfTextFromFile, formatHeadingPath } from './chunker';
import { generateContextPrefixes } from './contextual-generator';
import type { Embedder } from './embedder';
import {
  deleteChunksByPaths,
  deleteChunksFromIndex,
  embeddingToVectorLiteral,
  fetchEmbeddings,
  listCollectionChunks,
  query,
} from './neon-client';
import { planIndex, reuseKey, type ExistingChunk } from './plan';

export interface IndexProgress {
  /** Phase of work the indexer is in. UI maps to a friendly label.
   *  `context-generation` is the new Subtask 3 phase — runs between
   *  chunking and embedding when `contextualRetrievalEnabled` is on. */
  phase:
    | 'reading'
    | 'chunking'
    | 'context-generation'
    | 'embedding'
    | 'inserting';
  /** Items completed in this phase (0…total). */
  done: number;
  /** Total items in this phase. */
  total: number;
  /** Filename currently being processed (reading phase only). */
  currentFile?: string;
}

export interface IndexOptions {
  connectionString: string;
  /** Collection name — also the `collection` column in Neon. Must match
   *  the regex `/^[a-z0-9][a-z0-9_-]{0,62}$/` (validated upstream in the
   *  "New collection" form). */
  collection: string;
  embedder: Embedder;
  files: File[];
  chunkSize: number;
  chunkOverlap: number;
  onProgress?: (p: IndexProgress) => void;
  /** Cancel signal — when aborted, the indexer stops at the next safe
   *  boundary (end of current batch) and throws an `IndexCancelledError`.
   *  Already-inserted rows remain (re-running with same files is
   *  idempotent). */
  signal?: AbortSignal;
  // ─── Contextual Retrieval (Subtask 3, opt-in) ──────────────────────
  // 当 `contextualRetrievalEnabled` 为 true 时，indexer 在分块与嵌入之间插入
  // 一个 `context-generation` 阶段。对每个 chunk 用一个廉价 LLM 描述它在源文档
  // 中的位置，把前缀存进 `c.llmPrefix`。写库时它和结构 heading 路径一起拼成
  // `metadata.context_prefix`（见 `buildContextLine`），BM25 路径通过
  // `content_tsv` 的 COALESCE 自动吃到，嵌入输入也走同一条路。
  //
  // 关闭时（默认）不调用 LLM，但 `metadata.context_prefix` **仍可能非空**——
  // 结构 heading 路径不需要 LLM，它是本地算出来的。所以「关闭 CR 等于
  // metadata 无 context_prefix」不再成立。
  contextualEnabled?: boolean;
  contextualLlmBaseUrl?: string;
  contextualLlmApiKey?: string;
  contextualLlmModel?: string;
  // ─── 删除策略 ───────────────────────────────────────────────────
  // 默认「只增不删」：往 {A, B} 里加 C 时 A、B 必须原样保留。整份删除是
  // **opt-in**，且必须经 `confirmPrune` 让用户看过确切文件名。
  /** 是否让 collection 与本次选择保持一致（删除不在选择里的文件）。
   *  默认 `false`。 */
  syncMode?: boolean;
  /** 同步模式下，删除前的确认回调。返回 `false` 表示用户拒绝 → 整轮取消，
   *  一个字节都不写。缺省时**不删除**——没有确认通道就不做危险操作。 */
  confirmPrune?: (removed: { path: string; chunks: number }[]) => Promise<boolean>;
}

export interface IndexResult {
  collection: string;
  chunkCount: number;
  files: { path: string; size: number; chunks: number }[];
  /** 本次实际删除的行数（尾部裁剪 + 同步删除）。 */
  prunedCount: number;
  /** collection 里存在、但不在本次选择里的文件。**不等于「已从磁盘删除」**：
   *  我们不追踪磁盘状态，分不出「文件删了」与「这次没选」。UI 用它在
   *  collection 行上提示用户何时该用同步模式。 */
  notInLastRun: { path: string; chunks: number }[];
}

export class IndexCancelledError extends Error {
  constructor() {
    super('Indexing cancelled');
    this.name = 'IndexCancelledError';
  }
}

/** collection 里存有另一种模型的向量，且它们会活过本次运行。继续写会把两个
 *  向量空间混在一起，而 cosine 只在单一空间里有意义——所以这里中止，而不是
 *  让结果悄悄变差。调用方应给出两条出路：把 collection 里的文件都选齐，或改用
 *  同步模式（未选中的会被删掉，最终状态干净）。 */
export class MixedModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MixedModelError';
  }
}

const PDF_EXT = '.pdf';

/** 取回已存向量的批量大小。与 `INSERT_BATCH` 同量级——每批几百 KB 而非整表。 */
const INSERT_BATCH_FOR_VECTORS = 50;

/** 把 Postgres `vector` 的文本形式 `[0.1,0.2,...]` 解析回 `number[]`。
 *
 *  注意精度：写入时用 6 位小数字面量，读回再解析会带同样的位数，但 float →
 *  text → float 的往返可能让末位差 1e-6 量级。对 cosine 排序没有影响，记在这里
 *  免得后来者以为是 bug。 */
function parseVectorLiteral(literal: string): number[] {
  const trimmed = literal.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (trimmed === '') return [];
  return trimmed.split(',').map((s) => Number(s));
}

interface ChunkEntry {
  sourcePath: string;
  chunkIndex: number;
  content: string;
  hash: string;
  /** 结构 heading 路径，如 `"Chương II > Điều 4"`。无结构时为空串。
   *  它**不进** `content`——见 `chunkDocument` 的说明。 */
  headingPath: string;
  /** LLM 生成的上下文前缀。CR 关闭或生成失败时为空串（优雅降级——chunk
   *  照常入库）。 */
  llmPrefix: string;
}

/** 拼出写进 `metadata.context_prefix` 的那一行。
 *
 *  两个来源共用一个 key：结构 heading（本地算，免费）与 LLM 前缀（CR 开启时
 *  才有）。`content_tsv` 的生成表达式读的就是这个 key，所以两段都会进 BM25
 *  的词流；embed 输入也走同一条路。空的部分直接省略，不留下空行。 */
function buildContextLine(headingPath: string, llmPrefix: string): string {
  return [headingPath, llmPrefix].filter(Boolean).join('\n');
}

/** Build a `path → document-text` map once at the top of the
 *  context-generation phase so each chunk's lookup is O(1) instead
 *  of `fileEntries.find` scanning O(M) entries. Cheap memory
 *  (fileEntries is already in memory) and avoids an O(N×M) blow-up
 *  on collections with many files × many chunks. */
function buildDocumentIndex(
  fileEntries: { path: string; text: string; size: number }[],
): Map<string, string> {
  const idx = new Map<string, string>();
  for (const f of fileEntries) idx.set(f.path, f.text);
  return idx;
}

export async function indexCollection(opts: IndexOptions): Promise<IndexResult> {
  const {
    connectionString,
    collection,
    embedder,
    files,
    chunkSize,
    chunkOverlap,
    onProgress,
    signal,
    contextualEnabled = false,
    contextualLlmBaseUrl = '',
    contextualLlmApiKey = '',
    contextualLlmModel = '',
    syncMode = false,
    confirmPrune,
  } = opts;

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new IndexCancelledError();
  };

  // ─── Phase 1: read files ────────────────────────────────────────
  type FileEntry = { path: string; text: string; size: number };
  const fileEntries: FileEntry[] = [];
  /** 每个文件的「全文 + 切分参数」哈希，算一次（不是每个 chunk 一次）。
   *
   *  定义：对 **phase 1 拿到的原始文本**求哈希——含 `\r\n`、不做 trim。
   *  `\r\n → \n` 与 trim 发生在 `chunkDocument` 内部，晚于这里。若写入与比较
   *  用了两套定义，`doc_hash` 会永远对不上，缓存静默失效。
   *
   *  **掺入 `chunkSize`/`chunkOverlap`**：LLM 前缀描述的是「这个 chunk 在文档中
   *  的位置」，而位置由切分参数决定。只哈希文本的话，用户把 chunkSize 从 800 改到
   *  400 后，同一个 chunk 0 的哈希不变、前缀被判定可复用——但旧前缀描述的是 800
   *  字邻域，与新的 400 字邻域不符。向量不会因此出错（content_hash 变了会重新
   *  嵌入），但检索质量会静默变差。 */
  const docHashes = new Map<string, string>();
  const chunkingSignature = `${chunkSize}\u0000${chunkOverlap}\u0000`;
  for (let i = 0; i < files.length; i++) {
    throwIfCancelled();
    const file = files[i]!;
    onProgress?.({ phase: 'reading', done: i, total: files.length, currentFile: file.name });
    const ext = getFileExtension(file.name);
    let text: string;
    if (ext === PDF_EXT) {
      const { text: pdfText } = await extractPdfTextFromFile(file);
      text = pdfText;
    } else {
      text = await file.text();
    }
    fileEntries.push({ path: file.name, text, size: file.size });
    docHashes.set(file.name, contentHash(chunkingSignature + text));
  }
  onProgress?.({ phase: 'reading', done: files.length, total: files.length });

  // ─── Phase 2: chunk ─────────────────────────────────────────────
  throwIfCancelled();
  const chunks: ChunkEntry[] = [];
  const perFile: Record<string, number> = {};
  for (const fe of fileEntries) {
    const parts = chunkDocument(fe.text, { size: chunkSize, overlap: chunkOverlap });
    perFile[fe.path] = parts.length;
    for (let i = 0; i < parts.length; i++) {
      chunks.push({
        sourcePath: fe.path,
        chunkIndex: i,
        content: parts[i]!.text,
        hash: contentHash(parts[i]!.text),
        headingPath: formatHeadingPath(parts[i]!.headingPath),
        llmPrefix: '', // populated in Phase 3 when CR is enabled
      });
    }
  }
  onProgress?.({ phase: 'chunking', done: chunks.length, total: chunks.length });

  // ─── Phase 2b: 决策（prune / 尾部裁剪 / 复用 / 模型守卫）─────────
  //
  // 一次读全 collection 的轻量元数据（**不含向量**），交给纯函数 `planIndex`
  // 算出该删什么、哪些向量能复用。放在插入**之前**：同步模式下的 prune 是整轮
  // 的门闩——用户不确认就什么都不写，这样不存在「删了旧数据但没写进新数据」的
  // 中间态。
  //
  // 也必须放在下面 `chunks.length === 0` 的提前返回**之前**：全部文件都提取不出
  // 文字（扫描版 PDF）时，同步模式下的 prune 仍应生效，否则用户勾了「同步」却
  // 什么都没发生。
  const existingRows = await listCollectionChunks(connectionString, collection);
  const existing: ExistingChunk[] = existingRows.map((r) => ({
    sourcePath: r.source_path,
    chunkIndex: r.chunk_index,
    contentHash: r.content_hash,
    model: r.model ?? '',
    dim: r.dim ?? 0,
    headingPath: r.heading_path ?? '',
    llmPrefix: r.llm_prefix ?? '',
    docHash: r.doc_hash ?? '',
  }));

  const plan = planIndex({
    existing,
    incoming: chunks.map((c) => ({
      sourcePath: c.sourcePath,
      chunkIndex: c.chunkIndex,
      contentHash: c.hash,
      headingPath: c.headingPath,
      llmPrefix: c.llmPrefix,
      docHash: docHashes.get(c.sourcePath) ?? '',
    })),
    syncMode,
    activePaths: fileEntries.map((f) => f.path),
    current: { model: embedder.model, dim: embedder.dim },
    contextualEnabled: contextualEnabled && !!contextualLlmBaseUrl && !!contextualLlmModel,
  });

  // 模型混用：collection 里存着另一种模型的向量，而它们会活过本次运行。继续写
  // 就会让两个向量空间混在同一个 collection 里——cosine 从此没有意义，且不会
  // 报任何错。中止并让调用方给出两条出路（选齐文件 / 改用同步模式）。
  if (plan.verdict === 'mixed-model') {
    throw new MixedModelError(
      `Collection "${collection}" contains vectors from a different embedding model. ` +
        `Re-index every source in the collection, or enable sync mode to replace them.`,
    );
  }

  // 同步模式下若有文件会被删掉，先让用户过目**确切的文件名**再动任何东西。
  // 用户拒绝 → 整轮取消，一个字节都不写——此时还没有任何 mutation，不存在
  // 需要回滚的中间态。
  //
  // 没有 `confirmPrune` 通道时**不删除**（fail-closed）：拿不到用户确认就不做
  // 危险操作。把 `plan.prune` 清空而不是抛错——调用方没提供确认通道，通常只是
  // 没想到，没必要因此让整轮索引失败；少删一次总比未经确认地删掉数据好。
  if (plan.prune.length > 0 && !confirmPrune) {
    plan.prune = [];
  }
  if (plan.prune.length > 0 && confirmPrune) {
    const ok = await confirmPrune(
      plan.notInLastRun
        .filter((r) => plan.prune.includes(r.path))
        .map((r) => ({ path: r.path, chunks: r.chunks })),
    );
    if (!ok) throw new IndexCancelledError();
  }

  // 本轮真正要删的（确认通过之后才算数）。`notInLastRun` 必须**排除**这些——
  // 否则同步删除刚成功，collection 行上却还在提示「有 N 个源不在最近一次索引中」，
  // 指着刚刚被删掉的文件，自相矛盾。
  const willPrune = new Set(plan.prune);
  const notInLastRun = plan.notInLastRun.filter((r) => !willPrune.has(r.path));

  if (chunks.length === 0) {
    // 没有新内容可写。但同步模式下的 prune 仍需执行——否则「删除某个文件后
    // 用同步模式重跑」会因为它提取不出 chunk 而永远删不掉。
    let pruned = 0;
    if (plan.prune.length > 0) {
      pruned = await deleteChunksByPaths(connectionString, collection, plan.prune);
    }
    return {
      collection,
      chunkCount: 0,
      prunedCount: pruned,
      notInLastRun,
      files: fileEntries.map((f) => ({ path: f.path, size: f.size, chunks: 0 })),
    };
  }

  // ─── Phase 3: Contextual Retrieval (Subtask 3, opt-in) ──────────
  // When enabled, ask the configured LLM to generate a ≤40-word
  // context prefix per chunk. The prefix is prepended to the embed
  // input AND stashed in `metadata.context_prefix` so the tsvector
  // expression (built in Subtask 2) picks it up via its `COALESCE`.
  // Failures degrade gracefully: a chunk whose LLM call fails still
  // indexes with an empty prefix — beat the cost of aborting the
  // whole indexing run because one chunk's call timed out.
  if (contextualEnabled && contextualLlmBaseUrl && contextualLlmModel) {
    // O(1) per-chunk source lookup. See `buildDocumentIndex` above.
    const docIndex = buildDocumentIndex(fileEntries);
    const prefixInputs = chunks.map((c, idx) => {
      // Anchor the chunk's position WITHIN its source document —
      // the LLM gets a per-file index/total, not the global one, so
      // "chunk 7 of 12" means something meaningful (chunk 7 of 12
      // in *this file*), not "chunk 7 of 500 across 40 files".
      const fileChunks = chunks.filter((x) => x.sourcePath === c.sourcePath);
      const fileChunkIndex = fileChunks.indexOf(c);
      return {
        document: docIndex.get(c.sourcePath) ?? '',
        chunkText: c.content,
        chunkIndex: fileChunkIndex,
        totalChunks: fileChunks.length,
      };
    });

    // 能沿用旧前缀的 chunk 直接跳过 LLM 调用——这是 CR 最贵的一步（每 chunk 一次
    // 调用）。旧前缀仍然有效的前提是**整篇文档逐字节没变**（`doc_hash`）：前缀
    // 描述的是「这个 chunk 在文档中的位置」，文档一变描述就不准了。
    const existingByKey = new Map<string, ExistingChunk>();
    for (const ex of existing) existingByKey.set(reuseKey(ex.sourcePath, ex.chunkIndex), ex);

    const needGeneration: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const key = reuseKey(c.sourcePath, c.chunkIndex);
      const old = existingByKey.get(key);
      if (plan.reusePrefix.has(key) && old) {
        chunks[i]!.llmPrefix = old.llmPrefix;
      } else {
        needGeneration.push(i);
      }
    }

    if (needGeneration.length > 0) {
      const prefixes = await generateContextPrefixes(
        needGeneration.map((i) => prefixInputs[i]!),
        { baseUrl: contextualLlmBaseUrl, apiKey: contextualLlmApiKey, model: contextualLlmModel },
        signal,
      );
      throwIfCancelled();
      for (let j = 0; j < needGeneration.length; j++) {
        chunks[needGeneration[j]!]!.llmPrefix = prefixes[j] ?? '';
      }
    }
    onProgress?.({ phase: 'context-generation', done: chunks.length, total: chunks.length });
  }

  // ─── Phase 4: embed in batches ──────────────────────────────────
  //
  // 能复用的 chunk 跳过嵌入调用，改用数据库里已有的向量。判定条件见 `planIndex`：
  // 送入端点的那个串逐字节相同，且模型没变。**注意 `plan` 是在 phase 2b 算的，
  // 那时 `llmPrefix` 还是占位空串**——但 `reusePrefix` 已经把「本次会不会生成
  // 新前缀」考虑进去了（CR 开启且无法复用前缀的 chunk 一律不复用向量），所以
  // 这里的结论在 phase 3 跑完之后依然成立。
  //
  // 取向量按 `INSERT_BATCH` 分批、且只取确实要复用的那些——绝不整表拉取。
  const reusedVectors = new Map<string, number[]>();
  {
    const byPath = new Map<string, number[]>();
    for (const c of chunks) {
      const key = reuseKey(c.sourcePath, c.chunkIndex);
      if (!plan.reuse.has(key)) continue;
      const arr = byPath.get(c.sourcePath);
      if (arr) arr.push(c.chunkIndex);
      else byPath.set(c.sourcePath, [c.chunkIndex]);
    }
    for (const [path, indexes] of byPath) {
      for (let i = 0; i < indexes.length; i += INSERT_BATCH_FOR_VECTORS) {
        const slice = indexes.slice(i, i + INSERT_BATCH_FOR_VECTORS);
        const fetched = await fetchEmbeddings(connectionString, collection, path, slice);
        for (const [chunkIndex, literal] of fetched) {
          reusedVectors.set(reuseKey(path, chunkIndex), parseVectorLiteral(literal));
        }
      }
    }
  }

  const EMBED_BATCH = 32;
  const embeddings: (number[] | null)[] = new Array(chunks.length).fill(null);
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    throwIfCancelled();
    const batchEnd = Math.min(i + EMBED_BATCH, chunks.length);
    const slice = chunks.slice(i, batchEnd);

    // 先填可复用的，只把剩下的送去嵌入——顺序保持，所以结果能按位置回填。
    const toEmbed: number[] = [];
    for (let j = 0; j < slice.length; j++) {
      const c = slice[j]!;
      const reused = reusedVectors.get(reuseKey(c.sourcePath, c.chunkIndex));
      if (reused) embeddings[i + j] = reused;
      else toEmbed.push(j);
    }
    if (toEmbed.length > 0) {
      // 嵌入输入 = 上下文行（结构 heading + LLM 前缀）+ 正文。上下文行**不**
      // 混入 `chunk.content`——那一列存的是用于检索的原文（不含任何前缀），
      // 只有嵌入输入拿到增强后的文本。
      const texts = toEmbed.map((j) => {
        const c = slice[j]!;
        const ctx = buildContextLine(c.headingPath, c.llmPrefix);
        return ctx ? `${ctx}\n\n${c.content}` : c.content;
      });
      const batch = await embedder.embed(texts, signal);
      for (let k = 0; k < batch.length; k++) {
        embeddings[i + toEmbed[k]!] = batch[k]!;
      }
    }
    onProgress?.({ phase: 'embedding', done: batchEnd, total: chunks.length });
  }

  // ─── Phase 5: insert ────────────────────────────────────────────
  const INSERT_BATCH = 50;
  for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
    throwIfCancelled();
    const batchEnd = Math.min(i + INSERT_BATCH, chunks.length);
    const slice = chunks.slice(i, batchEnd);
    const sliceEmbs = embeddings.slice(i, batchEnd);

    const valueClauses: string[] = [];
    const params: unknown[] = [];
    // Params: collection, source_path, chunk_index, content, content_hash,
    //         embedding (vector literal), metadata (jsonb) — 7 per row.
    let p = 1;
    for (let j = 0; j < slice.length; j++) {
      const c = slice[j]!;
      const emb = sliceEmbs[j]!;
      valueClauses.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::vector, $${p++}::jsonb)`,
      );
      // `context_prefix` 只在非空时写入——CR 关闭且无结构的集合因此保持
      // metadata 精简（`content_tsv` 的 COALESCE 把「缺 key」与 `''` 视为
      // 同一回事）。
      //
      // NB: JSON key 用 `context_prefix`（snake_case）——`retriever.ts` 与
      // `hybrid-search.ts` 都通过 `metadata->>'context_prefix'` 读它，且
      // `content_tsv` 的生成表达式也依赖这个拼写。其余 key（`embedModel` /
      // `embedDim`）保持 camelCase：SQL 从不读它们，只与进程内结构一致。
      //
      // `heading_path` 与 `llm_prefix` 是**结构化的分量**，与拼好的
      // `context_prefix` 并存：CR 开启时后者是两段的拼接，无法再拆回原样，
      // 而增量索引需要能逐字段比较这两者。
      const contextLine = buildContextLine(c.headingPath, c.llmPrefix);
      const meta: Record<string, unknown> = {
        embedModel: embedder.model,
        embedDim: embedder.dim,
      };
      if (contextLine) {
        meta.context_prefix = contextLine;
      }
      if (c.headingPath) {
        meta.heading_path = c.headingPath;
      }
      if (c.llmPrefix) {
        meta.llm_prefix = c.llmPrefix;
      }
      // 源文档全文哈希。复用判定要靠它判断旧前缀是否仍描述当前位置——前缀由
      // LLM 依据整篇文档生成，文档一变就过期。写在每个 chunk 上是冗余的，但
      // 一次查询即可读回，省掉额外的按文件查询。
      const dh = docHashes.get(c.sourcePath);
      if (dh) {
        meta.doc_hash = dh;
      }
      params.push(
        collection,
        c.sourcePath,
        c.chunkIndex,
        c.content,
        c.hash,
        embeddingToVectorLiteral(emb),
        JSON.stringify(meta),
      );
    }
    const sql = `
      INSERT INTO rag_chunks
        (collection, source_path, chunk_index, content, content_hash, embedding, metadata)
      VALUES ${valueClauses.join(',')}
      ON CONFLICT (collection, source_path, chunk_index) DO UPDATE SET
        content = EXCLUDED.content,
        content_hash = EXCLUDED.content_hash,
        embedding = EXCLUDED.embedding,
        metadata = EXCLUDED.metadata
    `;
    // 把索引的取消信号透传下去——INSERT 是大集合重索引里最慢的一步，不传的话
    // 用户点「取消」只能等它自己跑完。
    await query(connectionString, sql, params, { signal });
    onProgress?.({ phase: 'inserting', done: batchEnd, total: chunks.length });
  }

  // ─── Phase 6: 尾部裁剪（逐文件，插入完成后）────────────────────
  //
  // 必须在**该文件的所有 chunk 都提交之后**才裁。`INSERT_BATCH` 是按全局
  // `chunks` 数组切的，一个批次可能横跨两个文件，所以不能在批边界上顺手裁——
  // 那时当前文件可能还有 chunk 没写进去，裁掉尾部等于把刚要写的行删了。
  // 循环全部结束后再统一裁，天然满足「插入完成」这个前提。
  //
  // 逐文件、且带 `source_path = $2`，不可能波及别的文件。
  let tailPruned = 0;
  for (const tp of plan.tailPrune) {
    tailPruned += await deleteChunksFromIndex(
      connectionString,
      collection,
      tp.sourcePath,
      tp.fromIndex,
    );
  }

  // ─── Phase 7: 同步模式下的整份删除 ─────────────────────────────
  //
  // 用户已在 Phase 2b 确认过确切文件名。到这一步 insert 已经成功，所以删掉旧
  // 文件不会留下「删了但没写」的空洞。
  let pruned = tailPruned;
  if (plan.prune.length > 0) {
    pruned += await deleteChunksByPaths(connectionString, collection, plan.prune);
  }

  return {
    collection,
    chunkCount: chunks.length,
    prunedCount: pruned,
    notInLastRun,
    files: fileEntries.map((f) => ({ path: f.path, size: f.size, chunks: perFile[f.path] ?? 0 })),
  };
}
