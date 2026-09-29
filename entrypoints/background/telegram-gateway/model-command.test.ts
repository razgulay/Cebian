// model-command.test.ts — `/model` 命令适配层的单测。
//
// 覆盖三层：
//   1. 纯 helper（buildModelKeyboard / parseModelCallbackData）—— 契约由
//      Telegram Bot API 约束（64-byte callback_data、按钮文本截断）驱动。
//   2. controller 的 onCommand —— 列模型 / ✅ 标注当前 / 空列表兜底。
//   3. controller 的 onCallback —— apply + 确认 edit / stale token / 越界 /
//      chat mismatch / apply 失败 五条分支。
//
// deps 全部注入 mock —— 本模块不 import manager，无 Chrome / WS 依赖。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelGroup } from '@/lib/providers/usable-models';
import type { ModelIdentity } from '@/lib/persistence/storage';
import type {
  InboundMessage,
  OutboundAction,
  OutboundActionResult,
  TelegramCallback,
} from '@/lib/telegram-gateway/types';
import {
  buildModelKeyboard,
  createTelegramModelController,
  makeModelToken,
  parseModelCallbackData,
} from './model-command';

// ─── fixtures ────────────────────────────────────────────────────

/** 最小 Model<Api> 桩——只填 buildModelKeyboard 会读的字段（id / name）。 */
function model(id: string, name: string): ModelGroup['models'][number] {
  return { id, name } as ModelGroup['models'][number];
}

function group(provider: string, label: string, models: ModelGroup['models']): ModelGroup {
  return { provider, label, models };
}

const ANTHROPIC = group('anthropic', 'anthropic', [
  model('claude-opus-5', 'Claude Opus 5'),
  model('claude-sonnet-5', 'Claude Sonnet 5'),
]);
const OPENAI = group('openai', 'openai', [model('gpt-5', 'GPT-5')]);

const INBOUND: InboundMessage = {
  kind: 'telegram_message',
  update_id: 1,
  message_id: 1,
  chat_id: 965822571,
  chat_type: 'private',
  text: '/model',
  date: 1737000000,
  from: { id: 42, username: 'tester' },
};

/** 造一个 callback，`data` 由调用者给。 */
function callback(data: string, chatId = 965822571, messageId = 77): TelegramCallback {
  return {
    kind: 'telegram_callback',
    callback_query_id: 'cq1',
    data,
    chat_id: chatId,
    message_id: messageId,
    from: { id: 42, username: 'tester' },
  };
}

/** 收集 send 调用的 deps.send 桩。 */
function makeSend() {
  const calls: OutboundAction[] = [];
  const send = vi.fn(async (action: OutboundAction): Promise<OutboundActionResult | null> => {
    calls.push(action);
    if (action.kind === 'sendMessage') {
      return { kind: 'sendMessage_result', request_id: action.request_id, ok: true, message_id: 1000 + calls.length };
    }
    return { kind: 'gateway_result', request_id: action.request_id, ok: true };
  });
  return { send, calls };
}

/** 造 controller + 可观测 deps。 */
function makeController(opts: {
  groups?: ModelGroup[];
  current?: ModelIdentity | null;
  /** 该 chat 是否已有会话行（默认：有 current 就算有行）。 */
  rowExisted?: boolean;
  applyImpl?: () => Promise<void>;
} = {}) {
  const { send, calls } = makeSend();
  const applyModel = vi.fn(opts.applyImpl ?? (async () => {}));
  const current = opts.current ?? null;
  const controller = createTelegramModelController({
    send,
    listGroups: vi.fn(async () => opts.groups ?? [ANTHROPIC, OPENAI]),
    getCurrentModel: vi.fn(async () => ({
      current,
      rowExisted: opts.rowExisted ?? current !== null,
    })),
    applyModel,
  });
  return { controller, send, calls, applyModel };
}

/** 取最后一条 sendMessage（命令发出的 keyboard）。 */
function lastSendMessage(calls: OutboundAction[]) {
  return calls.filter((c) => c.kind === 'sendMessage').at(-1) as
    | Extract<OutboundAction, { kind: 'sendMessage' }>
    | undefined;
}

/** 取最后一条 editMessage（callback 的确认 / 报错 edit）。 */
function lastEditMessage(calls: OutboundAction[]) {
  return calls.filter((c) => c.kind === 'editMessage').at(-1) as
    | Extract<OutboundAction, { kind: 'editMessage' }>
    | undefined;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── 纯 helper ───────────────────────────────────────────────────

describe('makeModelToken', () => {
  it('产出 8 位 hex（split(":") 安全，不含冒号）', () => {
    for (let i = 0; i < 20; i++) {
      expect(makeModelToken()).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('两次调用不重复（随机性 sanity check）', () => {
    const seen = new Set(Array.from({ length: 50 }, () => makeModelToken()));
    expect(seen.size).toBe(50);
  });
});

describe('parseModelCallbackData', () => {
  it('happy path：sm:<8hex>:<idx> → { token, index }', () => {
    expect(parseModelCallbackData('sm:deadbeef:3')).toEqual({ token: 'deadbeef', index: 3 });
    expect(parseModelCallbackData('sm:00000000:0')).toEqual({ token: '00000000', index: 0 });
  });

  it('非 sm: 前缀 → null（cap_ / au: 不会被误吞）', () => {
    expect(parseModelCallbackData('cap_123')).toBeNull();
    expect(parseModelCallbackData('au:deadbeef:0')).toBeNull();
    expect(parseModelCallbackData('')).toBeNull();
  });

  it('token 格式错 → null（非 hex / 长度不符）', () => {
    expect(parseModelCallbackData('sm:ZZZZZZZZ:0')).toBeNull();
    expect(parseModelCallbackData('sm:dead:0')).toBeNull();
    expect(parseModelCallbackData('sm:deadbeefaa:0')).toBeNull();
  });

  it('index 格式错 / 段数不符 → null', () => {
    expect(parseModelCallbackData('sm:deadbeef:abc')).toBeNull();
    expect(parseModelCallbackData('sm:deadbeef:')).toBeNull();
    expect(parseModelCallbackData('sm:deadbeef:1234')).toBeNull();
    expect(parseModelCallbackData('sm:deadbeef')).toBeNull();
    expect(parseModelCallbackData('sm:deadbeef:0:extra')).toBeNull();
  });
});

describe('buildModelKeyboard', () => {
  it('一模型一行；callback_data 为 sm:<token>:<idx>，与 entries 同序', () => {
    const { keyboard, entries, overflow } = buildModelKeyboard([ANTHROPIC], 'deadbeef', null);
    expect(keyboard).toEqual([
      [{ text: 'Claude Opus 5', callback_data: 'sm:deadbeef:0' }],
      [{ text: 'Claude Sonnet 5', callback_data: 'sm:deadbeef:1' }],
    ]);
    expect(entries).toEqual([
      { provider: 'anthropic', modelId: 'claude-opus-5', label: 'Claude Opus 5' },
      { provider: 'anthropic', modelId: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    ]);
    expect(overflow).toBe(0);
  });

  it('当前模型带 ✅ 前缀，其余不带', () => {
    const { keyboard } = buildModelKeyboard(
      [ANTHROPIC],
      'deadbeef',
      { provider: 'anthropic', modelId: 'claude-sonnet-5' },
    );
    expect(keyboard[0]![0]!.text).toBe('Claude Opus 5');
    expect(keyboard[1]![0]!.text).toBe('✅ Claude Sonnet 5');
  });

  it('多 provider → 按钮文本前缀分组 label 消歧', () => {
    const { keyboard } = buildModelKeyboard([ANTHROPIC, OPENAI], 'deadbeef', null);
    expect(keyboard[0]![0]!.text).toBe('anthropic · Claude Opus 5');
    expect(keyboard[2]![0]!.text).toBe('openai · GPT-5');
  });

  it('单 provider → 不加前缀（避免噪音）', () => {
    const { keyboard } = buildModelKeyboard([OPENAI], 'deadbeef', null);
    expect(keyboard[0]![0]!.text).toBe('GPT-5');
  });

  it('跨 provider 同名模型：✅ 只标匹配 provider 的那个', () => {
    const a = group('anthropic', 'anthropic', [model('shared', 'Shared')]);
    const b = group('openai', 'openai', [model('shared', 'Shared')]);
    const { keyboard } = buildModelKeyboard([a, b], 'deadbeef', { provider: 'openai', modelId: 'shared' });
    expect(keyboard[0]![0]!.text).toBe('anthropic · Shared');
    expect(keyboard[1]![0]!.text).toBe('✅ openai · Shared');
  });

  it('长 label 截断到 48 chars（含 ✅ 前缀后仍不溢出）', () => {
    const long = 'x'.repeat(120);
    const { keyboard, entries } = buildModelKeyboard([group('p', 'p', [model('m', long)])], 'deadbeef', null);
    expect(keyboard[0]![0]!.text).toBe(`${'x'.repeat(47)}…`);
    expect(entries[0]!.label).toBe(`${'x'.repeat(47)}…`);
  });

  it('name 为空 → 回落 model.id', () => {
    const { keyboard } = buildModelKeyboard([group('p', 'p', [model('gpt-5', '')])], 'deadbeef', null);
    expect(keyboard[0]![0]!.text).toBe('gpt-5');
  });

  it('超出 max → 只渲染前 max 个，overflow 计数正确', () => {
    const many = group(
      'p',
      'p',
      Array.from({ length: 30 }, (_, i) => model(`m${i}`, `M${i}`)),
    );
    const { keyboard, entries, overflow } = buildModelKeyboard([many], 'deadbeef', null, 24);
    expect(keyboard).toHaveLength(24);
    expect(entries).toHaveLength(24);
    expect(overflow).toBe(6);
    // 最后渲染的是第 24 个（index 23），callback 下标连续
    expect(keyboard[23]![0]!.callback_data).toBe('sm:deadbeef:23');
  });

  it('不变量：任意输入下 keyboard.length === entries.length（否则 callback 下标全错位）', () => {
    const cases: ModelGroup[][] = [
      [],
      [ANTHROPIC],
      [ANTHROPIC, OPENAI],
      [group('p', 'p', Array.from({ length: 30 }, (_, i) => model(`m${i}`, `M${i}`)))],
      [group('a', 'a', [model('x', 'X')]), group('b', 'b', Array.from({ length: 25 }, (_, i) => model(`n${i}`, `N${i}`)))],
    ];
    for (const groups of cases) {
      const { keyboard, entries } = buildModelKeyboard(groups, 'deadbeef', null);
      expect(keyboard).toHaveLength(entries.length);
      // 每个按钮的 idx 必须精确指向同下标的 entry
      keyboard.forEach((row, i) => {
        expect(row).toHaveLength(1);
        expect(row[0]!.callback_data).toBe(`sm:deadbeef:${i}`);
      });
    }
  });

  it('空 groups → 空 keyboard / entries / overflow 0', () => {
    const { keyboard, entries, overflow } = buildModelKeyboard([], 'deadbeef', null);
    expect(keyboard).toEqual([]);
    expect(entries).toEqual([]);
    expect(overflow).toBe(0);
  });

  it('callback_data 恒在 Telegram 64-byte 上限内', () => {
    const { keyboard } = buildModelKeyboard([ANTHROPIC], 'ffffffff', null);
    for (const row of keyboard) {
      expect(Buffer.byteLength(row[0]!.callback_data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});

// ─── controller: onCommand ───────────────────────────────────────

describe('createTelegramModelController — onCommand', () => {
  it('列出全部可用模型 + keyboard，当前模型 ✅ 标注', async () => {
    const { controller, calls } = makeController({
      current: { provider: 'anthropic', modelId: 'claude-opus-5' },
    });

    await controller.onCommand(INBOUND);

    const msg = lastSendMessage(calls);
    expect(msg).toBeDefined();
    expect(msg!.chat_id).toBe(965822571);
    expect(msg!.text).toBe('🤖 Chọn model:');
    const rows = msg!.reply_markup!.inline_keyboard;
    expect(rows).toHaveLength(3);
    expect(rows[0]![0]!.text).toBe('✅ anthropic · Claude Opus 5');
  });

  it('无可用模型 → 发指引文案，不带 keyboard', async () => {
    const { controller, calls } = makeController({ groups: [] });

    await controller.onCommand(INBOUND);

    const msg = lastSendMessage(calls);
    expect(msg!.text).toContain('Chưa có model nào khả dụng');
    expect(msg!.reply_markup).toBeUndefined();
  });

  it('overflow > 0 → 文本追加提示行', async () => {
    const many = group('p', 'p', Array.from({ length: 30 }, (_, i) => model(`m${i}`, `M${i}`)));
    const { controller, calls } = makeController({ groups: [many] });

    await controller.onCommand(INBOUND);

    const msg = lastSendMessage(calls);
    expect(msg!.text).toContain('…và 6 model khác không hiển thị');
  });

  it('再次 /model → 覆盖旧 keyboard（旧 token 点击被吞，不 apply）', async () => {
    const { controller, calls, applyModel } = makeController();
    await controller.onCommand(INBOUND);
    const firstToken = lastSendMessage(calls)!.reply_markup!.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;

    await controller.onCommand(INBOUND);
    const secondToken = lastSendMessage(calls)!.reply_markup!.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;
    expect(firstToken).not.toBe(secondToken);

    // 点**旧** token（同一个 controller，非新实例）→ latest-wins 生效，静默吞。
    const editsBefore = calls.filter((c) => c.kind === 'editMessage').length;
    await controller.onCallback(callback(`sm:${firstToken}:0`));
    expect(applyModel).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.kind === 'editMessage')).toHaveLength(editsBefore);

    // 新 token 仍然可用（覆盖只废旧的，没把新的也弄坏）。
    await controller.onCallback(callback(`sm:${secondToken}:0`));
    expect(applyModel).toHaveBeenCalledTimes(1);
  });

  it('读 deps 抛错 → 发兜底文案而非静默死掉', async () => {
    const { send, calls } = makeSend();
    const controller = createTelegramModelController({
      send,
      listGroups: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
      getCurrentModel: vi.fn(async () => ({ current: null, rowExisted: false })),
      applyModel: vi.fn(async () => {}),
    });

    await controller.onCommand(INBOUND);

    const msg = lastSendMessage(calls);
    expect(msg!.text).toContain('Không đọc được danh sách model');
    expect(msg!.text).toContain('storage unavailable');
  });

  it('getCurrentModel 抛错 → 同样兜底（两个读都在同一个 try 里）', async () => {
    const { send, calls } = makeSend();
    const controller = createTelegramModelController({
      send,
      listGroups: vi.fn(async () => [ANTHROPIC]),
      getCurrentModel: vi.fn(async () => {
        throw new Error('session row read failed');
      }),
      applyModel: vi.fn(async () => {}),
    });

    await controller.onCommand(INBOUND);

    expect(lastSendMessage(calls)!.text).toContain('session row read failed');
  });

  it('keyboard send 失败（resolve null）→ 不留半死 keyboard（后续点击被吞）', async () => {
    const calls: OutboundAction[] = [];
    const send = vi.fn(async (action: OutboundAction): Promise<OutboundActionResult | null> => {
      calls.push(action);
      return null; // 无 handle / WS 断开
    });
    const applyModel = vi.fn(async () => {});
    const controller = createTelegramModelController({
      send,
      listGroups: vi.fn(async () => [ANTHROPIC]),
      getCurrentModel: vi.fn(async () => ({ current: null, rowExisted: false })),
      applyModel,
    });

    await controller.onCommand(INBOUND);
    // keyboard 没送达，但 token 已写入 map —— 无从点击（用户看不到键盘），
    // 任何伪造点击也会被 index/token 校验吞掉。
    await controller.onCallback(callback('sm:00000000:0'));
    expect(applyModel).not.toHaveBeenCalled();
  });
});

// ─── controller: onCallback ──────────────────────────────────────

describe('createTelegramModelController — onCallback', () => {
  it('点击按钮 → applyModel 收到正确 identity + 确认 edit 清 keyboard', async () => {
    const { controller, calls, applyModel } = makeController();
    await controller.onCommand(INBOUND);
    const token = lastSendMessage(calls)!.reply_markup!.inline_keyboard[1]![0]!.callback_data.split(':')[1]!;

    await controller.onCallback(callback(`sm:${token}:1`));

    expect(applyModel).toHaveBeenCalledTimes(1);
    expect(applyModel).toHaveBeenCalledWith(
      965822571,
      { provider: 'anthropic', modelId: 'claude-sonnet-5' },
      false, // makeController 默认 current=null → /model 时无会话行
    );
    const edit = lastEditMessage(calls)!;
    expect(edit.chat_id).toBe(965822571);
    expect(edit.message_id).toBe(77);
    expect(edit.text).toContain('Đã chọn model: anthropic · Claude Sonnet 5');
    expect(edit.text).toContain('áp dụng từ tin nhắn tiếp theo');
    expect(edit.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('applyModel 收到 /model 时刻的 rowExisted（有会话行 → true）', async () => {
    const { controller, calls, applyModel } = makeController({
      current: { provider: 'anthropic', modelId: 'claude-opus-5' },
      rowExisted: true,
    });
    await controller.onCommand(INBOUND);
    const token = lastSendMessage(calls)!.reply_markup!.inline_keyboard[1]![0]!.callback_data.split(':')[1]!;

    await controller.onCallback(callback(`sm:${token}:1`));

    expect(applyModel).toHaveBeenCalledWith(
      965822571,
      { provider: 'anthropic', modelId: 'claude-sonnet-5' },
      true,
    );
  });

  it('one-shot：同一 token 点两次 → 只 apply 一次', async () => {
    const { controller, calls, applyModel } = makeController();
    await controller.onCommand(INBOUND);
    const token = lastSendMessage(calls)!.reply_markup!.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;

    await controller.onCallback(callback(`sm:${token}:0`));
    await controller.onCallback(callback(`sm:${token}:0`));

    expect(applyModel).toHaveBeenCalledTimes(1);
  });

  it('index 越界 → 静默吞（不 apply / 不 edit）', async () => {
    const { controller, calls, applyModel } = makeController();
    await controller.onCommand(INBOUND);
    const token = lastSendMessage(calls)!.reply_markup!.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;

    await controller.onCallback(callback(`sm:${token}:99`));

    expect(applyModel).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.kind === 'editMessage')).toHaveLength(0);
  });

  it('chat mismatch（别的 chat 的 token）→ 静默吞', async () => {
    const { controller, calls, applyModel } = makeController();
    await controller.onCommand(INBOUND);
    const token = lastSendMessage(calls)!.reply_markup!.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;

    await controller.onCallback(callback(`sm:${token}:0`, 999999));

    expect(applyModel).not.toHaveBeenCalled();
  });

  it('坏 payload → 静默吞（非 sm: / token 格式错）', async () => {
    const { controller, calls, applyModel } = makeController();
    await controller.onCommand(INBOUND);

    await controller.onCallback(callback('cap_123'));
    await controller.onCallback(callback('sm:ZZZZ:0'));
    await controller.onCallback(callback(''));

    expect(applyModel).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.kind === 'editMessage')).toHaveLength(0);
  });

  it('未发过 /model 就收到 callback → 静默吞', async () => {
    const { controller, applyModel } = makeController();
    await controller.onCallback(callback('sm:deadbeef:0'));
    expect(applyModel).not.toHaveBeenCalled();
  });

  it('applyModel 抛错 → 报错 edit + 清 keyboard（不留转圈）', async () => {
    const { controller, calls } = makeController({
      applyImpl: async () => {
        throw new Error('model not resolvable');
      },
    });
    await controller.onCommand(INBOUND);
    const token = lastSendMessage(calls)!.reply_markup!.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;

    await controller.onCallback(callback(`sm:${token}:0`));

    const edit = lastEditMessage(calls)!;
    expect(edit.text).toContain('Đổi model thất bại');
    expect(edit.text).toContain('model not resolvable');
    expect(edit.reply_markup).toEqual({ inline_keyboard: [] });
  });
});

// ─── controller: teardown ────────────────────────────────────────

describe('createTelegramModelController — teardown', () => {
  it('teardown 后旧 token 失效（迟到点击被吞）', async () => {
    const { controller, calls, applyModel } = makeController();
    await controller.onCommand(INBOUND);
    const token = lastSendMessage(calls)!.reply_markup!.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;

    controller.teardown();
    await controller.onCallback(callback(`sm:${token}:0`));

    expect(applyModel).not.toHaveBeenCalled();
  });
});
