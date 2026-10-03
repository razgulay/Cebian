import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the RAG settings + neon-client module-level so we don't need to
// touch the real chrome.storage layer. Each test adjusts the return
// values via the exported vi.fn handles. `vi.hoisted` is required
// because the vi.mock factories below run at module-eval time, before
// top-level vi.fn() bindings would be initialized.
const { ragSettingsGetValue, queryMock, knownNamesMock } = vi.hoisted(() => ({
  ragSettingsGetValue: vi.fn(),
  queryMock: vi.fn(),
  knownNamesMock: vi.fn(),
}));
vi.mock('@/lib/rag/settings', () => ({
  ragSettings: { getValue: ragSettingsGetValue },
  listKnownCollectionNames: knownNamesMock,
}));

vi.mock('@/lib/rag/neon-client', () => ({
  query: queryMock,
}));

import { ragInspectTool } from './rag-inspect';

describe('ragInspectTool', () => {
  beforeEach(() => {
    ragSettingsGetValue.mockReset();
    queryMock.mockReset();
    knownNamesMock.mockReset();
    knownNamesMock.mockResolvedValue(['phaply', 'docs']);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a friendly error when RAG is not configured', async () => {
    ragSettingsGetValue.mockResolvedValue({ neonConnectionString: '' });
    await expect(
      ragInspectTool.execute('call-1', { collection: 'phaply' } as never, undefined),
    ).rejects.toThrow(/RAG is not configured/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('reports zero rows honestly (may not exist OR empty) with known-name hints', async () => {
    ragSettingsGetValue.mockResolvedValue({ neonConnectionString: 'postgresql://test' });
    // File GROUP BY returns 0 rows — the collection is missing or empty;
    // the tool can no longer claim "exists" (C2 fix).
    queryMock.mockResolvedValueOnce([]);
    const result = await ragInspectTool.execute(
      'call-2',
      { collection: 'phap_ly' } as never,
      undefined,
    );
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('may not exist or has zero indexed chunks');
    expect(text).not.toContain('exists but is empty');
    expect(text).toContain('phap_ly');
    expect(text).toContain('known on this device');
    expect(text).toContain('phaply'); // suggested known name
  });

  it('reports zero rows without a name list when local meta is empty', async () => {
    ragSettingsGetValue.mockResolvedValue({ neonConnectionString: 'postgresql://test' });
    queryMock.mockResolvedValueOnce([]);
    knownNamesMock.mockResolvedValue([]);
    const result = await ragInspectTool.execute(
      'call-2b',
      { collection: 'nope' } as never,
      undefined,
    );
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('may not exist or has zero indexed chunks');
    expect(text).not.toContain('known on this device');
  });

  it('lists files + chunk counts + embedder model + dimension', async () => {
    ragSettingsGetValue.mockResolvedValue({ neonConnectionString: 'postgresql://test' });
    queryMock
      .mockResolvedValueOnce([
        { source_path: '/papers/a.pdf', chunk_count: 12 },
        { source_path: '/papers/b.md', chunk_count: 4 },
      ])
      .mockResolvedValueOnce([
        {
          metadata: { embedModel: 'bge-small', embedDim: 384 },
          created_at: '2026-08-01T10:00:00Z',
        },
      ]);

    const result = await ragInspectTool.execute(
      'call-3',
      { collection: 'phaply' } as never,
      undefined,
    );
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    expect(text).toContain('Collection: phaply');
    expect(text).toContain('Total chunks: 16 across 2 file(s)');
    expect(text).toContain('Embedder: bge-small (dim=384)');
    expect(text).toContain('2026-08-01T10:00:00Z');
    expect(text).toContain('/papers/a.pdf');
    expect(text).toContain('(12 chunks)');
    expect(text).toContain('/papers/b.md');
    expect(text).toContain('(4 chunks)');
  });

  it('handles a single-file collection (singular chunk label)', async () => {
    ragSettingsGetValue.mockResolvedValue({ neonConnectionString: 'postgresql://test' });
    queryMock
      .mockResolvedValueOnce([{ source_path: '/x.md', chunk_count: 1 }])
      .mockResolvedValueOnce([{ metadata: null, created_at: '2026-08-01T10:00:00Z' }]);

    const result = await ragInspectTool.execute(
      'call-4',
      { collection: 'phaply' } as never,
      undefined,
    );
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('(1 chunk)'); // singular
    expect(text).not.toContain('(1 chunks)');
    expect(text).toContain('Embedder: unknown (dim=unknown)'); // metadata was null
  });

  it('runs the file GROUP BY and metadata peek against the same collection', async () => {
    ragSettingsGetValue.mockResolvedValue({ neonConnectionString: 'postgresql://test' });
    queryMock
      .mockResolvedValueOnce([{ source_path: '/x.md', chunk_count: 7 }])
      .mockResolvedValueOnce([{ metadata: { embedModel: 'bge-small', embedDim: 384 }, created_at: '2026-08-01T10:00:00Z' }]);

    await ragInspectTool.execute('call-5', { collection: 'phaply' } as never, undefined);

    expect(queryMock).toHaveBeenCalledTimes(2);
    // query() signature is (connectionString, sqlText, params). The
    // collection name lives in the params array (index 2) and is
    // bound to the $1 placeholder in both queries.
    for (const call of queryMock.mock.calls) {
      const params = call[2] as unknown[];
      expect(params).toContain('phaply');
    }
  });
});