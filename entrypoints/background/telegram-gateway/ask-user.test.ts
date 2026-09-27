// ask-user.ts 单测 —— fake deps 直接驱动 controller（DI 的意义：无需
// bootstrap / storage / WS 脚手架）。超时用例切 fake timers，其余跑真时钟
// （10 分钟 timer 与用例无关）。@/ 别名与生产源码同路径（WxtVitest 接线）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskUserRequest } from '@/lib/tools/ask-user';
import type {
  OutboundAction,
  OutboundActionResult,
  TelegramCallback,
} from '@/lib/telegram-gateway/types';
import {
  buildAskKeyboard,
  createTelegramAskController,
  makeAskToken,
  parseAskCallbackData,
} from './ask-user';

// ─── fixtures ───

const SINGLE_Q: AskUserRequest = {
  questions: [{ id: 'q1', question: 'Chọn một?', options: [{ label: 'Á' }, { label: 'Bò' }, { label: 'Cá' }] }],
};
const MULTI_Q: AskUserRequest = {
  questions: [
    { id: 'q1', question: 'Chọn nhiều?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiple: true },
  ],
};
const FREE_ONLY_Q: AskUserRequest = {
  questions: [{ id: 'q1', question: 'Tên bạn là gì?' }],
};
const NO_ANSWER_Q: AskUserRequest = {
  questions: [{ id: 'q1', question: 'Im lặng?', allow_free_text: false }],
};
const TWO_Q: AskUserRequest = {
  questions: [
    { id: 'q1', question: 'Câu 1?', options: [{ label: 'X' }, { label: 'Y' }] },
    { id: 'q2', question: 'Câu 2?', options: [{ label: 'P' }, { label: 'Q' }] },
  ],
};

/** sendMessage 一律成功并回递增 message_id（可注入失败）；edit 一律成功。 */
function makeDeps(chatId = 100) {
  const sent: OutboundAction[] = [];
  const deps = {
    send: vi.fn(async (action: OutboundAction): Promise<OutboundActionResult | null> => {
      sent.push(action);
      if (action.kind === 'sendMessage') {
        return { kind: 'sendMessage_result', request_id: action.request_id, ok: true, message_id: 1000 + sent.length };
      }
      return { kind: 'gateway_result', request_id: action.request_id, ok: true };
    }),
    resolveTool: vi.fn<(sessionId: string, response: { answers: Record<string, unknown> }) => void>(),
    cancelTool: vi.fn<(sessionId: string) => void>(),
    getActiveTurnChatId: vi.fn((): number | null => chatId),
  };
  return { deps, sent };
}

function cb(data: string, chatId = 100): TelegramCallback {
  return { kind: 'telegram_callback', callback_query_id: 'cbid', data, chat_id: chatId, message_id: 42, from: null };
}

/** 等待 controller 内部的 send 微任务链落地（onAskStart 是 fire-and-forget）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 取第一条 sendMessage 的 keyboard（onAskStart 后的题面）。 */
function firstKeyboard(sent: OutboundAction[]) {
  const first = sent.find((a) => a.kind === 'sendMessage');
  expect(first).toBeDefined();
  if (first?.kind !== 'sendMessage') throw new Error('unreachable');
  expect(first.reply_markup).toBeDefined();
  return first.reply_markup!.inline_keyboard;
}

/** 从 keyboard 任一按钮提取当前 token。 */
function tokenOf(keyboard: Array<Array<{ callback_data: string }>>): string {
  const data = keyboard[0]![0]!.callback_data;
  return data.split(':')[1]!;
}

type Controller = ReturnType<typeof createTelegramAskController>;
function makeController(deps: ReturnType<typeof makeDeps>['deps']): Controller {
  return createTelegramAskController(deps);
}

// ─── 纯函数 ───

describe('makeAskToken', () => {
  it('8 位小写 hex，多次调用不重复', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const token = makeAskToken();
      expect(token).toMatch(/^[0-9a-f]{8}$/);
      seen.add(token);
    }
    expect(seen.size).toBe(64);
  });
});

describe('parseAskCallbackData', () => {
  it('接受 option / t / done', () => {
    expect(parseAskCallbackData('au:0123abcd:0')).toEqual({ token: '0123abcd', action: { kind: 'option', index: 0 } });
    expect(parseAskCallbackData('au:deadbeef:12')).toEqual({ token: 'deadbeef', action: { kind: 'option', index: 12 } });
    expect(parseAskCallbackData('au:0123abcd:t')).toEqual({ token: '0123abcd', action: { kind: 'text' } });
    expect(parseAskCallbackData('au:0123abcd:done')).toEqual({ token: '0123abcd', action: { kind: 'done' } });
  });
  it('拒绝坏 payload（含旧 cap_ 前缀）', () => {
    expect(parseAskCallbackData('')).toBeNull();
    expect(parseAskCallbackData('cap_123')).toBeNull();
    expect(parseAskCallbackData('au:0123abcd')).toBeNull(); // 缺 action
    expect(parseAskCallbackData('au:0123abcd:t:extra')).toBeNull(); // 4 段
    expect(parseAskCallbackData('au:abc:0')).toBeNull(); // token 太短
    expect(parseAskCallbackData('au:0123ABCD:0')).toBeNull(); // 大写 hex 不收
    expect(parseAskCallbackData('au:0123abcd:xyz')).toBeNull(); // 坏 action
    expect(parseAskCallbackData('au:0123abcd:')).toBeNull(); // 空 action
  });
});

describe('buildAskKeyboard', () => {
  it('单选 + 默认可自由文本：option 行 + ✍️ 行，无 Xong', () => {
    const rows = buildAskKeyboard(SINGLE_Q.questions[0]!, 'abc12345', new Set());
    expect(rows.map((r) => r[0]!.text)).toEqual(['Á', 'Bò', 'Cá', '✍️ Nhập tay']);
    expect(rows.map((r) => r[0]!.callback_data)).toEqual([
      'au:abc12345:0',
      'au:abc12345:1',
      'au:abc12345:2',
      'au:abc12345:t',
    ]);
  });

  it('multiple: true 追加 ✅ Xong 行；已选项带 ✅ 前缀', () => {
    const rows = buildAskKeyboard(MULTI_Q.questions[0]!, 'abc12345', new Set([1]));
    expect(rows.map((r) => r[0]!.text)).toEqual(['A', '✅ B', 'C', '✍️ Nhập tay', '✅ Xong']);
    expect(rows.at(-1)![0]!.callback_data).toBe('au:abc12345:done');
  });

  it('allow_free_text: false 无 ✍️ 行', () => {
    const q = { ...MULTI_Q.questions[0]!, allow_free_text: false };
    const rows = buildAskKeyboard(q, 'abc12345', new Set());
    expect(rows.map((r) => r[0]!.text)).toEqual(['A', 'B', 'C', '✅ Xong']);
  });

  it('label > 48 chars 截断为 47 + …，callback_data 恒 ≤ 64 byte', () => {
    const long = 'x'.repeat(80);
    const rows = buildAskKeyboard(
      { id: 'q', question: '?', options: [{ label: long }] },
      'abc12345',
      new Set(),
    );
    expect(rows[0]![0]!.text).toHaveLength(48);
    expect(rows[0]![0]!.text.endsWith('…')).toBe(true);
    for (const row of rows) {
      expect(new TextEncoder().encode(row[0]!.callback_data).length).toBeLessThanOrEqual(64);
    }
  });
});

// ─── Controller flows ───

describe('ask controller — single-select', () => {
  it('渲染 keyboard → 点 option → resolve 正确 label、发 ✅ 确认 + 清键盘', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', SINGLE_Q);
    await flush();

    const token = tokenOf(firstKeyboard(sent));
    await controller.onCallback(cb(`au:${token}:1`));

    expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
      answers: { q1: { selected: ['Bò'], free_text: '', skipped: false } },
    });
    expect(deps.cancelTool).not.toHaveBeenCalled();
    const edit = sent.find((a) => a.kind === 'editMessage');
    expect(edit).toBeDefined();
    if (edit?.kind !== 'editMessage') throw new Error('unreachable');
    expect(edit.text).toBe('✅ Bò');
    expect(edit.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('stale token（旧题/已收尾）点击静默吞掉', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', SINGLE_Q);
    await flush();
    const oldToken = tokenOf(firstKeyboard(sent));
    await controller.onCallback(cb(`au:${oldToken}:0`)); // 正常收尾
    const sendCount = sent.length;

    await controller.onCallback(cb(`au:${oldToken}:1`)); // 迟到点击
    expect(sent.length).toBe(sendCount); // 无新消息/edit
    expect(deps.resolveTool).toHaveBeenCalledTimes(1);
  });
});

describe('ask controller — multi-select', () => {
  it('toggle 重绘 ✅ 前缀、不 resolve；Xong 才收口', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', MULTI_Q);
    await flush();
    const token = tokenOf(firstKeyboard(sent));

    await controller.onCallback(cb(`au:${token}:0`));
    await controller.onCallback(cb(`au:${token}:2`));
    expect(deps.resolveTool).not.toHaveBeenCalled();

    const edit = sent.filter((a) => a.kind === 'editMessage').at(-1);
    if (edit?.kind !== 'editMessage') throw new Error('unreachable');
    expect(edit.reply_markup?.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ['✅ A'], ['B'], ['✅ C'], ['✍️ Nhập tay'], ['✅ Xong'],
    ]);

    await controller.onCallback(cb(`au:${token}:done`));
    expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
      answers: { q1: { selected: ['A', 'C'], free_text: '', skipped: false } },
    });
  });

  it('Xong 时 0 selected = 整题 skipped', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', MULTI_Q);
    await flush();
    const token = tokenOf(firstKeyboard(sent));

    await controller.onCallback(cb(`au:${token}:done`));
    expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
      answers: { q1: { selected: [], free_text: '', skipped: true } },
    });
  });

  it('user 钦定回归：tick 2 → ✍️ → 文本合并 selected + free_text（不丢勾）', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', MULTI_Q);
    await flush();
    const token = tokenOf(firstKeyboard(sent));

    await controller.onCallback(cb(`au:${token}:0`));
    await controller.onCallback(cb(`au:${token}:1`));
    await controller.onCallback(cb(`au:${token}:t`)); // ✍️ 转文本 —— selected 必须存活

    const consumed = await controller.interceptInbound({
      kind: 'telegram_message', update_id: 1, message_id: 9, chat_id: 100,
      chat_type: 'private', text: 'Cả A và B nhé', date: 0, from: null,
    });
    expect(consumed).toBe(true);
    expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
      answers: { q1: { selected: ['A', 'B'], free_text: 'Cả A và B nhé', skipped: false } },
    });
  });
});

describe('ask controller — 无选项题', () => {
  it('自由文本题：纯文本无 keyboard，arm awaitingText，下一条消息即答案', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', FREE_ONLY_Q);
    await flush();

    const first = sent[0]!;
    if (first.kind !== 'sendMessage') throw new Error('unreachable');
    expect(first.reply_markup).toBeUndefined();
    expect(first.text).toBe('❓ Tên bạn là gì?');

    const consumed = await controller.interceptInbound({
      kind: 'telegram_message', update_id: 1, message_id: 9, chat_id: 100,
      chat_type: 'private', text: 'An', date: 0, from: null,
    });
    expect(consumed).toBe(true);
    expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
      answers: { q1: { selected: [], free_text: 'An', skipped: false } },
    });
  });

  it('无选项 + allow_free_text: false → auto-skip 直接 resolve，不发消息', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', NO_ANSWER_Q);
    await flush();

    expect(sent).toHaveLength(0);
    expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
      answers: { q1: { selected: [], free_text: '', skipped: true } },
    });
  });

  it('awaitingText 只消费一条：第二条文本放行为聊天', async () => {
    const { deps } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', FREE_ONLY_Q);
    await flush();
    const msg = {
      kind: 'telegram_message' as const, update_id: 1, message_id: 9, chat_id: 100,
      chat_type: 'private' as const, text: 'một', date: 0, from: null,
    };
    expect(await controller.interceptInbound(msg)).toBe(true);
    expect(await controller.interceptInbound({ ...msg, text: 'hai' })).toBe(false);
    expect(deps.resolveTool).toHaveBeenCalledTimes(1);
  });
});

describe('ask controller — 多题串行', () => {
  it('两题各一 keyboard（token 不同），答完两题才 resolve', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', TWO_Q);
    await flush();

    const token1 = tokenOf(firstKeyboard(sent));
    await controller.onCallback(cb(`au:${token1}:0`));
    expect(deps.resolveTool).not.toHaveBeenCalled(); // 还有 q2

    await flush();
    const second = sent.filter((a) => a.kind === 'sendMessage')[1]!;
    if (second.kind !== 'sendMessage' || !second.reply_markup) throw new Error('unreachable');
    expect(second.text).toBe('❓ Câu 2?');
    const token2 = second.reply_markup.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;
    expect(token2).not.toBe(token1); // 每题一个 token

    await controller.onCallback(cb(`au:${token2}:1`));
    expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
      answers: {
        q1: { selected: ['X'], free_text: '', skipped: false },
        q2: { selected: ['Q'], free_text: '', skipped: false },
      },
    });
  });
});

describe('ask controller — dismissal / 外部 resolve / teardown', () => {
  const msg = {
    kind: 'telegram_message' as const, update_id: 1, message_id: 9, chat_id: 100,
    chat_type: 'private' as const, text: 'thôi cứ làm đi', date: 0, from: null,
  };

  it('keyboard pending + 普通文本 → cancelTool、⏭ edit、消息放行（不变量 #10）', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', SINGLE_Q);
    await flush();

    const consumed = await controller.interceptInbound(msg);
    expect(consumed).toBe(false);
    expect(deps.cancelTool).toHaveBeenCalledExactlyOnceWith('sess');
    expect(deps.resolveTool).not.toHaveBeenCalled();
    const edit = sent.find((a) => a.kind === 'editMessage');
    if (edit?.kind !== 'editMessage') throw new Error('unreachable');
    expect(edit.text).toBe('⏭ Đã bỏ qua câu hỏi.');
    expect(edit.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('外部 resolve（tool_resolved）→ 清残留 + ✅ Đã trả lời，不调 resolveTool；幂等', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', SINGLE_Q);
    await flush();

    controller.onToolResolved('sess');
    expect(deps.resolveTool).not.toHaveBeenCalled();
    expect(deps.cancelTool).not.toHaveBeenCalled();
    const edit = sent.find((a) => a.kind === 'editMessage');
    if (edit?.kind !== 'editMessage') throw new Error('unreachable');
    expect(edit.text).toBe('✅ Đã trả lời.');

    const count = sent.length;
    controller.onToolResolved('sess'); // 第二次 no-op
    expect(sent.length).toBe(count);
  });

  it('teardown → 每个 pending ask cancelTool，无 edit', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', SINGLE_Q);
    await flush();

    controller.teardown();
    expect(deps.cancelTool).toHaveBeenCalledExactlyOnceWith('sess');
    expect(sent.every((a) => a.kind === 'sendMessage')).toBe(true); // 无 edit
    // teardown 后再走外部 resolve 回环：无状态可清，不炸
    expect(() => controller.onToolResolved('sess')).not.toThrow();
  });

  it('非 Telegram session（getActiveTurnChatId → null）忽略，不发消息', async () => {
    const { deps, sent } = makeDeps();
    deps.getActiveTurnChatId.mockReturnValue(null);
    const controller = makeController(deps);
    controller.onAskStart('sess', SINGLE_Q);
    await flush();
    expect(sent).toHaveLength(0);
    expect(deps.resolveTool).not.toHaveBeenCalled();
  });
});

describe('ask controller — 失败与超时', () => {
  it('题面发送失败 → cancelTool（bridge 不悬挂），不 resolve', async () => {
    const { deps } = makeDeps();
    deps.send.mockResolvedValueOnce(null); // 第一条 sendMessage 失败
    const controller = makeController(deps);
    controller.onAskStart('sess', SINGLE_Q);
    await flush();

    expect(deps.cancelTool).toHaveBeenCalledExactlyOnceWith('sess');
    expect(deps.resolveTool).not.toHaveBeenCalled();
    // mockResolvedValueOnce 绕过 impl（sent 不入列）—— 改数 mock 调用次数
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it('10 分钟超时 → 未答题补 skipped、⌛ edit + 清键盘、resolve', async () => {
    vi.useFakeTimers();
    try {
      const { deps, sent } = makeDeps();
      const controller = makeController(deps);
      controller.onAskStart('sess', TWO_Q);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
        answers: {
          q1: { selected: [], free_text: '', skipped: true },
          q2: { selected: [], free_text: '', skipped: true },
        },
      });
      const edit = sent.find((a) => a.kind === 'editMessage');
      if (edit?.kind !== 'editMessage') throw new Error('unreachable');
      expect(edit.text).toBe('⌛ Đã hết thời gian trả lời.');
      expect(edit.reply_markup).toEqual({ inline_keyboard: [] });

      // 超时后旧 keyboard 迟到点击：静默
      const before = sent.length;
      await controller.onCallback(cb('au:deadbeef:0'));
      expect(sent.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('部分超时：已答题保留答案，未答题补 skipped', async () => {
    vi.useFakeTimers();
    try {
      const { deps, sent } = makeDeps();
      const controller = makeController(deps);
      controller.onAskStart('sess', TWO_Q);
      await vi.advanceTimersByTimeAsync(0); // 首题渲染落地
      const token = tokenOf(firstKeyboard(sent));
      await controller.onCallback(cb(`au:${token}:0`)); // q1 已答 → q2 渲染

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
        answers: {
          q1: { selected: ['X'], free_text: '', skipped: false },
          q2: { selected: [], free_text: '', skipped: true },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Supersede 与 race（post-await liveness）───

/** 第一个 editMessage 调用挂起直到 release() —— 复现 confirm edit 的在途窗口。 */
function makeGatedDeps() {
  const sent: OutboundAction[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let editGated = false;
  const deps = {
    send: vi.fn(async (action: OutboundAction): Promise<OutboundActionResult | null> => {
      if (action.kind === 'editMessage' && !editGated) {
        editGated = true;
        await gate;
        sent.push(action);
        return { kind: 'gateway_result', request_id: action.request_id, ok: true };
      }
      sent.push(action);
      return action.kind === 'sendMessage'
        ? { kind: 'sendMessage_result', request_id: action.request_id, ok: true, message_id: 1000 + sent.length }
        : { kind: 'gateway_result', request_id: action.request_id, ok: true };
    }),
    resolveTool: vi.fn(),
    cancelTool: vi.fn(),
    getActiveTurnChatId: vi.fn((): number | null => 100),
  };
  return { deps, sent, release };
}

describe('ask controller — supersede 与 race', () => {
  it('supersede：新 ask 清旧场但不 cancelTool，旧 token 失效、新 ask 正常收口', async () => {
    const { deps, sent } = makeDeps();
    const controller = makeController(deps);
    controller.onAskStart('sess', SINGLE_Q);
    await flush();
    const oldToken = tokenOf(firstKeyboard(sent));
    const sendMessageCountBefore = sent.filter((a) => a.kind === 'sendMessage').length;

    controller.onAskStart('sess', TWO_Q);
    await flush();

    // 绝不 cancelTool —— bridge 槽位已属于新 ask，cancel 会把新问题杀掉
    expect(deps.cancelTool).not.toHaveBeenCalled();
    // 旧键盘被 ⏭ edit 清掉
    expect(
      sent.some((a) => a.kind === 'editMessage' && a.text === '⏭ Đã bỏ qua câu hỏi.'),
    ).toBe(true);
    // 旧 token 失效：点击静默
    const before = sent.length;
    await controller.onCallback(cb(`au:${oldToken}:0`));
    expect(sent.length).toBe(before);

    // 新 ask 正常收口（两题）
    const sends = sent.filter((a) => a.kind === 'sendMessage');
    expect(sends.length).toBe(sendMessageCountBefore + 1);
    const q1Send = sends[sendMessageCountBefore];
    if (q1Send?.kind !== 'sendMessage' || !q1Send.reply_markup) throw new Error('unreachable');
    const token2 = q1Send.reply_markup.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;
    await controller.onCallback(cb(`au:${token2}:0`)); // 答新 q1 → q2 才渲染
    const q2Send = sent.filter((a) => a.kind === 'sendMessage')[sendMessageCountBefore + 1];
    if (q2Send?.kind !== 'sendMessage' || !q2Send.reply_markup) throw new Error('unreachable');
    const token3 = q2Send.reply_markup.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;
    await controller.onCallback(cb(`au:${token3}:1`));
    expect(deps.resolveTool).toHaveBeenCalledExactlyOnceWith('sess', {
      answers: {
        q1: { selected: ['X'], free_text: '', skipped: false },
        q2: { selected: ['Q'], free_text: '', skipped: false },
      },
    });
  });

  it('race：confirm edit 在途时外部 resolve → 僵尸不复活、不 resolveTool', async () => {
    const { deps, sent, release } = makeGatedDeps();
    const controller = createTelegramAskController(deps);
    controller.onAskStart('sess', TWO_Q);
    await flush();
    const token = tokenOf(firstKeyboard(sent));

    const click = controller.onCallback(cb(`au:${token}:0`)); // q1 答 → confirm edit 挂起
    await flush(); // click 推进到 edit 在途
    expect(deps.resolveTool).not.toHaveBeenCalled();

    controller.onToolResolved('sess'); // 外部 resolve：清场
    release(); // edit 落地 → recordAnswer 续体恢复 → advance 的 liveness guard 终止
    await click;

    expect(deps.resolveTool).not.toHaveBeenCalled();
    expect(deps.cancelTool).not.toHaveBeenCalled();
    expect(sent.filter((a) => a.kind === 'sendMessage')).toHaveLength(1); // q2 不被渲染
  });

  it('race：confirm edit 在途时超时命中 → resolveTool 恰一次（expire），答案保留', async () => {
    vi.useFakeTimers();
    try {
      const { deps, sent, release } = makeGatedDeps();
      const controller = createTelegramAskController(deps);
      controller.onAskStart('sess', TWO_Q);
      await vi.advanceTimersByTimeAsync(0); // 首题渲染落地
      const token = tokenOf(firstKeyboard(sent));

      const click = controller.onCallback(cb(`au:${token}:0`)); // edit 挂起
      await vi.advanceTimersByTimeAsync(0); // 让 click 挂到 gate 上
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // expire：q1 已答保留 + q2 skipped + resolve
      release();
      await click;

      expect(deps.resolveTool).toHaveBeenCalledTimes(1);
      expect(deps.resolveTool).toHaveBeenCalledWith('sess', {
        answers: {
          q1: { selected: ['X'], free_text: '', skipped: false },
          q2: { selected: [], free_text: '', skipped: true },
        },
      });
      expect(sent.filter((a) => a.kind === 'sendMessage')).toHaveLength(1); // q2 不被渲染
    } finally {
      vi.useRealTimers();
    }
  });
});
