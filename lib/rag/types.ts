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

  /** **目前恒为 0——没有任何 UI 可以设置它，也没有任何调用方读它。**
   *  保留字段是为了不改动已持久化的 settings 结构（旧版本可能存过非 0 值，
   *  删字段就要迁移；留着它则完全无害）。
   *
   *  历史：这曾是「已 pin 的 RAG 提及在 top-1 分数低于阈值时不附带 envelope」的
   *  门槛。撤下 UI 的原因是分数标尺随检索模式变化（cosine 0–1 对 RRF 0–0.033），
   *  不存在一个两种模式都正确的默认值；旧的 0.35 是 cosine 时代的数字，切到 hybrid
   *  后会静默过滤掉全部结果。过滤职责现在交给 Rerank。
   *
   *  因此 `RetrieveOptions.minScore` 的过滤分支当前不可达；将来若要做按模式区分的
   *  阈值，从这里重新接上。 */
  pinMinScore: number;

  // ─── Retrieval strategy (Subtask 2) ───────────────────────────────
  // Cebian supports two retrieval modes against the same `rag_chunks`
  // table:
  //   • 'vector'  — pure dense (cosine on the HNSW index). Original v1.
  //   • 'hybrid'  — dense + sparse (BM25 over tsvector) fused via RRF.
  // Hybrid is the recommended default because it catches keyword/code/
  // identifier matches that embeddings miss (see plan Subtask 2).
  //
  // Per-call callers (`retrieve({ mode })`) can override this; when
  // `mode` is omitted from `RetrieveOptions`, the retriever falls back
  // to this setting.

  /** Retrieval strategy used by `retrieve()` when the caller doesn't
   *  pass an explicit `mode`. `'hybrid'` is the default — better
   *  recall on keyword/code/identifier queries at the cost of one
   *  extra tsvector ranking per query. `'vector'` remains available
   *  for users who prefer pure-embedding behavior. */
  retrievalMode: 'vector' | 'hybrid';

  // ─── Contextual Retrieval (Subtask 3 — opt-in, off-by-default) ──
  // Anthropic's recipe (2024-09): for each chunk, ask a cheap LLM to
  // generate a 40-word context string describing where the chunk sits
  // in the document. Prepend that prefix to BOTH the embedding input
  // AND the BM25 token stream (handled by the tsvector generated
  // expression in `bootstrapSchema` — the `COALESCE` there already
  // picks up `metadata.context_prefix`). Net effect: a query that
  // matches the chunk's topic but not its exact words still ranks the
  // chunk correctly.
  //
  // Off by default: each chunk costs one extra LLM call at index
  // time. For a 1000-chunk reindex that's 1000 LLM calls. Users
  // flip the toggle in Settings when they want the recall boost.

  /** Master toggle for Contextual Retrieval. When off (default), the
   *  indexer embeds `chunk.content` directly with no prefix and the
   *  `metadata.context_prefix` column stays absent on new rows. */
  contextualRetrievalEnabled: boolean;

  /** Base URL for the OpenAI-compatible `/chat/completions` endpoint
   *  used to generate context prefixes. Defaults to the embedder's
   *  base URL (most local proxies expose both). Override per
   *  preference if the user runs a separate LLM endpoint for cheap
   *  generation (e.g. local Ollama on a different port). */
  contextualLlmBaseUrl: string;

  /** Bearer token for the Contextual Retrieval LLM endpoint. Empty
   *  string = no auth. Empty default — user explicitly fills if
   *  their LLM endpoint requires it. */
  contextualLlmApiKey: string;

  /** Chat model id used to generate context prefixes. Cheap models
   *  only — Anthropic uses Claude Haiku, the OpenAI counterpart is
   *  `gpt-4o-mini`. Free-form: any model name accepted by the
   *  configured endpoint. */
  contextualLlmModel: string;

  // ─── Agentic rag_search (Subtask 4 — opt-in, off-by-default) ────
  // When enabled, the main agent can call `rag_search` as a tool to
  // run its own hybrid queries during the conversation, beyond the
  // top-5 chunks pre-injected at send time. The tool itself lives in
  // `lib/tools/rag-search.ts`（per-session 工厂 `createRagSearchTool`）；
  // 此 flag 控制两个副作用：
  //   • `lib/tools/index.ts` 构造并条件推入该工具（off → tool list 不含它，
  //     LLM 无法选中）。
  //   • `entrypoints/background/agent/system-prompt.ts` injects the
  //     tool description into the RAG Workflow section (off → no
  //     mention in prompt, so the LLM won't hallucinate calls to a
  //     non-existent tool).
  // Both sides must agree — if the prompt mentions the tool but no
  // tool entry exists, the LLM hallucinates; if the tool exists but
  // the prompt never explains when to use it, the LLM never picks
  // it. The flag keeps the two in sync.

  /** Master toggle for the agentic `rag_search` tool. Off by
   *  default: keep the tool list minimal and the system prompt lean
   *  for users who don't need deeper-than-pre-injected lookups. */
  ragSearchEnabled: boolean;
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
  /** 存在于 Neon、但不在最近一次索引选择里的源。**不等于「已从磁盘删除」**：
   *  我们不追踪磁盘状态，分不出「文件删了」与「这次没选」。UI 用它提示用户
   *  何时该用同步模式清理。缺省 = 上次索引时无遗留（或该字段引入前索引的）。 */
  notInLastRun?: { path: string; chunks: number }[];
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
  /** 仅内部使用的相关度数值——vector 模式为 cosine similarity（[-1, 1]），
   *  hybrid 模式为 RRF 分数（k=60 时约 [0, 0.033]），rerank 过一遍后则是
   *  reranker 的 relevanceScore（又一把不同的标尺）。**绝不渲染给 LLM**：
   *  envelope 只携带顺序，数字会诱导跨调用比较与自行设阈值（pinMinScore 的
   *  教训）。保留此字段是为了（目前休眠的）`minScore` 过滤钩子。 */
  score: number;
  /** Subtask 3 — Contextual Retrieval prefix. LLM-generated at index
   *  time when CR was enabled; `null` for chunks indexed before CR or
   *  when CR was disabled. Surfaced to the LLM/UI verbatim so the
   *  envelope can render "this chunk is about X" alongside the raw
   *  text. The BM25 ranking already uses the prefix via `content_tsv`
   *  (see `bootstrapSchema`) — this field is for display. */
  contextPrefix: string | null;
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
  // Hybrid by default — recommended for keyword/code/identifier
  // queries. Users can flip to 'vector' via the Settings radio.
  retrievalMode: 'hybrid',
  // Contextual Retrieval — off by default (opt-in). Each chunk
  // costs one LLM call at index time; default to the same endpoint
  // / model as the embedder so users can flip the toggle without
  // touching the LLM config first.
  contextualRetrievalEnabled: false,
  contextualLlmBaseUrl: 'http://localhost:8317/v1',
  contextualLlmApiKey: '',
  contextualLlmModel: 'gpt-4o-mini',
  // Agentic rag_search — off by default. Users opt in when they
  // want the agent to run hybrid queries mid-conversation (e.g.
  // for "section 230(c)(1)" lookups that pre-injected top-5
  // doesn't cover). Enabling adds the tool to the shared tool list
  // AND injects its description into the system prompt.
  ragSearchEnabled: false,
};
