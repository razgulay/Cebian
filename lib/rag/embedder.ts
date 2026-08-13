//
// Embedding provider — wraps an OpenAI-compatible `/embeddings` HTTP
// endpoint. Default target is CLIProxyAPI on `http://localhost:8317/v1`
// (which proxies BGE / OpenAI / Cohere embeddings), but any OpenAI-
// compatible server can be substituted via `EmbedderConfig`.
//

export interface Embedder {
  /** Model id used for embedding. */
  readonly model: string;
  /** Output dimension. Validated against the actual response length on
   *  first call — a mismatch surfaces a clear error instead of silently
   *  poisoning the collection with wrong-dim vectors. */
  readonly dim: number;
  /** Embed one or more strings. Returns one vector per input string,
   *  same order. Empty input → empty output. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbedderConfig {
  baseUrl: string;       // e.g. http://localhost:8317/v1
  apiKey: string;
  model: string;
  dim: number;
}

/** Standard OpenAI-compatible `/embeddings` POST.
 *  Response shape: `{ data: [{ embedding: number[], index: number }, ...] }`.
 *  We re-order by `index` so the output matches the input order even if
 *  the server returns them shuffled (OpenAI does, some clones don't). */
export class OpenAICompatEmbedder implements Embedder {
  constructor(private readonly config: EmbedderConfig) {}

  get model(): string { return this.config.model; }
  get dim(): number { return this.config.dim; }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const url = `${base}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.config.model, input: texts }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Embed API ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json() as {
      data?: { embedding: number[]; index?: number }[];
      error?: { message?: string };
    };
    if (data.error?.message) {
      throw new Error(`Embed API error: ${data.error.message}`);
    }
    if (!data.data || data.data.length !== texts.length) {
      throw new Error(
        `Embed API returned ${data.data?.length ?? 0} vectors for ${texts.length} inputs`,
      );
    }
    // Sort by `index` if present; fall back to input order.
    const items = [...data.data];
    if (items.every((it) => typeof it.index === 'number')) {
      items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }
    const out: number[][] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      out[i] = items[i]!.embedding;
    }
    // Validate dim on first call. If a wrong model is configured, surface
    // the mismatch loudly so the user can fix it instead of writing bad
    // vectors that fail every retrieval later.
    if (out.length > 0 && out[0]!.length !== this.config.dim) {
      throw new Error(
        `Embedding dim mismatch: model ${this.config.model} returned ${out[0]!.length}, ` +
          `expected ${this.config.dim}. Update RagSettings.embedderDim to match.`,
      );
    }
    return out;
  }
}
