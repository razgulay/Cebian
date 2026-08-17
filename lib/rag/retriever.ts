//
// RAG retriever — 2-stage retrieval pipeline:
//
//   Lớp 1 (vector search): embed the user query, fetch top-K candidates
//     from Neon by cosine similarity (`<=>` operator). This is fast but
//     noisy — embedding similarity conflates semantic relatedness with
//     lexical overlap.
//
//   Lớp 2 (rerank, optional): when the user has enabled a rerank
//     endpoint in settings, pass the Lớp-1 candidates through a
//     cross-encoder-style model that scores each candidate against the
//     query more carefully, then return the top-N (rerankTopN, smaller
//     than vectorTopK). When rerank is disabled or fails, we fall back
//     to the raw Lớp-1 results — never an empty envelope unless Lớp 1
//     itself returned nothing.
//
// v1 ships brute-force cosine. For <10k chunks per collection pgvector
// handles seq-scan with the <=> operator in <100 ms, and we avoid the
// IVFFlat training step entirely. When a collection grows beyond that,
// add an `ivfflat` index per collection (CREATE INDEX … USING ivfflat
// (embedding vector_cosine_ops) WITH (lists = 100)) — that's a
// follow-up toggle in the settings UI.
//

import type { Embedder } from './embedder';
import { embeddingToVectorLiteral, query } from './neon-client';
import type { Reranker } from './reranker';
import type { RetrievedChunk } from './types';

export interface RetrieveOptions {
  connectionString: string;
  collection: string;
  query: string;
  embedder: Embedder;
  /** Number of Lớp-1 candidates to fetch. Must be ≥ `rerankTopN` if a
   *  reranker is provided. */
  topK: number;
  /** Optional score threshold — drop chunks below this cosine similarity.
   *  Useful to suppress irrelevant noise when the query is off-topic
   *  relative to the collection. Default 0 (no filtering). */
  minScore?: number;
  /** Optional Lớp-2 reranker. When provided, the retriever:
   *    1. fetches `topK` candidates via cosine,
   *    2. calls `reranker.rerank(...)` with `topN` (capped at topK),
   *    3. returns the reranked top-N with relevanceScore mapped to score.
   *  On rerank failure, falls back to the raw cosine top-K so the
   *  caller still gets something — the envelope degrades gracefully. */
  reranker?: Reranker;
  rerankTopN?: number;
}

export async function retrieve(opts: RetrieveOptions): Promise<RetrievedChunk[]> {
  const { connectionString, collection, query: q, embedder, topK, minScore = 0 } = opts;

  const trimmed = q.trim();
  if (!trimmed) return [];
  if (topK <= 0) return [];

  const [queryEmb] = await embedder.embed([trimmed]);
  if (!queryEmb) return [];

  // Cast `$1::vector` so pgvector parses the literal as a vector type.
  // The `<=>` operator returns cosine distance (0 = identical, 2 =
  // opposite). We subtract from 1 to get cosine similarity.
  const rows = await query<{
    source_path: string;
    chunk_index: number;
    content: string;
    score: number;
  }>(
    connectionString,
    `SELECT source_path,
            chunk_index,
            content,
            1 - (embedding <=> $1::vector) AS score
       FROM rag_chunks
      WHERE collection = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [embeddingToVectorLiteral(queryEmb), collection, topK],
  );

  const candidates: RetrievedChunk[] = [];
  for (const r of rows) {
    if (r.score < minScore) continue;
    candidates.push({
      sourcePath: r.source_path,
      chunkIndex: r.chunk_index,
      content: r.content,
      score: r.score,
    });
  }

  if (candidates.length === 0) return [];
  if (!opts.reranker) return candidates;

  // ─── Lớp 2 — rerank ──────────────────────────────────────────────
  const topN = Math.max(1, Math.min(opts.rerankTopN ?? 3, candidates.length));
  try {
    const reranked = await opts.reranker.rerank({
      query: trimmed,
      documents: candidates.map((c) => c.content),
      topN,
    });
    return reranked.map((r) => {
      const original = candidates[r.index]!;
      return {
        sourcePath: original.sourcePath,
        chunkIndex: original.chunkIndex,
        content: original.content,
        // Surface the reranker's relevance score so the LLM sees the
        // model's confidence ordering, not the noisy cosine number.
        score: r.relevanceScore,
      };
    });
  } catch (err) {
    // Graceful degradation: log + return the cosine top-K. The user
    // still gets chunks; they just aren't reranked. Surfacing the
    // error here would block the send — the rerank endpoint being
    // down shouldn't kill chat.
    console.warn('[RAG retriever] rerank failed, falling back to cosine', err);
    return candidates;
  }
}