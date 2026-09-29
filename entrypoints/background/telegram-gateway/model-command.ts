// Telegram Gateway BG — `/model` 命令 → inline keyboard 频道适配层。
//
// 与 ask-user.ts 同构（DI deps 注入 / 纯 helper 导出 / controller factory）：
// 本模块**不 import manager**（manager → 本模块单向依赖，无 import 环）；
// `send` 的契约是**永不 reject**（manager 侧包装：无 handle / WS reject 一律
// resolve null），因此本模块全部调用点都不需要 .catch。
//
// 设计约束：
//  - callback_data scheme：`sm:<8-hex-token>:<idx>`，恒在 Telegram 64-byte 上限内
//    （最长 15 byte）。token 每次 `/model` 重新生成 → 旧键盘的迟到点击 miss →
//    静默吞掉（stale click 安全，与 ask_user 同款 latest-wins 语义）。
//  - 每 chat 同时只有一个活动 keyboard：再次 `/model` 直接覆盖 map 项，旧 token
//    随新 token 写入而失效；旧键盘消息留在聊天窗（不发 edit 收尾——用户已经发了
//    新命令，把旧消息改掉反而制造噪音）。
//  - 点击后**先**清 map 再 apply（one-shot）：防双击重复 apply；apply 失败时用户
//    重新 `/model` 即可，不留半死键盘。
//  - **不调 answerCallbackQuery**：gateway 在转发 telegram_callback 之前已经
//    answer 过（Telegram 对同一 callback_query_id 只允许一次 answer），全部用户
//    反馈走 editMessageText。键盘存活期由 extension 自己管——gateway 对 `au:` /
//    `sm:` 一律不弹 toast、不 arm 5s watchdog（见 gateway/server.js 的
//    `isExtensionKeyboard`）；具体约定与 ask-user.ts 头注释一致。
//
// 用户可见文案沿用本 surface 的先例：硬编码越南语（locales 无越南语，manager.ts
// 全部硬编码）。

import type { ModelIdentity } from '@/lib/persistence/storage';
import type { ModelGroup } from '@/lib/providers/usable-models';
import type {
  InboundMessage,
  InlineKeyboardMarkup,
  OutboundAction,
  OutboundActionResult,
  TelegramCallback,
} from '@/lib/telegram-gateway/types';

// ─── 内部类型与常量 ───────────────────────────────────────────────

/** keyboard 上一个按钮的模型身份 + 展示 label（label 复用为确认文案）。 */
interface ModelKeyboardEntry {
  provider: string;
  modelId: string;
  /** 按钮上的展示名（不含 ✅ 前缀、已截断）——确认 edit 直接回显它。 */
  label: string;
}

/** buildModelKeyboard 的产物。`entries` 与 `keyboard` 下标一一对应——
 *  callback 的 `<idx>` 直接索引 entries。 */
interface ModelKeyboardResult {
  keyboard: InlineKeyboardMarkup['inline_keyboard'];
  entries: ModelKeyboardEntry[];
  /** 超出 `max` 被丢弃的模型数（调用者据此追加提示行）。 */
  overflow: number;
}

/** `/model` 时刻该 chat 的模型状态。`rowExisted` = 当时是否已有会话行——点击时要
 *  靠它区分「从未建行」（写全局种子）与「行在 /model 之后被删」（no-op，别污染
 *  全局默认）。在 onCommand 取样、随键盘一起存到 onCallback 使用。 */
export interface ChatModelState {
  current: ModelIdentity | null;
  rowExisted: boolean;
}

/** deps 注入契约 —— manager 侧用 handle / sessionStore / sessionManager 包装。 */
interface ModelDeps {
  /** 发送 outbound action。**契约：永不 reject**，失败（无 handle / WS 断开 /
   *  gateway 报错）resolve null。 */
  send(action: OutboundAction): Promise<OutboundActionResult | null>;
  /** 当前可选的模型分组（provider 分组 + 展示 label + 模型列表）。 */
  listGroups(): Promise<ModelGroup[]>;
  /** 该 chat 当前生效的模型身份 + 会话行是否存在。 */
  getCurrentModel(chatId: number): Promise<ChatModelState>;
  /** 落库 + 对齐活着的 agent。**经 manager 的串行队列**执行——保证 apply 时
   *  agent 处于 idle（refreshSessionConfig 在 phase ≠ idle 时静默 skip，而
   *  Telegram 是无 turn 的 prompt 入口，跳过会导致模型永久不生效）。
   *  `rowExisted` 来自 onCommand 取样，用于分辨「行被删」与「从未建行」。 */
  applyModel(chatId: number, identity: ModelIdentity, rowExisted: boolean): Promise<void>;
}

/** keyboard 最多渲染的模型数（超出部分只计数不渲染——Telegram 单条消息按钮
 *  过多会挤爆手机屏；与 buildTabsKeyboard 的 max=10 同思路，模型数天然更多）。 */
const MODEL_KEYBOARD_MAX = 24;
/** editMessage 带空 inline_keyboard = 清除键盘（Bot API 语义，与 /tabs 一致）。 */
const CLEAR_KEYBOARD: InlineKeyboardMarkup = { inline_keyboard: [] };

// ─── 纯函数 helpers ──────────────────────────────────────────────

/** 8 位 hex token（不含 ':' —— split(':') 切分安全；`sm:xxxxxxxx:0` ≈ 14 byte）。 */
function makeModelToken(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sm:<token>:<idx>` → { token, index }；坏 payload / 非 sm: → null。
 *  index 只做格式校验，相对 entries 的越界由 controller 吞。 */
function parseModelCallbackData(data: string): { token: string; index: number } | null {
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== 'sm') return null;
  const token = parts[1]!;
  if (!/^[0-9a-f]{8}$/.test(token)) return null;
  const raw = parts[2]!;
  if (!/^\d{1,3}$/.test(raw)) return null;
  return { token, index: Number(raw) };
}

/** label 截断 ~48 chars（同 buildTabsKeyboard / buildAskKeyboard 的手机防溢出口径）。 */
function clipLabel(text: string): string {
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** 按钮展示名：优先 pi-ai 的 `name`，空则回落 `id`；多 provider 时前缀分组
 *  label 消歧（同名模型可跨 provider 存在）。 */
function modelButtonLabel(group: ModelGroup, model: ModelGroup['models'][number], multiGroup: boolean): string {
  const base = model.name || model.id;
  return multiGroup ? `${group.label} · ${base}` : base;
}

/** 组 keyboard：一模型一行（同 buildTabsKeyboard 单钮行——label 长，双列会被
 *  Telegram 截断）。当前模型加 `✅ ` 前缀；超出 `max` 的模型不渲染但计入
 *  overflow。`entries` 与 `keyboard` 同序同长。 */
function buildModelKeyboard(
  groups: ModelGroup[],
  token: string,
  current: ModelIdentity | null,
  max = MODEL_KEYBOARD_MAX,
): ModelKeyboardResult {
  const multiGroup = groups.length > 1;
  const entries: ModelKeyboardEntry[] = [];
  const keyboard: InlineKeyboardMarkup['inline_keyboard'] = [];
  let total = 0;

  for (const group of groups) {
    for (const model of group.models) {
      total += 1;
      if (entries.length >= max) continue;
      const index = entries.length;
      const label = clipLabel(modelButtonLabel(group, model, multiGroup));
      const isCurrent =
        current !== null && current.provider === group.provider && current.modelId === model.id;
      entries.push({ provider: group.provider, modelId: model.id, label });
      keyboard.push([
        {
          text: isCurrent ? `✅ ${label}` : label,
          callback_data: `sm:${token}:${index}`,
        },
      ]);
    }
  }

  return { keyboard, entries, overflow: Math.max(0, total - entries.length) };
}

// ─── Controller ──────────────────────────────────────────────────

function createTelegramModelController(deps: ModelDeps) {
  /** chat_id → 活动 keyboard（token + 按钮序的 entries + /model 时的行存在性）。
   *  latest-wins：再次 `/model` 直接覆盖，旧 token 随之失效。 */
  const keyboardsByChat = new Map<
    number,
    { token: string; entries: ModelKeyboardEntry[]; rowExisted: boolean }
  >();

  /** `/model` 命令：列出可用模型 → 发 keyboard（当前模型带 ✅）。
   *  读 deps 失败（storage / resolve 抛错）→ 发兜底文案而非静默死掉
   *  （同 dispatchTabsCommand 的 try/catch 口径）。 */
  async function onCommand(msg: InboundMessage): Promise<void> {
    let groups: ModelGroup[];
    let modelState: ChatModelState;
    try {
      groups = await deps.listGroups();
      modelState = await deps.getCurrentModel(msg.chat_id);
    } catch (err) {
      console.warn('[telegram-gateway] /model list failed:', err);
      await deps.send({
        kind: 'sendMessage',
        request_id: crypto.randomUUID(),
        chat_id: msg.chat_id,
        text: `⚠️ Không đọc được danh sách model: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (groups.length === 0) {
      // 无可用模型 = 未配 API key。给可操作指引而不是空键盘。
      await deps.send({
        kind: 'sendMessage',
        request_id: crypto.randomUUID(),
        chat_id: msg.chat_id,
        text: '⚠️ Chưa có model nào khả dụng. Hãy cấu hình API key trong Settings trước.',
      });
      return;
    }

    const token = makeModelToken();
    const { keyboard, entries, overflow } = buildModelKeyboard(groups, token, modelState.current);
    keyboardsByChat.set(msg.chat_id, { token, entries, rowExisted: modelState.rowExisted });

    let text = '🤖 Chọn model:';
    if (overflow > 0) {
      text += `\n(…và ${overflow} model khác không hiển thị)`;
    }
    await deps.send({
      kind: 'sendMessage',
      request_id: crypto.randomUUID(),
      chat_id: msg.chat_id,
      text,
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  /** inline keyboard callback（manager router 保证 `sm:` 前缀才进来）。 */
  async function onCallback(cb: TelegramCallback): Promise<void> {
    const parsed = parseModelCallbackData(cb.data);
    if (parsed === null) return;
    const pending = keyboardsByChat.get(cb.chat_id);
    // stale（旧键盘 / 已收尾 / 别的 chat）→ 静默吞（不 crash、不 toast）。
    if (!pending || pending.token !== parsed.token) return;
    const entry = pending.entries[parsed.index];
    // 先清 map 再 apply（one-shot）——防双击重复 apply。
    keyboardsByChat.delete(cb.chat_id);
    if (!entry) return;

    try {
      await deps.applyModel(
        cb.chat_id,
        { provider: entry.provider, modelId: entry.modelId },
        pending.rowExisted,
      );
    } catch (err) {
      console.warn('[telegram-gateway] /model apply failed:', err);
      await deps.send({
        kind: 'editMessage',
        request_id: crypto.randomUUID(),
        chat_id: cb.chat_id,
        message_id: cb.message_id,
        text: `⚠️ Đổi model thất bại: ${err instanceof Error ? err.message : String(err)}`,
        reply_markup: CLEAR_KEYBOARD,
      });
      return;
    }

    // ⚠️ 乐观确认：applyModel resolve 的是「已入队」，不是「已生效」——若此刻
    // 有 turn 在跑（或 ask_user 在等作答），真正落地要等那一轮结束。文案因此
    // 限定为「từ tin nhắn tiếp theo」而不是「đã đổi xong」：不谎称已生效，也不
    // 让用户对着已清键盘的界面干等数分钟（等 settle 再 edit 的替代方案更差）。
    await deps.send({
      kind: 'editMessage',
      request_id: crypto.randomUUID(),
      chat_id: cb.chat_id,
      message_id: cb.message_id,
      text: `✅ Đã chọn model: ${entry.label}\n(áp dụng từ tin nhắn tiếp theo)`,
      reply_markup: CLEAR_KEYBOARD,
    });
  }

  /** gateway 被拆除：清掉全部活动 keyboard（旧 token 失效，迟到点击自吞）。 */
  function teardown(): void {
    keyboardsByChat.clear();
  }

  return { onCommand, onCallback, teardown };
}

// ─── Public API（exports 集中在文件底部，供 manager 接线 + 单测驱动）───

export {
  buildModelKeyboard,
  createTelegramModelController,
  makeModelToken,
  parseModelCallbackData,
};
