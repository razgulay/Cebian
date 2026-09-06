//
// `rag_search` tool — let the main agent run a hybrid (vector + BM25 /
// RRF) query against a RAG collection mid-conversation. Complements
// the send-time pre-injected top-5 chunks (`<attached-rag-context>`
// envelope): when the user asks a follow-up that requires different
// chunks — a specific section number, a function name, a code
// identifier — the agent can call this tool to run a fresh query.
//
// Why "agentic" / off-by-default:
//   • Tool list size affects LLM tool-selection latency and cost.
//     v1 ships the tool only when the user opts in (Settings →
//     Knowledge → Agentic rag_search). Off = no tool entry, no
//     prompt mention, so the LLM has no way to hallucinate a call.
//   • The tool always uses hybrid mode (dense + sparse + RRF) —
//     vector-only is available via Settings → retrievalMode for the
//     pre-injected path, but for agent lookups we want the best
//     recall regardless of the user's static preference. Agents
//     query semantically ("section 230(c)(1)") AND by keyword
//     ("void ab initio") — hybrid catches both.
//
// Gating:
//   • `execute()` reads `ragSettings.getValue()` and throws if
//     `ragSearchEnabled` is false. Belt-and-braces: even if a stale
//     session somehow has the tool listed while the user toggled
//     the switch off, the execute path still refuses to run.
//   • `lib/tools/index.ts` only pushes this tool into the session's
//     tool array when `ragSearchEnabled` is true. The two sides
//     stay consistent because both read the same settings blob at
//     filter time (with the execute-time check as the safety net).
//

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_RAG_SEARCH } from '@/lib/tools/names';
import { buildEmbedder, ragSettings } from '@/lib/rag';
import { hybridRagSearch } from '@/lib/rag/hybrid-search';

const RagSearchParameters = Type.Object({
  collection: Type.String({
    description:
      'Name of the RAG collection to search (e.g. "phaply"). ' +
      'This is the slug the user picked when creating the collection — ' +
      'lowercase ASCII letters/digits/dashes/underscores, must start with letter or digit.',
  }),
  query: Type.String({
    description:
      'The semantic / keyword query. Phrase as you would ask the user; the tool combines ' +
      'vector similarity with BM25 keyword match (RRF fusion). Quote exact phrases in ' +
      'double-quotes to bias toward keyword match.',
  }),
  limit: Type.Optional(
    Type.Number({
      description:
        'Maximum number of chunks to return. Defaults to 5 (matches the pre-injected top-5). ' +
        'Max 20 — keep the response envelope bounded so the LLM can ingest it without losing earlier context.',
      minimum: 1,
      maximum: 20,
      default: 5,
    }),
  ),
});

export const ragSearchTool: AgentTool<typeof RagSearchParameters> = {
  name: TOOL_RAG_SEARCH,
  label: 'Search RAG collection',
  description:
    'Run a hybrid (vector + BM25 / RRF-fused) search over a named RAG collection and return the top chunks as a structured text block. ' +
    'Use this when the pre-injected <attached-rag-context> top-5 chunks do not cover the user\'s question — for example, ' +
    'when the user asks about a specific section number, function name, code identifier, or topic that lives in a different part of ' +
    'the index than the chunks already in context. The tool always runs hybrid search regardless of the user\'s static retrieval ' +
    'mode preference, so a single call works for both semantic ("abstract concept about X") and keyword ("section 230(c)(1)") queries. ' +
    'Limit defaults to 5 and caps at 20. Score is RRF-fused (ordering-only, not a probability). ' +
    'Do NOT use this for the initial turn — pre-injected chunks already cover it.',
  parameters: RagSearchParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
    signal?.throwIfAborted();

    const settings = await ragSettings.getValue();

    // Safety net (see file header): even if the tool slipped into a
    // session before the user toggled the switch off, refuse to run.
    // Throw — pi-agent-core sets `message.isError = true` so the LLM
    // sees a clean error and replans instead of silently consuming
    // stale results.
    if (!settings.ragSearchEnabled) {
      throw new Error(
        'rag_search is disabled. Enable it in Settings → Knowledge → Agentic rag_search to allow the agent to run hybrid queries during the conversation.',
      );
    }
    if (!settings.neonConnectionString) {
      throw new Error(
        'RAG is not configured — open Settings → Knowledge and paste your Neon connection string.',
      );
    }
    if (!params.collection?.trim()) {
      throw new Error('rag_search: collection is required');
    }
    if (!params.query?.trim()) {
      throw new Error('rag_search: query is required');
    }

    const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
    signal?.throwIfAborted();

    // Build embedder from current settings so a model change in
    // Settings propagates without restarting the session. This is
    // the same embedder the indexer used to write the collection —
    // mixing embedders mid-collection would poison retrieval, but
    // settings.lock-in at index time + `embedderDim` validation in
    // OpenAICompatEmbedder catch the mismatch.
    const embedder = buildEmbedder(settings);
    const [queryEmb] = await embedder.embed([params.query.trim()], signal);
    if (!queryEmb) {
      throw new Error('rag_search: embedder returned no vector');
    }
    signal?.throwIfAborted();

    const rows = await hybridRagSearch(
      settings.neonConnectionString,
      params.collection,
      queryEmb,
      params.query,
      limit,
    );

    if (rows.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `<rag-search-result collection="${params.collection}" query="${escapeAttr(params.query)}" count="0">\n  (no matching chunks — try rephrasing the query or raising the limit)\n</rag-search-result>`,
          },
        ],
        details: {},
      };
    }

    const lines: string[] = [];
    lines.push(
      `<rag-search-result collection="${escapeAttr(params.collection)}" query="${escapeAttr(params.query)}" count="${rows.length}">`,
    );
    for (const r of rows) {
      // `score` in this envelope is the RRF fused score (k=60).
      // Top hits land around 0.016; tail around 0.001. Treat as
      // ordering-only — the agent should read chunk text, not the
      // float.
      lines.push(
        `  <chunk source="${escapeAttr(r.sourcePath)}" index="${r.chunkIndex}" score="${r.rrfScore.toFixed(6)}"${r.contextPrefix ? ` context="${escapeAttr(r.contextPrefix)}"` : ''}>${escapeText(r.content)}</chunk>`,
      );
    }
    lines.push(`</rag-search-result>`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: {},
    };
  },
};

/** XML attribute escape — `"` and `&` are the only characters that
 *  can break the attribute syntax. `<` / `>` in attribute values
 *  are tolerated by every parser we target. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** XML text-content escape — chunk content can contain `<`, `>`, `&`
 *  freely, so we escape all three to keep the envelope parseable by
 *  downstream consumers (debug tools, future UI rendering). */
function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
