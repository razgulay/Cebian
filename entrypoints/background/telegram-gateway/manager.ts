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
import { applyStreamOps } from '@/lib/agent/stream-replica';
import { getToolLabel } from '@/lib/tools/labels';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { BroadcastMessage, ServerMessage } from '@/lib/ipc/protocol';
import { sessionManager } from '../chat/session-manager';
import { sessionStore } from '../chat/session-store';
import { onBroadcastTap } from '../chat/viewers';
import { onPortConnect, post } from '../ipc/port-registry';
import { telegramGatewayChannel } from '@/lib/telegram-gateway/channel';
import {
  bootstrapTelegramGateway,
  type BootstrapHandle,
} from '@/lib/telegram-gateway/bootstrap';
import type { InboundMessage } from '@/lib/telegram-gateway/types';

let handle: BootstrapHandle | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** interactiveMode 的 BG 侧镜像——每次 sync 随配置刷新，dispatch 入口把关。 */
let interactiveMode = false;
/** 每 session 的串行队列（Promise 链尾）。burst 消息逐条排队，不丢。 */
const sessionQueues = new Map<string, Promise<void>>();
/** 每 Telegram session 的 turn 計數——sliding window 的觸發依據。 */
const telegramTurnCounts = new Map<string, number>();

// ─── Inbound turn 的 UX 生命周期状态（typing keepalive / placeholder / 流式编辑）───

const THINKING_PLACEHOLDER = '🤔 Thinking…';
// Telegram typing 状态 ~5s 自动过期 → 4s 续发
const TYPING_INTERVAL_MS = 4_000;
// editMessageText ~1 req/s per chat → 1.5s 节流
const EDIT_THROTTLE_MS = 1_500;
// Telegram message 上限 4096 → 留余量
const EDIT_CHUNK_LIMIT = 4000;
// Sliding window：每 N 个 turn 触发 compaction，把舊語境摘要化、LLM context
// 回到短狀態（Telegram 對話保持快速回應）。
const TELEGRAM_MAX_TURNS = 5;

/** 一个进行中的 Telegram turn 的 UX 状态。session 结束 / gateway 拆除时清理。 */
interface TelegramTurnState {
  sessionId: string;
  chatId: number;
  /** sendMessage('🤔 Thinking…') 的 message_id——所有 edit 的锚点。null = 尚未回执。 */
  placeholderId: number | null;
  /** placeholder 被删 / 编辑通道硬失败后置 false——后续 edit 全部跳过。 */
  placeholderAlive: boolean;
  typingTimer: ReturnType<typeof setInterval> | null;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  /** 流式副本（与 UI 同一 applyStreamOps 语义，每 turn 从空开始）。 */
  replica: BroadcastMessage[];
  /** placeholder 当前展示的文本——避免 editMessage 未变更时重复调用。 */
  lastSentText: string;
  /** 节流窗口内挂起待发的文本。 */
  pendingEditText: string | null;
  /** 上一次 edit 的时间戳——节流窗口的相位基准。 */
  lastEditAt: number;
}

/** sessionId → 进行中的 turn。agent_end / teardown 时清理。 */
const activeTurns = new Map<string, TelegramTurnState>();

/** 为 inbound turn 建 UX 状态：立刻发 typing + 占位消息，并启动 4s typing 续发。 */
function startTurnUx(msg: InboundMessage, sessionId: string): void {
  const state: TelegramTurnState = {
    sessionId,
    chatId: msg.chat_id,
    placeholderId: null,
    placeholderAlive: true,
    typingTimer: null,
    throttleTimer: null,
    replica: [],
    lastSentText: '',
    pendingEditText: null,
    lastEditAt: 0,
  };
  activeTurns.set(sessionId, state);
  const gateway = handle;
  if (!gateway) return;
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
  // 占位消息：拿到 message_id 回执后，后续 edit 才有锚点。
  void gateway.client
    .sendOutbound({
      kind: 'sendMessage',
      request_id: crypto.randomUUID(),
      chat_id: msg.chat_id,
      text: THINKING_PLACEHOLDER,
    })
    .then((result) => {
      if (result.kind === 'sendMessage_result' && result.ok) {
        state.placeholderId = result.message_id;
      } else {
        state.placeholderAlive = false;
      }
    })
    .catch(() => {
      state.placeholderAlive = false;
    });
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
  // gateway 拆除 → 进行中 turn 的 timer 一并清理（编辑发不出去，占位停在
  // 最后一帧；下次 Save / 重启时重建）。sliding window 計數也歸零。
  for (const state of activeTurns.values()) {
    clearTurnTimers(state);
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
 * agent_end（经 broadcast tap）触发 finalizeTurn 完成占位编辑 / 拆分发送。
 */
async function runTelegramTurn(sessionId: string, msg: InboundMessage): Promise<void> {
  // Re-arm UX per turn：每個排隊的訊息在實際開始執行時建自己的 UX 生命週期
  // （fresh placeholder + typing keepalive）。前一個 turn 的 agent_end 已清理
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
        return;
      }
      const name = msg.from?.username ? `@${msg.from.username}` : String(msg.chat_id);
      await sessionStore.create({
        id: sessionId,
        title: `Telegram · ${name}`,
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
      return;
    }
  }

  try {
    // prompt() await 整个 agent run（含全部 tool 轮）——串行队列保证此刻没有
    // 并发 run，不会撞 pi-agent-core 的「already processing」。
    await sessionManager.prompt(sessionId, msg.text);
  } catch (err) {
    console.warn('[telegram-gateway] prompt failed:', err);
    // prompt 抛错（模型不可用等）→ 占位改成失败标记，避免永远停在 Thinking。
    const state = activeTurns.get(sessionId);
    if (state?.placeholderAlive && state.placeholderId !== null) {
      void handle?.client
        .sendOutbound({
          kind: 'editMessage',
          request_id: crypto.randomUUID(),
          chat_id: msg.chat_id,
          message_id: state.placeholderId,
          text: '⚠️ Agent error',
        })
        .catch(() => {});
    }
    return;
  }
}

/** 清理 turn 的 timers（typing 续发 / 节流编辑）。 */
function clearTurnTimers(state: TelegramTurnState): void {
  if (state.typingTimer !== null) {
    clearInterval(state.typingTimer);
    state.typingTimer = null;
  }
  if (state.throttleTimer !== null) {
    clearTimeout(state.throttleTimer);
    state.throttleTimer = null;
  }
  state.pendingEditText = null;
}

/**
 * 节流编辑：1.5s trailing 窗口，把 pendingEditText 经 editMessage 发出
 * （不带 parse_mode——流式进行中 markdown 未闭合会 400）。同一窗口合并多次
 * 触发；文本未变化时跳过（'message is not modified' 的客户端预防）。
 */
function scheduleEdit(state: TelegramTurnState, text: string): void {
  if (!state.placeholderAlive || state.placeholderId === null) return;
  if (text === state.lastSentText) return;
  state.pendingEditText = text;
  if (state.throttleTimer !== null) return;
  const gateway = handle;
  if (!gateway) return;
  const since = Date.now() - state.lastEditAt;
  state.throttleTimer = setTimeout(
    () => {
      state.throttleTimer = null;
      const pending = state.pendingEditText;
      state.pendingEditText = null;
      if (
        pending === null ||
        pending === state.lastSentText ||
        !state.placeholderAlive ||
        state.placeholderId === null
      ) {
        return;
      }
      state.lastSentText = pending;
      state.lastEditAt = Date.now();
      void gateway.client
        .sendOutbound({
          kind: 'editMessage',
          request_id: crypto.randomUUID(),
          chat_id: state.chatId,
          message_id: state.placeholderId,
          text: pending,
        })
        .catch(() => {});
    },
    Math.max(0, EDIT_THROTTLE_MS - since),
  );
}

/**
 * agent_end：清 timers，并把最终回复写回 Telegram——≤4000 编辑占位
 * （Markdown，失败退 plain）；>4000 首段编辑占位、余段逐条 sendMessage
 * （末段 Markdown，失败退 plain）。
 */
async function finalizeTurn(state: TelegramTurnState, messages: BroadcastMessage[]): Promise<void> {
  clearTurnTimers(state);
  activeTurns.delete(state.sessionId);

  const gateway = handle;
  if (!gateway || !state.placeholderAlive || state.placeholderId === null) return;

  // run 失败（合成 assistant 带 stopReason error/aborted）→ 占位改成失败标记，
  // 不回退发旧文本（避免重复回复）。
  const last = messages[messages.length - 1] as
    | { role?: string; stopReason?: string }
    | undefined;
  if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) {
    void gateway.client
      .sendOutbound({
        kind: 'editMessage',
        request_id: crypto.randomUUID(),
        chat_id: state.chatId,
        message_id: state.placeholderId,
        text: '⚠️ Agent failed',
      })
      .catch(() => {});
    return;
  }

  const text = lastAssistantText(messages);
  if (!text) return;

  const chunks = text.length > EDIT_CHUNK_LIMIT
    ? [text.slice(0, EDIT_CHUNK_LIMIT), ...splitRemainder(text.slice(EDIT_CHUNK_LIMIT), EDIT_CHUNK_LIMIT)]
    : [text];
  const editChunk = async (chunk: string, useMarkdown: boolean): Promise<boolean> => {
    const result = await gateway.client.sendOutbound({
      kind: 'editMessage',
      request_id: crypto.randomUUID(),
      chat_id: state.chatId,
      message_id: state.placeholderId!,
      text: chunk,
      ...(useMarkdown ? { parse_mode: 'Markdown' as const } : {}),
    });
    return result.ok;
  };
  const sendChunk = async (chunk: string, useMarkdown: boolean): Promise<boolean> => {
    const result = await gateway.client.sendOutbound({
      kind: 'sendMessage',
      request_id: crypto.randomUUID(),
      chat_id: state.chatId,
      text: chunk,
      ...(useMarkdown ? { parse_mode: 'Markdown' as const } : {}),
    });
    return result.ok;
  };

  try {
    // 首段：编辑占位（Markdown，失败退 plain）
    if (!(await editChunk(chunks[0]!, true))) {
      await editChunk(chunks[0]!, false);
    }
    // 余段：sendMessage 逐条补发（末段 Markdown，失败退 plain）
    for (let i = 1; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      if (!(await sendChunk(chunks[i]!, isLast))) {
        await sendChunk(chunks[i]!, false);
      }
    }
  } catch (err) {
    console.warn('[telegram-gateway] finalize failed:', err);
  }
}

/** Telegram >4000 拆分：按 limit 硬切（v1 不做段落边界回溯）。 */
function splitRemainder(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    chunks.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
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

/** Broadcast tap 的 handler：只关心本侧 telegram session 的事件
 *  （typing / tool 状态 / 流式文本编辑在 agent 跑期间驱动；agent_end 收尾）。 */
function handleTurnBroadcast(msg: ServerMessage): void {
  const state =
    'sessionId' in msg && typeof msg.sessionId === 'string'
      ? activeTurns.get(msg.sessionId)
      : undefined;
  if (!state) return;
  switch (msg.type) {
    case 'stream_ops': {
      state.replica = applyStreamOps(state.replica, msg.ops) ?? state.replica;
      const text = lastAssistantText(state.replica);
      if (text !== null) scheduleEdit(state, text);
      break;
    }
    case 'tool_pending':
      scheduleEdit(state, `🔧 ${getToolLabel(msg.toolName, msg.args)}…`);
      break;
    case 'agent_end':
      void finalizeTurn(state, msg.messages);
      break;
    default:
      // agent_start / message_end / session_* —— UX 不需要
      break;
  }
}

/** 由 `entrypoints/background/index.ts` 启动序列调用。幂等注册（watch 重复挂
 *  只会多触发几次合并后的 sync，无副作用），正常启动只调一次。 */
export function setupTelegramGatewayManager(): void {
  telegramGatewayConfig.watch(() => scheduleSync());
  telegramGatewaySecrets.watch(() => scheduleSync());
  scheduleSync();
  // Broadcast tap：观察 telegram session 的 agent 事件流（typing / tool 状态 /
  // 流式文本编辑在 agent 跑期间驱动；agent_end 收尾）。
  onBroadcastTap((msg) => handleTurnBroadcast(msg));
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
