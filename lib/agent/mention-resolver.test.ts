import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the RAG module surface used by the resolver. Each test sets
// `retrieveMock` to whatever the test wants the retriever to return.
// `vi.hoisted` is required because the vi.mock factory below runs at
// module-eval time, before the top-level vi.fn() bindings would be
// initialized.
const { retrieveMock, ragSettingsGetValue, countCollectionChunksMock } = vi.hoisted(() => ({
  retrieveMock: vi.fn(),
  ragSettingsGetValue: vi.fn(),
  countCollectionChunksMock: vi.fn(),
}));
vi.mock('@/lib/rag', () => ({
  retrieve: retrieveMock,
  buildEmbedder: () => ({ model: 'stub', dim: 4, embed: async () => [[0.1, 0.2, 0.3, 0.4]] }),
  buildReranker: () => null,
  ragSettings: { getValue: ragSettingsGetValue },
  countCollectionChunks: countCollectionChunksMock,
}));

import { resolveMentionToAttachment } from './mention-resolver';

const ragChip = {
  kind: 'rag-collection' as const,
  id: 'rag:phaply',
  collection: 'phaply',
};

describe('resolveMentionToAttachment — pinned RAG path', () => {
  beforeEach(() => {
    retrieveMock.mockReset();
    ragSettingsGetValue.mockReset();
    countCollectionChunksMock.mockReset();
    ragSettingsGetValue.mockResolvedValue({ neonConnectionString: 'postgresql://test' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when retrieval returns 0 chunks and opts.minScore > 0 but not pinned (existing behavior)', async () => {
    retrieveMock.mockResolvedValue([]);
    const out = await resolveMentionToAttachment(ragChip, 'phaply', { minScore: 0.5 });
    expect(out).toBeNull();
    // countCollectionChunks is NOT called in the one-shot drop path —
    // the resolver exits before reaching the pinned-only branch.
    expect(countCollectionChunksMock).not.toHaveBeenCalled();
  });

  it('emits an empty envelope with reason="no_match" when pinned and collection has chunks but none above threshold', async () => {
    retrieveMock.mockResolvedValue([]);
    countCollectionChunksMock.mockResolvedValue(42);
    const out = await resolveMentionToAttachment(
      ragChip,
      'phaply',
      { minScore: 0.5, pinned: true },
    );
    expect(out).not.toBeNull();
    expect(out?.type).toBe('rag-context');
    expect((out as { chunks: unknown[] }).chunks).toEqual([]);
    expect((out as { reason?: string }).reason).toBe('no_match');
    expect(countCollectionChunksMock).toHaveBeenCalledOnce();
  });

  it('emits an empty envelope with reason="empty" when pinned and collection has zero rows', async () => {
    retrieveMock.mockResolvedValue([]);
    countCollectionChunksMock.mockResolvedValue(0);
    const out = await resolveMentionToAttachment(
      ragChip,
      'phaply',
      { minScore: 0.5, pinned: true },
    );
    expect(out).not.toBeNull();
    expect((out as { reason?: string }).reason).toBe('empty');
  });

  it('emits reason="no_match" if the count query fails (graceful degradation)', async () => {
    retrieveMock.mockResolvedValue([]);
    countCollectionChunksMock.mockRejectedValue(new Error('connection refused'));
    const out = await resolveMentionToAttachment(
      ragChip,
      'phaply',
      { minScore: 0.5, pinned: true },
    );
    expect(out).not.toBeNull();
    // Failure path stays with `no_match` — the envelope still reaches
    // the LLM (so it can answer "no matches") even if we can't tell
    // whether the cause was "no matches" or "no chunks at all".
    expect((out as { reason?: string }).reason).toBe('no_match');
  });

  it('does not call countCollectionChunks when retrieval returned chunks (happy path)', async () => {
    retrieveMock.mockResolvedValue([
      { sourcePath: '/x.md', chunkIndex: 0, content: 'hi', score: 0.9 },
    ]);
    const out = await resolveMentionToAttachment(
      ragChip,
      'phaply',
      { minScore: 0.5, pinned: true },
    );
    expect(out).not.toBeNull();
    expect((out as { chunks: unknown[] }).chunks.length).toBe(1);
    expect(countCollectionChunksMock).not.toHaveBeenCalled();
  });

  it('returns null when RAG is not configured (no connection string)', async () => {
    ragSettingsGetValue.mockResolvedValue({ neonConnectionString: '' });
    const out = await resolveMentionToAttachment(
      ragChip,
      'phaply',
      { pinned: true },
    );
    expect(out).toBeNull();
    expect(retrieveMock).not.toHaveBeenCalled();
  });
});