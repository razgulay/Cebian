// chat 域客户端 handler 的订阅 cursor 端到端回归测试 —— 锁定 v1.7.0 引入的
// 「mid-stream subscribe + microtask 错位」竞态被消费者层 cursor 过滤
// 正确压制，不再依赖 commit 0822474 的 210ms 时间豁免窗。
//
// 场景：agent 在 `subscribe` 期间仍持续 emit；agent 先同步把 partial.content 写进
// `messages`，再 `await emit` 把 BG handler 排成 microtask。M_BG 在本函数的同步段
// 返回后才被调度，对应事件就只进了 `session_state` 快照、还没进缓冲——它的
// trailing 帧照样会把已存在于快照的 delta 重发一遍，导致 UI 端 "ABCC" 重复。
//
// 修法：消费者（viewers.ts）按端口 cursor 过滤——subscribe post session_state
// 之前先 seed port 的 cursor 为快照里最后一条 assistant 的各块长度，之后
// 任何 tail_append 的 endOffset ≤ cursor 即被丢弃。这里直接复用真 viewer /
// 真 stream-broadcast、mock 掉 sessionManager / sessionStore，端到端断言新
// viewer 不会被重复 delta 影响。

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
const { queueStreamEvent, dropStreamBroadcast, flushStreamOps, FLUSH_INTERVAL_MS } =
  await import('./stream-broadcast');

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

describe('chatClientHandlers.subscribe · 流式 cursor 端到端', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.clearAllMocks();
    // fake timer 才能让 leading 起算的 trailing timer 走 fake 队列（否则
    // advanceTimersByTime 不会驱动它，测试无法断言「trailing 真的 fire 了、
    // 但被 cursor 过滤掉了」）。
    vi.useFakeTimers();
    dropStreamBroadcast(S);
    // 默认：agent 正在 stream，session_state 的最后一条 assistant text = "ABC"。
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

  it('新 viewer 不会被「已被快照覆盖」的重复 stream_ops 影响——cursor 端到端过滤', async () => {
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

    // 订阅：handle 在 snapshot 完毕后会立刻 seed port 的 cursor（= "ABC".length=3）
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
    // （partial.content 已被 sync 改到 'ABC'，await emit 排在 microtask 队列尾，
    //   subscribe 的同步段先于 M_BG 跑完）。这就是会与快照重复的那一帧。
    partial.content[0].text = 'ABC'; // 模拟 pi 在 emit 之前已同步把 partial 写到 'ABC'
    queueStreamEvent(S, {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'C',
      partial,
    } as never);

    // 让 trailing timer 触发。**故意**超过原 210ms 豁免窗——cursor 端到端
    // 过滤不应受时间影响：trailing 在任意延迟下到达，endOffset=3 ≤
    // cursor=3 都会被丢弃。
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 10);

    // 3) 关键断言：新 viewer **不应**收到带重复 'C' 的 stream_ops。
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
            '已被快照覆盖的 delta 必须被 cursor 过滤掉',
          ).not.toBe('C');
        }
      }
    }

    // 4) 反向断言：session_state 必须照发
    const allTypes = new Set(sent.map((m) => m.type));
    expect(allTypes.has('session_state')).toBe(true);
  });

  it('新 viewer 正常收「超出快照」的 stream_ops（cursor 不会过度屏蔽）', async () => {
    const { port, sent } = makePort();
    // partial.content[0].text 已是 'X'，subscribe 时会快照成 'X'（长度 1），
    // 所以 cursor = (msgId, 0, 'text') = 1。
    const partial = {
      role: 'assistant',
      content: [{ type: 'text', text: 'X' }],
      timestamp: 0,
    };
    mocks.getSessionState.mockReturnValue({
      messages: [{ role: 'assistant', content: [partial.content[0]], timestamp: 0 }],
      isRunning: true,
      isCompacting: false,
      pendingTools: [],
      pendingPermissions: [],
    });

    await chatClientHandlers.subscribe!(port, { sessionId: S } as never);
    expect(sent.some((m) => m.type === 'session_state')).toBe(true);

    // 一帧真正新增的 delta（endOffset=2 > cursor=1）必须透传
    partial.content[0].text += 'D'; // 模拟 pi 在 emit 前同步把 partial.text 追加到 'XD'（2 字符）
    queueStreamEvent(S, {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'D',
      partial,
    } as never);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS + 20);

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
    expect(gotD, '超出快照长度的 delta 必须正常下发').toBe(true);
  });

  /**
   * **Contract test, not production validation.** Test directly injects
   * `{ type: 'start' }` into `queueStreamEvent` to exercise the messageId-bump
   * path; the production bridge in `session-manager.ts` only forwards
   * `message_update` events (not the standalone `start` AssistantMessageEvent
   * — pi-agent-core converts it into a `message_start` AgentEvent), so this
   * bump branch never fires in real traffic. The live cross-turn defense is
   * `tail_replace` reseeding at each new block start (text_start /
   * thinking_start / toolcall_start all travel through `message_update`).
   * This test exists to lock in the producer-side bump contract in case the
   * bridge evolves; the production-scenario regression lives in the
   * `viewers.test.ts` cross-`messageId` key suite and the live `tail_replace`
   * path.
   */
  it('inter-turn：上一轮 cursor 不会吞掉新轮开头的 delta', async () => {
    const { port, sent } = makePort();
    // 第一轮：text="ABCDE"，cursor=5
    const partial1 = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ABCDE' }],
      timestamp: 0,
    };
    mocks.getSessionState.mockReturnValue({
      messages: [{ role: 'assistant', content: [partial1.content[0]], timestamp: 0 }],
      isRunning: true,
      isCompacting: false,
      pendingTools: [],
      pendingPermissions: [],
    });
    await chatClientHandlers.subscribe!(port, { sessionId: S } as never);

    // 模拟新一轮 'start'：messageId bump，partial.content[0].text 重置为空。
    // producer 端的 messageId 从 1 → 2，新轮的 cursor 在 (2, 0, 'text') 下从 0 起步。
    const partial2 = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      timestamp: 0,
    };
    queueStreamEvent(S, { type: 'start', partial: partial2 } as never);
    partial2.content[0].text += 'XY'; // 模拟 pi 同步写完
    queueStreamEvent(S, {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'XY',
      partial: partial2,
    } as never);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS + 20);

    // 关键断言：port 应收到 'XY'（endOffset=2 > 新轮 cursor=0）。如果 cursor
    // key 没有 messageId，新轮的 (0, text) 会撞上旧轮 cursor=5，'XY' 被错误吞掉。
    const streamOps = sent.filter((m) => m.type === 'stream_ops') as Extract<
      ServerMessage,
      { type: 'stream_ops' }
    >[];
    const gotXY = streamOps.some((frame) =>
      frame.ops.some(
        (op) =>
          op.kind === 'tail_append' &&
          op.field === 'text' &&
          op.blockIndex === 0 &&
          op.delta === 'XY',
      ),
    );
    expect(gotXY, '新轮 messageId 自成 cursor key，旧轮 cursor 不影响新轮').toBe(true);
  });
});
