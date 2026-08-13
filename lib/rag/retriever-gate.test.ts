import { afterEach, describe, expect, it, vi } from 'vitest';
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
      reranker: { id: 'mock', rerank } as unknown as Parameters<typeof retrieve>[0]['reranker'],
    });
    expect(rerank).not.toHaveBeenCalled();
  });
});