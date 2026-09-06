import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hybridSearch from './hybrid-search';
import * as neonClient from './neon-client';
import { retrieve } from './retriever';
import type { Embedder } from './embedder';

describe('retrieve — pinned RAG relevance gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Stub embedder that returns a single deterministic vector. */
  const embedder: Embedder = {
    model: 'stub',
    dim: 4,
    async embed(texts: string[]) {
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };

  function mockQuery(rows: { source_path: string; chunk_index: number; content: string; score: number }[]) {
    return vi.spyOn(neonClient, 'query').mockResolvedValue(rows as never);
  }

  /** Subtask 2 of the Hybrid RAG plan switched the default mode to
   *  `'hybrid'`. These gate tests target the cosine (Lớp 1) path
   *  specifically, so opt into `'vector'` explicitly — keeps the
   *  test fixtures independent of the hybrid row shape (which
   *  `hybrid-search.test.ts` covers separately). */
  const VECTOR_OPTS = { mode: 'vector' as const };

  it('returns empty array when every chunk scores below minScore', async () => {
    // 5 candidates all with score 0.1 — below any reasonable threshold.
    mockQuery(
      Array.from({ length: 5 }, (_, i) => ({
        source_path: `/files/doc-${i}.md`,
        chunk_index: i,
        content: `content-${i}`,
        score: 0.1,
      })),
    );

    const out = await retrieve({
      connectionString: 'postgresql://x',
      collection: 'c',
      query: 'q',
      embedder,
      topK: 5,
      minScore: 0.5,
      ...VECTOR_OPTS,
    });
    expect(out).toEqual([]);
  });

  it('keeps chunks that score above minScore', async () => {
    mockQuery([
      { source_path: '/files/a.md', chunk_index: 0, content: 'A', score: 0.9 },
      { source_path: '/files/b.md', chunk_index: 0, content: 'B', score: 0.6 },
      { source_path: '/files/c.md', chunk_index: 0, content: 'C', score: 0.2 },
    ]);

    const out = await retrieve({
      connectionString: 'postgresql://x',
      collection: 'c',
      query: 'q',
      embedder,
      topK: 5,
      minScore: 0.5,
      ...VECTOR_OPTS,
    });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.sourcePath)).toEqual(['/files/a.md', '/files/b.md']);
  });

  it('does not call rerank when vector filter leaves zero candidates', async () => {
    mockQuery([
      { source_path: '/a', chunk_index: 0, content: 'x', score: 0.1 },
    ]);
    const rerank = vi.fn();
    await retrieve({
      connectionString: 'postgresql://x',
      collection: 'c',
      query: 'q',
      embedder,
      topK: 5,
      minScore: 0.5,
      ...VECTOR_OPTS,
      reranker: { id: 'mock', rerank } as unknown as Parameters<typeof retrieve>[0]['reranker'],
    });
    expect(rerank).not.toHaveBeenCalled();
  });
});

describe('retrieve — mode-resolution priority (Subtask 2 back-compat)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const embedder: Embedder = {
    model: 'stub',
    dim: 4,
    async embed(texts: string[]) {
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };

  /** Cosine SQL row shape (matches `retrieveVector`'s SELECT). */
  const vectorRow = (overrides: Partial<{ source_path: string; chunk_index: number; content: string; score: number; context_prefix: string | null }> = {}) => ({
    source_path: '/files/a.md',
    chunk_index: 0,
    content: 'A',
    score: 0.9,
    context_prefix: null,
    ...overrides,
  });

  /** Hybrid SQL row shape (matches `hybridRagSearch`'s SELECT). */
  const hybridRow = (overrides: Partial<{ source_path: string; chunk_index: number; content: string; rrf_score: number; dense_rank: number; sparse_rank: number }> = {}) => ({
    source_path: '/files/a.md',
    chunk_index: 0,
    content: 'A',
    dense_rank: 1,
    sparse_rank: null,
    rrf_score: 1 / 61,
    ...overrides,
  });

  it('explicit mode="vector" overrides settings.retrievalMode="hybrid"', async () => {
    const querySpy = vi.spyOn(neonClient, 'query').mockResolvedValue([vectorRow()] as never);
    const hybridSpy = vi.spyOn(hybridSearch, 'hybridRagSearch').mockResolvedValue([]);
    const out = await retrieve({
      connectionString: 'postgresql://x',
      collection: 'c',
      query: 'q',
      embedder,
      topK: 5,
      mode: 'vector',
      // Even with settings saying hybrid, the explicit `mode` wins.
      settings: { retrievalMode: 'hybrid' },
    });
    expect(out).toHaveLength(1);
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy.mock.calls[0]![1]).toContain('embedding <=> $1::vector'); // cosine SQL
    expect(hybridSpy).not.toHaveBeenCalled();
  });

  it('falls back to settings.retrievalMode="vector" when mode is omitted', async () => {
    const querySpy = vi.spyOn(neonClient, 'query').mockResolvedValue([vectorRow()] as never);
    const hybridSpy = vi.spyOn(hybridSearch, 'hybridRagSearch').mockResolvedValue([]);
    await retrieve({
      connectionString: 'postgresql://x',
      collection: 'c',
      query: 'q',
      embedder,
      topK: 5,
      // No `mode` — should resolve from settings.
      settings: { retrievalMode: 'vector' },
    });
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy.mock.calls[0]![1]).toContain('embedding <=> $1::vector');
    expect(hybridSpy).not.toHaveBeenCalled();
  });

  it('defaults to hybrid when neither mode nor settings is provided', async () => {
    const querySpy = vi.spyOn(neonClient, 'query').mockResolvedValue([]);
    const hybridSpy = vi.spyOn(hybridSearch, 'hybridRagSearch').mockResolvedValue([
      // Return a hybrid-shaped row so the retriever can map it.
      {
        id: 1,
        sourcePath: '/files/a.md',
        chunkIndex: 0,
        content: 'A',
        denseRank: 1,
        sparseRank: null,
        rrfScore: 1 / 61,
        contextPrefix: null,
      },
    ]);
    const out = await retrieve({
      connectionString: 'postgresql://x',
      collection: 'c',
      query: 'q',
      embedder,
      topK: 5,
      // Neither mode nor settings.
    });
    expect(hybridSpy).toHaveBeenCalledTimes(1);
    expect(querySpy).not.toHaveBeenCalled(); // vector SQL must NOT run
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBeCloseTo(1 / 61, 6); // RRF score, not cosine
  });
});

describe('retrieve — context_prefix forwarding (Subtask 3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const embedder: Embedder = {
    model: 'stub',
    dim: 4,
    async embed(texts: string[]) {
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };

  it('forwards context_prefix from the SQL row through the vector path', async () => {
    vi.spyOn(neonClient, 'query').mockResolvedValue([
      {
        source_path: '/files/a.md',
        chunk_index: 0,
        content: 'A',
        score: 0.9,
        context_prefix: 'Section about billing clauses.',
      },
    ] as never);
    const out = await retrieve({
      connectionString: 'postgresql://x',
      collection: 'c',
      query: 'q',
      embedder,
      topK: 5,
      mode: 'vector',
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.contextPrefix).toBe('Section about billing clauses.');
  });

  it('forwards null context_prefix for pre-CR rows', async () => {
    vi.spyOn(neonClient, 'query').mockResolvedValue([
      {
        source_path: '/files/a.md',
        chunk_index: 0,
        content: 'A',
        score: 0.9,
        context_prefix: null,
      },
    ] as never);
    const out = await retrieve({
      connectionString: 'postgresql://x',
      collection: 'c',
      query: 'q',
      embedder,
      topK: 5,
      mode: 'vector',
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.contextPrefix).toBeNull();
  });

  it('preserves context_prefix through the rerank step', async () => {
    vi.spyOn(neonClient, 'query').mockResolvedValue([
      {
        source_path: '/files/a.md',
        chunk_index: 0,
        content: 'A',
        score: 0.9,
        context_prefix: 'Section about billing.',
      },
      {
        source_path: '/files/b.md',
        chunk_index: 0,
        content: 'B',
        score: 0.6,
        context_prefix: 'Section about auth.',
      },
    ] as never);
    const rerank = vi.fn().mockResolvedValue([
      { index: 1, relevanceScore: 0.95 },
      { index: 0, relevanceScore: 0.4 },
    ]);
    const out = await retrieve({
      connectionString: 'postgresql://x',
      collection: 'c',
      query: 'q',
      embedder,
      topK: 5,
      mode: 'vector',
      reranker: { id: 'mock', rerank } as unknown as Parameters<typeof retrieve>[0]['reranker'],
      rerankTopN: 2,
    });
    expect(out.map((c) => c.contextPrefix)).toEqual([
      'Section about auth.',
      'Section about billing.',
    ]);
  });
});