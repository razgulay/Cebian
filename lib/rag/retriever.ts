//
// RAG retriever — 2-stage retrieval pipeline:
//
//   Lớp 1 (retrieval): embed the user query, fetch top-K candidates
//     from Neon. Two strategies are supported (controlled by
//     `RetrieveOptions.mode`):
//
//       • 'vector' — pure dense cosine on the HNSW index (`<=>`
//         operator). Original v1 behavior. Fast but noisy: embeddings
//         conflate semantic relatedness with lexical overlap, so
//         keyword/code/identifier queries underperform.
//
//       • 'hybrid' — dense cosine (HNSW) + sparse BM25 (tsvector /
//         GIN) fused via Reciprocal Rank Fusion (k=60). Recommended
//         default. See `lib/rag/hybrid-search.ts` for the SQL.
//
//     `retrieve()` keeps the two paths as separate helper functions
//     so the cosine branch is byte-identical to v1 when the user
//     explicitly opts into vector-only mode.
//
//   Lớp 2 (rerank, optional): when the user has enabled a rerank
//     endpoint in settings, pass the Lớp-1 candidates through a
//     cross-encoder-style model that scores each candidate against
//     the query more carefully, then return the top-N (rerankTopN,
//     smaller than vectorTopK). When rerank is disabled or fails, we
//     fall back to the raw Lớp-1 results — never an empty envelope
//     unless Lớp 1 itself returned nothing.
//
// Lớp 1 query semantics: pgvector serves the `<=>` (cosine distance)
// operator via an HNSW index on the embedding column — see
// `rag_chunks_hnsw_idx` created in `bootstrapSchema` (Subtask 1 of
// the Hybrid RAG plan). HNSW is approximate by design, but for our
// embedding model + candidate set (topK ≤ 50 after Subtask 2) the
// recall at the top of the ranking is effectively indistinguishable
// from a brute-force scan. The pgvector planner still picks a
// seq-scan when a collection is tiny enough that HNSW's fixed
// per-query overhead would dominate — no app-side branching needed.
//
// Future per-collection tuning (e.g., raising `ef_search` for
// higher-recall users) can drop into `bootstrapSchema` without
// touching the retriever body.
//

import type { Embedder } from './embedder';
import { hybridRagSearch } from './hybrid-search';
import { embeddingToVectorLiteral, query } from './neon-client';
import type { Reranker } from './reranker';
import type { RagSettings, RetrievedChunk } from './types';

/** Retrieval strategy. `'hybrid'` (recommended default) runs dense
 *  cosine + sparse BM25 fused via RRF; `'vector'` keeps the original
 *  v1 pure-cosine behavior for users who want it. */
export type RetrievalMode = 'vector' | 'hybrid';

/** Back-compat call shape: callers that don't care about the
 *  retrieval mode (the historical `retrieve({...})` API) pass the
 *  full `RagSettings` blob and we read `retrievalMode` from it.
 *  This keeps `lib/agent/mention-resolver.ts` (and any other
 *  pre-Subtask-2 caller) working without a per-call mode override. */
export interface RetrieveOptions {
  connectionString: string;
  collection: string;
  query: string;
  embedder: Embedder;
  /** Number of Lớp-1 candidates to fetch. Must be ≥ `rerankTopN` if a
   *  reranker is provided. */
  topK: number;
  /** Optional score threshold — drop chunks below this score.
   *
   *  **Score scale depends on `mode`**: in `'vector'` mode it's cosine
   *  similarity in [0, 1] (1 = identical). In `'hybrid'` mode it's the
   *  fused RRF score in roughly [0, 0.033] (top hit ≈ 0.0164 with k=60).
   *  A threshold calibrated for one mode will over- or under-filter under
   *  the other — call sites that flip modes should reset the threshold.
   *  Default 0 (no filtering). */
  minScore?: number;
  /** Optional Lớp-2 reranker. When provided, the retriever:
   *    1. fetches `topK` candidates via the chosen `mode`,
   *    2. calls `reranker.rerank(...)` with `topN` (capped at topK),
   *    3. returns the reranked top-N with relevanceScore mapped to score.
   *  On rerank failure, falls back to the raw top-K so the
   *  caller still gets something — the envelope degrades gracefully. */
  reranker?: Reranker;
  rerankTopN?: number;
  /** Override the retrieval strategy for this single call. When
   *  omitted, falls back to `settings.retrievalMode`. If neither is
   *  provided, defaults to `'hybrid'` (recommended). */
  mode?: RetrievalMode;
  /** Optional settings blob — when `mode` is omitted we read
   *  `settings.retrievalMode`. This is the back-compat path for
   *  callers that pre-date Subtask 2 (mention resolver, rag_inspect
   *  wiring) and don't yet pass an explicit `mode`. */
  settings?: Pick<RagSettings, 'retrievalMode'>;
}

export async function retrieve(opts: RetrieveOptions): Promise<RetrievedChunk[]> {
  const { connectionString, collection, query: q, embedder, topK, minScore = 0 } = opts;

  const trimmed = q.trim();
  if (!trimmed) return [];
  if (topK <= 0) return [];

  const [queryEmb] = await embedder.embed([trimmed]);
  if (!queryEmb) return [];

  // Resolve the effective retrieval mode. Priority: explicit `mode`
  // option > `settings.retrievalMode` > default `'hybrid'`. The
  // default order matches the plan — hybrid is the recommended
  // baseline so callers that don't pass either still get the new
  // behavior on upgrade.
  const mode: RetrievalMode = opts.mode ?? opts.settings?.retrievalMode ?? 'hybrid';

  const candidates: RetrievedChunk[] = mode === 'hybrid'
    ? await retrieveHybrid(connectionString, collection, queryEmb, trimmed, topK, minScore)
    : await retrieveVector(connectionString, collection, queryEmb, topK, minScore);

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
        // model's confidence ordering, not the noisy cosine / RRF
        // number.
        score: r.relevanceScore,
        // Preserve the context prefix (if any) through the rerank
        // pass — the prefix doesn't change, only the order does.
        contextPrefix: original.contextPrefix,
      };
    });
  } catch (err) {
    // Graceful degradation: log + return the mode-specific top-K. The
    // user still gets chunks; they just aren't reranked. Surfacing
    // the error here would block the send — the rerank endpoint
    // being down shouldn't kill chat.
    console.warn('[RAG retriever] rerank failed, falling back to Lớp 1', err);
    return candidates;
  }
}

/** Lớp 1 dense-only path. Original v1 behavior — preserved verbatim
 *  so users who set `retrievalMode = 'vector'` get byte-identical
 *  retrieval to pre-Subtask-2. */
async function retrieveVector(
  connectionString: string,
  collection: string,
  queryEmb: number[],
  topK: number,
  minScore: number,
): Promise<RetrievedChunk[]> {
  // Cast `$1::vector` so pgvector parses the literal as a vector type.
  // The `<=>` operator returns cosine distance (0 = identical, 2 =
  // opposite). We subtract from 1 to get cosine similarity.
  const rows = await query<{
    source_path: string;
    chunk_index: number;
    content: string;
    score: number;
    context_prefix: string | null;
  }>(
    connectionString,
    `SELECT source_path,
            chunk_index,
            content,
            1 - (embedding <=> $1::vector) AS score,
            metadata->>'context_prefix' AS context_prefix
       FROM rag_chunks
      WHERE collection = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [embeddingToVectorLiteral(queryEmb), collection, topK],
  );

  const out: RetrievedChunk[] = [];
  for (const r of rows) {
    if (r.score < minScore) continue;
    out.push({
      sourcePath: r.source_path,
      chunkIndex: r.chunk_index,
      content: r.content,
      score: r.score,
      // `context_prefix` is `null` for chunks indexed before Subtask 3
      // (no `metadata.context_prefix` key) or when CR was disabled for
      // that chunk. Surface it as-is so downstream callers can render
      // the prefix in tool cards / answer envelopes without a separate
      // DB read.
      contextPrefix: r.context_prefix,
    });
  }
  return out;
}

/** Lớp 1 hybrid path. Dense cosine (HNSW) + sparse BM25 (tsvector /
 *  GIN) fused via Reciprocal Rank Fusion. `minScore` is interpreted
 *  on the RRF scale (see `RetrieveOptions.minScore` doc). */
async function retrieveHybrid(
  connectionString: string,
  collection: string,
  queryEmb: number[],
  queryText: string,
  topK: number,
  minScore: number,
): Promise<RetrievedChunk[]> {
  const rows = await hybridRagSearch(connectionString, collection, queryEmb, queryText, topK);
  const out: RetrievedChunk[] = [];
  for (const r of rows) {
    if (r.rrfScore < minScore) continue;
    out.push({
      sourcePath: r.sourcePath,
      chunkIndex: r.chunkIndex,
      content: r.content,
      score: r.rrfScore,
      // Forwarded from `hybridRagSearch` — `null` for pre-CR chunks
      // and chunks indexed without CR enabled.
      contextPrefix: r.contextPrefix,
    });
  }
  return out;
}