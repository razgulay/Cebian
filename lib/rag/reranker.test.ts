import { afterEach, describe, expect, it, vi } from 'vitest';
import { CohereCompatReranker } from './reranker';

describe('CohereCompatReranker', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs {model, query, documents, top_n} to {baseUrl}/rerank', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = new CohereCompatReranker('http://localhost:20128/v1', 'cohere/rerank-v3.0', '');
    await r.rerank({ query: 'q', documents: ['doc1', 'doc2', 'doc3'], topN: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:20128/v1/rerank');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      model: 'cohere/rerank-v3.0',
      query: 'q',
      documents: ['doc1', 'doc2', 'doc3'],
      top_n: 3,
    });
  });

  it('omits Authorization header when apiKey is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new CohereCompatReranker('http://x', 'm', '').rerank({ query: 'q', documents: ['d'], topN: 1 });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends Bearer token when apiKey is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new CohereCompatReranker('http://x', 'm', 'sk-test').rerank({ query: 'q', documents: ['d'], topN: 1 });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('flattens object documents to text on the wire and maps results back to objects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.5 },
            { index: 0, relevance_score: 0.9 },
          ],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const docs = [
      { text: 'first', id: 'a' },
      { text: 'second', id: 'b' },
    ];
    const out = await new CohereCompatReranker('http://x', 'm', '').rerank({
      query: 'q',
      documents: docs,
      topN: 2,
    });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.documents).toEqual(['first', 'second']);

    expect(out).toHaveLength(2);
    expect(out[0]!.index).toBe(1);
    expect(out[0]!.relevanceScore).toBe(0.5);
    expect((out[0]!.document as unknown as { id: string }).id).toBe('b');
    expect(out[1]!.index).toBe(0);
    expect((out[1]!.document as unknown as { id: string }).id).toBe('a');
  });

  it('caps topN at documents.length', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new CohereCompatReranker('http://x', 'm', '').rerank({
      query: 'q',
      documents: ['only'],
      topN: 10,
    });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.top_n).toBe(1);
  });

  it('returns empty when input has no documents, without hitting the network', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await new CohereCompatReranker('http://x', 'm', '').rerank({ query: 'q', documents: [], topN: 3 });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty when topN ≤ 0', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await new CohereCompatReranker('http://x', 'm', '').rerank({ query: 'q', documents: ['d'], topN: 0 });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a clean error on non-2xx with JSON message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'invalid api key' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    await expect(
      new CohereCompatReranker('http://x', 'm', 'bad').rerank({ query: 'q', documents: ['d'], topN: 1 }),
    ).rejects.toThrow(/401.*invalid api key/);
  });

  it('strips trailing slash from baseUrl before appending /rerank', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await new CohereCompatReranker('http://localhost:20128/v1/', 'm', '').rerank({ query: 'q', documents: ['d'], topN: 1 });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:20128/v1/rerank');
  });

  it('id field is a stable description string', () => {
    const r = new CohereCompatReranker('http://localhost:20128/v1', 'rerank-english-v3.0', '');
    expect(r.id).toBe('cohere-compat:http://localhost:20128/v1/rerank-english-v3.0');
  });
});