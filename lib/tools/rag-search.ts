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
// Gating（三层，读同一份 settings，同快照重建）：
//   • `lib/tools/index.ts` 只在 `ragSearchEnabled` 为真、或本会话被「ghim RAG
//     collection」解锁时，才把工具推进 session 的工具数组；
//   • `execute()` 再查一次 settings——即使过期 session 残留了工具条目，执行侧
//     依然拒绝运行（belt-and-braces）；
//   • 系统提示词里的 rag_search 条目（prompt-composer）与工具列表由同一份
//     flag 驱动，两侧必须一致，否则 LLM 幻觉调用（有提示无工具）或永不调用
//     （有工具无提示）。
// 工厂形态：`createRagSearchTool(unlocked)`。`unlocked` 表示**本会话**因 ghim
// 了 RAG collection 而解锁（证据随每次 send 的 `rag-context` `pinned="true"`
// attachment 到达后台），是唯一可以越过全局开关的通道；全局开关 BẬT 的语义
// 不变——工具出现在所有会话。
//

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_RAG_SEARCH } from '@/lib/tools/names';
import {
  buildEmbedder,
  describeEmbedderMismatch,
  listKnownCollectionNames,
  ragSettings,
  readCollectionEmbedIdentity,
  warnLegacyEmbedRows,
} from '@/lib/rag';
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

/** Per-session factory。`unlocked` 见文件头 Gating 段。 */
export function createRagSearchTool(unlocked: boolean): AgentTool<typeof RagSearchParameters> {
  return {
    name: TOOL_RAG_SEARCH,
    label: 'Search RAG collection',
    description:
      'Run a hybrid (vector + BM25 / RRF-fused) search over a named RAG collection and return the top chunks as a structured text block. ' +
      'Use this when the pre-injected <attached-rag-context> top-5 chunks do not cover the user\'s question — for example, ' +
      'when the user asks about a specific section number, function name, code identifier, or topic that lives in a different part of ' +
      'the index than the chunks already in context. The tool always runs hybrid search regardless of the user\'s static retrieval ' +
      'mode preference, so a single call works for both semantic ("abstract concept about X") and keyword ("section 230(c)(1)") queries. ' +
      'Limit defaults to 5 and caps at 20. Chunks arrive in relevance order — there is no numeric score. ' +
      'On an empty result the envelope carries reason="no_match" (the collection has data but nothing matched — rephrase) ' +
      'or reason="collection_not_found" (the name does not exist / the collection is empty — use the listed known names instead). ' +
      'Do NOT use this for the initial turn — pre-injected chunks already cover it.',
    parameters: RagSearchParameters,

    async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
      signal?.throwIfAborted();

      const settings = await ragSettings.getValue();

      // 执行侧安全网（见文件头 Gating 段）：即使过期 session 残留了工具条目，
      // 这里也拒绝运行。Throw — pi-agent-core 置 `message.isError = true`，LLM
      // 看到干净的错误并重新规划，而不是默默吞下过期结果。
      if (!settings.ragSearchEnabled && !unlocked) {
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

      // C1 守卫：读路径的 (model, dim) 对账（写路径在 planIndex 已有同款）。
      // 必须排在 embed 之前——错配时连一次嵌入 API 调用都省掉。分支顺序
      // （命中即停）：
      //   1. total === 0 → 直接返回 collection_not_found envelope（C2 fast
      //      path，ST3 反馈）：不存在的名字/空 collection 没必要白花一次 embed
      //      API 调用、再跑一注定为空的检索。staleness：60s 缓存窗口内刚收到
      //      第一批 chunk 的 collection 会被误报一次 not_found——罕见、自愈，
      //      且 hint 的建议名单此时已含它（索引成功先于 upsertCollection）。
      //   2. 任何已识别 pair 与当前 (model, dim) 不符（哪怕还有 legacy 行）
      //      → throw，报错里给出两侧模型与两条出路；
      //   3. pairs 全部相符但 identified < total（部分或全部 legacy 行）→
      //      放行 + 一次性 warn，提示 re-index 后检索质量才可验证。
      const identity = await readCollectionEmbedIdentity(
        settings.neonConnectionString,
        params.collection,
      );
      if (identity.total === 0) {
        const known = await listKnownCollectionNames();
        // 「Use one of the listed names」只在真的列了名单时才出现——名单为空
        // 时留着这句是 dangling instruction，会诱导 LLM 凭空挑一个名字。
        const tail = known.length > 0
          ? ` Collections known on this device: ${known.join(', ')}. ` +
            'Use one of the listed names, or tell the user the collection is missing.'
          : ' Ask the user for the correct collection name, or tell the user the collection is missing.';
        return {
          content: [
            {
              type: 'text',
              text:
                `<rag-search-result collection="${escapeAttr(params.collection)}" ` +
                `query="${escapeAttr(params.query)}" count="0" reason="collection_not_found">\n  ` +
                `(no collection named "${escapeText(params.collection)}" — it does not exist in the ` +
                `database or has zero indexed chunks.${tail})\n</rag-search-result>`,
            },
          ],
          details: {},
        };
      }
      const mismatch = describeEmbedderMismatch(identity.pairs, {
        model: settings.defaultEmbedModel,
        dim: settings.embedderDim,
      });
      if (mismatch) throw new Error(mismatch);
      if (identity.identified < identity.total) {
        warnLegacyEmbedRows(params.collection, identity.total - identity.identified);
      }

      // 从当前 settings 构建 embedder，Settings 里的模型变更即时生效、无需重启
      // 会话。embedder 自身的 dim 校验只能拦住**宽度不同**——「同维度、不同
      // 模型」的静默错配由上面的身份守卫负责，两层各管一半。
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
        // total === 0 已被上面的 fast path 截走，能走到这里的 0 行必然是
        // 「collection 有数据但没有命中」。
        return {
          content: [
            {
              type: 'text',
              text: `<rag-search-result collection="${escapeAttr(params.collection)}" query="${escapeAttr(params.query)}" count="0" reason="no_match">\n  (no matching chunks — try rephrasing the query or raising the limit)\n</rag-search-result>`,
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
        // envelope 不带分数：顺序本身就是排名信号；再给一个 RRF 数字只会诱导
        // LLM 跨调用比较或自行设阈值（pinMinScore 的教训）。
        lines.push(
          `  <chunk source="${escapeAttr(r.sourcePath)}" index="${r.chunkIndex}"${r.contextPrefix ? ` context="${escapeAttr(r.contextPrefix)}"` : ''}>${escapeText(r.content)}</chunk>`,
        );
      }
      lines.push(`</rag-search-result>`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {},
      };
    },
  };
}

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
