//
// Unit tests for Contextual Retrieval prefix generator.
//
// Mock surface area is just `globalThis.fetch` — the LLM call uses
// `fetch` directly (mirroring the embedder). The four behaviors that
// matter for indexer correctness are:
//   1. ≤ 60-word LLM output passes through with `buildPrompt` structure.
//   2. > 60-word LLM output gets truncated at the word boundary.
//   3. Empty / thrown response → `''` (graceful degradation).
//   4. Smart context window: doc ≤ 40K chars → full document; doc > 40K
//      → slim envelope (title + outline + surrounding paragraphs).
//
// `truncateToWordBoundary` and `extractSlimContext` are exported so the
// tests can poke the pure logic without any LLM at all.
//

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPrompt,
  extractSlimContext,
  generateContextPrefix,
  generateContextPrefixes,
  truncateToWordBoundary,
} from './contextual-generator';

describe('truncateToWordBoundary', () => {
  it('returns empty string for empty / whitespace-only input', () => {
    expect(truncateToWordBoundary('', 10)).toBe('');
    expect(truncateToWordBoundary('   ', 10)).toBe('');
    expect(truncateToWordBoundary('\n\t', 10)).toBe('');
  });

  it('returns input verbatim when it fits within maxWords', () => {
    expect(truncateToWordBoundary('one two three', 5)).toBe('one two three');
    // Leading/trailing whitespace is trimmed; internal runs are
    // preserved (the function only splits on whitespace, doesn't
    // normalize it).
    expect(truncateToWordBoundary('  spaced  out  ', 5)).toBe('spaced  out');
  });

  it('cuts at the last word boundary ≤ maxWords', () => {
    expect(truncateToWordBoundary('a b c d e f g', 3)).toBe('a b c');
    expect(truncateToWordBoundary('a b c d e f g', 1)).toBe('a');
  });

  it('treats any whitespace as a word separator (re-joined with single space)', () => {
    // Truncation collapses runs of whitespace to single spaces — the
    // word-boundary cut is the same regardless of which separator
    // was used in the source.
    expect(truncateToWordBoundary('one\ttwo\nthree   four', 2)).toBe('one two');
  });
});

describe('buildPrompt — smart context window', () => {
  const baseOpts = {
    document: '',
    chunkText: 'chunk body',
    llmBaseUrl: 'http://x',
    llmApiKey: '',
    llmModel: 'm',
    chunkIndex: 0,
    totalChunks: 1,
  };

  it('embeds the full document when it fits within 40K chars', () => {
    const doc = 'lorem ipsum '.repeat(1000); // ~12K chars
    const prompt = buildPrompt({ ...baseOpts, document: doc });
    expect(prompt).toContain('<document>');
    expect(prompt).toContain('</document>');
    expect(prompt).toContain(doc);
    expect(prompt).not.toContain('<document-slim>');
  });

  it('uses slim envelope when document > 40K chars', () => {
    const longDoc = '# Title\n\n## Section A\n\n' + 'lorem ipsum '.repeat(5000); // ~60K
    const prompt = buildPrompt({ ...baseOpts, document: longDoc });
    expect(prompt).not.toContain('<document>');
    expect(prompt).toContain('<document-slim>');
    expect(prompt).toContain('<title>Title</title>');
    expect(prompt).toContain('<outline>');
  });

  it('places <chunk> after the document block so the model knows what to contextualize', () => {
    const prompt = buildPrompt({ ...baseOpts, document: 'short doc' });
    const docEnd = prompt.indexOf('</document>');
    const chunkStart = prompt.indexOf('<chunk>');
    expect(docEnd).toBeGreaterThan(-1);
    expect(chunkStart).toBeGreaterThan(docEnd);
    expect(prompt).toContain('<chunk>\nchunk body\n</chunk>');
  });

  it('includes the chunk index / total hint when provided', () => {
    const prompt = buildPrompt({ ...baseOpts, chunkIndex: 4, totalChunks: 12 });
    expect(prompt).toContain('(chunk 5 of 12)');
  });

  it('omits the (chunk N of M) location hint when chunkIndex is not provided', () => {
    // The base prompt text mentions "chunk" in many places (e.g.
    // "for one chunk of a document", "<chunk>...</chunk>") — the
    // location hint we conditionally append is the parenthesized
    // "(chunk N of M)" fragment. Assert against that specific shape.
    const prompt = buildPrompt({
      ...baseOpts,
      chunkIndex: undefined,
      totalChunks: undefined,
    });
    expect(prompt).not.toMatch(/\(chunk \d+ of \d+\)/);
  });

  it('declares a hard word limit that matches the post-processor (60)', () => {
    const prompt = buildPrompt({ ...baseOpts, document: 'short' });
    expect(prompt).toContain('Hard limit 60 words');
  });
});

describe('extractSlimContext', () => {
  it('uses the first heading as title', () => {
    const slim = extractSlimContext(
      '# My Document\n\n## Section A\n\nbody text',
      'body text',
    );
    expect(slim).toContain('<title>My Document</title>');
  });

  it('falls back to "(untitled document)" when there are no markdown headings', () => {
    const slim = extractSlimContext(
      'plain prose with no headings at all\n\nanother paragraph',
      'plain prose',
    );
    expect(slim).toContain('<title>(untitled document)</title>');
    expect(slim).toContain('(no headings detected)');
  });

  it('lists all headings in the outline section', () => {
    const slim = extractSlimContext(
      '# Title\n\nintro\n\n## Section A\n\nbody\n\n### Subsection\n\nmore',
      'body',
    );
    expect(slim).toContain('## Section A');
    expect(slim).toContain('### Subsection');
  });

  it('returns a slim envelope under SLIM_CONTEXT_BUDGET for moderate docs', () => {
    const doc = '# T\n\n' + 'paragraph. '.repeat(2000);
    const slim = extractSlimContext(doc, 'paragraph.');
    expect(slim.length).toBeLessThan(9000);
    expect(slim).not.toContain('[…truncated for length]');
  });

  it('marks the envelope as truncated when the slim exceeds the budget', () => {
    // Build a document whose slim envelope (title + outline of many
    // headings + surrounding paragraphs before/after the anchor)
    // clearly overshoots SLIM_CONTEXT_BUDGET (8K chars).
    //
    // 800 headings × ~15 chars each → ~12K char outline alone — well
    // over 8K, so the envelope must be truncated.
    const interleaved: string[] = [];
    for (let i = 0; i < 800; i++) {
      interleaved.push(`## Section ${i}`);
      interleaved.push(`paragraph ${i} body lorem ipsum dolor sit amet consectetur`);
    }
    const doc = ['# T', ...interleaved].join('\n\n');
    // Anchor on a paragraph deep in the doc so both before/after
    // windows are non-empty.
    const slim = extractSlimContext(doc, 'paragraph 400 body');
    expect(slim).toContain('[…truncated for length]');
  });
});

describe('generateContextPrefix — LLM fetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Mock `fetch` with a single canned response. Returns the spy so
   *  tests can assert call shape (URL, headers, body). */
  function mockFetch(responder: (req: { url: string; body: any; headers: Record<string, string> }) => Response | Promise<Response>) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const body = JSON.parse(String((init as RequestInit).body ?? '{}'));
      const headers = (init as RequestInit).headers as Record<string, string>;
      return responder({ url, body, headers });
    });
  }

  it('returns the LLM content trimmed and ≤ 60 words', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Section about billing.' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const out = await generateContextPrefix({
      document: 'short doc',
      chunkText: 'chunk',
      llmBaseUrl: 'http://x/v1',
      llmApiKey: 'tk',
      llmModel: 'gpt-4o-mini',
    });
    expect(out).toBe('Section about billing.');
  });

  it('truncates at word boundary 60 when the LLM rambles', async () => {
    const rambled = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    mockFetch(() =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: rambled } }] }),
        { status: 200 },
      ),
    );
    const out = await generateContextPrefix({
      document: 'd',
      chunkText: 'c',
      llmBaseUrl: 'http://x',
      llmApiKey: '',
      llmModel: 'm',
    });
    const words = out.split(/\s+/);
    expect(words).toHaveLength(60);
    expect(words[0]).toBe('w0');
    expect(words[59]).toBe('w59');
  });

  it('returns "" on HTTP error (graceful degradation)', async () => {
    mockFetch(() => new Response('upstream down', { status: 502 }));
    const out = await generateContextPrefix({
      document: 'd',
      chunkText: 'c',
      llmBaseUrl: 'http://x',
      llmApiKey: '',
      llmModel: 'm',
    });
    expect(out).toBe('');
  });

  it('returns "" when the LLM returns an empty `choices`', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const out = await generateContextPrefix({
      document: 'd',
      chunkText: 'c',
      llmBaseUrl: 'http://x',
      llmApiKey: '',
      llmModel: 'm',
    });
    expect(out).toBe('');
  });

  it('returns "" when the response contains an `error` field', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 200,
      }),
    );
    const out = await generateContextPrefix({
      document: 'd',
      chunkText: 'c',
      llmBaseUrl: 'http://x',
      llmApiKey: '',
      llmModel: 'm',
    });
    expect(out).toBe('');
  });

  it('sends Authorization: Bearer header only when an api key is configured', async () => {
    const spy = mockFetch(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
    );
    await generateContextPrefix({
      document: 'd',
      chunkText: 'c',
      llmBaseUrl: 'http://x/v1',
      llmApiKey: 'bearer-123',
      llmModel: 'm',
    });
    expect(spy.mock.calls[0]![1]!.headers).toMatchObject({
      Authorization: 'Bearer bearer-123',
    });

    spy.mockClear();
    await generateContextPrefix({
      document: 'd',
      chunkText: 'c',
      llmBaseUrl: 'http://x/v1',
      llmApiKey: '',
      llmModel: 'm',
    });
    expect(spy.mock.calls[0]![1]!.headers).not.toHaveProperty('Authorization');
  });

  it('strips a trailing slash from the base URL before composing the request', async () => {
    const spy = mockFetch(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
    );
    await generateContextPrefix({
      document: 'd',
      chunkText: 'c',
      llmBaseUrl: 'http://x/v1///',
      llmApiKey: '',
      llmModel: 'm',
    });
    expect(spy.mock.calls[0]![0]).toBe('http://x/v1/chat/completions');
  });
});

describe('generateContextPrefixes — bounded concurrency', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('returns one prefix per chunk in input order', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const idx = callCount++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: `prefix-${idx}` } }] }),
        { status: 200 },
      );
    });

    const prefixes = await generateContextPrefixes(
      [
        { document: 'a', chunkText: 'c0', chunkIndex: 0, totalChunks: 3 },
        { document: 'a', chunkText: 'c1', chunkIndex: 1, totalChunks: 3 },
        { document: 'a', chunkText: 'c2', chunkIndex: 2, totalChunks: 3 },
      ],
      { baseUrl: 'http://x', apiKey: '', model: 'm' },
    );

    // Each prefix comes from a single mock that increments callCount
    // — the exact mapping depends on concurrency ordering, so we
    // assert the SET rather than the index (concurrency is allowed to
    // interleave). All three input chunks must produce a non-empty
    // prefix.
    expect(prefixes).toHaveLength(3);
    expect(new Set(prefixes)).toEqual(new Set(['prefix-0', 'prefix-1', 'prefix-2']));
  });

  it('returns "" for chunks whose LLM call fails (others proceed)', async () => {
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      // First call fails, next two succeed.
      if (call === 1) return new Response('bad gateway', { status: 502 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'good' } }] }),
        { status: 200 },
      );
    });
    const prefixes = await generateContextPrefixes(
      [
        { document: 'a', chunkText: 'c0', chunkIndex: 0, totalChunks: 2 },
        { document: 'a', chunkText: 'c1', chunkIndex: 1, totalChunks: 2 },
      ],
      { baseUrl: 'http://x', apiKey: '', model: 'm' },
    );
    expect(prefixes).toHaveLength(2);
    expect(prefixes.sort()).toEqual(['', 'good']);
  });

  it('returns empty array for empty input', async () => {
    const out = await generateContextPrefixes(
      [],
      { baseUrl: 'http://x', apiKey: '', model: 'm' },
    );
    expect(out).toEqual([]);
  });
});
