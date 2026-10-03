import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the RAG module surface used by the resolver. Each test sets
// `retrieveMock` to whatever the test wants the retriever to return.
// `vi.hoisted` is required because the vi.mock factory below runs at
// module-eval time, before the top-level vi.fn() bindings would be
// initialized.
const {
  retrieveMock,
  ragSettingsGetValue,
  countCollectionChunksMock,
  readCollectionEmbedIdentityMock,
  describeEmbedderMismatchMock,
  warnLegacyEmbedRowsMock,
} = vi.hoisted(() => ({
  retrieveMock: vi.fn(),
  ragSettingsGetValue: vi.fn(),
  countCollectionChunksMock: vi.fn(),
  readCollectionEmbedIdentityMock: vi.fn(),
  describeEmbedderMismatchMock: vi.fn(),
  warnLegacyEmbedRowsMock: vi.fn(),
}));
vi.mock('@/lib/rag', () => ({
  retrieve: retrieveMock,
  buildEmbedder: () => ({ model: 'stub', dim: 4, embed: async () => [[0.1, 0.2, 0.3, 0.4]] }),
  buildReranker: () => null,
  ragSettings: { getValue: ragSettingsGetValue },
  countCollectionChunks: countCollectionChunksMock,
  readCollectionEmbedIdentity: readCollectionEmbedIdentityMock,
  describeEmbedderMismatch: describeEmbedderMismatchMock,
  warnLegacyEmbedRows: warnLegacyEmbedRowsMock,
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
    readCollectionEmbedIdentityMock.mockReset();
    describeEmbedderMismatchMock.mockReset();
    warnLegacyEmbedRowsMock.mockReset();
    ragSettingsGetValue.mockResolvedValue({ neonConnectionString: 'postgresql://test' });
    // Clean, fully-identified collection by default — every existing
    // test relies on the guard passing through.
    readCollectionEmbedIdentityMock.mockResolvedValue({
      total: 10,
      identified: 10,
      pairs: [],
    });
    describeEmbedderMismatchMock.mockReturnValue(null);
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

  it('emits reason="model_mismatch" WITHOUT retrieving when the collection was indexed with another embedder', async () => {
    // The pin path must NOT throw — failures here are silent and count
    // toward auto-unpin; a fixable config error would silently tear
    // down the user's pin. The envelope tells the LLM what to say.
    describeEmbedderMismatchMock.mockReturnValue(
      'This collection was indexed with embedding model "old-model" ...',
    );
    const out = await resolveMentionToAttachment(ragChip, 'phaply', { pinned: true });
    expect(out).not.toBeNull();
    expect(out?.type).toBe('rag-context');
    expect((out as { reason?: string }).reason).toBe('model_mismatch');
    expect((out as { chunks: unknown[] }).chunks).toEqual([]);
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('proceeds to retrieval with a legacy warn when some chunks lack model metadata', async () => {
    readCollectionEmbedIdentityMock.mockResolvedValue({
      total: 10,
      identified: 4,
      pairs: [],
    });
    retrieveMock.mockResolvedValue([
      { sourcePath: '/x.md', chunkIndex: 0, content: 'hi', score: 0.9 },
    ]);
    const out = await resolveMentionToAttachment(ragChip, 'phaply', { pinned: true });
    expect(out).not.toBeNull();
    expect((out as { chunks: unknown[] }).chunks.length).toBe(1);
    expect(warnLegacyEmbedRowsMock).toHaveBeenCalledTimes(1);
    expect(retrieveMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveMentionToAttachment — worker-role path', () => {
  it('worker-role chip → 不产 attachment（null，directive 由 ChatInput 单独注入）', async () => {
    const { resolveMentionToAttachment } = await import('./mention-resolver');
    const chip = {
      kind: 'worker-role' as const,
      id: 'r1',
      role: 'reviewer' as const,
    };
    const out = await resolveMentionToAttachment(chip);
    expect(out).toBeNull();
    // 关键：worker-role 路径不查 VFS、不查 grants、不查 RAG——只是 directive
    // 注入的事，由 ChatInput.handleSend 单独处理。
    expect(retrieveMock).not.toHaveBeenCalled();
  });
});