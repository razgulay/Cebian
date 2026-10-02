//
// RAG barrel — single import path for the chat / settings layers.
//
// Usage:
//   import { ragSettings, retrieve, retrieveForMention } from '@/lib/rag';
//

export type {
  RagCollection,
  RagCollectionSource,
  RagSettings,
  RetrievedChunk,
} from './types';
export {
  DEFAULT_RAG_SETTINGS,
  normalizeCollectionName,
  patchCollectionCount,
  ragCollections,
  ragSettings,
  removeCollectionMeta,
  updateRagSettings,
  upsertCollection,
} from './settings';
export {
  bootstrapSchema,
  countCollectionChunks,
  deleteCollectionChunks,
  embeddingToVectorLiteral,
  query,
  testConnection,
} from './neon-client';
export type { BootstrapWarning, ConnectionTestResult } from './neon-client';
export type { Embedder, EmbedderConfig } from './embedder';
export { OpenAICompatEmbedder } from './embedder';
export {
  chunkDocument,
  ChunkOptionsError,
  contentHash,
  extractPdfTextFromFile,
} from './chunker';
export type { ChunkOptions, DocumentChunk } from './chunker';
export {
  indexCollection,
  IndexCancelledError,
  MixedModelError,
} from './indexer';
export type { IndexOptions, IndexProgress, IndexResult } from './indexer';
export { retrieve } from './retriever';
export type { RetrieveOptions, RetrievalMode } from './retriever';
export { hybridRagSearch } from './hybrid-search';
export type { HybridSearchRow } from './hybrid-search';
export { CohereCompatReranker } from './reranker';
export type { Reranker, RerankInput, RerankResult } from './reranker';

/** Build an embedder from the current RAG settings. Used by both the
 *  indexer (Settings → New collection) and the mention resolver
 *  (chat send-time retrieval). Keeps the model/dim/apiKey wiring in
 *  one place so a settings change propagates without code edits. */
import { OpenAICompatEmbedder } from './embedder';
import { probeEmbeddingDim } from './embedder';
import type { EmbedderProbeResult } from './embedder';
import type { RagSettings } from './types';
export function buildEmbedder(settings: RagSettings): OpenAICompatEmbedder {
  return new OpenAICompatEmbedder({
    baseUrl: settings.embedderBaseUrl,
    apiKey: settings.embedderApiKey,
    model: settings.defaultEmbedModel,
    dim: settings.embedderDim,
  });
}

/** Probe the embedding endpoint for the width its model actually returns.
 *
 *  这是 dim 的唯一权威来源：`settings.embedderDim` 是用户手填的数字，可能与
 *  模型实际输出不符（Cebian 默认 1536，而不少本地模型是 1024），而列宽必须
 *  由模型决定。调用方应在 bootstrap 前用它拿到真实 dim，而不是直接读设置。
 *  端点不可用时返回 `ok: false`，不抛错。 */
export function probeEmbedder(settings: RagSettings, signal?: AbortSignal): Promise<EmbedderProbeResult> {
  return probeEmbeddingDim({
    baseUrl: settings.embedderBaseUrl,
    apiKey: settings.embedderApiKey,
    model: settings.defaultEmbedModel,
    signal,
  });
}

/** Build a reranker from settings, or return null when rerank is
 *  disabled / not configured. The retriever treats null as "skip Lớp 2"
 *  and returns the raw cosine top-K. */
import { CohereCompatReranker } from './reranker';
export function buildReranker(settings: RagSettings): CohereCompatReranker | null {
  if (!settings.rerankEnabled) return null;
  if (!settings.rerankBaseUrl || !settings.rerankModel) return null;
  return new CohereCompatReranker(
    settings.rerankBaseUrl,
    settings.rerankModel,
    settings.rerankApiKey,
  );
}
