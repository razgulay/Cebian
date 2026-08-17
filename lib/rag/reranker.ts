//
// Reranker — Lớp 2 in the 2-stage RAG pipeline. Vector search (Lớp 1)
// returns a noisy top-K; rerank asks a stronger model to re-order those
// candidates against the query and returns the most relevant ones.
//
// We use the Cohere-compatible `/rerank` endpoint shape, which 9Router,
// most Cohere-compatible proxies, and Cohere itself all accept. The
// request body matches the `rerank.js` script in the 9router-embeddings
// skill:
//
//   POST {baseUrl}/rerank
//   { "model": "...", "query": "...", "documents": [...], "top_n": N }
//
//   → { "results": [{ "index": i, "relevance_score": s }, ...] }
//
// The output index refers to the input document position, not a global
// chunk id — so callers pair it with their original candidates.
//

export interface RerankInput {
  /** Original query text. */
  query: string;
  /** Candidate documents (strings or {text} objects). Objects are
   *  flattened to `.text` for the wire payload, and the original object
   *  is preserved in the return so callers don't lose metadata. */
  documents: (string | { text: string; [key: string]: unknown })[];
  /** Number of results to return. Must be ≤ documents.length. */
  topN: number;
  /** Optional cancellation signal — aborts the in-flight HTTP call. */
  signal?: AbortSignal;
}

export interface RerankResult {
  /** Index into the original `documents` array. */
  index: number;
  /** Original document (string or object) — passed through verbatim. */
  document: string | { text: string; [key: string]: unknown };
  /** Relevance score in [0, 1] — provider-specific semantics, but
   *  always higher-is-more-relevant. */
  relevanceScore: number;
}

export interface Reranker {
  /** Provider/model identifier — surfaced in error messages so the user
   *  knows which endpoint failed. */
  readonly id: string;
  rerank(input: RerankInput): Promise<RerankResult[]>;
}

/** Detect API errors and surface a clean message (no stack from the wire
 *  payload). Some providers leak a JSON body with `{message: ...}` on
 *  non-2xx; we extract that first, otherwise fall back to the raw text. */
async function readErrorBody(resp: Response): Promise<string> {
  const text = await resp.text();
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? text;
  } catch {
    return text;
  }
}

/** Cohere-compatible reranker. Hits `{baseUrl}/rerank` with the standard
 *  Cohere request shape. Bearer auth is optional (empty = no header). */
export class CohereCompatReranker implements Reranker {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
  ) {
    if (!baseUrl) throw new Error('Rerank base URL is empty');
    if (!model) throw new Error('Rerank model is empty');
  }

  get id(): string {
    return `cohere-compat:${this.baseUrl}/${this.model}`;
  }

  async rerank(input: RerankInput): Promise<RerankResult[]> {
    if (input.documents.length === 0) return [];
    if (input.topN <= 0) return [];
    // Flatten objects to strings for the wire payload — the response
    // refers back to indices, so the mapping back to objects is done
    // on this side after the fetch.
    const docTexts = input.documents.map((d) => (typeof d === 'string' ? d : d.text));
    const url = `${this.baseUrl.replace(/\/+$/, '')}/rerank`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        query: input.query,
        documents: docTexts,
        top_n: Math.min(input.topN, docTexts.length),
      }),
      signal: input.signal,
    });
    if (!resp.ok) {
      const detail = await readErrorBody(resp);
      throw new Error(`Rerank ${resp.status} ${resp.statusText}: ${detail}`);
    }
    const json = (await resp.json()) as {
      results?: { index: number; relevance_score: number }[];
    };
    const raw = json.results ?? [];
    return raw.map((r) => ({
      index: r.index,
      document: input.documents[r.index]!,
      relevanceScore: r.relevance_score,
    }));
  }
}