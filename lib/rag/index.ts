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
  renameCollectionMeta,
  updateRagSettings,
  upsertCollection,
} from './settings';
export {
  bootstrapSchema,
  countCollectionChunks,
  deleteCollectionChunks,
  embeddingToVectorLiteral,
  query,
  renameCollectionChunks,
  testConnection,
} from './neon-client';
export type { ConnectionTestResult } from './neon-client';
export type { Embedder, EmbedderConfig } from './embedder';
export { OpenAICompatEmbedder } from './embedder';
export { chunkText, ChunkOptionsError, contentHash, extractPdfTextFromFile } from './chunker';
export type { ChunkOptions } from './chunker';
export {
  indexCollection,
  IndexCancelledError,
} from './indexer';
export type { IndexOptions, IndexProgress, IndexResult } from './indexer';
export { retrieve } from './retriever';
export type { RetrieveOptions } from './retriever';
export { CohereCompatReranker } from './reranker';
export type { Reranker, RerankInput, RerankResult } from './reranker';

/** Build an embedder from the current RAG settings. Used by both the
 *  indexer (Settings → New collection) and the mention resolver
 *  (chat send-time retrieval). Keeps the model/dim/apiKey wiring in
 *  one place so a settings change propagates without code edits. */
import { OpenAICompatEmbedder } from './embedder';
import type { RagSettings } from './types';
export function buildEmbedder(settings: RagSettings): OpenAICompatEmbedder {
  return new OpenAICompatEmbedder({
    baseUrl: settings.embedderBaseUrl,
    apiKey: settings.embedderApiKey,
    model: settings.defaultEmbedModel,
    dim: settings.embedderDim,
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
