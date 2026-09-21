// Telegram Gateway BG manager — 把 `bootstrapTelegramGateway` 接上存储，「通电」，
// 并按 OpenClaw 模式做 session 隔离路由：每个 Telegram chat_id 一个固定 session。
//
// 两层职责：
//   1. 连线：SW 启动 sync 一次 + watch config/secrets（Settings 保存后自动
//      (re)bootstrap——「改 token 即触发 WebSocket 重连」）。未配置 / 清空 →
//      teardown + publishStatus('disconnected')。
//   2. Inbound 路由（session isolation）：收到 Telegram 消息后路由到专用
//      session（每个 chat / group 一个，永不跟当前打开的 session 混），跑完
//      agent 后把最后一条 assistant 文本经 WS 回到该 chat。DM 与 group 天然
//      各占一个 session；用户在 History 里随时点开查看。
//
// Session id：从 chat_id 派生确定性 id（4×FNV-1a seeds → 128-bit，v5 形状）。
// 全仓的 session id 不变量是 UUID-only（SESSION_ID_RE 把关 backup / delegate_task
// / run_skill 的所有边界）——自由字符串会撞坏这些门，所以必须收敛成 UUID 形状；
// 同 chat 永远映射到同一 session，识别靠「Telegram ·」标题。同步派生（不用
// crypto.subtle）——dispatch 路径没有 real-macrotask 依赖，测试时序确定性。
//
// 串行队列：同一 session 的消息按到达顺序排队（Map<sessionId, Promise> 链式
// 串联）。pi-agent-core 的 Agent.prompt() 在 run 进行中会 throw——不排队的话
// burst 消息会被静默丢掉；排队后逐条处理，语义与 OpenClaw 一致。
//
// interactiveMode 开关在 dispatch 入口把关：OFF → 完全忽略 inbound。开关状态
// 在每次 sync 时刷新。
//
// 合并：保存路径先写 config 再写 secrets → storage watch 连发两次。用 100ms
// 去抖合并成一次 sync；sync 内部总是先 teardown 旧的、再按当前 storage 重建，
// 幂等——中间态最多多一次快速重连，最终态永远等于落盘配置。

import {
  lastSelectedModel,
  lastSelectedThinkingLevel,
  telegramGatewayConfig,
  telegramGatewaySecrets,
} from '@/lib/persistence/storage';
import { getAssistantText } from '@/lib/agent/message-helpers';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { BroadcastMessage, ServerMessage } from '@/lib/ipc/protocol';
import { sessionManager } from '../chat/session-manager';
import { sessionStore } from '../chat/session-store';
import { onBroadcastTap } from '../chat/viewers';
import { onPortConnect, post } from '../ipc/port-registry';
import { telegramGatewayChannel } from '@/lib/telegram-gateway/channel';
import { splitReply } from '@/lib/telegram-gateway/message-split';
import { getToolLabel } from '@/lib/tools/labels';
import {
  bootstrapTelegramGateway,
  type BootstrapHandle,
} from '@/lib/telegram-gateway/bootstrap';
import type { InboundMessage } from '@/lib/telegram-gateway/types';
import { TELEGRAM_TITLE_PREFIX } from '@/lib/telegram-gateway/session-title';

let handle: BootstrapHandle | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** interactiveMode 的 BG 侧镜像——每次 sync 随配置刷新，dispatch 入口把关。 */
let interactiveMode = false;
/** 每 session 的串行队列（Promise 链尾）。burst 消息逐条排队，不丢。 */
const sessionQueues = new Map<string, Promise<void>>();
/** 每 Telegram session 的 turn 計數——sliding window 的觸發依據。 */
const telegramTurnCounts = new Map<string, number>();

// ─── Inbound turn 的 UX 生命周期状态（reaction + typing keepalive）───

// Reaction 生命周期 emoji（Step-Progress：等待 👀 → 完成 👌 / 失败 ❌）。
// 动画由 Telegram client 原生渲染（relay 侧 is_big），运行期间零 edit 调用。
const REACTION_THINKING = '👀';
const REACTION_DONE = '👌';
const REACTION_ERROR = '❌';
// 工具狀態行的 edit 節流（editMessageText ~1/s per chat → 2.75s trailing 窗口）
const TOOL_STATUS_THROTTLE_MS = 2_750;
// Telegram typing 状态 ~5s 自动过期 → 4s 续发
const TYPING_INTERVAL_MS = 4_000;
// Sliding window：每 N 个 turn 触发 compaction，把舊語境摘要化、LLM context
// 回到短狀態（Telegram 對話保持快速回應）。
const TELEGRAM_MAX_TURNS = 5;

/** 一个进行中的 Telegram turn 的 UX 状态。session 结束 / gateway 拆除时清理。 */
interface TelegramTurnState {
  sessionId: string;
  chatId: number;
  /** 用户消息的 message_id——reaction 的锚点 + finalize Block 1 的 reply_to。 */
  userMessageId: number;
  typingTimer: ReturnType<typeof setInterval> | null;
  // ─── 工具狀態行（Step-Progress：首個 tool 到達時建立，finalize / abort 刪除）───
  /** 狀態行 message_id；null = 尚未發出。首發失敗 → statusDead，本輪不再嘗試。 */
  statusMessageId: number | null;
  statusDead: boolean;
  /** 首發在途標記——回執未到時的後續 tool_pending 只更新 pendingStatusText。 */
  statusSendInFlight: boolean;
  statusThrottleTimer: ReturnType<typeof setTimeout> | null;
  pendingStatusText: string | null;
  /** 狀態行當前文本——label 未變化時跳過 edit（'message is not modified' 預防）。 */
  lastSentStatus: string;
}

/** sessionId → 进行中的 turn。agent_end / teardown 时清理。 */
const activeTurns = new Map<string, TelegramTurnState>();

/** 为 inbound turn 建 UX 状态：在用户消息上贴 👀 reaction（client 原生动画）
 *  + 启动 4s typing 续发。不再发送任何占位消息——运行期间聊天窗零打扰。 */
function startTurnUx(msg: InboundMessage, sessionId: string): void {
  const state: TelegramTurnState = {
    sessionId,
    chatId: msg.chat_id,
    userMessageId: msg.message_id,
    typingTimer: null,
    statusMessageId: null,
    statusDead: false,
    statusSendInFlight: false,
    statusThrottleTimer: null,
    pendingStatusText: null,
    lastSentStatus: '',
  };
  activeTurns.set(sessionId, state);
  const gateway = handle;
  if (!gateway) return;
  void gateway.client
    .sendOutbound({
      kind: 'setMessageReaction',
      request_id: crypto.randomUUID(),
      chat_id: msg.chat_id,
      message_id: msg.message_id,
      emoji: REACTION_THINKING,
    })
    .catch(() => {});
  void gateway.client
    .sendOutbound({
      kind: 'sendChatAction',
      request_id: crypto.randomUUID(),
      chat_id: msg.chat_id,
      action: 'typing',
    })
    .catch(() => {});
  state.typingTimer = setInterval(() => {
    // 每次触发重读 handle——排队期间 gateway 被拆除则静默跳过。
    const h = handle;
    if (!h) return;
    void h.client
      .sendOutbound({
        kind: 'sendChatAction',
        request_id: crypto.randomUUID(),
        chat_id: msg.chat_id,
        action: 'typing',
      })
      .catch(() => {});
  }, TYPING_INTERVAL_MS);
}

/** FNV-1a 32-bit（多个不同 seed 派生 128 位）。仅作稳定标识，非安全哈希。 */
function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 从 chat_id 派生确定性 session id（128-bit，v5 UUID 形状）：同 chat 永远同一
 * session（跨 SW 重启稳定），且通过 UUID-only 的 session id 不变量（backup /
 * delegate_task / run_skill 的所有 gate）。识别靠「Telegram ·」标题，不靠 id。
 * 同步派生——dispatch 路径没有 real-macrotask 依赖，测试时序确定性。
 */
export function telegramSessionId(chatId: number): string {
  const key = `telegram:${chatId}`;
  const hex = [0x811c9dc5, 0x2545f491, 0x9e3779b9, 0x85ebca6b]
    .map((seed) => fnv1a(key, seed).toString(16).padStart(8, '0'))
    .join('');
  // v5 UUID 形状：第 3 组首字符 = 版本位 5；第 4 组首字符 = RFC 4122 variant。
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 读当前落盘配置，重建 / 拆除 bootstrap。总是先拆旧再建新（幂等）。 */
async function syncGateway(): Promise<void> {
  const [config, secrets] = await Promise.all([
    telegramGatewayConfig.getValue(),
    telegramGatewaySecrets.getValue(),
  ]);
  const url = config.workerUrl.trim();
  const token = secrets[0]?.wsAuthToken.trim() ?? '';
  interactiveMode = config.interactiveMode;

  if (handle) {
    handle.teardown();
    handle = null;
    // 拆线后立刻把状态归位——旧客户端的事件不再来，徽章不该停在旧状态。
    telegramGatewayChannel.publishStatus('disconnected');
  }
  // gateway 拆除 → 进行中 turn 的 timer（typing 续发）一并清理；👀 reaction
  // 留在用户消息上成为静默残留（Telegram client 行为，API 无法回收）。turn
  // 状态一并丢弃——agent_end 晚到也无人收尾。sliding window 計數也歸零。
  for (const state of activeTurns.values()) {
    clearTurnTimers(state);
    // 置 statusDead：首發在途時被拆除的話，遲到的回執自刪狀態行（best-effort，
    // 走正在 drain 的舊 client）——不留孤兒狀態行
    state.statusDead = true;
  }
  activeTurns.clear();
  telegramTurnCounts.clear();

  if (url.length === 0 || token.length === 0) return;

  handle = bootstrapTelegramGateway({ url, token });
  console.log('[Telegram Gateway] Connecting to:', url);
  // Inbound dispatch：在 bootstrap 自己的 broadcastAll 订阅之外，再挂一个
  // listener 跑 session 隔离路由（两个订阅互不干扰，Set 结构天然共存）。
  // 返回 turn Promise 供测试 await（worker-client 忽略返回值）。
  handle.client.onMessage((msg) => dispatchInbound(msg));
}

function scheduleSync(): void {
  if (syncTimer !== null) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncGateway().catch((err) => {
      console.warn('[telegram-gateway] sync failed:', err);
    });
  }, 100);
}

/** 取 messages 里最后一条带文本的 assistant 消息（agent 常常先出 tool calls
 *  再出最终文本——从尾部向前找，跳过纯 tool-call 的 assistant 块）。messages
 *  是第三方 AgentMessage[]，role/content 按结构窄化，不引入完整类型依赖。 */
function lastAssistantText(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!m || m.role !== 'assistant') continue;
    const text = getAssistantText(m as AssistantMessage).trim();
    if (text.length > 0) return text;
  }
  return null;
}

/**
 * 入口：计算确定性 sessionId → 排进该 session 的串行队列。返回该 turn 的
 * Promise（等整个 turn 跑完）——worker-client 忽略返回值（fire-and-forget），
 * 测试则 await 它获得确定性时序。
 */
async function dispatchInbound(msg: InboundMessage): Promise<void> {
  if (!interactiveMode) return;
  if (!handle) {
    console.warn('[telegram-gateway] WS not connected — inbound dropped');
    return;
  }
  const sessionId = telegramSessionId(msg.chat_id);
  // UX 狀態（typing + 佔位消息）在 runTelegramTurn 開始時才建——每個排隊的
  // turn 有自己的完整生命週期。dispatch 時不建，避免 burst 時 state 被覆蓋。
  const prev = sessionQueues.get(sessionId) ?? Promise.resolve();
  const job = prev
    .then(() => runTelegramTurn(sessionId, msg))
    .then(() => maybeCompactTelegramSession(sessionId))
    .catch((err) => console.warn('[telegram-gateway] turn failed:', err));
  sessionQueues.set(sessionId, job);
  void job.then(() => {
    if (sessionQueues.get(sessionId) === job) sessionQueues.delete(sessionId);
  });
  return job;
}

/**
 * 一个完整的 Telegram turn：确保 session 行 → 跑 agent。回复的发送不再在此——
 * agent_end（经 broadcast tap）触发 finalizeTurn 完成 reaction 收尾 / 分块落位。
 */
async function runTelegramTurn(sessionId: string, msg: InboundMessage): Promise<void> {
  // Re-arm UX per turn：每個排隊的訊息在實際開始執行時建自己的 UX 生命週期
  // （fresh reaction + typing keepalive）。前一個 turn 的 agent_end 已清理
  // 前一個 state，此處建立的是本輪專屬的。
  startTurnUx(msg, sessionId);
  // 确保 session 行存在（带「Telegram ·」识别标题）。prompt() 也会建——但用
  // heuristic 标题且会触发 auto title-gen；这里预建则 prompt() 看到 existing
  // 直接跳过，标题稳定不被覆盖。竞态（burst 首跑并发）：撞 already_exists
  // 时重读一次，行在就继续。
  try {
    const existing = await sessionStore.load(sessionId);
    if (!existing) {
      const [globalModel, globalThinking] = await Promise.all([
        lastSelectedModel.getValue(),
        lastSelectedThinkingLevel.getValue(),
      ]);
      if (!globalModel) {
        console.warn('[telegram-gateway] no model configured — cannot run Telegram agent');
        abortTurnUx(sessionId);
        return;
      }
      const name = msg.from?.username ? `@${msg.from.username}` : String(msg.chat_id);
      await sessionStore.create({
        id: sessionId,
        title: `${TELEGRAM_TITLE_PREFIX}${name}`,
        model: globalModel.modelId,
        provider: globalModel.provider,
        userInstructions: '',
        thinkingLevel: globalThinking || 'medium',
      });
    }
  } catch (err) {
    const still = await sessionStore.load(sessionId).catch(() => null);
    if (!still) {
      console.warn('[telegram-gateway] ensure session failed:', err);
      abortTurnUx(sessionId);
      return;
    }
  }

  try {
    // prompt() await 整个 agent run（含全部 tool 轮）——串行队列保证此刻没有
    // 并发 run，不会撞 pi-agent-core 的「already processing」。
    await sessionManager.prompt(sessionId, msg.text);
  } catch (err) {
    console.warn('[telegram-gateway] prompt failed:', err);
    abortTurnUx(sessionId);
    return;
  }
}

/** 清理 turn 的 timers（typing 续发 / 工具狀態行 edit 節流）。 */
function clearTurnTimers(state: TelegramTurnState): void {
  if (state.typingTimer !== null) {
    clearInterval(state.typingTimer);
    state.typingTimer = null;
  }
  if (state.statusThrottleTimer !== null) {
    clearTimeout(state.statusThrottleTimer);
    state.statusThrottleTimer = null;
  }
  state.pendingStatusText = null;
}

/** 刪掉工具狀態行（正式回覆落位 / turn 中止時的收尾——聊天窗不留作業殘渣）。
 *  置 statusDead：遲到的首發回執見此標記會自刪（見 scheduleToolStatus 的 .then）。 */
function deleteStatusMessage(state: TelegramTurnState): void {
  if (state.statusThrottleTimer !== null) {
    clearTimeout(state.statusThrottleTimer);
    state.statusThrottleTimer = null;
  }
  state.pendingStatusText = null;
  const id = state.statusMessageId;
  state.statusMessageId = null;
  state.statusDead = true;
  if (id === null) return;
  void handle?.client
    .sendOutbound({
      kind: 'deleteMessage',
      request_id: crypto.randomUUID(),
      chat_id: state.chatId,
      message_id: id,
    })
    .catch(() => {});
}

/**
 * Turn 无法继续（无模型 / session 行缺失 / prompt 抛错）：清掉 typing timer，
 * 用户消息上的 reaction 换成 ❌——失败可见、聊天窗依然零打扰（不再发
 * 「⚠️ Agent error」占位文本）。state 留在表里——迟到的 agent_end 广播仍能收尾。
 */
function abortTurnUx(sessionId: string): void {
  const state = activeTurns.get(sessionId);
  if (!state) return;
  clearTurnTimers(state);
  void handle?.client
    .sendOutbound({
      kind: 'setMessageReaction',
      request_id: crypto.randomUUID(),
      chat_id: state.chatId,
      message_id: state.userMessageId,
      emoji: REACTION_ERROR,
    })
    .catch(() => {});
  deleteStatusMessage(state);
}

/**
 * 工具狀態行（Step-Progress）：第一個 tool_pending 到達時發出一條**靜默**狀態
 * 消息（`🔧 <label>...`）——即時確認「系統在做事、在做什麼」；後續 tool 切換以
 * trailing 窗口（TOOL_STATUS_THROTTLE_MS）就地 edit，多步 ReAct 鏈每步有名有姓、
 * 又不刷屏。agent_end / abort 時整行刪除——正式回覆落位後聊天窗乾淨。
 * 首發失敗（relay 舊 / 網路斷）→ statusDead，本輪不再嘗試；finalize 的回覆路徑
 * 與此獨立，照常送達。
 */
function scheduleToolStatus(state: TelegramTurnState, label: string): void {
  if (state.statusDead) return;
  const text = `🔧 ${label}...`;
  if (state.statusMessageId === null) {
    if (state.statusSendInFlight) {
      // 首發在途：只記最新文本——回執到達後若已變化，補一次節流 edit
      state.pendingStatusText = text;
      return;
    }
    const gateway = handle;
    if (!gateway) return;
    state.statusSendInFlight = true;
    state.lastSentStatus = text;
    void gateway.client
      .sendOutbound({
        kind: 'sendMessage',
        request_id: crypto.randomUUID(),
        chat_id: state.chatId,
        text,
        disable_notification: true,
      })
      .then((result) => {
        state.statusSendInFlight = false;
        if (!(result.kind === 'sendMessage_result' && result.ok)) {
          state.statusDead = true;
          return;
        }
        if (state.statusDead) {
          // 收尾（finalize / abort）已跑过而回执迟到：消息刚落地就得删——不留孤儿
          void gateway.client
            .sendOutbound({
              kind: 'deleteMessage',
              request_id: crypto.randomUUID(),
              chat_id: state.chatId,
              message_id: result.message_id,
            })
            .catch(() => {});
          return;
        }
        state.statusMessageId = result.message_id;
        if (state.pendingStatusText !== null && state.pendingStatusText !== text) {
          const pending = state.pendingStatusText;
          state.pendingStatusText = null;
          scheduleStatusEdit(state, pending);
        }
      })
      .catch(() => {
        state.statusSendInFlight = false;
        state.statusDead = true;
      });
    return;
  }
  scheduleStatusEdit(state, text);
}

/** 節流 edit 狀態行：窗口內合併為最新文本；label 未變化時跳過。 */
function scheduleStatusEdit(state: TelegramTurnState, text: string): void {
  if (text === state.lastSentStatus) return;
  state.pendingStatusText = text;
  if (state.statusThrottleTimer !== null) return;
  const gateway = handle;
  if (!gateway) return;
  state.statusThrottleTimer = setTimeout(() => {
    state.statusThrottleTimer = null;
    const pending = state.pendingStatusText;
    state.pendingStatusText = null;
    if (
      pending === null ||
      pending === state.lastSentStatus ||
      state.statusMessageId === null
    ) {
      return;
    }
    state.lastSentStatus = pending;
    void gateway.client
      .sendOutbound({
        kind: 'editMessage',
        request_id: crypto.randomUUID(),
        chat_id: state.chatId,
        message_id: state.statusMessageId,
        text: pending,
      })
      .catch(() => {});
  }, TOOL_STATUS_THROTTLE_MS);
}

/**
 * agent_end：清 timers + 换 reaction（👀 → 👌 / ❌），把最终回复写回 Telegram
 * （首段锚点模型的 finalize）——splitReply 把回复切成「完整第一段 + ≤2000 的
 * 段落分组块」：Block 1 以 reply_to 回链用户消息（Markdown → plain → 无 reply
 * 三级兜底，保证送达），Block 2+ 静默补发（关 link preview）。运行期间聊天窗
 * 零打扰，finalize 每块仅 1-2 次调用。
 */
async function finalizeTurn(state: TelegramTurnState, messages: BroadcastMessage[]): Promise<void> {
  clearTurnTimers(state);
  activeTurns.delete(state.sessionId);

  const gateway = handle;
  if (!gateway) return;

  // run 失败（合成 assistant 带 stopReason error/aborted）→ reaction 换 ❌，
  // 不回退发旧文本（避免重复回复）。
  const last = messages[messages.length - 1] as
    | { role?: string; stopReason?: string }
    | undefined;
  const failed =
    last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted');
  void gateway.client
    .sendOutbound({
      kind: 'setMessageReaction',
      request_id: crypto.randomUUID(),
      chat_id: state.chatId,
      message_id: state.userMessageId,
      emoji: failed ? REACTION_ERROR : REACTION_DONE,
    })
    .catch(() => {});
  // 工具狀態行收尾：先刪——正式回覆隨後落地，聊天窗不留作業殘渣
  //（relay 舊不支援 deleteMessage 時靜默失敗，狀態行殘留為已知取捨）。
  deleteStatusMessage(state);
  if (failed) return;

  const text = lastAssistantText(messages);
  if (!text) return;

  const blocks = splitReply(text);
  const sendBlock = async (
    chunk: string,
    opts: { replyTo?: boolean; useMarkdown: boolean },
  ): Promise<boolean> => {
    const result = await gateway.client.sendOutbound({
      kind: 'sendMessage',
      request_id: crypto.randomUUID(),
      chat_id: state.chatId,
      text: chunk,
      ...(opts.replyTo ? { reply_to_message_id: state.userMessageId } : {}),
      ...(opts.useMarkdown ? { parse_mode: 'Markdown' as const } : {}),
      // Block 2+（无 reply）：静默 + 关 link preview——多块不刷通知 / 预览卡
      ...(!opts.replyTo
        ? { disable_notification: true, disable_link_preview: true }
        : {}),
    });
    return result.kind === 'sendMessage_result' && result.ok;
  };

  try {
    // Block 1：reply_to 用户消息，三级兜底保证送达（Markdown → plain → 无 reply）
    const first = blocks[0]!;
    if (!(await sendBlock(first, { replyTo: true, useMarkdown: true }))) {
      if (!(await sendBlock(first, { replyTo: true, useMarkdown: false }))) {
        await sendBlock(first, { useMarkdown: false });
      }
    }
    // Block 2+：静默补发，Markdown 失败退 plain
    for (const block of blocks.slice(1)) {
      if (!(await sendBlock(block, { useMarkdown: true }))) {
        await sendBlock(block, { useMarkdown: false });
      }
    }
  } catch (err) {
    console.warn('[telegram-gateway] finalize failed:', err);
  }
}

/**
 * Sliding window：每 TELEGRAM_MAX_TURNS 個 turn 觸發一次 compaction，把舊語境
 * 摘要化、LLM context 回到短狀態。觸發時機在 prompt 完成後（serial queue 尾端），
 * 下一條訊息自然排在 compaction 完成之後。
 */
async function maybeCompactTelegramSession(sessionId: string): Promise<void> {
  const count = (telegramTurnCounts.get(sessionId) ?? 0) + 1;
  telegramTurnCounts.set(sessionId, count);
  if (count < TELEGRAM_MAX_TURNS) return;
  telegramTurnCounts.delete(sessionId);
  console.log('[telegram-gateway] sliding window: compacting after', count, 'turns');
  await sessionManager.compactNow(sessionId);
}

/** Broadcast tap 的 handler：只关心本侧 telegram session 的 agent_end
 *  （Step-Progress + reaction 模型：运行期间不打扰聊天窗——reaction / typing
 *  已在 startTurnUx 布好，唯一动作是 agent_end 收尾落位完整回复）。 */
function handleTurnBroadcast(msg: ServerMessage): void {
  const state =
    'sessionId' in msg && typeof msg.sessionId === 'string'
      ? activeTurns.get(msg.sessionId)
      : undefined;
  if (!state) return;
  switch (msg.type) {
    case 'agent_end':
      void finalizeTurn(state, msg.messages);
      break;
    default:
      // stream_ops / agent_start / message_end / session_* —— UX 不需要
      //（tool_pending 走上方 case）
      break;
  }
}

/** 由 `entrypoints/background/index.ts` 启动序列调用。幂等注册（watch 重复挂
 *  只会多触发几次合并后的 sync，无副作用），正常启动只调一次。 */
export function setupTelegramGatewayManager(): void {
  telegramGatewayConfig.watch(() => scheduleSync());
  telegramGatewaySecrets.watch(() => scheduleSync());
  scheduleSync();
  // Broadcast tap：观察 telegram session 的 agent_end（收尾落位完整回复）。
  // Step-Progress 的工具狀態行走 sessionManager.onToolExecution tap——
  // `tool_pending` 广播只涵盖交互式工具（ask-user / permission bridge），
  // 普通工具根本不经过 InteractiveBridge（曾因此状态行永不出现）。
  onBroadcastTap((msg) => handleTurnBroadcast(msg));
  // 工具狀態行：Telegram session 的 agent 每開始執行一個 tool 就更新
  sessionManager.onToolExecution((sessionId, toolName, args) => {
    const state = activeTurns.get(sessionId);
    if (state) {
      scheduleToolStatus(state, getToolLabel(toolName, args as Record<string, any> | undefined));
    }
  });
  // First-frame push：sidepanel 的 channel 单例初始值是 'disconnected'。若 WS
  // 在 port 建立之前就连上了，之后没有新的状态变化事件可广播，徽章会永远停在
  // 灰。port 一接入就把当前真实状态发给它——canvas（canvas_state）/ recorder
  // （首帧）都有同款机制，telegram 此前漏了这一环。
  onPortConnect((port) => {
    post(port, {
      type: 'telegram_gateway_status',
      status: handle?.client.getStatus() ?? 'disconnected',
    });
  });
}

/** 取出当前持有的 bootstrap 句柄（client-handlers 的 `telegram_gateway_send`
 *  需要它来转发 UI 的回复）。未配置 / 未同步时返回 null。 */
export function getBootstrapHandle(): BootstrapHandle | null {
  return handle;
}

/** 主动触发一次 sync（不等 watch 节流）。`telegram_gateway_config_set` handler
 *  保存成功后调一下——确保用户点 Save 那一瞬间就发起 WS 连接，而不是等
 *  storage watch + 100ms 去抖。读到的值与 Save 写入的完全一致。 */
export function triggerTelegramGatewaySync(): void {
  scheduleSync();
}
