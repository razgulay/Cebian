import { describe, it, expect } from 'vitest';
import {
  extractCitationsFromResult,
  isCitationResult,
  type Citation,
} from '@/lib/tools/mcp-tool';

/**
 * `extractCitationsFromResult` is the boundary between the messy,
 * server-defined MCP search-result shape and the minimal `{url, title}`
 * that the UI renders. Tests cover each input form the producer may
 * see in practice:
 *
 *   - Typed `structuredContent.results` (Exa / Brave MCP servers)
 *   - Markdown link list in a text block (Jina / Exa fallback)
 *   - Raw JSON array in a text block
 *   - Numbered / bulleted list as a last-resort scrape
 *   - Mixed inputs (structured + text, dedup across both)
 *
 * Plus `isCitationResult` validation: only `details` with a non-empty
 * `citations` array of valid http(s) URLs should pass the guard.
 */

describe('extractCitationsFromResult', () => {
  it('parses structuredContent.results (Exa / Brave shape)', () => {
    const citations = extractCitationsFromResult(
      [],
      {
        results: [
          { url: 'https://exa.example/a', title: 'A' },
          { url: 'https://exa.example/b', title: 'B' },
        ],
      },
    );
    expect(citations).toEqual([
      { url: 'https://exa.example/a', title: 'A' },
      { url: 'https://exa.example/b', title: 'B' },
    ]);
  });

  it('parses markdown links in a text block', () => {
    const text = `Here are the results:
[First Hit](https://example.com/one) — useful
[Second Hit](https://example.com/two) — also useful
Plain text without links.`;
    const citations = extractCitationsFromResult([{ type: 'text', text }]);
    expect(citations).toEqual([
      { url: 'https://example.com/one', title: 'First Hit' },
      { url: 'https://example.com/two', title: 'Second Hit' },
    ]);
  });

  it('parses raw JSON array in a text block', () => {
    const text = JSON.stringify([
      { url: 'https://jina.example/x', title: 'X' },
      { url: 'https://jina.example/y' },
    ]);
    const citations = extractCitationsFromResult([{ type: 'text', text }]);
    expect(citations).toEqual([
      { url: 'https://jina.example/x', title: 'X' },
      { url: 'https://jina.example/y' },
    ]);
  });

  it('falls back to numbered-list scraping when other shapes are absent', () => {
    const text = `1. Alpha entry — https://news.example/alpha
2. Beta entry — https://news.example/beta`;
    const citations = extractCitationsFromResult([{ type: 'text', text }]);
    expect(citations).toEqual([
      { url: 'https://news.example/alpha', title: 'Alpha entry' },
      { url: 'https://news.example/beta', title: 'Beta entry' },
    ]);
  });

  it('prefers structuredContent over text-block markdown', () => {
    const citations = extractCitationsFromResult(
      [{ type: 'text', text: '[ignored](https://ignored.example)' }],
      { results: [{ url: 'https://winner.example/w', title: 'W' }] },
    );
    expect(citations).toEqual([{ url: 'https://winner.example/w', title: 'W' }]);
  });

  it('dedupes identical URLs across both sources', () => {
    const citations = extractCitationsFromResult(
      [{ type: 'text', text: '[dup](https://shared.example/x)' }],
      { results: [{ url: 'https://shared.example/x', title: 'duplicate' }] },
    );
    // Structured layer runs first and wins — title is retained from the
    // first-seen occurrence. The text-block hit is dropped by the URL
    // dedup, not re-parsed.
    expect(citations).toEqual([
      { url: 'https://shared.example/x', title: 'duplicate' },
    ]);
  });

  it('drops invalid URLs (non-http schemes, malformed)', () => {
    const citations = extractCitationsFromResult(
      [{
        type: 'text',
        text: [
          '[bad scheme](javascript:alert(1))',
          '[file](file:///etc/passwd)',
          '[ok](https://good.example)',
        ].join('\n'),
      }],
    );
    expect(citations).toEqual([{ url: 'https://good.example', title: 'ok' }]);
  });

  it('returns empty array for non-search tool output', () => {
    const citations = extractCitationsFromResult(
      [{ type: 'text', text: 'just a regular message with no URLs' }],
    );
    expect(citations).toEqual([]);
  });

  it('preserves first-seen order across mixed sources', () => {
    const text = `[markdown hit](https://m.example) something else`;
    const citations = extractCitationsFromResult(
      [{ type: 'text', text }],
      {
        results: [
          { url: 'https://s.example/1', title: 's1' },
          { url: 'https://m.example', title: 'm' },
        ],
      },
    );
    // Structured hits come first, then text-block hits that aren't already seen.
    expect(citations.map((c) => c.url)).toEqual([
      'https://s.example/1',
      'https://m.example',
    ]);
  });

  it('parses Tavily-style `sources` array', () => {
    const citations = extractCitationsFromResult([], {
      sources: [
        { url: 'https://tavily.example/a', title: 'A' },
        { url: 'https://tavily.example/b' },
      ],
    });
    expect(citations).toEqual([
      { url: 'https://tavily.example/a', title: 'A' },
      { url: 'https://tavily.example/b' },
    ]);
  });

  it('falls through to text scrapers when structured arrays are empty', () => {
    // `results` exists but is empty (Exa zero-hit response) — must
    // still harvest the URL out of the markdown text below, otherwise
    // the user sees a tool call with zero citations even though the
    // text block clearly lists one.
    const citations = extractCitationsFromResult(
      [{ type: 'text', text: 'See [A](https://exa.example/a)' }],
      { results: [] },
    );
    expect(citations).toEqual([{ url: 'https://exa.example/a', title: 'A' }]);
  });

  it('parses Jina / Tavily line-block format (Title: ... \\n URL: ...)', () => {
    const text = `Title: Alpha entry
URL: https://jina.example/alpha
Content: some snippet

Title: Beta entry
URL: https://jina.example/beta
Content: another snippet`;
    const citations = extractCitationsFromResult([{ type: 'text', text }]);
    expect(citations).toEqual([
      { url: 'https://jina.example/alpha', title: 'Alpha entry' },
      { url: 'https://jina.example/beta', title: 'Beta entry' },
    ]);
  });

  it('parses standalone URLs as a last resort', () => {
    const text = `Sources consulted:
https://news.example/one
https://news.example/two
https://news.example/three`;
    const citations = extractCitationsFromResult([{ type: 'text', text }]);
    expect(citations.map((c) => c.url)).toEqual([
      'https://news.example/one',
      'https://news.example/two',
      'https://news.example/three',
    ]);
  });

  it('prefers structured results even when text has richer titles', () => {
    // Once structured yielded a hit, the text-block scrapers must not
    // run. Otherwise the same URL ends up with a worse title from the
    // numbered-list parser.
    const text = `1. markdown title — https://exa.example/w`;
    const citations = extractCitationsFromResult(
      [{ type: 'text', text }],
      { results: [{ url: 'https://exa.example/w', title: 'canonical title' }] },
    );
    expect(citations).toEqual([
      { url: 'https://exa.example/w', title: 'canonical title' },
    ]);
  });
});

describe('isCitationResult', () => {
  const valid: unknown = {
    server: { id: 'srv-1', name: 'Exa' },
    tool: 'web_search_exa',
    citations: [{ url: 'https://example.com/a', title: 'A' }],
  };

  it('accepts a well-formed details payload', () => {
    expect(isCitationResult(valid)).toBe(true);
  });

  it('rejects missing server.id', () => {
    expect(isCitationResult({ ...valid as object, server: { id: '', name: 'x' } })).toBe(false);
  });

  it('rejects missing citations array', () => {
    const { citations: _drop, ...rest } = valid as { citations: unknown };
    void _drop;
    expect(isCitationResult(rest)).toBe(false);
  });

  it('rejects empty citations array', () => {
    expect(isCitationResult({ ...valid as object, citations: [] })).toBe(false);
  });

  it('rejects citations containing non-http URLs', () => {
    expect(
      isCitationResult({
        ...valid as object,
        citations: [{ url: 'javascript:alert(1)' }],
      }),
    ).toBe(false);
  });

  it('narrows the type for valid input', () => {
    if (isCitationResult(valid)) {
      // Type-narrowing sanity: `citations` is now `Citation[]` with known
      // shape — access without a cast must compile.
      const c: Citation = valid.citations[0];
      expect(c.url).toBe('https://example.com/a');
    }
  });
});