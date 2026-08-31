// 上下文压缩（compaction）领域模块：集中存放压缩消息类型、切点计算与摘要生成，
// 使压缩特性自包含。具体的「何时压缩 / 插入摘要 / 状态广播」编排在 session-manager。

import type { Api, Model, Models } from '@earendil-works/pi-ai';
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
} from '@earendil-works/pi-ai';
import { getApiProvider } from '@earendil-works/pi-ai/compat';
import {
  type AgentMessage,
  type CompactionSummaryMessage,
  type ThinkingLevel,
  estimateTokens,
  generateSummary,
  DEFAULT_COMPACTION_SETTINGS,
} from '@earendil-works/pi-agent-core';
import { debugLog, withSession } from '@/lib/debug/log';

/**
 * Cebian 的压缩配置（④：写死默认 + 留配置位）。当前直接对齐 pi 的
 * `DEFAULT_COMPACTION_SETTINGS`，集中成一个常量而非散落的 magic number：
 * 将来要做成用户可调设置项时，只需把这里改成读 storage，编排层
 * （session-manager）无需改动。
 *
 * - `enabled`：压缩总开关。
 * - `reserveTokens`：为摘要提示词与输出预留的 token，同时作为 `shouldCompact`
 *   触发阈值的安全边距（`tokens > contextWindow - reserveTokens` 时触发）。
 * - `keepRecentTokens`：压缩后保留区的目标 token 预算，切点据此从尾部回溯。
 */
export const COMPACTION_SETTINGS = DEFAULT_COMPACTION_SETTINGS;

/** 喂给 pi-agent-core `generateSummary` 的 customInstructions：在既有的 6 节
 *  Markdown 模板之外，额外要求 LLM 在响应末尾输出一个围栏 JSON 块。
 *  Markdown 是人读视图，JSON 是工具查询视图——两者由 LLM 在一次响应里
 *  一并输出。pi-agent-core 把这段字符串原样追加在 `Additional focus: `
 *  之后（见 pi harness `compaction.js:387-392`），故不会破坏现有 Markdown
 *  模板的结构，只在末尾追加 schema 描述。
 *
 *  schema 演进时改写本常量并同步 `isStructuredSummary` 的守门；v1 的 archive
 *  文件仍按 v1 解析，v2 archive 走另一条路径。 */
export const COMPACTION_STRUCTURED_INSTRUCTIONS =
  'In addition to the structured Markdown summary above, append a single ' +
  'JSON code block fenced as ```json ... ``` at the very end of your response. ' +
  'The JSON is consumed by tooling; it must be valid JSON (no trailing commas, ' +
  'no comments). Schema (all fields required; use empty arrays for empty lists):\n' +
  '\n' +
  '```\n' +
  '{\n' +
  '  "schema_version": 1,\n' +
  '  "goal": "string",\n' +
  '  "constraints": ["string"],\n' +
  '  "progress": {\n' +
  '    "done": ["string"],\n' +
  '    "in_progress": ["string"],\n' +
  '    "blocked": ["string"]\n' +
  '  },\n' +
  '  "decisions": [{"decision": "string", "rationale": "string"}],\n' +
  '  "next_steps": ["string"],\n' +
  '  "critical_context": ["string"]\n' +
  '}\n' +
  '```\n' +
  '\n' +
  'Emit the JSON only once, as the final block. If a section has no items, use ' +
  'an empty array (or empty object for progress). Do not add fields beyond the ' +
  'schema.';

/** pi-agent-core 的 `reserveTokens` 默认值（16384）在 contextWindow ≤ 32k
 *  的模型上会令 `contextWindow - reserveTokens` 翻负，使 `shouldCompact`
 *  永远返回 true；同时 `keepRecentTokens`（20000）也会让
 *  `findCompactionCutPoint` 在小上下文里把整段 transcript 吞进「保留区」、
 *  切点退化为 0 ——两条默认值在 ≤ 32k 的模型上都是死代码。两个工具都是
 *  `shouldCompact` 与 sliding-window 共同读，夹紧公式抽到一处便于同步：
 *
 *  - `reserve` 夹到 contextWindow 的 50%（给「真·对话」至少留一半）；
 *  - `keepRecent` 夹到 contextWindow 的 40%（保留区预算比 reserve 大、保证
 *    `shouldCompact` 触发时仍有空间保留尾巴）。
 *
 *  公式与 session-manager.ts 中原本内联的 `Math.min(COMPACTION_SETTINGS.reserveTokens, contextWindow × 0.5)` 一一对应；Subtask 3 把 inline 收敛到这里，`maybeCompact`（Subtask 2 的 80% 预检路径）与 `transformContext` 共用同一份夹紧值。 */
export function clampedCompactionReserve(contextWindow: number): number {
  return Math.min(COMPACTION_SETTINGS.reserveTokens, Math.floor(contextWindow * 0.5));
}

export function clampedCompactionKeepRecent(contextWindow: number): number {
  return Math.min(COMPACTION_SETTINGS.keepRecentTokens, Math.floor(contextWindow * 0.4));
}

/**
 * 压缩摘要消息：当会话过长触发压缩时，被压缩的历史会被一段 LLM 生成的结构化
 * 摘要替代。这条消息直接作为一条普通成员存在于 `agent.state.messages` 数组里，
 * 跟随正常的持久化 / 广播 / UI 渲染管线，无需改动存储 schema。
 *
 * 落点：树化后摘要是**尾部追加**（压缩发生在新一轮 user 消息进入之前，故摘要
 * 总在「上一轮尾部、本轮 user 之前」），保留区副本挂在 `retainedTail` 上。
 * `truncateForRetry`「截到最后一条 user」天然保住摘要，无需特判。
 *
 * 消息类型直接复用 pi harness 的 `CompactionSummaryMessage`（pi 自身已把它注册进
 * `AgentMessage` union），在此对其做 declaration merging 增广一个字段：
 * - `retainedTail`：压缩时保留区的消息副本（对齐 pi CompactionEntry 的同名字段）。
 *   树化后摘要在会话里是**尾部追加**（不再中段插入），保留区原文位于摘要之前，
 *   LLM 视图由 transformContext 用本字段重建为「摘要 + 保留区 + 其后消息」。
 *   v1 迁移来的旧摘要没有此字段（保留区本就排在摘要之后），两种形态由同一条
 *   transformContext 公式统一处理。UI 渲染忽略此字段。
 */
declare module '@earendil-works/pi-agent-core' {
  interface CompactionSummaryMessage {
    // 语义是 AgentMessage[]，但必须声明为 unknown[]：AgentMessage union 包含本
    // 接口自身，真递归类型会让 Dexie 的 UpdateSpec/KeyPaths 映射类型无限展开
    // （TS2615）。读取统一走下面的 getRetainedTail 拿回具体类型。
    retainedTail?: unknown[];
    /** Subtask 4：LLM 响应里解析出的结构化 JSON。仅当解析成功时设置；
     *  解析失败时该字段**缺席**（不显式置 null），方便现有
     *  `if (msg.structured)` 守卫照常工作。Markdown 摘要正文继续走
     *  `summary` 字段，structured 是查询 / 归档用的侧信道。 */
    structured?: StructuredSummary;
  }
}

export type { CompactionSummaryMessage };

/** 取回 retainedTail 的具体类型（声明层为 unknown[]，见上方注释）；缺失返回 []。 */
export function getRetainedTail(msg: CompactionSummaryMessage): AgentMessage[] {
  return (msg.retainedTail as AgentMessage[] | undefined) ?? [];
}

/** 构造一条 compactionSummary 消息。`retainedTail` 见接口注释（新压缩必传，
 *  哪怕保留区为空也传 `[]`；仅 v1 迁移来的历史摘要没有该字段）。 */
export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  retainedTail: AgentMessage[],
): CompactionSummaryMessage {
  return {
    role: 'compactionSummary',
    summary,
    tokensBefore,
    timestamp: Date.now(),
    retainedTail,
  };
}

/** 类型守卫：判断一条消息是否为 compactionSummary。 */
export function isCompactionSummary(
  msg: { role: string },
): msg is CompactionSummaryMessage {
  return msg.role === 'compactionSummary';
}

// ─── 结构化摘要（Subtask 4） ───

/** LLM 在压缩摘要末尾输出的 JSON schema。`schema_version` 必为 1；
 *  schema 演进时同步加 `isStructuredSummaryV2` 并 dispatch。
 *  字段顺序与 JS 对象的 key order 一致，便于阅读。 */
export interface StructuredSummary {
  schema_version: 1;
  goal: string;
  constraints: string[];
  progress: { done: string[]; in_progress: string[]; blocked: string[] };
  decisions: { decision: string; rationale: string }[];
  next_steps: string[];
  critical_context: string[];
}

/** 严格守门：只接受 `schema_version === 1` 且**全部**字段结构正确的对象。
 *  任何一项不匹配返回 false——避免 Markdown 正文里的内联 `{...}` 例子
 *  被误判成 JSON。 */
export function isStructuredSummary(x: unknown): x is StructuredSummary {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.schema_version !== 1) return false;
  if (typeof o.goal !== 'string') return false;
  if (!isStringArray(o.constraints)) return false;
  if (!o.progress || typeof o.progress !== 'object') return false;
  const p = o.progress as Record<string, unknown>;
  if (!isStringArray(p.done)) return false;
  if (!isStringArray(p.in_progress)) return false;
  if (!isStringArray(p.blocked)) return false;
  if (!isStringArray(o.next_steps)) return false;
  if (!isStringArray(o.critical_context)) return false;
  if (!Array.isArray(o.decisions)) return false;
  for (const d of o.decisions) {
    if (!d || typeof d !== 'object') return false;
    const dd = d as Record<string, unknown>;
    if (typeof dd.decision !== 'string') return false;
    if (typeof dd.rationale !== 'string') return false;
  }
  return true;
}

function isStringArray(x: unknown): boolean {
  return Array.isArray(x) && x.every((s) => typeof s === 'string');
}

/** 去掉首尾空白与首尾一对 ` ```... ` ``` 围栏。无围栏时返回原文。
 *  仅供 `parseStructuredSummary` / 测试使用；不解析 JSON。 */
export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const m = /^\s*```(?:json|ts|javascript|js)?\s*\n([\s\S]*?)\n```\s*$/.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

/** 从 LLM 输出里提取并解析结构化 JSON 摘要。优先级：
 *  1. 最后一个 ```json (或 ```ts/js) 围栏里的内容 → JSON.parse → isStructuredSummary；
 *     围栏语言标签大小写不敏感（个别模型会写 ```JSON），内文首行偶然是 `json` 也兼容。
 *  2. 退而求其次：把整个 LLM 输出当 JSON 解析（覆盖 LLM 漏写围栏的情况）。
 *  全部失败返回 null；不抛。 */
export function parseStructuredSummary(llmOutput: string): StructuredSummary | null {
  if (!llmOutput) return null;
  // 1. 收集所有围栏（按出现顺序），从最后一个开始尝试
  const fenceRe = /```(?:json|ts|javascript|js)?\s*\n([\s\S]*?)\n```/gi;
  const blocks: string[] = [];
  for (const m of llmOutput.matchAll(fenceRe)) blocks.push(m[1]);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const candidate = blocks[i].trim();
    if (!candidate) continue;
    const parsed = tryParseJson(candidate);
    if (parsed && isStructuredSummary(parsed)) return parsed;
    // 只在 JSON 解析失败时再试剥前缀（个别 LLM 把围栏标成 ```json 但内文首
    // 行又写了一遍 `json` 字面）。若 JSON 已成功解析却被 schema 守门驳回（结构
    // 性错误，不是前缀问题），剥前缀也救不回来，直接跳过避免无意义尝试。
    if (parsed === null) {
      const stripped = candidate.replace(/^json\s*\n/i, '');
      const parsed2 = tryParseJson(stripped);
      if (parsed2 && isStructuredSummary(parsed2)) return parsed2;
    }
  }
  // 2. 整体当 JSON 解析（无围栏的回退）
  const direct = tryParseJson(llmOutput.trim());
  if (direct && isStructuredSummary(direct)) return direct;
  return null;
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── 切点计算（flat） ───

/**
 * 计算压缩切点：返回「保留区首条消息」的下标——它一定是一条 user 消息
 * （turn-start）。该下标之前的全部消息将被一段摘要替代。
 *
 * 为什么只在 user 消息处切：
 * - user 消息是一轮对话的起点；在此切点保证保留区从一条完整 user turn 开始，
 *   不会把 assistant 的 toolCall 与其 toolResult 拆散——孤立的 toolResult 正是
 *   issue #9 中 provider 返回 400 的根因。
 * - 同时天然规避 pi `findCutPoint` 的 split-turn 复杂度：保留区永远是若干完整轮次。
 *
 * 算法移植自 pi `findCutPoint` 的「从尾部累计 token」思路，扁平化（直接操作
 * `AgentMessage[]` 数组，而非 pi 的 SessionTreeEntry 树）且候选切点仅限 user 消息：
 * 1. 从最后一条消息往前累计估算 token，直到达到 keepRecentTokens，记边界 i。
 * 2. 取第一条下标 >= i 的 user 消息作切点（保留区 token 约等于预算，可能略少）。
 * 3. 若 i 之后已无 user 消息（末轮过长、无法在其内部安全切分），退取最后一条
 *    user 消息——宁可多保留，也不拆散一轮。
 *
 * @returns 保留区首条消息下标。若不存在 user 消息可切返回 -1；返回 <= 0 时
 *          调用方应视为「本轮不压缩」（其前没有可摘要的历史）。
 */
export function findCompactionCutPoint(
  messages: AgentMessage[],
  keepRecentTokens: number,
): number {
  // 候选切点：所有 user 消息下标。首条 user（通常下标 0）在此切等于不压缩，
  // 交由调用方按 cutIndex <= 0 判定 no-op，这里不特殊排除。
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIndices.push(i);
  }
  if (userIndices.length === 0) return -1;

  // 从尾部累计 token，确定「最近预算」的起始边界。总量不足预算时边界保持 0，
  // 最终退化为返回首条 user（no-op），这是安全的退化分支。
  let boundary = 0;
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      boundary = i;
      break;
    }
  }

  // 取第一条 >= boundary 的 user 切点。
  for (const idx of userIndices) {
    if (idx >= boundary) return idx;
  }
  // boundary 之后无 user 消息：退取最后一条 user 切点（多保留，不拆轮次）。
  return userIndices[userIndices.length - 1];
}

// ─── 压缩模型选择 ───

/** 压缩调用最终要用的「模型 + 凭证」。`apiKey` 可能为 undefined（连主模型都没
 *  凭证），由调用方按现有「无 key 则本轮裸发」分支处理。 */
export interface CompactionTarget {
  model: Model<Api>;
  apiKey: string | undefined;
}

/**
 * 配置的压缩目标可用（解析成功且凭证可用）就返回它，否则返回 null
 * 表示「回退主模型」。
 *
 * 纯函数——读配置、解析 model、取 key 这些 IO 留在调用方（session-manager 的
 * `resolveCompactionModel`），这里只做「配置是否可用」的判定，便于独立单测。
 */
export function usableCompactionTarget(
  configured: CompactionTarget | null,
): CompactionTarget | null {
  return configured && configured.apiKey ? configured : null;
}

// ─── 摘要生成（带重试） ───

/** {@link runCompaction} 的入参。 */
export interface RunCompactionParams {
  /** 待摘要的历史消息（切点之前的全部消息）。 */
  messagesToSummarize: AgentMessage[];
  model: Model<Api>;
  apiKey: string;
  /** 上一段压缩摘要，用于滚动更新（pi 内部走 UPDATE 提示词合并）。 */
  previousSummary?: string;
  /** 为摘要提示词与输出预留的 token；默认取 pi 的 DEFAULT_COMPACTION_SETTINGS。 */
  reserveTokens?: number;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  /** Optional session id for debug-log correlation. When set, compaction
   *  start/done events get `sessionId` promoted to the top-level field so
   *  log queries can filter by session without parsing the JSON payload. */
  sessionId?: string;
}

/**
 * 用已解析好的 apiKey 构造一个只服务该 model 的临时 Models 集合。
 *
 * 0.80 的 generateSummary 经 Models 集合解析 auth、不再接受 apiKey 参数（主循环仍走
 * agent-core 内部的显式 apiKey 路径，二者在 0.80 不对称）。Cebian 是浏览器扩展、无
 * env，apiKey / OAuth-token 全由 resolveProviderApiKey 自己解析，故把已解析好的 key
 * （OAuth 已刷新为 bearer）以 api_key 凭证注入内存 store，envApiKeyAuth 让它成为唯一
 * 来源。model 对象本身已带正确 baseUrl / headers（resolveModel 烤入 copilot baseUrl /
 * openrouter 归因头），直接复用。每次压缩单独构造，无全局状态、无并发串扰，复刻
 * 主循环「显式 model + 显式 key」语义。
 *
 * api 实现（按 model.api 选 wire protocol）直接取 `/compat` 的 api-registry（`getApiProvider`）
 * ——它就是 pi 内部 BUILTIN_APIS 的公开入口，返回的是 lazy 包装（SDK 延迟加载）。
 * 复用 pi 的单一真理源，无需自己维护一张 api→impl 映射；agent-core 内部本就已 import
 * `/compat`，故内置 api 在此时均已注册。
 */
async function modelsForSummary(model: Model<Api>, apiKey: string): Promise<Models> {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({ type: 'api_key', key: apiKey }));

  const streams = getApiProvider(model.api);
  if (!streams) {
    throw new Error(`[compaction] no API implementation registered for "${model.api}"`);
  }

  const models = createModels({ credentials });
  models.setProvider(createProvider({
    id: model.provider,
    baseUrl: model.baseUrl,
    auth: { apiKey: envApiKeyAuth(model.provider, []) },
    models: [model],
    api: streams,
  }));
  return models;
}

/**
 * 生成一段压缩摘要：底层复用 pi 的 `generateSummary`（内部处理摘要提示词与
 * previousSummary 滚动合并），在其上叠加「失败重试一次」。
 *
 * 返回摘要文本；两次尝试都失败返回 null。调用方（session-manager）据此走「不带
 * 摘要的 turn-start 截断」回退，并在后续轮次再次尝试压缩。
 *
 * 取消语义：每次尝试前检查 signal，已 abort 则直接返回 null 不再重试；若
 * generateSummary 返回 code='aborted' 的错误，同样视为取消而非失败。均遵守
 * pi-agent-core 的 cancellation 约定。
 */
export async function runCompaction(params: RunCompactionParams): Promise<string | null> {
  const {
    messagesToSummarize,
    model,
    apiKey,
    previousSummary,
    reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    signal,
    thinkingLevel,
    sessionId,
  } = params;

  // Compaction observability: log start/done with timing + input/output sizes.
  // `messagesCount` = how many messages we're summarizing (proxy for context
  // size). `summaryLen` = length of the resulting summary text (proxy for
  // compression ratio). `durationMs` covers both retries when they happen.
  // We surface this at info level (not debug) because it's a user-visible
  // event — a long compaction = user sees "Compacting..." for seconds.
  const startedAt = Date.now();
  const inputTokens = messagesToSummarize.reduce((sum, m) => sum + estimateTokens(m), 0);
  debugLog.info('llm', 'compaction:start', withSession({
    messagesCount: messagesToSummarize.length,
    inputTokens,
    model: `${model.provider}/${model.id}`,
    hasPreviousSummary: !!previousSummary,
  }, sessionId ?? ''));

  // 0.80 的 generateSummary 经 Models 集合解析 auth：用已解析好的 key 构造一个只
  // 服务该 model 的临时集合（见 modelsForSummary），两次重试复用同一集合。
  const models = await modelsForSummary(model, apiKey);

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) return null;
    const result = await generateSummary(
      messagesToSummarize,
      models,
      model,
      reserveTokens,
      signal,
      // customInstructions：Subtask 4 — 在既有 Markdown 模板之外追加围栏 JSON
      // schema spec，让 LLM 一次响应里同时输出人读 Markdown 与工具可读 JSON。
      // Markdown 摘要正文走 `summary` 字段，JSON 由 `parseStructuredSummary`
      // 抽出后挂在 `structured?` 侧信道（见 CompactionSummaryMessage 注释）。
      COMPACTION_STRUCTURED_INSTRUCTIONS,
      previousSummary,
      thinkingLevel,
    );
    if (result.ok) {
      debugLog.info('llm', 'compaction:done', withSession({
        ok: true,
        messagesCount: messagesToSummarize.length,
        inputTokens,
        summaryLen: result.value.length,
        durationMs: Date.now() - startedAt,
        attempts: attempt,
      }, sessionId ?? ''));
      return result.value;
    }
    // 取消不是失败：不记警告、不重试。
    if (result.error.code === 'aborted' || signal?.aborted) {
      debugLog.info('llm', 'compaction:done', withSession({
        ok: false,
        cancelled: true,
        durationMs: Date.now() - startedAt,
      }, sessionId ?? ''));
      return null;
    }
    console.warn(`[compaction] generateSummary failed (attempt ${attempt}/2):`, result.error);
  }
  debugLog.warn('llm', 'compaction:done', withSession({
    ok: false,
    reason: 'max_retries_exceeded',
    durationMs: Date.now() - startedAt,
  }, sessionId ?? ''));
  return null;
}

// ─── VFS 归档（Subtask 4） ───

/** 一次压缩事件在 VFS 里的存档结构。`schemaVersion` 与 LLM 输出的
 *  `schema_version` 是两件事：前者是归档文件本身的版本，后者是 LLM 摘要
 *  内容的 schema。两者都从 1 起跳，分别独立演进。 */
export interface CompactionArchiveEntry {
  schemaVersion: 1;
  sessionId: string;
  compactedAt: number;
  tokensBefore: number;
  messagesSummarized: number;
  compactingModel: string;                       // "provider/id"
  structured: StructuredSummary | null;          // null when JSON parse failed
  rawOutput: string;                             // full LLM output (Markdown + JSON fence)
  parseError?: string;                           // set only when structured === null
}

export interface BuildArchiveInput {
  sessionId: string;
  compactedAt: number;
  tokensBefore: number;
  messagesSummarized: number;
  compactingModel: Model<Api>;
  llmOutput: string;
}

/** 把 LLM 原始输出 + 元数据封装成可写入 VFS 的存档条目。LLM 响应解析失败的
 *  情况仍写出（`structured: null` + `parseError`），归档是「事实日志」，不让
 *  一次解析错误抹掉一次压缩事件的所有上下文。 */
export function buildCompactionArchiveEntry(input: BuildArchiveInput): CompactionArchiveEntry {
  const structured = parseStructuredSummary(input.llmOutput);
  const entry: CompactionArchiveEntry = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    compactedAt: input.compactedAt,
    tokensBefore: input.tokensBefore,
    messagesSummarized: input.messagesSummarized,
    compactingModel: `${input.compactingModel.provider}/${input.compactingModel.id}`,
    structured,
    rawOutput: input.llmOutput,
  };
  if (structured === null) {
    entry.parseError = 'parseStructuredSummary returned null';
  }
  return entry;
}

/** 生成归档文件名：ISO 时间戳 + 6 字符十六进制后缀。同毫秒下多次调用的
 *  冲突概率约 2^-24（`Math.random` 的 24 bit 有效精度），对压缩场景
 *  （同会话同毫秒连续压缩两次几乎不可能）够用。
 *
 *  `rng` 形参是测试钩子——生产走 `Math.random`，测试可注入确定性随机源，
 *  方便断言时间戳前缀与后缀的拼接格式。 */
export function buildArchiveFilename(compactAt: number, rng: () => number = Math.random): string {
  const iso = new Date(compactAt).toISOString().replace(/[:.]/g, '-');
  const suffix = Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0');
  return `${iso}-${suffix}.json`;
}
