//
// Shared types for the RAG system. Storage shapes live here so all of
// `lib/rag/*` and the UI agree on names.
//

/** Persistent RAG configuration. Stored in `chrome.storage.local` as
 *  `local:ragSettings`. `null` means "not configured yet" — the UI
 *  prompts the user to paste a Neon connection string. */
export interface RagSettings {
  /** Postgres connection string (`postgresql://user:pass@host/db?sslmode=require`).
   *  The user/password segment IS the auth — Neon serverless doesn't need a
   *  separate API key. */
  neonConnectionString: string;

  /** Base URL for the OpenAI-compatible `/embeddings` endpoint.
   *  Defaults to the local CLIProxyAPI on `http://localhost:8317/v1`. */
  embedderBaseUrl: string;

  /** Bearer token for the embedder. Empty string = no auth. */
  embedderApiKey: string;

  /** Embedding model id (e.g. `text-embedding-3-small`, `bge-small-en-v1.5`).
   *  Free-form: any model name accepted by the configured endpoint. */
  defaultEmbedModel: string;

  /** Output dimension. Used to validate at insert time so a wrong model
   *  choice doesn't poison the collection. Defaults to 1024 (BGE-base,
   *  most common shape). */
  embedderDim: number;

  /** Target chunk size in characters. 800 is a sensible default for prose. */
  chunkSize: number;

  /** Sliding-window overlap. Keeps context across chunk boundaries. */
  chunkOverlap: number;

  // ─── Rerank (Lớp 2 — optional) ─────────────────────────────────────
  // When enabled, the retriever fetches `vectorTopK` chunks via cosine
  // search (Lớp 1), then asks the rerank endpoint to re-order them and
  // returns the top `rerankTopN` (Lớp 2). When disabled, the retriever
  // returns the raw `vectorTopK` chunks unchanged.

  /** Master toggle for the rerank stage. Off by default — most personal
   *  setups work fine with cosine-only retrieval; rerank adds latency
   *  + an external API call per send. */
  rerankEnabled: boolean;

  /** Base URL for the Cohere-compatible `/rerank` endpoint. Defaults
   *  to the same base as the embedder (most local proxies like 9Router
   *  expose both `/embeddings` and `/rerank` under the same `/v1` host). */
  rerankBaseUrl: string;

  /** Bearer token for the rerank endpoint. Empty = no auth. */
  rerankApiKey: string;

  /** Rerank model id. For Cohere direct: `rerank-english-v3.0`. For
   *  9Router proxy: `cohere/rerank-v3.0`. Free-form. */
  rerankModel: string;

  /** Number of chunks returned after rerank. Must be ≤ vectorTopK. */
  rerankTopN: number;

  /** Minimum cosine similarity (top-1 score) for a pinned RAG mention
   *  to attach its envelope. When the top hit scores below this, the
   *  resolver drops the attachment silently — the user still sends
   *  their message, the LLM just doesn't get RAG context this turn.
   *  Only applies to PINNED RAG mentions (one-shot mentions always
   *  attach — the user explicitly opted in for that message).
   *  Default 0 (no gate). Typical Jina cosine similarity sits in
   *  0.3–0.9 for relevant hits; 0.2–0.4 for off-topic. */
  pinMinScore: number;
}

/** Per-collection metadata. Lives in `chrome.storage.local` as
 *  `local:ragCollections`. The actual chunks + vectors live in Neon. */
export interface RagCollection {
  /** Stable identifier (also used as the `collection` column in Neon).
   *  Lowercased + hyphenated by the UI; must be unique. */
  name: string;
  /** Embedding model locked at index time. Switching models requires
   *  re-indexing the whole collection. */
  embedModel: string;
  /** Embedding dimension at index time. Validates future re-index runs. */
  embedDim: number;
  /** ISO timestamp of first index. */
  createdAt: number;
  /** ISO timestamp of most recent successful index. */
  updatedAt: number;
  /** Number of chunks currently stored in Neon. Refreshed after each
   *  successful index / delete operation. */
  chunkCount: number;
  /** Per-source breakdown — file name + chunk count + size. Display only;
   *  the source files themselves stay on the user's disk. */
  sources: RagCollectionSource[];
}

export interface RagCollectionSource {
  /** Filename including extension. Stable identifier for the source row
   *  (matches `source_path` in Neon). */
  path: string;
  /** Original byte size on disk. */
  size: number;
  /** Chunks generated from this source. */
  chunkCount: number;
}

/** Single retrieved chunk returned from a vector search. */
export interface RetrievedChunk {
  sourcePath: string;
  chunkIndex: number;
  content: string;
  /** Cosine similarity in [-1, 1]; for normalized embeddings, [0, 1]. */
  score: number;
}

/** Default settings — applied when the user first opens the section
 *  (or after a "reset to defaults" action). Personal use only, so we
 *  default the embedder to the locally-running CLIProxyAPI on port 8317
 *  with the same `cebian-local-key` the user configured there. */
export const DEFAULT_RAG_SETTINGS: RagSettings = {
  neonConnectionString: '',
  embedderBaseUrl: 'http://localhost:8317/v1',
  embedderApiKey: '',
  defaultEmbedModel: 'text-embedding-3-small',
  embedderDim: 1536,
  chunkSize: 800,
  chunkOverlap: 100,
  rerankEnabled: false,
  rerankBaseUrl: 'http://localhost:8317/v1',
  rerankApiKey: '',
  rerankModel: 'rerank-english-v3.0',
  rerankTopN: 3,
  pinMinScore: 0,
};
