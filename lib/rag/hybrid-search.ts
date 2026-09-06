//
// Hybrid RAG search — dense (pgvector cosine) + sparse (Postgres tsvector /
// BM25) fused via Reciprocal Rank Fusion (RRF, k=60).
//
// v1 of Cebian's RAG pipeline was pure dense (Subtask 1 added HNSW on top).
// Pure dense misses keyword/code/identifier exact-match — query "điều 4
// khoản 2" or "section 230(c)(1)" doesn't tokenize into anything the
// embedding model recognizes. Hybrid RRF blends both rankings so a chunk
// that matches only one of the two still ranks well.
//
// RRF math: `score = Σ 1/(k + rank_i)` for each ranking the chunk appears
// in. We use `k=60` (the value from the original Cormack et al. 2009 paper
// and what most modern IR systems default to). The score is a pure
// ordering signal — values cluster near ~0.016 for top hits and ~0.001 for
// the tail. Callers should treat it as ranking-only, not as a probability.
//
// SQL shape: a single round-trip with two CTEs (`dense_search` + `sparse_search`)
// joined FULL OUTER, so a chunk that only appears in one ranking still
// contributes its single-side RRF term. We never create a Postgres FUNCTION
// — Neon grants don't include CREATE FUNCTION on shared plans, and an
// inline CTE runs on every call with no migration overhead.
//

import { embeddingToVectorLiteral, query } from './neon-client';

/** Standard RRF constant. Picked at 60 because it's the value used in
 *  the original RRF paper and what pgvector's own hybrid-search recipes
 *  default to. Lower k makes the top hit dominate more; higher k
 *  flattens the contributions. 60 is a fine v1 default. */
const RRF_K = 60;

/** Lower bound on the candidate count we ask Postgres to produce from
 *  each side. Must be ≥ `matchCount` so the RRF merge has enough
 *  material to re-rank. Bumped to 2× match count (min 20) so a chunk
 *  that only matches one side still has a chance to surface. */
function candidateLimit(matchCount: number): number {
  return Math.max(20, matchCount * 2);
}

/** One row returned from a hybrid search — the union of what
 *  `RetrievedChunk` carries plus the per-side ranks for diagnostics. */
export interface HybridSearchRow {
  /** Stable chunk id in Neon (used to recompose the chunk via
   *  `retriever.ts`). Not surfaced in the user-facing `RetrievedChunk`
   *  shape — retriever strips it. */
  id: number;
  sourcePath: string;
  chunkIndex: number;
  content: string;
  /** Per-side ranks inside each CTE. NULL on the side the chunk did
   *  not appear in (e.g. a keyword-only hit has `denseRank = null`).
   *  Used for diagnostics and for the RRF math; not exposed to the
   *  caller. */
  denseRank: number | null;
  sparseRank: number | null;
  /** Fused RRF score. Higher is better; top hit is ~1/(60+1) ≈ 0.0164
   *  when both sides rank it #1. Treat as ranking-only, not a
   *  probability or a similarity. */
  rrfScore: number;
  /** Subtask 3 — LLM-generated context prefix attached at index time
   *  (when Contextual Retrieval was enabled). `null` for chunks
   *  indexed before Subtask 3 or when CR was disabled (the SQL
   *  column is nullable, the map step forwards `null` directly).
   *  Retriever forwards this to the LLM/UI so the model can see
   *  "this chunk is about X" in addition to the raw text. The BM25
   *  path uses the prefix via `content_tsv` already (see
   *  `bootstrapSchema`'s COALESCE) — this field is for display only. */
  contextPrefix: string | null;
}

/**
 * Run a hybrid (vector + keyword) search over a single RAG collection
 * and return the top `matchCount` chunks fused via RRF.
 *
 * @param connectionString  Neon connection string.
 * @param collection        Collection name (exact match on the
 *                          `collection` column).
 * @param queryEmbedding     Float vector for the dense side. Caller
 *                          embeds the user's text via `Embedder.embed`.
 * @param queryText          Raw text for the sparse side. We push it
 *                          through `websearch_to_tsquery('simple', ...)`
 *                          which handles user-friendly operators
 *                          (`"phrase"`, `OR`, `-excluded`) gracefully.
 * @param matchCount         Number of rows to return. Defaults to 5
 *                          (matches the Lớp-1 default for vector-only
 *                          retrieval — symmetric with the retriever
 *                          pipeline).
 */
export async function hybridRagSearch(
  connectionString: string,
  collection: string,
  queryEmbedding: number[],
  queryText: string,
  matchCount = 5,
): Promise<HybridSearchRow[]> {
  const trimmed = queryText.trim();
  if (!trimmed) return [];
  if (matchCount <= 0) return [];

  const limit = candidateLimit(matchCount);

  // The two CTEs each fetch up to `limit` rows ranked by their own
  // scoring function. FULL OUTER JOIN means a chunk only matched on
  // one side still surfaces — its NULL rank simply contributes nothing
  // to the RRF sum on the other side via `COALESCE(..., 0)` in the
  // SELECT list. Final ORDER BY rrf_score DESC LIMIT $5 picks the
  // top-K globally.
  const rows = await query<{
    id: number;
    source_path: string;
    chunk_index: number;
    content: string;
    dense_rank: number | null;
    sparse_rank: number | null;
    rrf_score: number;
    context_prefix: string | null;
  }>(
    connectionString,
    `WITH dense_search AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
         FROM rag_chunks
        WHERE collection = $2
        LIMIT $3
     ),
     sparse_search AS (
       SELECT id, ROW_NUMBER() OVER (
         ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('simple', $4)) DESC
       ) AS rank
         FROM rag_chunks
        WHERE collection = $2
          AND content_tsv @@ websearch_to_tsquery('simple', $4)
        LIMIT $3
     )
     SELECT c.id,
            c.source_path,
            c.chunk_index,
            c.content,
            d.rank AS dense_rank,
            s.rank AS sparse_rank,
            (COALESCE(1.0 / ($6 + d.rank), 0)
             + COALESCE(1.0 / ($6 + s.rank), 0))::float AS rrf_score,
            c.metadata->>'context_prefix' AS context_prefix
       FROM dense_search d
       FULL OUTER JOIN sparse_search s ON d.id = s.id
       JOIN rag_chunks c ON c.id = COALESCE(d.id, s.id)
      ORDER BY rrf_score DESC
      LIMIT $5`,
    [
      embeddingToVectorLiteral(queryEmbedding),
      collection,
      limit,
      trimmed,
      matchCount,
      RRF_K,
    ],
  );

  return rows.map((r) => ({
    id: r.id,
    sourcePath: r.source_path,
    chunkIndex: r.chunk_index,
    content: r.content,
    denseRank: r.dense_rank,
    sparseRank: r.sparse_rank,
    rrfScore: r.rrf_score,
    contextPrefix: r.context_prefix,
  }));
}
