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
import type { Embedder } from './embedder';
import { embeddingToVectorLiteral, query } from './neon-client';

export interface IndexProgress {
  /** Phase of work the indexer is in. UI maps to a friendly label. */
  phase: 'reading' | 'chunking' | 'embedding' | 'inserting';
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
}

export async function indexCollection(opts: IndexOptions): Promise<IndexResult> {
  const { connectionString, collection, embedder, files, chunkSize, chunkOverlap, onProgress, signal } = opts;

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

  // ─── Phase 3: embed in batches ──────────────────────────────────
  const EMBED_BATCH = 32;
  const embeddings: number[][] = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    throwIfCancelled();
    const batchEnd = Math.min(i + EMBED_BATCH, chunks.length);
    const texts = chunks.slice(i, batchEnd).map((c) => c.content);
    const batch = await embedder.embed(texts, signal);
    for (let j = 0; j < batch.length; j++) {
      embeddings[i + j] = batch[j]!;
    }
    onProgress?.({ phase: 'embedding', done: batchEnd, total: chunks.length });
  }

  // ─── Phase 4: insert ────────────────────────────────────────────
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
      params.push(
        collection,
        c.sourcePath,
        c.chunkIndex,
        c.content,
        c.hash,
        embeddingToVectorLiteral(emb),
        JSON.stringify({ embedModel: embedder.model, embedDim: embedder.dim }),
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
