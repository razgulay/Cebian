import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// We mock `@/lib/rag/settings`, `@/lib/rag/embedder`,
// `@/lib/rag/hybrid-search`, and `@/lib/rag/neon-client`. The tool
// under test imports `buildEmbedder` + `ragSettings` from the
// `@/lib/rag` barrel and `hybridRagSearch` from `./hybrid-search`.
// The barrel also exports `retrieve` from `retriever.ts`, which
// itself imports `hybridRagSearch` and `embeddingToVectorLiteral` /
// `query` from `neon-client` — so the latter two mocks are required
// just to keep `retriever.ts` resolvable under fake-browser.
//
// The vi.mock factories return fresh `vi.fn()` instances and we
// re-grab those same instances below via the public imports so each
// test can configure them with `mockResolvedValueOnce` and assert
// with `toHaveBeenCalledWith`.

vi.mock('@/lib/rag/settings', () => ({
  ragSettings: { getValue: vi.fn() },
}));

vi.mock('@/lib/rag/embedder', () => {
  // `buildEmbedder` (in `@/lib/rag`) calls `new OpenAICompatEmbedder(...)`.
  // Export a real constructable class. All instances route their
  // `.embed(...)` call to a single shared `vi.fn` so tests can
  // configure / assert on it from outside the factory (factory
  // bodies can't reference top-level variables — vitest hoists
  // them above the imports).
  const sharedEmbed = vi.fn();
  class FakeOpenAICompatEmbedder {
    embed = sharedEmbed;
  }
  return {
    OpenAICompatEmbedder: FakeOpenAICompatEmbedder,
    __sharedEmbed: sharedEmbed,
  };
});

vi.mock('@/lib/rag/hybrid-search', () => ({
  hybridRagSearch: vi.fn(),
}));

vi.mock('@/lib/rag/neon-client', () => ({
  query: vi.fn(),
  embeddingToVectorLiteral: vi.fn().mockReturnValue('[0.1,0.2]'),
  bootstrapSchema: vi.fn(),
}));

import { ragSearchTool } from './rag-search';
import { ragSettings } from '@/lib/rag/settings';
import { hybridRagSearch } from '@/lib/rag/hybrid-search';
import * as EmbedderModule from '@/lib/rag/embedder';

// The imports above are the **mocked** module surfaces — every call
// here resolves to the `vi.fn()` we returned from the factory.
// `ragSettings.getValue` is a fresh `vi.fn()` per test reset;
// `hybridRagSearch` likewise. The embedder factory exposed a
// shared `__sharedEmbed` so all `new OpenAICompatEmbedder()`
// instances route their `.embed(...)` call to the same vi.fn().
const mockedGetValue = ragSettings.getValue as unknown as ReturnType<typeof vi.fn>;
const mockedHybridSearch = hybridRagSearch as unknown as ReturnType<typeof vi.fn>;
const mockedEmbedder = (EmbedderModule as unknown as {
  __sharedEmbed: ReturnType<typeof vi.fn>;
}).__sharedEmbed;

/** Default settings blob — every test spreads it and overrides what
 *  it cares about. The shape mirrors `RagSettings` but we only type
 *  the fields the tool actually reads so the test stays readable. */
const baseSettings = {
  neonConnectionString: 'postgresql://test',
  embedderBaseUrl: 'http://localhost:8317/v1',
  embedderApiKey: '',
  defaultEmbedModel: 'bge-small',
  embedderDim: 4,
  ragSearchEnabled: true,
} as const;

/** Wire `mockedEmbedder` (the shared `embed` vi.fn exposed by the
 *  embedder factory) to resolve with a single fixed-dim vector
 *  matching `baseSettings.embedderDim`. The real tool does
 *  `const [queryEmb] = await embedder.embed(...)` so we always
 *  return a 1-element array. */
function stubEmbedderSuccess(dim = 4) {
  mockedEmbedder.mockResolvedValue([Array.from({ length: dim }, () => 0.1)]);
}

describe('ragSearchTool', () => {
  beforeEach(() => {
    mockedGetValue.mockReset();
    mockedHybridSearch.mockReset();
    mockedEmbedder.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('throws when ragSearchEnabled is false (defense in depth)', async () => {
    mockedGetValue.mockResolvedValue({ ...baseSettings, ragSearchEnabled: false });
    await expect(
      ragSearchTool.execute(
        'call-1',
        { collection: 'phaply', query: 'q' } as never,
        undefined,
      ),
    ).rejects.toThrow(/rag_search is disabled/i);
    expect(mockedHybridSearch).not.toHaveBeenCalled();
    expect(mockedEmbedder).not.toHaveBeenCalled();
  });

  it('throws when RAG is not configured (no neon connection string)', async () => {
    mockedGetValue.mockResolvedValue({ ...baseSettings, neonConnectionString: '' });
    await expect(
      ragSearchTool.execute(
        'call-2',
        { collection: 'phaply', query: 'q' } as never,
        undefined,
      ),
    ).rejects.toThrow(/RAG is not configured/i);
  });

  it('throws when collection or query is empty', async () => {
    mockedGetValue.mockResolvedValue(baseSettings);
    await expect(
      ragSearchTool.execute('call-3a', { collection: '   ', query: 'q' } as never, undefined),
    ).rejects.toThrow(/collection is required/i);
    await expect(
      ragSearchTool.execute('call-3b', { collection: 'phaply', query: '' } as never, undefined),
    ).rejects.toThrow(/query is required/i);
  });

  it('returns a "no matches" envelope when hybrid search returns empty', async () => {
    mockedGetValue.mockResolvedValue(baseSettings);
    stubEmbedderSuccess();
    mockedHybridSearch.mockResolvedValueOnce([]);
    const result = await ragSearchTool.execute(
      'call-4',
      { collection: 'phaply', query: 'section 230' } as never,
      undefined,
    );
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('<rag-search-result');
    expect(text).toContain('collection="phaply"');
    expect(text).toContain('count="0"');
    expect(text).toContain('(no matching chunks');
  });

  it('returns a structured envelope with chunk XML when hybrid search hits', async () => {
    mockedGetValue.mockResolvedValue(baseSettings);
    stubEmbedderSuccess();
    mockedHybridSearch.mockResolvedValueOnce([
      {
        id: 1,
        sourcePath: '/papers/a.md',
        chunkIndex: 3,
        content: 'The transformer attention mechanism computes a weighted sum.',
        denseRank: 1,
        sparseRank: 2,
        rrfScore: 1 / 61 + 1 / 62,
        contextPrefix: 'Section on attention mechanisms.',
      },
      {
        id: 2,
        sourcePath: '/papers/b.md',
        chunkIndex: 0,
        content: 'A & B <c> "quoted" text',
        denseRank: 2,
        sparseRank: 5,
        rrfScore: 1 / 62 + 1 / 65,
        contextPrefix: null,
      },
    ]);

    const result = await ragSearchTool.execute(
      'call-5',
      { collection: 'phaply', query: 'attention mechanism', limit: 5 } as never,
      undefined,
    );
    const text = (result.content[0] as { type: 'text'; text: string }).text;

    // Envelope shape
    expect(text).toContain('<rag-search-result');
    expect(text).toContain('collection="phaply"');
    expect(text).toContain('query="attention mechanism"');
    expect(text).toContain('count="2"');

    // First chunk — context prefix surfaces, score formatted as float
    expect(text).toContain('<chunk source="/papers/a.md" index="3"');
    expect(text).toContain('context="Section on attention mechanisms."');
    expect(text).toContain('>The transformer attention mechanism');

    // Second chunk — null context prefix → no `context=` attribute;
    // content with special characters must be XML-escaped so the
    // envelope remains parseable by downstream consumers.
    // `escapeText` escapes `&`, `<`, `>` (the only chars that can
    // break XML text content); `"` is left alone since it's legal
    // in element text (only illegal inside attribute values).
    expect(text).toContain('<chunk source="/papers/b.md" index="0"');
    expect(text).not.toContain('context=""'); // not emitted when null
    expect(text).toContain('A &amp; B &lt;c&gt; "quoted" text');

    // The tool calls hybridRagSearch with the right args — collection,
    // embedding, query text, and the limit (NOT 20 — limit is the
    // explicit 5, max-20 only kicks in when the caller passed > 20).
    expect(mockedHybridSearch).toHaveBeenCalledTimes(1);
    const call = mockedHybridSearch.mock.calls[0]!;
    expect(call[1]).toBe('phaply');
    expect(Array.isArray(call[2])).toBe(true); // query embedding
    expect(call[3]).toBe('attention mechanism');
    expect(call[4]).toBe(5);
  });

  it('clamps limit to [1, 20]', async () => {
    mockedGetValue.mockResolvedValue(baseSettings);
    stubEmbedderSuccess();
    mockedHybridSearch.mockResolvedValue([]);

    // Caller passes limit=999 → clamped to 20.
    await ragSearchTool.execute(
      'call-6a',
      { collection: 'phaply', query: 'q', limit: 999 } as never,
      undefined,
    );
    expect(mockedHybridSearch.mock.calls[0]![4]).toBe(20);

    // Caller passes limit=0 → clamped to 1.
    await ragSearchTool.execute(
      'call-6b',
      { collection: 'phaply', query: 'q', limit: 0 } as never,
      undefined,
    );
    expect(mockedHybridSearch.mock.calls[1]![4]).toBe(1);

    // Caller omits limit → defaults to 5.
    await ragSearchTool.execute(
      'call-6c',
      { collection: 'phaply', query: 'q' } as never,
      undefined,
    );
    expect(mockedHybridSearch.mock.calls[2]![4]).toBe(5);
  });

  it('embeds the trimmed query (not the raw user input)', async () => {
    mockedGetValue.mockResolvedValue(baseSettings);
    stubEmbedderSuccess();
    mockedHybridSearch.mockResolvedValueOnce([]);
    await ragSearchTool.execute(
      'call-7',
      { collection: 'phaply', query: '   attention mechanism   ' } as never,
      undefined,
    );
    // `embedder.embed` receives `[trimmed]` so a leading/trailing
    // whitespace user query doesn't pollute the vector.
    expect(mockedEmbedder.mock.calls[0]![0]).toEqual(['attention mechanism']);
  });

  it('throws when the embedder returns no vector', async () => {
    mockedGetValue.mockResolvedValue(baseSettings);
    mockedEmbedder.mockResolvedValueOnce([]);
    await expect(
      ragSearchTool.execute(
        'call-8',
        { collection: 'phaply', query: 'q' } as never,
        undefined,
      ),
    ).rejects.toThrow(/embedder returned no vector/i);
    expect(mockedHybridSearch).not.toHaveBeenCalled();
  });
});
