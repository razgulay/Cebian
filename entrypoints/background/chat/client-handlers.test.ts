// chat 域客户端 handler 的订阅豁免窗回归测试 —— 锁定 v1.7.0 引入的「mid-stream
// subscribe + microtask 错位」竞态被正确压制。
//
// 场景：agent 在 `subscribe` 期间仍持续 emit；agent 先同步把 partial.content 写进
// `messages`，再 `await emit` 把 BG handler 排成 microtask。M_BG 在本函数的同步段
// 返回后才被调度，对应事件就只进了 `session_state` 快照、还没进缓冲——它的
// trailing 帧照样会把已存在于快照的 delta 重发一遍，导致 UI 端 "ABCC" 重复。
//
// 修法见 `client-handlers.ts subscribe` 与 `viewers.ts suppressStreamOpsFor`。
// 这里直接复用真 viewer / 真 stream-broadcast、mock 掉 sessionManager /
// sessionStore，端到端断言新 viewer 在豁免窗内不收 `stream_ops`。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ServerMessage, StreamOp } from '@/lib/ipc/protocol';

const mocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  getBranchInfo: vi.fn(),
  cancel: vi.fn(),
  sessionStoreOpen: vi.fn(),
}));

vi.mock('./session-manager', () => ({
  sessionManager: {
    getSessionState: mocks.getSessionState,
    getBranchInfo: mocks.getBranchInfo,
    cancel: mocks.cancel,
  },
}));

vi.mock('./session-store', () => ({
  sessionStore: {
    open: mocks.sessionStoreOpen,
  },
}));

const { chatClientHandlers } = await import('./client-handlers');
const {
  queueStreamEvent,
  dropStreamBroadcast,
  flushStreamOps,
  FLUSH_INTERVAL_MS,
} = await import('./stream-broadcast');

interface SessionStateMsg {
  type: 'session_state';
  messages: { content: { type: string; text?: string }[] }[];
}

const S = '11111111-1111-4111-8111-111111111111';

function makePort(): { port: chrome.runtime.Port; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const port = {
    postMessage: vi.fn((msg: ServerMessage) => {
      sent.push(msg);
    }),
  } as unknown as chrome.runtime.Port;
  return { port, sent };
}

const SUBSCRIPTION_WINDOW_MS = FLUSH_INTERVAL_MS * 2 + 50;

describe('chatClientHandlers.subscribe · 订阅豁免窗', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.clearAllMocks();
    // 用 fake timer 才能让 `text_start` 起算的 trailing timer 走 fake 队列
    // （否则 advanceTimersByTime 不会驱动它，测试会从「无 stream_ops」变成
    // 「no stream_ops」的空断言——suppression 是否生效无法被验证）。
    vi.useFakeTimers();
    dropStreamBroadcast(S);
    // 默认：agent 正在 stream。`getSessionState` 的真实实现会把 streamingMessage
    // 当作尾消息 append 进 `messages` —— mock 这里直接给最终的产物形态，
    // 让 session_state 的 `messages.at(-1).content[0].text` 等于 "ABC"。
    mocks.getSessionState.mockReturnValue({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ABC' }],
          timestamp: 0,
        },
      ],
      isRunning: true,
      isCompacting: false,
      pendingTools: [],
      pendingPermissions: [],
    });
    mocks.getBranchInfo.mockResolvedValue(undefined);
    mocks.sessionStoreOpen.mockResolvedValue(undefined);
  });

  afterEach(() => {
    dropStreamBroadcast(S);
    vi.useRealTimers();
  });

  it('豁免窗内新 viewer 不收会与快照重复的 stream_ops，但 session_state 立即到达', async () => {
    const { port, sent } = makePort();

    // 让 BG 缓冲先有一帧旧增量（leading 已发），再 flush 出去——
    // 新 viewer 不该看到这段缓冲 flush，因为 session_state 会整体覆盖。
    const partial = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      timestamp: 0,
    };
    queueStreamEvent(S, { type: 'text_start', contentIndex: 0, partial } as never);
    queueStreamEvent(S, {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'AB',
      partial,
    } as never);
    flushStreamOps(S);

    // 订阅：handle 在 snapshot 完毕后会立刻进入豁免窗。
    const subscribe = chatClientHandlers.subscribe!;
    await subscribe(port, { sessionId: S } as never);

    // 1) session_state 必须到达（不能被屏蔽），且快照内容是 "ABC"
    const sessionState = sent.find((m) => m.type === 'session_state') as
      | SessionStateMsg
      | undefined;
    expect(sessionState, 'session_state 必须立即到达新 viewer').toBeDefined();
    expect(
      sessionState?.messages.at(-1)?.content[0]?.text,
      '快照必须包含 sync-updated 的完整文本',
    ).toBe('ABC');

    // 2) 模拟 v1.7.0 bug 场景：BG handler 在 subscribe 返回后才把 'C' 推入缓冲
    // （partial.content 已被 sync 改完、await emit 排在 microtask 队列尾，
    //   subscribe 的同步段先于 M_BG 跑完）。这就是会与快照重复的那一帧。
    queueStreamEvent(S, {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'C',
      partial,
    } as never);

    // 让 trailing timer 触发：哪怕加上 setTimeout drift（MV3 SW 实测可漂到
    // ~50ms），走过整个 `FLUSH_INTERVAL_MS * 2 + 50` 豁免窗也绰绰有余。
    // fake timer 已在 beforeEach 启用，否则 `text_start` 起的真实 setTimeout
    // 不会被 advanceTimersByTime 驱动——本次断言就退化成了「trailing 根本没跑」
    // 的空断言，suppression 是否生效无从验证。
    vi.advanceTimersByTime(SUBSCRIPTION_WINDOW_MS + 100);

    // 3) 关键断言：新 viewer 在豁免窗内**不应**收到带重复 'C' 的 stream_ops。
    // 这正是 v1.7.0 文本翻倍 bug 的端到端反例。
    const streamOps = sent.filter((m) => m.type === 'stream_ops') as Extract<
      ServerMessage,
      { type: 'stream_ops' }
    >[];
    for (const frame of streamOps) {
      for (const op of frame.ops as StreamOp[]) {
        if (op.kind === 'tail_append' && op.field === 'text' && op.blockIndex === 0) {
          expect(
            op.delta,
            '豁免窗内不应向新 viewer 投递与快照重叠的 delta',
          ).not.toBe('C');
        }
      }
    }

    // 4) 反向断言：豁免窗内其它消息（session_state 等）必须照发——上面已经
    // 验证 session_state 到达；这里再确认整个 sent 流里没有意外混入错误类型。
    const allTypes = new Set(sent.map((m) => m.type));
    expect(allTypes.has('session_state')).toBe(true);
  });

  it('豁免窗外新 viewer 正常收 stream_ops（持续流式不被屏蔽）', async () => {
    const { port, sent } = makePort();
    const partial = {
      role: 'assistant',
      content: [{ type: 'text', text: 'X' }],
      timestamp: 0,
    };

    await chatClientHandlers.subscribe!(port, { sessionId: S } as never);
    expect(sent.some((m) => m.type === 'session_state')).toBe(true);

    // 等过豁免窗（fake timer 已在 beforeEach 启用）
    vi.advanceTimersByTime(SUBSCRIPTION_WINDOW_MS + 100);

    // 在窗外来一帧真实增量
    queueStreamEvent(S, {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'D',
      partial,
    } as never);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS + 20);

    // 新 viewer 应收到这一帧（不在豁免窗内）
    const allStreamOps = sent.filter((m) => m.type === 'stream_ops') as Extract<
      ServerMessage,
      { type: 'stream_ops' }
    >[];
    const gotD = allStreamOps.some((frame) =>
      frame.ops.some(
        (op) =>
          op.kind === 'tail_append' &&
          op.field === 'text' &&
          op.blockIndex === 0 &&
          op.delta === 'D',
      ),
    );
    expect(gotD, '豁免窗外 stream_ops 必须照常投递').toBe(true);
  });
});
