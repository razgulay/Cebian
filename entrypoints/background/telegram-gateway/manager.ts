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
import { extractInlineImages } from '@/lib/telegram-gateway/inline-images';
import { getToolLabel } from '@/lib/tools/labels';
import { TOOL_ASK_USER } from '@/lib/tools/names';
import type { AskUserRequest } from '@/lib/tools/ask-user';
import {
  bootstrapTelegramGateway,
  type BootstrapHandle,
} from '@/lib/telegram-gateway/bootstrap';
import { createTelegramAskController } from './ask-user';
import { captureTabForTelegram } from './capture';
import type {
  AgentStateName,
  InboundMessage,
  InlineKeyboardMarkup,
  TelegramCallback,
} from '@/lib/telegram-gateway/types';
import { TELEGRAM_TITLE_PREFIX } from '@/lib/telegram-gateway/session-title';

let handle: BootstrapHandle | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** interactiveMode 的 BG 侧镜像——每次 sync 随配置刷新，dispatch 入口把关。 */
let interactiveMode = false;
/** 每 session 的串行队列（Promise 链尾）。burst 消息逐条排队，不丢。 */
const sessionQueues = new Map<string, Promise<void>>();
/** 每 Telegram session 的 turn 計數——sliding window 的觸發依據。 */
const telegramTurnCounts = new Map<string, number>();

// ─── ask_user → inline keyboard 频道适配（模块细节见 ./ask-user 头注释）───
// deps 包装：send 永不 reject（无 handle / WS reject 一律 resolve null ——
// AskDeps 的契约）；resolve/cancel 直通 sessionManager 公开接口；activeTurns
// 只含 Telegram session 进行中的 turn —— 自动隔离非 Telegram session（它们的
// ask_user 仍走 sidepanel 表单）。
const askController = createTelegramAskController({
  send: (action) =>
    handle
      ? handle.client.sendOutbound(action).catch(() => null)
      : Promise.resolve(null),
  resolveTool: (sessionId, response) =>
    sessionManager.resolveTool(sessionId, TOOL_ASK_USER, response),
  cancelTool: (sessionId) => sessionManager.cancelTool(sessionId, TOOL_ASK_USER),
  getActiveTurnChatId: (sessionId) => activeTurns.get(sessionId)?.chatId ?? null,
});

/** 发送 agent_state one-way frame（gateway `/status` 的数据源）。只在状态
 *  **转变**时调用（不按 timer）；WS 未连接时 sendState 静默丢弃。 */
function emitAgentState(chatId: number, state: AgentStateName, tool?: string): void {
  handle?.client.sendState({
    kind: 'agent_state',
    chat_id: chatId,
    state,
    ...(tool !== undefined ? { tool } : {}),
    ts: Date.now(),
  });
}

// ─── Inline-image 媒体分发常量 ───

/** Telegram 媒体 caption 硬限（Bot API：caption ≠ 文本消息的 4096 上限）。 */
const TELEGRAM_CAPTION_LIMIT = 1024;
/** sendMediaGroup 单组张数硬限（Bot API：2–10）。超出丢弃——单轮 >10 图本就异常。 */
const MEDIA_GROUP_MAX = 10;
/** 媒体发送（sendPhoto URL / sendMediaGroup）的回执上限。旧 relay 不认识新 action
 *  kind 时**静默丢弃**（不回任何 frame）→ pending promise 永不 resolve；超时把
 *  「永远挂着」变成「降级文本路径」。若 relay 实际已发出而回执迟到，会出现媒体 +
 *  fallback 文本并存的罕见重复——有界可接受（与 relay 竞态同类的已知取舍）。 */
const MEDIA_SEND_TIMEOUT_MS = 8_000;

/** 给一段 promise 套超时（manager 侧仅媒体回执使用；超时不取消底层发送）。 */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

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
// 回到短狀態（Telegram 對話保持快速回應）。15 是「短對話不受打擾、長對話仍會收斂」
// 的折中：門檻太低會讓幾輪閒聊也觸發一次摘要（每次都是額外一次 LLM 呼叫）。
const TELEGRAM_MAX_TURNS = 15;
// 工具狀態行動畫：1Hz 旋轉 emoji 前綴，遞歸 setTimeout 確保 tick 後只在
// 上一個 editMessageText 落定後才排下一個（防止 429 雪崩 + 避免請求堆疊）。
// cycle 順序：🔧 → ⚙️ → 🛠️ → 🔩。⚙️ (U+2699) 在 Unicode 11.0 之前是
// text-default codepoint——缺 U+FE0F 時舊系統 / 字型會 fallback 成黑白線稿，
// 這是必須顯式拼 FE0F 的那個；🛠️ (U+1F6E0) 自 Unicode 7.0 起已是 emoji-default，
// FE0F 屬防禦性冗餘，保留是為了讓 cycle 內兩個可帶 FE0F 的字形走同一條渲染
// 路徑、視覺一致。🔧 (U+1F527) / 🔩 (U+1F529) 本身即 emoji-default，不帶 FE0F。
const TOOL_STATUS_ANIMATION_INTERVAL_MS = 1_000;
const TOOL_STATUS_EMOJI_CYCLE: readonly string[] = [
  '🔧',             // U+1F527 WRENCH
  '⚙️',              // U+2699 GEAR + U+FE0F variation selector
  '🛠️',              // U+1F6E0 HAMMER AND WRENCH + U+FE0F
  '🔩',             // U+1F529 NUT AND BOLT
];

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
  // ─── 工具狀態行動畫（旋轉 emoji 前綴，1Hz；遞歸 setTimeout）───
  /** 動畫遞歸 timer；null = 未在跑。setTimeout 而非 setInterval，確保排隊下一個 tick
   *  必須等待上一個 sendOutbound().finally() 落定——避免慢網時並行請求堆疊撞 429。 */
  toolStatusAnimTimer: ReturnType<typeof setTimeout> | null;
  /** 動畫幀索引（指向 TOOL_STATUS_EMOJI_CYCLE）；label 切換不重置，emoji 連續。 */
  toolStatusAnimFrame: number;
  /** 當前 tool label——動畫 tick 用於 build 文本；label 切換時由 scheduleToolStatus 更新。 */
  currentToolLabel: string;
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
    toolStatusAnimTimer: null,
    toolStatusAnimFrame: 0,
    currentToolLabel: '',
  };
  activeTurns.set(sessionId, state);
  emitAgentState(msg.chat_id, 'thinking');
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
  // gateway 拆除 → ask_user 问答一并清场 + cancelTool（防 bridge 在 gateway
  // 关掉后永久悬挂；细节见 ask-user.ts 的 teardown 注释）。
  askController.teardown();
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

  if (url.length === 0 || token.length === 0 || config.enabled === false) return;

  handle = bootstrapTelegramGateway({ url, token });
  console.log('[Telegram Gateway] Connecting to:', url);
  // Inbound dispatch：在 bootstrap 自己的 broadcastAll 订阅之外，再挂一个
  // listener 跑 session 隔离路由（两个订阅互不干扰，Set 结构天然共存）。
  // 返回 turn Promise 供测试 await（worker-client 忽略返回值）。
  handle.client.onMessage((msg) => dispatchInbound(msg));
  // `/tabs` keyboard callback —— gateway 已 answer 过（Telegram 拒绝对同一
  // callback_query_id 的第二次 answer），这里只处理 content；worker-client
  // 忽略返回值。`au:` 前缀 = ask_user 问答键盘 → 适配层；其余（`cap_*`）走
  // /tabs 截图流程（行为原状）。
  handle.client.onTelegramCallback((msg) => {
    if (msg.data.startsWith('au:')) return askController.onCallback(msg);
    return dispatchTabsCallback(msg);
  });
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
  // `/tabs` 是用户显式命令 — 直接处理，不走 LLM，也不受 interactiveMode
  // gate（显式命令不走 LLM 路由：OFF interactive 时 utility command 依然可用；想让它
  // 也吃 gate 的话把下面两行移到 `if (!interactiveMode)` 之后即可）。
  // 接受 `/tabs`、`/t`（短别名 — Telegram autocomplete UX）、`/tabs@botname`
  // 三种形式；空白不匹配。
  if (/^\/(tabs|t)(@\S+)?\s*$/.test(msg.text.trim())) {
    return dispatchTabsCommand(msg);
  }
  // ask_user 问答拦截：✍️ 文本答案就地消费（true = 不往 agent 转发）；
  // keyboard pending 时的普通文本 = dismiss form（ask-user.ts 里 cancelTool
  // + ⏭ 确认），消息照常往下走。位置约束：在 /tabs 之后（命令不吃拦截）、
  // interactiveMode gate 之前（ask pending 期间即使刚关掉 interactive，
  // 在途答案仍须被消费——teardown 竞态窗口内 map 可能还活着）。
  if (await askController.interceptInbound(msg)) return;
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

// ─── `/tabs` command：inline keyboard → capture → sendPhoto ────────────────
// 流程见 plan「Flow 总体」。关键约束：gateway 在 forward telegram_callback
// 之前已经 answerCallbackQuery（Telegram 拒绝对同一个
// callback_query_id 的第二次 answer），所以本 cluster 里**没有任何 answer
// 调用**；全部用户反馈走 editMessageText。

/** `/tabs` keyboard 的一行输入 — 结构最小化，测试不需要 chrome types。
 *  字段 optional 以兼容 `chrome.tabs.Tab`（exactOptionalPropertyTypes 下
 *  `Tab.id?` 不能赋给必填的 `id: number | undefined`）。 */
export interface TabsKeyboardInput {
  id?: number | undefined;
  title?: string | null | undefined;
}

/** 纯函数：构建 inline keyboard（1 tab/row，最多 `max` 行，title 截断到
 *  ~48 chars 防止手机上溢出）。返回被截掉的 tab 数让调用者追加提示行。 */
export function buildTabsKeyboard(
  tabs: TabsKeyboardInput[],
  max = 10,
): { keyboard: InlineKeyboardMarkup['inline_keyboard']; overflow: number } {
  const usable = tabs.filter((t): t is TabsKeyboardInput & { id: number } => typeof t.id === 'number');
  const rows = usable.slice(0, max).map((t) => {
    const title = (t.title ?? '').trim() || '(untitled)';
    const clipped = title.length > 48 ? `${title.slice(0, 47)}…` : title;
    return [{ text: clipped, callback_data: `cap_${t.id}` }];
  });
  return { keyboard: rows, overflow: Math.max(0, usable.length - max) };
}

/** 纯函数：`cap_12345` → 12345；其它（旧 keyboard 残留 / 未知 payload）→ null。 */
export function parseTabCallbackData(data: string): number | null {
  if (!data.startsWith('cap_')) return null;
  const rest = data.slice(4);
  if (!/^\d+$/.test(rest)) return null;
  const id = Number(rest);
  return Number.isSafeInteger(id) ? id : null;
}

/** `/tabs` 命令处理：query 所有 tab → inline keyboard 发回同一个 chat。
 *  0 tab / query 失败都有兜底文案；keyboard 只在≥1 tab 时附带。 */
async function dispatchTabsCommand(msg: InboundMessage): Promise<void> {
  const gateway = handle;
  if (!gateway) {
    console.warn('[telegram-gateway] /tabs dropped — WS not connected');
    return;
  }
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await gateway.client
      .sendOutbound({
        kind: 'sendMessage',
        request_id: crypto.randomUUID(),
        chat_id: msg.chat_id,
        text: `⚠️ Không đọc được danh sách tab: ${message}`,
      })
      .catch((sendErr) => console.warn('[telegram-gateway] /tabs error sendMessage failed:', sendErr));
    return;
  }

  const { keyboard, overflow } = buildTabsKeyboard(tabs);
  let text = '🗂 Chọn tab để chụp màn hình:';
  if (keyboard.length === 0) {
    text = '🗂 Không có tab nào đang mở.';
  } else if (overflow > 0) {
    text = `🗂 Chọn tab để chụp màn hình (…và ${overflow} tab khác không hiển thị):`;
  }

  await gateway.client
    .sendOutbound({
      kind: 'sendMessage',
      request_id: crypto.randomUUID(),
      chat_id: msg.chat_id,
      text,
      reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    })
    .catch((err) => console.warn('[telegram-gateway] /tabs sendMessage failed:', err));
}

/** Inline-keyboard callback（`cap_<tabId>`）：capture → sendPhoto →
 *  editMessage 结果 + 清 keyboard。所有失败路径都收敛到 editMessage 错误
 *  文案 —— 没有任何 answer 路径（gateway 已代为 answer，extension 不可重复调用）。 */
async function dispatchTabsCallback(cb: TelegramCallback): Promise<void> {
  console.log('[telegram-gateway] /tabs callback received', {
    cb_id: cb.callback_query_id,
    chat_id: cb.chat_id,
    message_id: cb.message_id,
    data: cb.data,
  });
  const tabId = parseTabCallbackData(cb.data);
  if (tabId === null) {
    // 未知 callback payload —— gateway 已经 answer 过，这里静默丢弃即可。
    console.warn('[telegram-gateway] unsupported callback data:', cb.data);
    return;
  }
  const gateway = handle;
  if (!gateway) {
    console.warn('[telegram-gateway] /tabs callback dropped — WS gone (handle null)');
    return;
  }

  const editKeyboardMessage = async (text: string): Promise<void> => {
    await gateway.client
      .sendOutbound({
        kind: 'editMessage',
        request_id: crypto.randomUUID(),
        chat_id: cb.chat_id,
        message_id: cb.message_id,
        text,
        reply_markup: { inline_keyboard: [] },
      })
      .catch((err) => console.warn('[telegram-gateway] callback editMessage failed:', err));
  };

  // 开拍前先把 keyboard 消息改成「⏳ Đang chụp tab…」——一举三得：
  //  1. gateway 的 editMessage 分支会 **cancel 5s callback watchdog**——capture
  //     再慢（discarded tab 唤醒要 reload）也不会再出现「⚠️ Hết giờ chụp +
  //     照片随后才到」的自相矛盾组合（bug 3 的 root cause）；
  //  2. 不带 reply_markup → Bot API 保留原键盘；
  //  3. 用户即时看到「在拍了」，慢路径不再是黑洞。
  await gateway.client
    .sendOutbound({
      kind: 'editMessage',
      request_id: crypto.randomUUID(),
      chat_id: cb.chat_id,
      message_id: cb.message_id,
      text: '⏳ Đang chụp tab…',
    })
    .catch((err) => console.warn('[telegram-gateway] capture-start edit failed:', err));

  try {
    console.log('[telegram-gateway] /tabs capture start', { tabId });
    const { base64, title } = await captureTabForTelegram(tabId);
    console.log('[telegram-gateway] /tabs capture ok', { tabId, title, bytes: base64.length });
    const photo = await gateway.client.sendOutbound({
      kind: 'sendPhoto',
      request_id: crypto.randomUUID(),
      chat_id: cb.chat_id,
      image_base64: base64,
      caption: title || undefined,
      message_id: cb.message_id,
    });
    console.log('[telegram-gateway] /tabs sendPhoto reply', photo);
    if (photo.kind === 'gateway_result' && !photo.ok) {
      await editKeyboardMessage(`⚠️ Gửi ảnh thất bại: ${photo.error ?? 'unknown'}`);
      return;
    }
    await editKeyboardMessage(`✅ Đã chụp: ${title || `tab ${tabId}`}`);
  } catch (err) {
    console.warn('[telegram-gateway] /tabs capture failed (likely Extension context invalidated or capture throw):', err);
    await editKeyboardMessage(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Capture 任一 tab（含后台 / discarded）的实现已搬到 `./capture`（CDP
 *  `Page.captureScreenshot`——offscreen、不 activate、不抢焦点；旧
 *  captureVisibleTab 版本的完整约束注释随实现一并迁移）。 */

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

/** 清理 turn 的 timers（typing 续发 / 工具狀態行 edit 節流 / 動畫 timer）。 */
function clearTurnTimers(state: TelegramTurnState): void {
  if (state.typingTimer !== null) {
    clearInterval(state.typingTimer);
    state.typingTimer = null;
  }
  if (state.statusThrottleTimer !== null) {
    clearTimeout(state.statusThrottleTimer);
    state.statusThrottleTimer = null;
  }
  stopStatusAnimation(state);
  state.pendingStatusText = null;
}

/** 刪掉工具狀態行（正式回覆落位 / turn 中止時的收尾——聊天窗不留作業殘渣）。
 *  置 statusDead：遲到的首發回執見此標記會自刪（見 scheduleToolStatus 的 .then）。
 *  同時停掉動畫 timer——statusDead 後 runStatusAnimationFrame 不再排隊下一幀，
 *  此處主動 clearTimeout 雙保險（任何尚未觸發的下一幀回調直接取消）。 */
function deleteStatusMessage(state: TelegramTurnState): void {
  if (state.statusThrottleTimer !== null) {
    clearTimeout(state.statusThrottleTimer);
    state.statusThrottleTimer = null;
  }
  stopStatusAnimation(state);
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
 * 这条路径**不会**触发 agent_end 广播 → 必须在此显式发 idle：否则 gateway 的
 * agentStates 永远停在 thinking——45s 后 stall fire-gate 误报一次，且 /status
 * 对已死的 turn 谎报状态。
 */
function abortTurnUx(sessionId: string): void {
  const state = activeTurns.get(sessionId);
  if (!state) return;
  clearTurnTimers(state);
  emitAgentState(state.chatId, 'idle');
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
 * 工具狀態行（Step-Progress + 動畫）：第一個 tool_pending 到達時發出一條**靜默**狀態
 * 消息（emoji 來自 TOOL_STATUS_EMOJI_CYCLE 第 0 幀 + `<label>...`），即時確認
 * 「系統在做事、在做什麼」；後續 tool 切換以 trailing 窗口（TOOL_STATUS_THROTTLE_MS）
 * 就地 edit，多步 ReAct 鏈每步有名有姓又不刷屏。狀態行發出後啟動 1Hz 動畫 timer：
 * emoji 在 🔧 → ⚙️ → 🛠️ → 🔩 → 🔧 ... 循環，每秒一幀、遞歸 setTimeout 保證
 * 上一幀落定才排下一幀（防 429 + 並行請求覆蓋）。label 變更**不重置** frame 索引
 * ——emoji 在切換瞬間同字形短暫停在兩個 label 上（「🛠️ Reading file...」→「🛠️ Browsing web...」），
 * 視覺上像是同一個工具在「換目標」，比 emoji 從 0 重啟自然。agent_end / abort 時
 * 整行刪除——正式回覆落位後聊天窗乾淨。
 * 首發失敗（relay 舊 / 網路斷）→ statusDead，本輪不再嘗試；finalize 的回覆路徑
 * 與此獨立，照常送達。
 */
function scheduleToolStatus(state: TelegramTurnState, label: string): void {
  if (state.statusDead) return;
  state.currentToolLabel = label;
  const text = statusFrameText(label, state.toolStatusAnimFrame);
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
        // 狀態行落地 → 啟動 1Hz emoji 旋轉動畫（遞歸 setTimeout）。
        ensureStatusAnimation(state);
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

// ─── 工具狀態行動畫（遞歸 setTimeout：tick N+1 必須等 tick N 的 sendOutbound 落定）───

/** Build 一幀動畫文本：`<emoji> <label>...`。emoji 取自 cycle 第 `frame` 個元素。 */
function statusFrameText(label: string, frame: number): string {
  const cycle = TOOL_STATUS_EMOJI_CYCLE;
  const emoji = cycle[((frame % cycle.length) + cycle.length) % cycle.length]!;
  return `${emoji} ${label}...`;
}

/** 啟動動畫 timer（若未在跑）。遞歸：每個 tick 排下一個 setTimeout，**只在
 *  上一個 sendOutbound().finally() 落定後**才排隊下一個。setInterval 不可——慢網
 *  下累積並行的 editMessageText 請求會撞 429 + 在 chat 上互相覆蓋。 */
function ensureStatusAnimation(state: TelegramTurnState): void {
  if (state.toolStatusAnimTimer !== null) return;
  const scheduleNext = (): void => {
    state.toolStatusAnimTimer = setTimeout(() => {
      state.toolStatusAnimTimer = null;
      // 同步觸發一幀：sync 邏輯；async 部分（sendOutbound 落定後排下一個）
      // 在 .finally() 內完成。
      runStatusAnimationFrame(state, scheduleNext);
    }, TOOL_STATUS_ANIMATION_INTERVAL_MS);
  };
  scheduleNext();
}

/** 停掉動畫 timer。deleteStatusMessage / clearTurnTimers 都會調。 */
function stopStatusAnimation(state: TelegramTurnState): void {
  if (state.toolStatusAnimTimer !== null) {
    clearTimeout(state.toolStatusAnimTimer);
    state.toolStatusAnimTimer = null;
  }
}

/** 一幀動畫的同步決策 + 異步發送。`scheduleNext` 是 sendOutbound 落定後的回調，
 *  由 ensureStatusAnimation 注入——只在上一個請求 settle 後才排下一個 tick。 */
function runStatusAnimationFrame(
  state: TelegramTurnState,
  scheduleNext: () => void,
): void {
  // 收尾 / 拆除 / 首發失敗 / 尚未落地 → 不發、不排下一個。
  // currentToolLabel 保證非空：ensureStatusAnimation 只在 scheduleToolStatus 的
  // 首發 .then 內啟動，該路徑已先把 label 寫入，且後續無任何路徑重設它。
  if (state.statusDead) return;
  if (state.statusMessageId === null) return;
  // label 變更已排隊（pendingStatusText != null）→ 讓節流窗口先發，動畫不覆蓋。
  // 注意：label 變更的 edit 自身會把 lastSentStatus 推到新 label 的當前 frame，
  // 動畫下一幀再從當前 frame 續接，emoji 不中斷。
  if (state.pendingStatusText !== null) {
    scheduleNext();
    return;
  }
  const gateway = handle;
  if (!gateway) return;
  // frame 每 tick 前進 1，cycle 4 個字形互異 → 新 text 必與上一幀不同，因此無需
  // 「text === lastSentStatus 就跳過」的比對（label 變更路徑的相同比對由
  // scheduleStatusEdit 負責）。若日後 cycle 改成含重複 emoji / 長度 1，需在此補回。
  state.toolStatusAnimFrame = (state.toolStatusAnimFrame + 1) % TOOL_STATUS_EMOJI_CYCLE.length;
  const text = statusFrameText(state.currentToolLabel, state.toolStatusAnimFrame);
  state.lastSentStatus = text;
  void gateway.client
    .sendOutbound({
      kind: 'editMessage',
      request_id: crypto.randomUUID(),
      chat_id: state.chatId,
      message_id: state.statusMessageId,
      text,
    })
    .catch(() => {})
    .finally(() => {
      // 上一幀落定（無論成功 / 失敗）→ 排下一幀；若已被收尾（statusDead）則
      // 確保不再啟動。
      if (!state.statusDead) scheduleNext();
    });
}

/**
 * agent_end：清 timers + 换 reaction（👀 → 👌 / ❌），把最终回复写回 Telegram
 * （首段锚点模型的 finalize）——splitReply 把回复切成「完整第一段 + ≤2000 的
 * 段落分组块」：Block 1 以 reply_to 回链用户消息（Markdown → plain → 无 reply
 * 三级兜底，保证送达），Block 2+ 静默补发（关 link preview）。运行期间聊天窗
 * 零打扰，finalize 每块仅 1-2 次调用。
 */
async function finalizeTurn(state: TelegramTurnState, messages: BroadcastMessage[]): Promise<void> {
  console.log('[telegram-gateway] finalizeTurn start', {
    sessionId: state.sessionId,
    chatId: state.chatId,
    messagesCount: messages.length,
    lastRole: messages[messages.length - 1]?.role,
    lastStopReason: (messages[messages.length - 1] as { stopReason?: string })?.stopReason,
  });
  clearTurnTimers(state);
  activeTurns.delete(state.sessionId);

  const gateway = handle;
  if (!gateway) {
    console.warn('[telegram-gateway] finalizeTurn: gateway handle null — WS gone?');
    return;
  }

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
  console.log('[telegram-gateway] finalizeTurn: assistant text', {
    hasText: !!text,
    textLen: text?.length ?? 0,
    textPreview: text ? text.slice(0, 80) : null,
  });
  if (!text) {
    console.warn('[telegram-gateway] finalizeTurn: no assistant text — agent produced empty reply');
    return;
  }

  const blocks = splitReply(text);
  console.log('[telegram-gateway] finalizeTurn: sending blocks', { count: blocks.length });
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

  // 块发送统一收口：`anchorFirst` = 首块走三级兜底（reply+MD → reply+plain → 无
  // reply）回链用户消息；其余块静默补发（MD → plain）。0 图路径与媒体 fallback
  // 共用同一条收口，保证降级后的送达语义与既有行为逐字节一致。
  const sendAllBlocks = async (chunks: string[], anchorFirst: boolean): Promise<void> => {
    const first = chunks[0];
    if (first !== undefined) {
      if (anchorFirst) {
        if (!(await sendBlock(first, { replyTo: true, useMarkdown: true }))) {
          if (!(await sendBlock(first, { replyTo: true, useMarkdown: false }))) {
            await sendBlock(first, { useMarkdown: false });
          }
        }
      } else if (!(await sendBlock(first, { useMarkdown: true }))) {
        await sendBlock(first, { useMarkdown: false });
      }
    }
    for (const block of chunks.slice(1)) {
      if (!(await sendBlock(block, { useMarkdown: true }))) {
        await sendBlock(block, { useMarkdown: false });
      }
    }
  };

  // ─── 内联图片路由 ───
  // web 图片按 Telegram 原生 photo 发送（sendPhoto / sendMediaGroup），其余文本
  // 照旧走块路径。VFS 图（#/...）不匹配 http(s)、extractInlineImages 不提取。
  // 整段 try/catch 沿袭既有行为：sendOutbound 在 WS 中途断开时会 reject（close
  // 广播给全部 pending），finalize 是广播 tap 的 fire-and-forget 尾巴，绝不能把
  // rejection 漏成 unhandled。
  try {
    const { images, cleanText } = extractInlineImages(text);
    if (images.length === 0) {
      await sendAllBlocks(blocks, true);
      console.log('[telegram-gateway] finalizeTurn: all blocks sent OK');
      return;
    }

    const textBlocks = cleanText ? splitReply(cleanText) : [];
    // caption 候选 = 第一个文本块，且不超 Telegram caption 硬限；超限则不挂 caption
    //（不在媒体上截断半个 markdown 块），整块照常走后续文本路径。
    const caption = textBlocks[0] !== undefined && textBlocks[0].length <= TELEGRAM_CAPTION_LIMIT
      ? textBlocks[0]
      : undefined;
    const remaining = caption !== undefined ? textBlocks.slice(1) : textBlocks;

    const sendMedia = async (): Promise<boolean> => {
      try {
        if (images.length === 1) {
          const img = images[0]!;
          console.log('[telegram-gateway] finalizeTurn: sendPhoto', {
            url: img.url,
            captioned: caption !== undefined,
          });
          const result = await withTimeout(
            gateway.client.sendOutbound({
              kind: 'sendPhoto',
              request_id: crypto.randomUUID(),
              chat_id: state.chatId,
              image_url: img.url,
              ...(caption !== undefined ? { caption, parse_mode: 'Markdown' as const } : {}),
              reply_to_message_id: state.userMessageId,
            }),
            MEDIA_SEND_TIMEOUT_MS,
            'sendPhoto',
          );
          if (!(result.kind === 'gateway_result' && result.ok)) return false;
        } else {
          // 单组上限 10 张（Bot API 硬限）；溢出的图不静默丢弃——发送成功后以
          // 🖼 链接块补在文本后面（与 fallback 的链接块同形态，内容零丢失）。
          // caption 语义与 Telegram 一致：只有 media[0].caption 生效。
          const media = images.slice(0, MEDIA_GROUP_MAX).map((img, index) => ({
            type: 'photo' as const,
            media: img.url,
            ...(index === 0 && caption !== undefined ? { caption } : {}),
          }));
          console.log('[telegram-gateway] finalizeTurn: sendMediaGroup', {
            count: media.length,
            overflow: images.length - media.length,
            captioned: caption !== undefined,
          });
          const result = await withTimeout(
            gateway.client.sendOutbound({
              kind: 'sendMediaGroup',
              request_id: crypto.randomUUID(),
              chat_id: state.chatId,
              media,
              ...(caption !== undefined ? { parse_mode: 'Markdown' as const } : {}),
              reply_to_message_id: state.userMessageId,
            }),
            MEDIA_SEND_TIMEOUT_MS,
            'sendMediaGroup',
          );
          if (!(result.kind === 'gateway_result' && result.ok)) return false;
        }
        // 溢出链接块：sendPhoto 路径（单图）恒为空 → 行为不变；sendMediaGroup
        // 超过 10 张的图在这里以链接补齐，不静默丢失。
        const overflowLinks = images
          .slice(MEDIA_GROUP_MAX)
          .map((img) => `🖼 ${img.url}`)
          .join('\n');
        await sendAllBlocks(overflowLinks ? [...remaining, overflowLinks] : remaining, false);
        return true;
      } catch (err) {
        console.warn('[telegram-gateway] finalizeTurn: media dispatch failed, falling back to text:', err);
        return false;
      }
    };

    if (await sendMedia()) {
      console.log('[telegram-gateway] finalizeTurn: media path done');
      return;
    }

    // 文本 fallback：干净文本块（图片 markdown 已剥离）+ 图片 URL 以纯链接补一块。
    // 不把 `![alt](url)` 残渣直接怼进聊天窗——内容与链接都保住，渲染交给用户点击。
    const fallbackBlocks = [...textBlocks];
    const linksBlock = images.map((img) => `🖼 ${img.url}`).join('\n');
    if (linksBlock) fallbackBlocks.push(linksBlock);
    await sendAllBlocks(fallbackBlocks, true);
    console.log('[telegram-gateway] finalizeTurn: text fallback done');
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
  console.log('[telegram-gateway] turn broadcast', {
    type: msg.type,
    sessionId: 'sessionId' in msg ? msg.sessionId : null,
  });
  switch (msg.type) {
    case 'agent_end':
      // Backstop：session destroy / cancel 不 fire tool_resolved（toolCtx.dispose
      // 直接摘订阅、无 transition）——agent_end 兜底清 ask_user 的 Telegram 残留。
      // 幂等（正常路径 advance 前已清 map，此处 no-op）。
      askController.onToolResolved(msg.sessionId);
      emitAgentState(state.chatId, 'idle');
      void finalizeTurn(state, msg.messages);
      break;
    case 'tool_pending':
      // ask_user pending → 渲染 inline keyboard（键盘消息本身就是进行中指示，
      // 不再叠加 🔧 状态行 —— 见下方 onToolExecution tap 的 skip）。start 信号
      // 用 tool_pending 而非 tool_execution_start：bridge 单槽 transition 保证
      // resolved(旧) → pending(新) 的顺序，supersede 不踩 race。
      if (msg.toolName === TOOL_ASK_USER) {
        askController.onAskStart(msg.sessionId, msg.args as AskUserRequest);
        // 通知 gateway：agent 正在等用户作答（/status 显示 waiting_user，
        // 同时 stall detector 显式解除——等用户作答时沉默是正常的）。
        emitAgentState(state.chatId, 'waiting_user');
      }
      break;
    case 'tool_resolved':
      // ask_user 从别处收口（sidepanel 提交 / cancelAll / destroy）→ 清 Telegram
      // 键盘残留。绝不 resolveTool/cancelTool（外部已收口）。
      if (msg.toolName === TOOL_ASK_USER) {
        askController.onToolResolved(msg.sessionId);
        // 答案到位 → 回到 thinking（后续 workflow / 收尾继续跑）。
        emitAgentState(state.chatId, 'thinking');
      }
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
    // ask_user 走 tool_pending 广播渲染键盘（键盘消息即进行中指示）——
    // 这里跳过，不再叠加 🔧 状态行。
    if (toolName === TOOL_ASK_USER) return;
    const state = activeTurns.get(sessionId);
    if (state) {
      scheduleToolStatus(state, getToolLabel(toolName, args as Record<string, any> | undefined));
      // agent_state: tool 转变（gateway /status 显示工具名 + re-arm stall watch）。
      emitAgentState(state.chatId, 'tool', toolName);
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
