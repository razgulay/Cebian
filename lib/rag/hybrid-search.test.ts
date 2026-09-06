import { afterEach, describe, expect, it, vi } from 'vitest';
import * as neonClient from './neon-client';
import { hybridRagSearch } from './hybrid-search';

describe('hybridRagSearch — RRF fusion (k=60)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Capture the SQL string + params passed to `query()` so we can
   *  assert the SQL shape (CTE names, parameter ordering) alongside
   *  the RRF math. The mock then returns whatever rows the test
   *  wants — Postgres itself isn't in the loop. */
  interface CapturedCall {
    sql: string;
    params: unknown[];
  }
  function mockQueryWith(rows: Record<string, unknown>[]) {
    const captured: CapturedCall = { sql: '', params: [] };
    vi.spyOn(neonClient, 'query').mockImplementation(async (_cs, sql, params) => {
      captured.sql = sql;
      captured.params = params ?? [];
      return rows as never;
    });
    return captured;
  }

  const baseRow = {
    id: 1,
    source_path: '/files/a.md',
    chunk_index: 0,
    content: 'A',
    dense_rank: 1,
    sparse_rank: 1,
    rrf_score: 0,
  };

  it('returns empty array for empty query text', async () => {
    const querySpy = vi.spyOn(neonClient, 'query');
    const out = await hybridRagSearch('postgresql://x', 'c', [0.1, 0.2], '   ', 5);
    expect(out).toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('returns empty array for non-positive matchCount', async () => {
    const querySpy = vi.spyOn(neonClient, 'query');
    expect(await hybridRagSearch('postgresql://x', 'c', [0.1], 'q', 0)).toEqual([]);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('sends a single SQL query with CTE-based RRF + the right parameter order', async () => {
    const captured = mockQueryWith([{ ...baseRow, rrf_score: 0.033 }]);
    await hybridRagSearch('postgresql://x', 'mycoll', [0.1, 0.2, 0.3], 'hello world', 5);

    expect(captured.sql).toContain('WITH dense_search AS');
    expect(captured.sql).toContain('sparse_search AS');
    expect(captured.sql).toContain('FULL OUTER JOIN sparse_search');
    expect(captured.sql).toContain('ts_rank_cd(content_tsv, websearch_to_tsquery');
    expect(captured.sql).toContain('websearch_to_tsquery(\'simple\'');
    expect(captured.sql).toContain('LIMIT $5');
    expect(captured.sql).toContain('($6 + d.rank)'); // RRF k constant
    // Params: [embeddingLiteral, collection, candidateLimit, queryText, matchCount, RRF_K]
    expect(captured.params).toHaveLength(6);
    expect(captured.params[0]).toBe('[0.100000,0.200000,0.300000]'); // pgvector literal
    expect(captured.params[1]).toBe('mycoll');
    expect(captured.params[3]).toBe('hello world');
    expect(captured.params[4]).toBe(5);
    expect(captured.params[5]).toBe(60); // RRF_K
    // candidateLimit = max(20, matchCount * 2) → 20 for matchCount=5
    expect(captured.params[2]).toBe(20);
  });

  it('uses larger candidate limit when matchCount is high', async () => {
    const captured = mockQueryWith([]);
    await hybridRagSearch('postgresql://x', 'c', [0.1], 'q', 50);
    expect(captured.params[2]).toBe(100); // max(20, 50 * 2)
  });

  it('maps dense_rank + sparse_rank + rrf_score from the SQL row', async () => {
    mockQueryWith([
      {
        id: 42,
        source_path: '/files/x.md',
        chunk_index: 7,
        content: 'hello',
        dense_rank: 3,
        sparse_rank: 2,
        rrf_score: 1 / 63 + 1 / 62, // k=60 → rank3 dense + rank2 sparse
      },
    ]);
    const out = await hybridRagSearch('postgresql://x', 'c', [0.1], 'q', 5);
    expect(out).toEqual([
      {
        id: 42,
        sourcePath: '/files/x.md',
        chunkIndex: 7,
        content: 'hello',
        denseRank: 3,
        sparseRank: 2,
        rrfScore: expect.closeTo(1 / 63 + 1 / 62, 6),
      },
    ]);
  });

  it('returns chunk only on dense side when sparse_rank is NULL (no keyword match)', async () => {
    // Postgres returns NULL as `null` over the wire; pgvector's RRF
    // math uses `COALESCE(1.0/(k + rank), 0)` so a NULL sparse_rank
    // contributes 0 from the sparse side. The chunk still surfaces
    // via the FULL OUTER JOIN — this is the path that catches
    // "embedding match but no exact keyword" hits.
    mockQueryWith([
      {
        id: 1,
        source_path: '/files/a.md',
        chunk_index: 0,
        content: 'A',
        dense_rank: 2,
        sparse_rank: null,
        // dense_rank=2 contributes 1/(60+2); sparse side contributes 0.
        rrf_score: 1 / 62,
      },
    ]);
    const out = await hybridRagSearch('postgresql://x', 'c', [0.1], 'q', 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.denseRank).toBe(2);
    expect(out[0]!.sparseRank).toBeNull();
    expect(out[0]!.rrfScore).toBeCloseTo(1 / 62, 6);
  });

  it('returns chunk only on sparse side when dense_rank is NULL (keyword match, embedding far)', async () => {
    // Mirror of the previous case — the BM25 hit that the embedding
    // missed. This is exactly the recall gap that motivates the
    // hybrid path. Both NULL-rank cases must surface a chunk with
    // just the one-sided RRF contribution.
    mockQueryWith([
      {
        id: 1,
        source_path: '/files/a.md',
        chunk_index: 0,
        content: 'A',
        dense_rank: null,
        sparse_rank: 1,
        rrf_score: 1 / 61, // k=60 → rank1 sparse = 1/(60+1)
      },
    ]);
    const out = await hybridRagSearch('postgresql://x', 'c', [0.1], 'q', 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.denseRank).toBeNull();
    expect(out[0]!.sparseRank).toBe(1);
    expect(out[0]!.rrfScore).toBeCloseTo(1 / 61, 6);
  });

  it('preserves row ordering from the SQL (RRF DESC at the DB level)', async () => {
    // The SQL handles ordering via `ORDER BY rrf_score DESC LIMIT $5`,
    // so the retriever must NOT re-sort — it should pass rows through
    // in the order Postgres returned them. Verify by mocking rows in
    // a deliberately unsorted-by-score order.
    mockQueryWith([
      { ...baseRow, id: 1, source_path: '/a', content: 'A', dense_rank: 1, sparse_rank: 5, rrf_score: 0.02 },
      { ...baseRow, id: 2, source_path: '/b', content: 'B', dense_rank: 5, sparse_rank: 1, rrf_score: 0.025 },
      { ...baseRow, id: 3, source_path: '/c', content: 'C', dense_rank: 2, sparse_rank: 2, rrf_score: 0.032 },
    ]);
    const out = await hybridRagSearch('postgresql://x', 'c', [0.1], 'q', 5);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3]); // input order preserved
  });
});
