// 上下文压缩（compaction）领域模块：切点计算与摘要生成（依赖 pi-ai 的模型注册表）。
// 摘要消息的类型增广与纯辅助在 compaction-summary.ts，供不需要 pi-ai 的消费者引用。
// 具体的「何时压缩 / 插入摘要 / 状态广播」编排在 session-manager。

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
  type ThinkingLevel,
  convertToLlm,
  generateSummary,
  serializeConversation,
  DEFAULT_COMPACTION_SETTINGS,
} from '@earendil-works/pi-agent-core';
import {
  estimateContextTokens,
  estimateMessageTokens,
  estimateTextTokens,
} from '@/lib/agent/context-tokens';
import {
  getRetainedTail,
  isCompactionSummary,
  type CompactionSummaryMessage,
} from '@/lib/agent/compaction-summary';
import { sanitizeAgentMessages } from '@/lib/agent/message-helpers';
import type { CompactionSettings } from '@/lib/persistence/storage';

/**
 * 为摘要提示词与输出预留的 token。只用于限制**摘要本身**的长度（pi 的
 * `generateSummary` 取其 0.8 倍作 maxTokens），与「何时触发压缩」无关——后者现在由
 * 用户可调的百分比阈值决定，见 {@link resolveCompactionBudget}。沿用 pi 的默认值。
 */
const SUMMARY_RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

// ─── 保留区预算 ───
//
// 压缩后保留多少近期上下文，不做成设置项——用户真正关心的是「什么时候压」，保留多少
// 是实现细节。取窗口百分比而非 pi 的固定 20000，是因为固定值随窗口漂移得厉害：1M 窗口
// 只留 2% 的近期上下文，压完基本等于失忆。

/** 保留区目标预算占模型窗口的比例。 */
const KEEP_RECENT_PERCENT = 20;
/** 下界：再小的话一条大工具结果就能把保留区整个挤掉。 */
const MIN_KEEP_RECENT_TOKENS = 8_000;
/** 上界：避免大窗口模型每轮都拖着几十万 token 的保留区反复重发。 */
const MAX_KEEP_RECENT_TOKENS = 64_000;
/**
 * 保留区相对触发点的占比上限。小窗口模型（如 8k）下 `MIN_KEEP_RECENT_TOKENS` 可能反超
 * 触发点，届时切点回溯的边界恒为 0、压缩每轮都退化成 no-op——会话照样撑爆。这道钳位
 * 保证保留区永远明显小于触发点，压缩总能真正切下点东西。
 */
const KEEP_RECENT_TRIGGER_RATIO = 0.5;

/** 由用户设置 + 模型窗口换算出的本次压缩预算（token 绝对值）。 */
interface CompactionBudget {
  /** 上下文估算超过它即触发压缩。`Infinity` = 本会话不压缩（总开关关闭 / 窗口未知）。 */
  triggerTokens: number;
  /** 压缩后保留区的目标 token 预算，切点据此从尾部回溯。始终是有限值。 */
  keepRecentTokens: number;
}

/**
 * 把「百分比设置 + 模型窗口」换算成本次压缩的 token 预算。
 *
 * 「压不压缩」的判据只在这里编码一次：总开关关闭、或模型没声明窗口（`contextWindow`
 * 非正）都返回 `triggerTokens = Infinity`，调用方统一按「预算不可达就跳过」处理，不必
 * 各自再判一次开关。宁可不压，也不要拿一个瞎猜的窗口把用户的历史摘掉。
 */
function resolveCompactionBudget(
  settings: CompactionSettings,
  contextWindow: number,
): CompactionBudget {
  const byWindow = Math.min(
    MAX_KEEP_RECENT_TOKENS,
    Math.max(MIN_KEEP_RECENT_TOKENS, Math.floor((contextWindow * KEEP_RECENT_PERCENT) / 100)),
  );
  if (!settings.enabled || contextWindow <= 0) {
    return { triggerTokens: Number.POSITIVE_INFINITY, keepRecentTokens: byWindow };
  }
  const triggerTokens = Math.floor((contextWindow * settings.thresholdPercent) / 100);
  return {
    triggerTokens,
    // 见 KEEP_RECENT_TRIGGER_RATIO：保留区不能反超触发点，否则压缩永远切不动。
    keepRecentTokens: Math.min(byWindow, Math.floor(triggerTokens * KEEP_RECENT_TRIGGER_RATIO)),
  };
}

// ─── 切点计算（flat） ───

/**
 * 计算压缩切点：返回「保留区首条消息」的下标。该下标之前的全部消息将被一段摘要替代。
 *
 * **绝不在 toolResult 处切**，这是唯一的硬约束：一条脱离了自己 toolCall 的 toolResult
 * 会让 provider 直接 400，正是 issue #9 的根因。user 与 assistant 都可以当切点——
 * toolResult 永远排在产生它的 assistant 之后，所以从任何 user / assistant 处切开，
 * toolCall 与其 toolResult 要么整组留在保留区、要么整组进摘要，不会被拆散。
 *
 * 候选优先级：
 * 1. **user（turn-start）优先**：保留区从一条完整轮次开始，语义最干净。
 * 2. **退而求其次切在 assistant 上**：修 issue #72 —— 「一句指令 + 上百次工具调用」的
 *    会话整段只有一条 user 消息（下标 0），只认 user 切点的话结果恒为 0、调用方按
 *    no-op 跳过，于是**压缩一次都不会发生**，上下文一路涨到撑爆。允许轮内的 assistant
 *    边界之后，这类会话才真正压得动。
 * 3. 两种候选在 boundary 之后都没有（末尾单条消息就超预算）→ 退取最后一个候选
 *    （user 或 assistant，取下标大的那个）。此时保留区注定超预算——尾部那段非候选
 *    消息自己就超了——宁可多保留，也不拆散配对。
 *
 * 失败 / 取消留下的 assistant 标记不算候选：pi 的 `handleRunFailure` 与 Cebian 的
 * `buildAbortedMarker` 都会合成一条 `content: [{ text: '' }]`、`stopReason` 为
 * `aborted` / `error` 的空 assistant。它估算为 0 token，推不动 boundary，却可能**成为**
 * boundary 之后的第一个候选——切在它上面，保留区就只剩这条空消息，而 provider 适配层
 * 还会把空 content 的 assistant 整条丢掉，等于把用户正在用的工具输出全部扔进摘要。
 * 判据与 `lib/agent/context-tokens.ts` 挑 usage 锚点时一致：没正常完成的轮次不作数。
 *
 * 保留区以 assistant 开头是否合法：合法。`transformContext` 会把摘要折叠成一条 user
 * 消息排在最前，因此送给 provider 的序列仍以 user 开头（Anthropic 的硬要求），其后是
 * 配对完整的 assistant / toolResult。
 *
 * 算法移植自 pi `findCutPoint` 的「从尾部累计 token」思路，扁平化（直接操作
 * `AgentMessage[]` 数组，而非 pi 的 SessionTreeEntry 树），尺子换成 CJK 感知的
 * `estimateMessageTokens`（见 lib/agent/context-tokens）：
 * 1. 从最后一条消息往前累计估算 token，直到达到 keepRecentTokens，记边界 i。
 * 2. 按上面的优先级取 >= i 的候选（保留区 token 约等于预算，可能略少）。
 *
 * @returns 保留区首条消息下标。无任何可切候选返回 -1；返回 <= 0 时调用方应视为
 *          「本轮不压缩」（其前没有可摘要的历史）。
 */
function findCompactionCutPoint(
  messages: AgentMessage[],
  keepRecentTokens: number,
): number {
  // 候选切点：user 与「正常完成的」assistant 的下标。toolResult、自定义消息、以及
  // aborted / error 的空 assistant 标记一律排除（理由见上方 JSDoc）。下标 0 若成为切点
  // 等于不压缩，交由调用方按 cut <= 0 判定 no-op，这里不特殊排除。
  const userIndices: number[] = [];
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'user') userIndices.push(i);
    else if (
      message.role === 'assistant' &&
      message.stopReason !== 'aborted' &&
      message.stopReason !== 'error'
    ) {
      assistantIndices.push(i);
    }
  }
  if (userIndices.length === 0 && assistantIndices.length === 0) return -1;

  // 从尾部累计 token，确定「最近预算」的起始边界（累计用全部消息，不只候选）。
  // 总量不足预算时边界保持 0，此时所有候选都 >= boundary，仍按下面的优先级挑；
  // 只有挑出来正好是 0 才是 no-op。
  let boundary = 0;
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateMessageTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      boundary = i;
      break;
    }
  }

  const firstAtOrAfter = (indices: number[]) => indices.find((idx) => idx >= boundary);
  // 先找完整轮次的起点，没有再退到轮内的 assistant 边界。
  const cut = firstAtOrAfter(userIndices) ?? firstAtOrAfter(assistantIndices);
  if (cut !== undefined) return cut;

  // boundary 之后一个候选都没有：退取最后一个候选（user 或 assistant）。保留区此时
  // 必然超预算，但不拆配对优先。
  const lastUser = userIndices[userIndices.length - 1] ?? -1;
  const lastAssistant = assistantIndices[assistantIndices.length - 1] ?? -1;
  return Math.max(lastUser, lastAssistant);
}

// ─── 压缩决策（纯函数） ───

/** {@link measureContextUsage} / {@link planCompaction} 的公共入参。 */
interface ContextInput {
  /** `agent.state.messages` 全量。 */
  messages: AgentMessage[];
  settings: CompactionSettings;
  contextWindow: number;
  systemPrompt?: string;
  tools?: unknown[];
  /**
   * 强制压缩：跳过「用量是否已越过 thresholdPercent」这道门，直接按可切性判断。
   *
   * 用于用户主动触发（`compactNow`）与 Telegram 的 sliding window——两者都是「按计划
   * 该压就压」，与用量阈值无关。仍受 `settings.enabled` 与窗口已知这两条约束（关掉压缩
   * 是用户的显式选择，force 也不该绕过），也仍然保留 stuck 判定：压不动就是压不动，
   * 强行裸发只会 400。
   *
   * 注意 force 只影响**触发**，不影响保留区预算的取法——见 `resolveCompactionBudget`。
   */
  force?: boolean;
}

/**
 * 当前上下文占用快照，驱动输入框旁的占用指示。
 *
 * 由后台算好、经独立的 `context_usage` 帧下发，而不是前端自己估：一来前端拿不到模型的
 * `contextWindow`，二来两处各算一套必然漂移——会出现「界面显示 75%、却已经开始压缩」。
 */
export interface ContextUsage {
  /** 估算已用 token，与压缩判据用的是同一个数。 */
  tokens: number;
  /** 模型窗口；模型未声明时为 0，此时界面整个不渲染占用环。 */
  contextWindow: number;
  /** 触发压缩的 token 数；`null` = 不压缩（用户关掉了自动压缩，或窗口未知）。 */
  triggerTokens: number | null;
}

/**
 * 一次压缩的工作计划。由 {@link planCompaction} 算出，两个调用点共用：轮首（新一轮
 * user 消息进来之前）与轮内（agent loop 每次请求之前）。
 */
interface CompactionPlan {
  /**
   * 整形后的完整消息序列。可能与传入的数组不是同一个引用（历史里有 text 为 null 的
   * 坏消息时会被治好，见 issue #43），所以回写 state 时要以它为准。
   */
  messages: AgentMessage[];
  /** 上一条摘要（滚动合并的输入）；没有则 null。 */
  lastSummary: CompactionSummaryMessage | null;
  /** 待摘要区间：切点之前的全部消息。 */
  messagesToSummarize: AgentMessage[];
  /** 压缩后的保留区，挂到新摘要的 `retainedTail` 上。 */
  retainedTail: AgentMessage[];
  /** 压缩前的上下文估算，写进摘要消息的 `tokensBefore`。 */
  tokensBefore: number;
}

/**
 * 保留区大到这个程度就认为压缩救不了场：压完的请求还要放下摘要本身、systemPrompt、
 * 工具 schema 和模型的输出预留，保留区再逼近窗口就没有余量了。
 *
 * 预留量按窗口比例取、再以 `SUMMARY_RESERVE_TOKENS` 封顶：固定值对小窗口模型是灾难性的
 * ——20k 窗口减掉 16384 只剩 3616，正常会话会被当成压不动。
 */
function hopelessRetainedTokens(contextWindow: number): number {
  return contextWindow - Math.min(SUMMARY_RESERVE_TOKENS, Math.floor(contextWindow * 0.2));
}

/**
 * {@link planCompaction} 的结论。
 *
 * `stuck` 要和 `skip` 分开：两者都「压不了」，但含义相反——`skip` 是还不用压，`stuck`
 * 是已经超阈值、压缩却救不了场。两种形状都算：整段 sinceLast 只有一条候选消息（切在
 * 开头等于没压），以及切得动但保留区自己就塞不进窗口（一组拆不开的 assistant + 超大
 * toolResult）。继续跑下去只会一路 400，所以调用方应当停轮，把控制权交回用户——这正是
 * issue #72 里用户要的「快到上限就中断」。
 */
type CompactionDecision =
  | { kind: 'skip' }
  | { kind: 'compact'; plan: CompactionPlan }
  | { kind: 'stuck' };

/**
 * 判断当前上下文该不该压缩、压哪一段。纯函数、无副作用，摘要调用与状态回写都在
 * 编排层（session-manager）。
 */
/**
 * 量一次当前上下文占用。
 *
 * 与 {@link planCompaction} 共用同一段折叠与估算——指示器显示的必须就是压缩判据用的
 * 那个数，否则会出现「界面显示 75%、却已经开始压缩」这种对不上的情况。
 */
function measureContextUsage(params: ContextInput): ContextUsage {
  const { budget, tokens } = readContext(params);
  return {
    tokens,
    contextWindow: Math.max(0, params.contextWindow),
    triggerTokens: Number.isFinite(budget.triggerTokens) ? budget.triggerTokens : null,
  };
}

/** 折叠出「自上次摘要以来」的工作序列并估算占用。决策与占用指示的共同前半段。 */
function readContext(
  params: ContextInput,
  budget = resolveCompactionBudget(params.settings, params.contextWindow),
) {

  // 整形回类型契约（null text/thinking/name → ''），否则估算与切点对 assistant 块取
  // .length 会崩（issue #43）。copy-on-write：无坏数据时返回同一引用、零分配。
  const messages = sanitizeAgentMessages(params.messages);

  // 滚动摘要的工作序列：「自上次摘要以来」的活跃上下文 = 上次的保留区副本
  // （retainedTail，其原文在 state 里位于摘要之前）+ 摘要之后的新消息；无摘要时 = 全量。
  // 估算 / 切点 / 待摘要区间都基于这个序列——它就是 transformContext 发给 LLM 的内容
  // （摘要本体除外），保证阈值判断与真实负载一致，也保证上一轮保留区会被并入下一轮
  // 摘要而不是被静默丢弃。
  let lastSummaryIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactionSummary(messages[i])) {
      lastSummaryIdx = i;
      break;
    }
  }
  const lastSummary =
    lastSummaryIdx >= 0 ? (messages[lastSummaryIdx] as CompactionSummaryMessage) : null;
  const sinceLast = lastSummary
    ? [...getRetainedTail(lastSummary), ...messages.slice(lastSummaryIdx + 1)]
    : messages;

  // 估算与 LLM 视图同形（摘要 + 自上次摘要以来的序列）；systemPrompt / tools 一并交给
  // 估算器，由它决定要不要计入（只在没有 usage 锚点时才算）。
  const { tokens } = estimateContextTokens({
    messages: lastSummary ? [lastSummary, ...sinceLast] : messages,
    systemPrompt: params.systemPrompt,
    tools: params.tools,
  });
  return { budget, messages, lastSummary, sinceLast, tokens };
}

function planCompaction(params: ContextInput): CompactionDecision {
  // 预算不可达（总开关关闭 / 窗口未知）→ 本会话不压缩。「压不压」的判据只在
  // resolveCompactionBudget 里编码一次，这里不复述开关，免得新增调用点漏判。
  // 先判再读：关掉压缩时就不必走 readContext 那三趟线性扫描了（占用指示那边没有这个
  // 短路——它关掉压缩也要照常显示占用）。算好的 budget 直接传下去，不重复算。
  const budget = resolveCompactionBudget(params.settings, params.contextWindow);
  if (!Number.isFinite(budget.triggerTokens)) return { kind: 'skip' };
  const { messages, lastSummary, sinceLast, tokens } = readContext(params, budget);
  // force（用户主动触发 / Telegram sliding window）跳过阈值这道门——调用方要的是
  // 「现在就压」，与当前用量无关。注意是**跳过比较**，不是把阈值抬到 100：后者会让
  // 触发点等于整个窗口，只有已经撑爆才压得动，等于没压。enabled 与 stuck 判定照旧。
  if (!params.force && tokens <= budget.triggerTokens) return { kind: 'skip' };

  const cut = findCompactionCutPoint(sinceLast, budget.keepRecentTokens);
  // cut <= 0：无候选 / 从头保留即 no-op（其前没有可摘要的历史）。已经超阈值却切不动，
  // 再跑下去只会一路涨到 400。
  if (cut <= 0) return { kind: 'stuck' };

  // 切得动，但保留区自己就已经塞不进窗口——压了也白压，这一次请求照样会 400。典型形状是
  // 一次工具调用返回的正文极大，切点的第三档回退把它连同它的 assistant 整组留在保留区，
  // 谁也拆不开。同样按 stuck 处理。
  //
  // 判据必须用**窗口**而不是 `triggerTokens`：「压完还装不装得下」是模型窗口的事，跟用户
  // 设的触发百分比无关。拿阈值比会让「把阈值调低」——本意是更早压缩——反而更容易误判成
  // 压不动而停轮，把设置的含义整个拧反。
  //
  // 两边的尺子不完全同口径：这里是 `estimateMessageTokens` 的裸和，不含 systemPrompt /
  // 工具 schema，也不含压完之后要带上的那段摘要；而上面的 `tokens` 可能来自真实 usage
  // 锚点（本就含前缀）。偏差方向是低估保留区，也就是偏向「继续压」，这是安全的一侧。
  const retainedTail = sinceLast.slice(cut);
  const retainedTokens = retainedTail.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  if (retainedTokens >= hopelessRetainedTokens(params.contextWindow)) return { kind: 'stuck' };

  return {
    kind: 'compact',
    plan: {
      messages,
      lastSummary,
      messagesToSummarize: sinceLast.slice(0, cut),
      retainedTail,
      tokensBefore: tokens,
    },
  };
}

// 压缩用哪个模型 + 凭证的判定（ModelTarget / usableModelTarget）在 lib/providers/model-target.ts，
// 与自动标题共用；本模块只负责切点与摘要生成。

// ─── 摘要生成（带重试） ───

/** {@link runCompaction} 的入参。 */
interface RunCompactionParams {
  /** 待摘要的历史消息（切点之前的全部消息）。 */
  messagesToSummarize: AgentMessage[];
  model: Model<Api>;
  apiKey: string;
  /** 上一段压缩摘要，用于滚动更新（pi 内部走 UPDATE 提示词合并）。 */
  previousSummary?: string;
  /** 为摘要提示词与输出预留的 token；默认 {@link SUMMARY_RESERVE_TOKENS}。 */
  reserveTokens?: number;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
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

// ─── 分块 ───

/**
 * 摘要提示词里与消息条数无关的固定开销：系统提示词 + CREATE/UPDATE 指令 +
 * `<conversation>` 包装标签，合计几百 token，留 1000 做安全垫。
 *
 * **不含**逐条消息的框架开销（`[Tool result]: ` 这类前缀与 `\n\n` 连接符）——那部分
 * 随消息条数增长，已经含在 {@link serializedTokens} 的逐条测量里。
 */
const SUMMARY_PROMPT_OVERHEAD_TOKENS = 1_000;

/**
 * pi 的 `generateSummary` 把输出上限定为 `0.8 × reserveTokens`，因此任何一段摘要
 * （包括滚动过程中产生的中间摘要）都不会超过这个量。算预算时按它预留，就不必在
 * 循环里追着 rolling 的实际长度重算——分块一旦切好就不能再改了。
 */
const SUMMARY_OUTPUT_RATIO = 0.8;

/**
 * 分块数上限。历史远大于窗口时（换到小窗口模型继续一段长会话就会这样），块数会线性
 * 增长，每块都是一次真实的 LLM 调用。超出上限就**丢掉最旧的那些块**、只摘要最近的
 * MAX 块：越近的上下文对接下来的对话越有用，而无节制地烧几十次调用不可接受。
 */
const MAX_SUMMARY_CHUNKS = 8;

/** 单块预算的下限：再小就分出一堆碎块，摘要质量和调用次数都不划算。 */
const MIN_SUMMARY_CHUNK_TOKENS = 4_000;

/**
 * 一次摘要调用能塞下多少 token 的会话正文。
 *
 * 两种情况返回 `Infinity` = 不分块，退回单次调用的旧行为：
 * - `contextWindow` 非正（模型没声明窗口）——宁可按老样子试一次，也不要拿瞎猜的
 *   窗口把历史切碎；
 * - 算出来的空间连 {@link MIN_SUMMARY_CHUNK_TOKENS} 都不到（窗口比 `reserveTokens`
 *   还小的小模型）。此时切成碎块也一样会超窗，不如一次性试完就交给丢弃兜底，别把
 *   下限硬撑成一个「看起来可用、其实必然失败」的预算。
 *
 * 预留量按**最坏情况**算：滚动摘要会随块推进变长，而分块在循环外就定死了，所以这里
 * 直接按摘要输出上限预留，而不是按当前 `previousSummary` 的实际长度。
 */
function summaryChunkBudget(
  contextWindow: number,
  reserveTokens: number,
  previousSummary: string | undefined,
): number {
  if (contextWindow <= 0) return Number.POSITIVE_INFINITY;
  const rollingCeiling = Math.max(
    estimateTextTokens(previousSummary ?? ''),
    Math.floor(reserveTokens * SUMMARY_OUTPUT_RATIO),
  );
  const available =
    contextWindow - reserveTokens - SUMMARY_PROMPT_OVERHEAD_TOKENS - rollingCeiling;
  return available < MIN_SUMMARY_CHUNK_TOKENS ? Number.POSITIVE_INFINITY : available;
}

/**
 * 一条消息在摘要正文里**实际**占多少 token。
 *
 * 必须按 pi 序列化之后的文本量，不能拿 {@link estimateMessageTokens}（那把尺子量的是
 * 消息在真实上下文里的占用，`findCompactionCutPoint` 用它是对的）：`serializeConversation`
 * 会把每条 toolResult 截到 2000 字符，实测一条 5 万字的页面正文序列化后只剩 2054 字符，
 * 差 24 倍。照原样估算会把一次就能装下的历史切成十几块，`MAX_SUMMARY_CHUNKS` 的截断
 * 随即把最旧的历史白白丢掉——本来是极端情况的逃生口，会变成常态路径。
 *
 * 直接复用 pi 的 serializer，逐条测量，顺带把 `[Tool result]: ` 这类逐条框架开销也算进去。
 */
function serializedTokens(message: AgentMessage): number {
  const text = serializeConversation(convertToLlm([message]));
  // 加一个 token 抵掉块内各段之间的 `\n\n` 连接符。
  return text ? estimateTextTokens(text) + 1 : 0;
}

/**
 * 把待摘要区间切成若干块，每块序列化后的估算 token 不超过 `budgetTokens`，块内保持原顺序。
 *
 * 为什么这里**不用**管 toolCall / toolResult 配对：`generateSummary` 会把整段会话
 * `serializeConversation` 成一条 user 消息的**正文文本**再发出去，不是按原角色发的
 * 消息序列。所以块边界只是文本边界，切在哪都不会让 provider 400——这跟
 * {@link findCompactionCutPoint} 的硬约束是两回事，别把那套规则照搬过来。
 *
 * 单条消息自己就超预算时独占一块：这一块多半会失败，由调用方按整体失败处理，再由
 * session-manager 的丢弃兜底接住。
 *
 * 块数超过 {@link MAX_SUMMARY_CHUNKS} 时丢掉最旧的，只留最近的若干块。
 */
function splitForSummary(
  messages: AgentMessage[],
  budgetTokens: number,
): AgentMessage[][] {
  if (messages.length === 0) return [];
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let accumulated = 0;
  for (const message of messages) {
    const tokens = serializedTokens(message);
    if (current.length > 0 && accumulated + tokens > budgetTokens) {
      chunks.push(current);
      current = [];
      accumulated = 0;
    }
    current.push(message);
    accumulated += tokens;
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length <= MAX_SUMMARY_CHUNKS) return chunks;
  // 丢最旧的是既定策略，但不能悄无声息——摘要会读起来像覆盖了全部历史。
  console.warn(
    `[compaction] history needs ${chunks.length} summary chunks, ` +
      `dropping the oldest ${chunks.length - MAX_SUMMARY_CHUNKS}`,
  );
  return chunks.slice(-MAX_SUMMARY_CHUNKS);
}

// ─── 摘要生成 ───

/**
 * 生成一段压缩摘要：底层复用 pi 的 `generateSummary`（内部处理摘要提示词与
 * previousSummary 滚动合并），在其上叠加「按摘要模型窗口分块」与「每块失败重试一次」。
 *
 * 返回摘要文本；任一块两次尝试都失败返回 null。调用方（session-manager）据此插入一条
 * 「早期历史已丢弃」的兜底标记（见 `createDroppedHistoryMessage`），把早期历史移出
 * LLM 视图，并在后续轮次再次尝试压缩。
 *
 * 取消语义：每次尝试前检查 signal，已 abort 则直接返回 null 不再重试；若
 * generateSummary 返回 code='aborted' 的错误，同样视为取消而非失败。均遵守
 * pi-agent-core 的 cancellation 约定。
 */
async function runCompaction(params: RunCompactionParams): Promise<string | null> {
  const {
    messagesToSummarize,
    model,
    apiKey,
    previousSummary,
    reserveTokens = SUMMARY_RESERVE_TOKENS,
    signal,
    thinkingLevel,
  } = params;

  // 0.80 的 generateSummary 经 Models 集合解析 auth：用已解析好的 key 构造一个只
  // 服务该 model 的临时集合（见 modelsForSummary），全部分块与重试复用同一集合。
  const models = await modelsForSummary(model, apiKey);

  // 按摘要模型的窗口分块。待摘要区间比窗口还大时（issue #72 的现场就是如此），单次
  // 调用必然 400，分块之后才摘得动；一块装得下时退化成原来的单次调用。
  const chunks = splitForSummary(
    messagesToSummarize,
    summaryChunkBudget(model.contextWindow, reserveTokens, previousSummary),
  );
  if (chunks.length === 0) return null;

  // 逐块滚动：前一块的结果作为下一块的 previousSummary，交给 pi 的 UPDATE 提示词合并。
  // 注意这是有损的：每次 UPDATE 的输出都受同一个上限约束，块数越多，最早那几块的细节
  // 被挤掉得越厉害。这是 pi 反复压缩本身就有的性质，不是本实现引入的。
  let rolling = previousSummary;
  for (const [index, chunk] of chunks.entries()) {
    const outcome = await summarizeChunk({
      chunk, models, model, reserveTokens, previousSummary: rolling, signal, thinkingLevel,
    });
    // 取消不是失败：静默退出，调用方据 signal 走取消路径，不会插丢弃标记。
    if (outcome.kind === 'cancelled') return null;
    // 任一块失败就整体放弃：只摘了一半的结果更危险——块是按时间从旧到新排的，中途失败
    // 等于「留下最旧的摘要、丢掉最新的历史」，正好搞反了轻重。整体失败由 session-manager
    // 插丢弃标记接住。
    if (outcome.kind === 'failed') {
      if (chunks.length > 1) {
        console.warn(`[compaction] chunk ${index + 1}/${chunks.length} failed, giving up`);
      }
      return null;
    }
    rolling = outcome.summary;
  }
  return rolling ?? null;
}

/** {@link summarizeChunk} 的结果。取消与失败必须分开——前者不该触发丢弃兜底，也不该记警告。 */
type ChunkOutcome =
  | { kind: 'ok'; summary: string }
  | { kind: 'failed' }
  | { kind: 'cancelled' };

/** 摘要单块，失败重试一次。 */
async function summarizeChunk(params: {
  chunk: AgentMessage[];
  models: Models;
  model: Model<Api>;
  reserveTokens: number;
  previousSummary: string | undefined;
  signal: AbortSignal | undefined;
  thinkingLevel: ThinkingLevel | undefined;
}): Promise<ChunkOutcome> {
  const { chunk, models, model, reserveTokens, previousSummary, signal, thinkingLevel } = params;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) return { kind: 'cancelled' };
    const result = await generateSummary(
      chunk,
      models,
      model,
      reserveTokens,
      signal,
      // customInstructions：fork 的 Subtask 4 —— 在既有 Markdown 模板之外追加围栏 JSON
      // schema spec，让 LLM 一次响应里同时输出人读 Markdown 与工具可读 JSON。Markdown
      // 摘要正文走 `summary` 字段，JSON 由 `parseStructuredSummary` 抽出后供 VFS 归档。
      // 分块时每块都带同一份指令；最终归档取最后一块的输出（正文即滚动合并的结果）。
      COMPACTION_STRUCTURED_INSTRUCTIONS,
      previousSummary,
      thinkingLevel,
    );
    // 空摘要要当失败重试：pi 只拒 aborted / error，模型返回空内容一样是 ok。放过去的话
    // 它会顶掉 rolling，让前面几块的合并链凭空断掉，而且悄无声息。
    if (result.ok && result.value.trim()) return { kind: 'ok', summary: result.value };
    // 取消不是失败：不记警告、不重试。
    if (!result.ok && (result.error.code === 'aborted' || signal?.aborted)) {
      return { kind: 'cancelled' };
    }
    if (signal?.aborted) return { kind: 'cancelled' };
    console.warn(
      `[compaction] generateSummary failed (attempt ${attempt}/2):`,
      result.ok ? 'empty summary' : result.error,
    );
  }
  return { kind: 'failed' };
}

// ─── 结构化摘要（Subtask 4：从 fork 移植） ───
//
// LLM 在 Markdown 摘要之外再输出一个围栏 JSON 块，供工具查询 / VFS 归档使用。
// 这一段与 1.8.0 的分块摘要互不冲突：分块逻辑只关心 Markdown 正文（`summary`），
// JSON 侧信道是每块输出各自的附加产物，最终以最后一块的正文为准。

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

// ─── VFS 归档（Subtask 4：从 fork 移植） ───

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
 *  方便断言时间戳后缀的拼接格式。 */
export function buildArchiveFilename(compactAt: number, rng: () => number = Math.random): string {
  const iso = new Date(compactAt).toISOString().replace(/[:.]/g, '-');
  const suffix = Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0');
  return `${iso}-${suffix}.json`;
}

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
  '  "decisions": [{ "decision": "string", "rationale": "string" }],\n' +
  '  "next_steps": ["string"],\n' +
  '  "critical_context": ["string"]\n' +
  '}\n' +
  '```';

/** Re-export pi-agent-core's CompactionSummaryMessage so other modules can pull it
 *  from this consolidation point without taking a direct dep on pi-agent-core's
 *  internal type layout. */
export type { CompactionSummaryMessage };

// ─── Public API ───
//
// 上方的结构化摘要 / 归档 helper 已在各自定义处 `export`（fork 移植段），此处只导出
// 1.8.0 原生 API 与本模块内部产出的类型。

export {
  findCompactionCutPoint,
  measureContextUsage,
  planCompaction,
  resolveCompactionBudget,
  runCompaction,
  splitForSummary,
  summaryChunkBudget,
};
export type {
  CompactionDecision,
  CompactionPlan,
  RunCompactionParams,
};
