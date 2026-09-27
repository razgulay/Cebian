// Telegram Gateway BG — ask_user → inline keyboard 频道适配层。
//
// ask_user 工具本身**不 fork**：sidepanel 表单路径原样保留。本模块只在
// Telegram session 出现 ask_user pending 时把问题渲染成 inline keyboard，
// 把按钮点击 / 自由文本回答收敛回 { answers: Record<id, AskUserAnswer> }，
// 经 sessionManager.resolveTool 交还 bridge（与 sidepanel 提交同一条 resolve 链）。
//
// 设计约束（见 plan「breezy-gliding-starfish」）：
//  - DI deps 注入（send / resolveTool / cancelTool / getActiveTurnChatId）。
//    本模块**不 import manager**（manager → 本模块单向依赖，无 import 环）；
//    `send` 的契约是**永不 reject**（manager 侧包装：无 handle / WS reject
//    一律 resolve null），因此本模块全部调用点都不需要 .catch。
//  - callback_data scheme：`au:<8-hex-token>:<idx|t|done>`，恒在 Telegram
//    64-byte 上限内。token 每题一个：题答完即从 asksByToken 删除，旧键盘的
//    迟到点击 miss → 静默吞掉（stale click 安全）。
//  - 一次 ask_user 调用可带多道题 → 逐题串行渲染（同 chat 同时只有一个活动
//    keyboard），全部答完才 resolveTool 一次。
//  - 不变量 #1：任何 resolveTool / cancelTool 之前先清干净 maps ——
//    tool_resolved 广播在 resolve 内**同步** fire，回环到 onToolResolved 时
//    必须已找不到本 ask（否则会用冗余 edit 覆盖刚写的 ✅ 确认）。
//  - 任何错误 / 超时 / 被顶掉路径都 editMessage + 清 keyboard，绝不给 user
//    留转圈；bridge 永不悬挂（cancelTool 兜底）。
//  - 已知残留（post-task review LOW-1）：gateway teardown 与 turn 在途的竞态
//    窗口内，turn 走到 ask_user 时 activeTurns 已被 syncGateway 清空 →
//    onAskStart 不触发（无键盘、也无 10 分钟 timer），该 bridge 只能靠
//    sidepanel 表单作答 / SW 重启 / session destroy 收口。有界且自愈；彻底
//    修复需 manager 侧维护独立的 telegram-session 注册表（区分「非 Telegram
//    session」与「UX 状态已被拆除的 telegram turn」）——超出本 plan 设计面，
//    记录在案，暂不处理。
//
// 用户可见文案沿用本 surface 的先例：硬编码越南语（locales 无越南语，
// manager.ts 全部硬编码 —— 见 plan 不变量 #8）。

import type { AskUserAnswer, AskUserRequest, AskUserResponse } from '@/lib/tools/ask-user';
import type {
  InboundMessage,
  InlineKeyboardMarkup,
  OutboundAction,
  OutboundActionResult,
  TelegramCallback,
} from '@/lib/telegram-gateway/types';

// ─── 内部类型与常量 ───────────────────────────────────────────────

/** ask_user pending 期间每 chat 一个的会话状态。 */
interface AskSession {
  sessionId: string;
  chatId: number;
  questions: AskUserRequest['questions'];
  /** 已答题（qid → answer）；超时 / dismiss 时未答题统一补 skipped。 */
  answers: Record<string, AskUserAnswer>;
  /** 当前渲染到第几题。 */
  qIndex: number;
  /** 当前题的 callback token（asksByToken 的 key），题与题之间更新。 */
  currentToken: string | null;
  /** 当前题的 Telegram message id（keyboard 载体 / 确认 edit 的锚点）。 */
  messageId: number | null;
  /** 当前 multi-select 题已选 option 下标（单选题不用；✍️ 转文本后保留，
   *  文本到达时与 free_text 合并 —— 不丢已点勾）。 */
  selected: Set<number>;
  /** 整场 10 分钟超时 timer（spec：每 ask 一个，不按题重置）。 */
  timer: ReturnType<typeof setTimeout> | null;
}

/** deps 注入契约 —— manager 侧用 handle / activeTurns / sessionManager 包装。 */
interface AskDeps {
  /** 发送 outbound action。**契约：永不 reject**，失败（无 handle / WS 断开
   *  / gateway 报错）resolve null。 */
  send(action: OutboundAction): Promise<OutboundActionResult | null>;
  /** 解析 ask_user 的 pending 请求（sessionManager.resolveTool 的包装）。 */
  resolveTool(sessionId: string, response: AskUserResponse): void;
  /** 取消 ask_user 的 pending 请求（sessionManager.cancelTool 的包装）——
   *  bridge 收到 INTERACTIVE_CANCELLED，等价 sidepanel 的 dismissed 语义。 */
  cancelTool(sessionId: string): void;
  /** sessionId 是否是正在跑 turn 的 Telegram session（activeTurns 查询）。
   *  null = 非 Telegram session（sidepanel 表单路径，本模块不介入）。 */
  getActiveTurnChatId(sessionId: string): number | null;
}

/** 解析后的 callback action。 */
type AskCallbackAction =
  | { kind: 'option'; index: number }
  | { kind: 'text' }
  | { kind: 'done' };

/** 整场 ask 的超时（spec：10 分钟 / ask，不按题重置 —— 4-5 题偏紧是已知
 *  trade-off，plan 不变量 #9）。 */
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
const BUTTON_FREE_TEXT = '✍️ Nhập tay';
const BUTTON_DONE = '✅ Xong';
/** editMessage 带空 inline_keyboard = 清除键盘（Bot API 语义，与 /tabs 流程一致）。 */
const CLEAR_KEYBOARD: InlineKeyboardMarkup = { inline_keyboard: [] };

// ─── 纯函数 helpers ──────────────────────────────────────────────

/** 8 位 hex token（不含 ':' —— split(':') 切分安全；`au:xxxxxxxx:0` ≈ 15 byte）。 */
function makeAskToken(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `au:<token>:<idx|t|done>` → { token, action }；坏 payload / 非 au: → null。
 *  option index 只做格式校验（数字），相对 options 的越界由 controller 吞。 */
function parseAskCallbackData(
  data: string,
): { token: string; action: AskCallbackAction } | null {
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'au') return null;
  const token = parts[1]!;
  if (!/^[0-9a-f]{8}$/.test(token)) return null;
  const raw = parts[2]!;
  if (raw === 't') return { token, action: { kind: 'text' } };
  if (raw === 'done') return { token, action: { kind: 'done' } };
  if (!/^\d{1,3}$/.test(raw)) return null;
  return { token, action: { kind: 'option', index: Number(raw) } };
}

/** 组题 keyboard：一 option 一行（越南语 label 长，双列会被 Telegram 截断）。
 *  multi-select 重绘时以 `✅ ` 前缀标注已选（Telegram 不会自己画勾）；
 *  allow_free_text ≠ false 追加 ✍️ 行；multiple = true 追加 ✅ Xong 行。 */
function buildAskKeyboard(
  question: AskUserRequest['questions'][number],
  token: string,
  selected: Set<number>,
): InlineKeyboardMarkup['inline_keyboard'] {
  // 一 option 一行（单钮行）—— 越南语 label 长，双列会被 Telegram 截断。
  const rows = (question.options ?? []).map((opt, i) => [
    {
      text: selected.has(i) ? `✅ ${clipLabel(opt.label)}` : clipLabel(opt.label),
      callback_data: `au:${token}:${i}`,
    },
  ]);
  if (question.allow_free_text !== false) {
    rows.push([{ text: BUTTON_FREE_TEXT, callback_data: `au:${token}:t` }]);
  }
  if (question.multiple === true) {
    rows.push([{ text: BUTTON_DONE, callback_data: `au:${token}:done` }]);
  }
  return rows;
}

/** label 截断 ~48 chars（同 buildTabsKeyboard 的手机防溢出口径）。 */
function clipLabel(text: string): string {
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** 确认 edit 里自由文本的展示截断（答案原文完整进 free_text，不在此丢内容）。 */
function clipConfirm(text: string): string {
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

/** 题面文本：`❓ <question>`，附带的 message 换行缀后。 */
function questionText(question: AskUserRequest['questions'][number]): string {
  const base = `❓ ${question.question}`;
  return question.message ? `${base}\n\n${question.message}` : base;
}

/** 已选下标 → 按 option 顺序取 label（越界防御性跳过）。 */
function pickedLabels(ask: AskSession): string[] {
  const q = ask.questions[ask.qIndex]!;
  return [...ask.selected]
    .sort((a, b) => a - b)
    .map((i) => q.options?.[i]?.label)
    .filter((label): label is string => typeof label === 'string');
}

// ─── Controller ──────────────────────────────────────────────────

function createTelegramAskController(deps: AskDeps) {
  /** chat_id → 活动 ask（每 chat 同时最多一个 —— spec 硬约束）。 */
  const activeAsksByChat = new Map<number, AskSession>();
  /** token → 活动 ask（只含当前题的 live token；旧题 token 一律清除）。 */
  const asksByToken = new Map<string, AskSession>();
  /** chat_id → 正在等自由文本的当前题 token（✍️ / 无选项题 arm）。 */
  const awaitingTextByChat = new Map<number, string>();

  // ─── 清理（不变量 #1 的落点：resolveTool / cancelTool 前必经）───

  /** 清掉当前题的 token / awaitingText / 锚点（题与题推进、整场收尾共用）。 */
  function clearQuestionRefs(ask: AskSession): void {
    if (ask.currentToken !== null) {
      asksByToken.delete(ask.currentToken);
      if (awaitingTextByChat.get(ask.chatId) === ask.currentToken) {
        awaitingTextByChat.delete(ask.chatId);
      }
    }
    ask.currentToken = null;
    ask.messageId = null;
    ask.selected.clear();
  }

  /** 整场收尾的 map / timer 清理。**不**调 resolveTool / cancelTool —— 由
   *  caller 按语义调用（finish / dismiss / timeout / teardown 各不同）。 */
  function cleanupSession(ask: AskSession): void {
    if (ask.timer !== null) {
      clearTimeout(ask.timer);
      ask.timer = null;
    }
    clearQuestionRefs(ask);
    activeAsksByChat.delete(ask.chatId);
  }

  // ─── 渲染与推进 ───

  /** 渲染当前题。无选项 + 不允许自由文本 → 无从作答，记 skipped 直接前进。 */
  async function renderQuestion(ask: AskSession): Promise<void> {
    const q = ask.questions[ask.qIndex]!;
    if ((q.options?.length ?? 0) === 0 && q.allow_free_text === false) {
      ask.answers[q.id] = { selected: [], free_text: '', skipped: true };
      await advance(ask);
      return;
    }

    const token = makeAskToken();
    ask.currentToken = token;
    ask.messageId = null;
    ask.selected.clear();
    asksByToken.set(token, ask);

    const hasKeyboard = (q.options?.length ?? 0) > 0;
    const result = await deps.send({
      kind: 'sendMessage',
      request_id: crypto.randomUUID(),
      chat_id: ask.chatId,
      text: questionText(q),
      // 无选项的自由文本题：纯文本 + 直接 arm awaitingText（下一條消息即答案）。
      ...(hasKeyboard
        ? { reply_markup: { inline_keyboard: buildAskKeyboard(q, token, ask.selected) } }
        : {}),
    });
    const messageId =
      result?.kind === 'sendMessage_result' && result.ok ? result.message_id : null;
    // send 在途期间本场可能已被清（外部 resolve / dismissal / teardown）——
    // 死场就地终止：不 cancelTool（bridge 槽位可能已属于新 ask）。
    if (activeAsksByChat.get(ask.chatId) !== ask) return;
    if (messageId === null) {
      // 题面没送达 —— form 到不了用户手上，bridge 不能悬挂：cancel（=sidepanel
      // 的 dismissed 语义）。maps 先清（不变量 #1）。
      console.warn('[telegram-gateway] ask_user question send failed — cancelling ask');
      cleanupSession(ask);
      deps.cancelTool(ask.sessionId);
      return;
    }
    ask.messageId = messageId;
    if (!hasKeyboard) {
      awaitingTextByChat.set(ask.chatId, token);
    }
  }

  /** 推进到下一题；没有下一题 → 收尾 resolve（maps 已清，tool_resolved 回环 no-op）。 */
  async function advance(ask: AskSession): Promise<void> {
    // liveness guard：recordAnswer 的确认 edit await 期间，dismiss / 外部
    // resolve / 超时可能已把本场清走（cleanupSession 必然摘除 map 项 ——
    // 「map 里还是自己」即「仍然存活」）。续体恢复时发现已死 → 就地终止：
    // 不再渲染下一题、不 resolveTool（否则僵尸把陈旧答案灌进 bridge 的单槽
    // —— 若此刻新 ask 正 pending，等于跨调用串答案）。
    if (activeAsksByChat.get(ask.chatId) !== ask) return;
    clearQuestionRefs(ask);
    if (ask.qIndex + 1 >= ask.questions.length) {
      cleanupSession(ask);
      deps.resolveTool(ask.sessionId, { answers: ask.answers });
      return;
    }
    ask.qIndex += 1;
    await renderQuestion(ask);
  }

  /** 记答案：先发 ✅ 确认 edit（user 立即看到落点），再 advance / resolve。 */
  async function recordAnswer(
    ask: AskSession,
    answer: AskUserAnswer,
    confirmText: string,
  ): Promise<void> {
    const q = ask.questions[ask.qIndex]!;
    ask.answers[q.id] = answer;
    const messageId = ask.messageId;
    if (messageId !== null) {
      const edited = await deps.send({
        kind: 'editMessage',
        request_id: crypto.randomUUID(),
        chat_id: ask.chatId,
        message_id: messageId,
        text: confirmText,
        reply_markup: CLEAR_KEYBOARD,
      });
      if (edited === null || !edited.ok) {
        // 确认 edit 失败不回滚答案 —— 键盘上 token 已随 advance 清除，
        // 迟到点击会被吞，仅聊天窗残留旧键盘（同 👀 reaction 残留级别）。
        console.warn('[telegram-gateway] ask_user confirm edit failed');
      }
    }
    await advance(ask);
  }

  /** multi-select toggle 后原位重绘 keyboard（文案不变，仅 ✅ 前缀变化）。 */
  async function rerenderKeyboard(ask: AskSession): Promise<void> {
    const q = ask.questions[ask.qIndex]!;
    if (ask.messageId === null || ask.currentToken === null) return;
    const result = await deps.send({
      kind: 'editMessage',
      request_id: crypto.randomUUID(),
      chat_id: ask.chatId,
      message_id: ask.messageId,
      text: questionText(q),
      reply_markup: { inline_keyboard: buildAskKeyboard(q, ask.currentToken, ask.selected) },
    });
    if (result === null || !result.ok) {
      console.warn('[telegram-gateway] ask_user keyboard re-render failed');
    }
  }

  // ─── 生命周期入口 ───

  /** ask_user pending 的起点（tool_pending 广播）。非 Telegram session → 忽略。 */
  function onAskStart(sessionId: string, request: AskUserRequest): void {
    const chatId = deps.getActiveTurnChatId(sessionId);
    if (chatId === null) return;
    // belt-and-braces：正常顺序是旧 ask 先被 bridge supersede（tool_resolved
    // 先 fire → onToolResolved 清场）。这里兜底清残留 —— **不能** cancelTool：
    // bridge 槽位已属于新 ask，cancel 会把新问题杀掉。只清 Telegram 侧状态
    // + 把旧键盘改掉（旧 token 随 cleanup 失效，迟到点击自吞）。
    const prev = activeAsksByChat.get(chatId);
    if (prev) {
      const prevMessageId = prev.messageId;
      cleanupSession(prev);
      if (prevMessageId !== null) {
        void deps.send({
          kind: 'editMessage',
          request_id: crypto.randomUUID(),
          chat_id: chatId,
          message_id: prevMessageId,
          text: '⏭ Đã bỏ qua câu hỏi.',
          reply_markup: CLEAR_KEYBOARD,
        });
      }
    }

    const ask: AskSession = {
      sessionId,
      chatId,
      questions: request.questions,
      answers: {},
      qIndex: 0,
      currentToken: null,
      messageId: null,
      selected: new Set(),
      timer: null,
    };
    activeAsksByChat.set(chatId, ask);
    ask.timer = setTimeout(() => expire(ask), ASK_TIMEOUT_MS);
    void renderQuestion(ask);
  }

  /** inline keyboard callback（manager router 保证 `au:` 前缀才进来）。 */
  async function onCallback(cb: TelegramCallback): Promise<void> {
    const parsed = parseAskCallbackData(cb.data);
    if (parsed === null) return;
    const ask = asksByToken.get(parsed.token);
    // stale（旧题 / 已收尾 / 别的 chat）→ 静默吞（spec：不 crash、不 toast）。
    if (!ask || ask.chatId !== cb.chat_id) return;
    const q = ask.questions[ask.qIndex]!;
    const options = q.options ?? [];

    if (parsed.action.kind === 'option') {
      if (parsed.action.index >= options.length) return;
      // ✍️ 之后改点选项：文本模式让位（下次 ✍️ 可再进）。
      if (awaitingTextByChat.get(ask.chatId) === parsed.token) {
        awaitingTextByChat.delete(ask.chatId);
      }
      if (q.multiple === true) {
        if (ask.selected.has(parsed.action.index)) {
          ask.selected.delete(parsed.action.index);
        } else {
          ask.selected.add(parsed.action.index);
        }
        await rerenderKeyboard(ask);
        // multi-select 未定，不 resolve
        return;
      }
      const label = options[parsed.action.index]!.label;
      await recordAnswer(
        ask,
        { selected: [label], free_text: '', skipped: false },
        `✅ ${clipLabel(label)}`,
      );
      return;
    }

    if (parsed.action.kind === 'text') {
      // ✍️：转自由文本模式。保留 keyboard（不带 reply_markup 的 editMessageText
      // 按 Bot API 语义保留原键盘）；ask.selected 原样存活 —— 文本到达时与
      // free_text 合并，已点勾不丢。
      awaitingTextByChat.set(ask.chatId, parsed.token);
      if (ask.messageId !== null) {
        await deps.send({
          kind: 'editMessage',
          request_id: crypto.randomUUID(),
          chat_id: ask.chatId,
          message_id: ask.messageId,
          text: '✍️ Gõ câu trả lời của bạn…',
        });
      }
      return;
    }

    // done（multi-select 收口）：0 selected = 整题 skip。
    const labels = pickedLabels(ask);
    if (labels.length === 0) {
      await recordAnswer(ask, { selected: [], free_text: '', skipped: true }, '⏭ Đã bỏ qua câu hỏi.');
      return;
    }
    await recordAnswer(
      ask,
      { selected: labels, free_text: '', skipped: false },
      `✅ ${labels.map(clipLabel).join(', ')}`,
    );
  }

  /** inbound 文本拦截（dispatchInbound 顶端，/tabs 检查之后）。返回 true =
   *  已消费，不再往 agent 转发。 */
  async function interceptInbound(msg: InboundMessage): Promise<boolean> {
    // (1) ✍️ 文本模式：这条消息就是答案。接线顺序（ST3 落地）：dispatchInbound
    // 里 /tabs 命令检查在本拦截**之前** —— /tabs 永远走 utility 流程，不会被
    // 当成答案吞掉（答完再发 /tabs 即可）。selected 与 free_text 合并，不丢已点勾。
    const token = awaitingTextByChat.get(msg.chat_id);
    if (token !== undefined) {
      const ask = asksByToken.get(token);
      awaitingTextByChat.delete(msg.chat_id);
      if (!ask) {
        // 状态不一致（不应发生）→ 放行为普通聊天
        return false;
      }
      await recordAnswer(
        ask,
        { selected: pickedLabels(ask), free_text: msg.text, skipped: false },
        `✅ ${clipConfirm(msg.text)}`,
      );
      return true;
    }

    // (2) keyboard pending、无 ✍️：普通文本 = dismiss form（mirror sidepanel
    // 的「打字即放弃表单」语义），消息照常作为聊天走。cancelTool 会让 bridge
    // 以 INTERACTIVE_CANCELLED 收场（Step 0 已验证 unblock 链），agent 继续
    // 跑完本轮 → 串行队列接上这条消息。maps 先清（不变量 #1）。
    // ⚠️ 本分支必须**无 await**地返回 false：dispatchInbound 在 queue 登记
    // 之前 await 本方法，若在此等待 ⏭ edit 的 WS 往返，紧随其后的同 chat
    // 消息会先入队、dismiss 文本反而排到后面 —— 到达顺序被倒转（违反
    // manager 头注释的串行队列不变量）。故 edit 走 fire-and-forget（失败仅
    // console.warn，无信息丢失）。
    const ask = activeAsksByChat.get(msg.chat_id);
    if (ask) {
      const messageId = ask.messageId;
      cleanupSession(ask);
      if (messageId !== null) {
        void deps.send({
          kind: 'editMessage',
          request_id: crypto.randomUUID(),
          chat_id: ask.chatId,
          message_id: messageId,
          text: '⏭ Đã bỏ qua câu hỏi.',
          reply_markup: CLEAR_KEYBOARD,
        });
      }
      deps.cancelTool(ask.sessionId);
      return false;
    }

    return false;
  }

  /** 10 分钟超时：未答题统一补 skipped，edit ⌛ + 清键盘，resolve。 */
  function expire(ask: AskSession): void {
    const messageId = ask.messageId;
    cleanupSession(ask);
    for (let i = ask.qIndex; i < ask.questions.length; i++) {
      const q = ask.questions[i]!;
      if (!(q.id in ask.answers)) {
        ask.answers[q.id] = { selected: [], free_text: '', skipped: true };
      }
    }
    if (messageId !== null) {
      void deps.send({
        kind: 'editMessage',
        request_id: crypto.randomUUID(),
        chat_id: ask.chatId,
        message_id: messageId,
        text: '⌛ Đã hết thời gian trả lời.',
        reply_markup: CLEAR_KEYBOARD,
      });
    }
    deps.resolveTool(ask.sessionId, { answers: ask.answers });
  }

  /** ask_user 已从别处 resolve（sidepanel 提交 / cancelAll / destroy）——
   *  只清 Telegram 残留 + 确认 edit，**绝不**调 resolveTool / cancelTool。
   *  自家 resolve 路径因不变量 #1（先清 maps）到达此处即 no-op —— 幂等。 */
  function onToolResolved(sessionId: string): void {
    for (const ask of activeAsksByChat.values()) {
      if (ask.sessionId !== sessionId) continue;
      const messageId = ask.messageId;
      cleanupSession(ask);
      if (messageId !== null) {
        void deps.send({
          kind: 'editMessage',
          request_id: crypto.randomUUID(),
          chat_id: ask.chatId,
          message_id: messageId,
          text: '✅ Đã trả lời.',
          reply_markup: CLEAR_KEYBOARD,
        });
      }
      return;
    }
  }

  /** gateway 被拆除（syncGateway teardown / config 变更）：先清 maps（
   *  tool_resolved 回环 no-op），再 cancelTool 每个 pending ask —— 防 bridge
   *  在 gateway 关掉后永久悬挂。不 edit（handle 正在死，消息发不出去）。 */
  function teardown(): void {
    const asks = [...activeAsksByChat.values()];
    for (const ask of asks) cleanupSession(ask);
    for (const ask of asks) deps.cancelTool(ask.sessionId);
  }

  return { onAskStart, onCallback, interceptInbound, onToolResolved, teardown };
}

// ─── Public API（exports 集中在文件底部，供 manager 接线 + 单测驱动）───

export {
  buildAskKeyboard,
  createTelegramAskController,
  makeAskToken,
  parseAskCallbackData,
};
