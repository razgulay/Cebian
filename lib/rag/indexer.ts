//
// RAG indexer — reads files, chunks, embeds, persists to Neon.
//
// Reindexing is idempotent via `ON CONFLICT (collection, source_path,
// chunk_index) DO UPDATE`. Adding new files adds rows; deleting files
// from disk leaves orphan rows in Neon (cleanup is a follow-up — not a
// blocker for personal use at this scale).
//

import { getFileExtension } from '@/lib/agent/attachments';
import { chunkText, contentHash, extractPdfTextFromFile } from './chunker';
import { generateContextPrefixes } from './contextual-generator';
import type { Embedder } from './embedder';
import { embeddingToVectorLiteral, query } from './neon-client';

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
  // When `contextualRetrievalEnabled` is true the indexer inserts a
  // `context-generation` phase between chunking and embedding. Per
  // chunk we ask a cheap LLM to describe where the chunk sits in its
  // source document, prepend the prefix to the embed input, and stash
  // it in `metadata.context_prefix` so the BM25 path picks it up via
  // the `COALESCE` in `content_tsv` (Subtask 2). When false (default)
  // the indexer behaves byte-identically to pre-Subtask-3.
  contextualEnabled?: boolean;
  contextualLlmBaseUrl?: string;
  contextualLlmApiKey?: string;
  contextualLlmModel?: string;
}

export interface IndexResult {
  collection: string;
  chunkCount: number;
  files: { path: string; size: number; chunks: number }[];
}

export class IndexCancelledError extends Error {
  constructor() {
    super('Indexing cancelled');
    this.name = 'IndexCancelledError';
  }
}

const PDF_EXT = '.pdf';

interface ChunkEntry {
  sourcePath: string;
  chunkIndex: number;
  content: string;
  hash: string;
  /** LLM-generated context prefix for this chunk. Empty string when
   *  CR is disabled or generation failed (graceful degradation — the
   *  chunk still indexes). */
  contextPrefix: string;
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
  } = opts;

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new IndexCancelledError();
  };

  // ─── Phase 1: read files ────────────────────────────────────────
  type FileEntry = { path: string; text: string; size: number };
  const fileEntries: FileEntry[] = [];
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
  }
  onProgress?.({ phase: 'reading', done: files.length, total: files.length });

  // ─── Phase 2: chunk ─────────────────────────────────────────────
  throwIfCancelled();
  const chunks: ChunkEntry[] = [];
  const perFile: Record<string, number> = {};
  for (const fe of fileEntries) {
    const parts = chunkText(fe.text, { size: chunkSize, overlap: chunkOverlap });
    perFile[fe.path] = parts.length;
    for (let i = 0; i < parts.length; i++) {
      chunks.push({
        sourcePath: fe.path,
        chunkIndex: i,
        content: parts[i]!,
        hash: contentHash(parts[i]!),
        contextPrefix: '', // populated in Phase 3 when CR is enabled
      });
    }
  }
  onProgress?.({ phase: 'chunking', done: chunks.length, total: chunks.length });

  if (chunks.length === 0) {
    return {
      collection,
      chunkCount: 0,
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
    const prefixes = await generateContextPrefixes(
      prefixInputs,
      { baseUrl: contextualLlmBaseUrl, apiKey: contextualLlmApiKey, model: contextualLlmModel },
      signal,
    );
    throwIfCancelled();
    for (let i = 0; i < chunks.length; i++) {
      chunks[i]!.contextPrefix = prefixes[i] ?? '';
    }
    onProgress?.({ phase: 'context-generation', done: chunks.length, total: chunks.length });
  }

  // ─── Phase 4: embed in batches ──────────────────────────────────
  const EMBED_BATCH = 32;
  const embeddings: number[][] = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    throwIfCancelled();
    const batchEnd = Math.min(i + EMBED_BATCH, chunks.length);
    const slice = chunks.slice(i, batchEnd);
    // When CR is enabled and a prefix is present, prepend it to the
    // embed input per Anthropic's recipe. The prefix is *not* stripped
    // from `chunk.content` — that column stores the raw text for
    // retrieval (no prefix mixed in); only the embed input gets the
    // augmented text.
    const texts = slice.map((c) =>
      c.contextPrefix ? `${c.contextPrefix}\n\n${c.content}` : c.content,
    );
    const batch = await embedder.embed(texts, signal);
    for (let j = 0; j < batch.length; j++) {
      embeddings[i + j] = batch[j]!;
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
      // Only include `context_prefix` in metadata when CR is enabled
      // AND this chunk got one — keeps the metadata row compact for
      // collections where CR is off (the COALESCE in `content_tsv`
      // treats a missing key the same as `''`).
      //
      // NB: the JSON key is `context_prefix` (snake_case) — both
      // `retriever.ts` and `hybrid-search.ts` read it back via
      // `metadata->>'context_prefix'`. The other meta keys
      // (`embedModel`, `embedDim`) stay camelCase for consistency
      // with the in-process shape — they're never read by SQL.
      const meta: Record<string, unknown> = {
        embedModel: embedder.model,
        embedDim: embedder.dim,
      };
      if (c.contextPrefix) {
        meta.context_prefix = c.contextPrefix;
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
    await query(connectionString, sql, params);
    onProgress?.({ phase: 'inserting', done: batchEnd, total: chunks.length });
  }

  return {
    collection,
    chunkCount: chunks.length,
    files: fileEntries.map((f) => ({ path: f.path, size: f.size, chunks: perFile[f.path] ?? 0 })),
  };
}
