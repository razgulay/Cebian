// chat viewer 路由的流式 cursor 过滤单元测试。
//
// 锁定四个契约：
//   1) tail_append 的 endOffset ≤ cursor → 整段丢弃（已被快照覆盖）；
//   2) tail_append 的 startOffset < cursor < endOffset → 部分重叠，裁掉
//      重叠前缀再下发；
//   3) 跨轮 messageId 隔离——上一轮 (blockIndex, field) 的 cursor 不会
//      影响新轮同 key 的 delta 通过；
//   4) tail_replace reseed 该消息各块的 cursor 为快照长度。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { BroadcastMessage, ServerMessage, StreamOp } from '@/lib/ipc/protocol';

const mocks = vi.hoisted(() => ({
  // getCurrentMessageId 由 viewers.ts 从 stream-broadcast 导入；测试里替成
  // 一个可控的 fake，让 messageId 跨用例显式可调。
  getCurrentMessageId: vi.fn(),
}));

vi.mock('./stream-broadcast', () => ({
  getCurrentMessageId: mocks.getCurrentMessageId,
}));

const { broadcastToViewers, sendSessionStateToAllViewers, sendSessionStateToPort, setViewing } =
  await import('./viewers');

const S = 'session-A';

function makePort(): { port: chrome.runtime.Port; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const port = {
    postMessage: vi.fn((msg: ServerMessage) => {
      sent.push(msg);
    }),
  } as unknown as chrome.runtime.Port;
  return { port, sent };
}

function assistantMsg(content: unknown[], role = 'assistant'): BroadcastMessage {
  return { role, content, timestamp: 0 } as unknown as BroadcastMessage;
}

const textAppend = (
  messageId: number,
  blockIndex: number,
  field: 'text' | 'thinking' | 'partialJson',
  delta: string,
  startOffset: number,
  endOffset: number,
): StreamOp => ({ kind: 'tail_append', messageId, blockIndex, field, delta, startOffset, endOffset });

beforeEach(() => {
  fakeBrowser.reset();
  vi.clearAllMocks();
  mocks.getCurrentMessageId.mockReturnValue(0);
});

describe('viewers · 流式 cursor 过滤', () => {
  it('endOffset ≤ cursor：tail_append 整段丢弃（已被快照覆盖）', () => {
    const { port, sent } = makePort();
    // 假装 port 已订阅 S
    setViewing(port, S);

    // 先用 session_state seed cursor：text 长度 3 → cursor = 3
    mocks.getCurrentMessageId.mockReturnValue(1);
    sendSessionStateToAllViewers(S, {
      type: 'session_state',
      sessionId: S,
      messages: [assistantMsg([{ type: 'text', text: 'ABC' }])],
      isRunning: true,
    } as never);

    // 一帧 endOffset=3 ≤ cursor=3 的 tail_append——必须丢弃
    broadcastToViewers(S, {
      type: 'stream_ops',
      sessionId: S,
      ops: [textAppend(1, 0, 'text', 'ABC', 0, 3)],
    });

    expect(sent.some((m) => m.type === 'stream_ops')).toBe(false);
  });

  it('endOffset > cursor 且 startOffset = cursor：tail_append 原样下发', () => {
    const { port, sent } = makePort();
    setViewing(port, S);

    mocks.getCurrentMessageId.mockReturnValue(1);
    sendSessionStateToAllViewers(S, {
      type: 'session_state',
      sessionId: S,
      messages: [assistantMsg([{ type: 'text', text: 'ABC' }])],
      isRunning: true,
    } as never);

    broadcastToViewers(S, {
      type: 'stream_ops',
      sessionId: S,
      ops: [textAppend(1, 0, 'text', 'DEF', 3, 6)],
    });

    const streamOps = sent.filter((m) => m.type === 'stream_ops') as Extract<
      ServerMessage,
      { type: 'stream_ops' }
    >[];
    expect(streamOps).toHaveLength(1);
    expect(streamOps[0].ops).toEqual([textAppend(1, 0, 'text', 'DEF', 3, 6)]);
  });

  it('startOffset < cursor < endOffset：partial overlap，裁掉重叠前缀', () => {
    const { port, sent } = makePort();
    setViewing(port, S);

    // cursor seed = 3（text="ABC"）
    mocks.getCurrentMessageId.mockReturnValue(1);
    sendSessionStateToAllViewers(S, {
      type: 'session_state',
      sessionId: S,
      messages: [assistantMsg([{ type: 'text', text: 'ABC' }])],
      isRunning: true,
    } as never);

    // 一个跨 cursor 的 trailing 帧：startOffset=1, endOffset=4, delta='BCD'
    // cursor=3 → 跳过 'BC'，只下发 'D'
    broadcastToViewers(S, {
      type: 'stream_ops',
      sessionId: S,
      ops: [textAppend(1, 0, 'text', 'BCD', 1, 4)],
    });

    const streamOps = sent.filter((m) => m.type === 'stream_ops') as Extract<
      ServerMessage,
      { type: 'stream_ops' }
    >[];
    expect(streamOps).toHaveLength(1);
    expect(streamOps[0].ops).toEqual([textAppend(1, 0, 'text', 'D', 3, 4)]);
  });

  it('新轮 messageId 自成 cursor key：旧轮 cursor 不会影响新轮', () => {
    const { port, sent } = makePort();
    setViewing(port, S);

    // 第一轮：cursor seed=5（text="ABCDE"），messageId=1
    mocks.getCurrentMessageId.mockReturnValue(1);
    sendSessionStateToAllViewers(S, {
      type: 'session_state',
      sessionId: S,
      messages: [assistantMsg([{ type: 'text', text: 'ABCDE' }])],
      isRunning: true,
    } as never);

    // 第二轮：messageId=2。新轮 (2, 0, text) 的 cursor 是 0（旧轮的 5 不影响）。
    mocks.getCurrentMessageId.mockReturnValue(2);
    // 模拟新一轮 'start' 的 tail_replace reseed——这里用 sendSessionStateToPort
    // 来 seed（实际生产中 producer 的 'start' 走 tail_replace，消费者按 op 的
    // messageId reseed；这里用单端口 sendSessionStateToPort 模拟更直观）。
    sendSessionStateToPort(port, {
      type: 'session_state',
      sessionId: S,
      messages: [assistantMsg([{ type: 'text', text: '' }])], // 新轮开始，text=空
      isRunning: true,
    } as never);

    // 新轮的 delta：endOffset=2 > cursor=0 → 应透传
    broadcastToViewers(S, {
      type: 'stream_ops',
      sessionId: S,
      ops: [textAppend(2, 0, 'text', 'XY', 0, 2)],
    });

    const streamOps = sent.filter((m) => m.type === 'stream_ops') as Extract<
      ServerMessage,
      { type: 'stream_ops' }
    >[];
    expect(streamOps.some((f) => f.ops.some((op) => op.kind === 'tail_append' && (op as Extract<StreamOp, { kind: 'tail_append' }>).delta === 'XY'))).toBe(true);
  });

  it('tail_replace 按 op.messageId reseed cursor', () => {
    const { port, sent } = makePort();
    setViewing(port, S);

    // 第一轮：seed cursor=3
    mocks.getCurrentMessageId.mockReturnValue(1);
    sendSessionStateToAllViewers(S, {
      type: 'session_state',
      sessionId: S,
      messages: [assistantMsg([{ type: 'text', text: 'ABC' }])],
      isRunning: true,
    } as never);

    // tail_replace 把 text 推到 'XYZ'（messageId=1）→ reseed cursor=3（不变）
    // 紧接着再发同 messageId 的 tail_append，endOffset=3 ≤ cursor=3 → 丢弃
    broadcastToViewers(S, {
      type: 'stream_ops',
      sessionId: S,
      ops: [
        {
          kind: 'tail_replace',
          messageId: 1,
          message: assistantMsg([{ type: 'text', text: 'XYZ' }]),
        },
        textAppend(1, 0, 'text', 'XYZ', 0, 3),
      ],
    });

    // tail_replace 必须透传，tail_append 必须被丢弃
    const streamOps = sent.filter((m) => m.type === 'stream_ops') as Extract<
      ServerMessage,
      { type: 'stream_ops' }
    >[];
    expect(streamOps).toHaveLength(1);
    expect(streamOps[0].ops).toEqual([
      { kind: 'tail_replace', messageId: 1, message: expect.objectContaining({ content: [{ type: 'text', text: 'XYZ' }] }) as BroadcastMessage },
    ]);
  });

  it('sendSessionStateToPort：先 seed cursor 再 post session_state', () => {
    const { port, sent } = makePort();
    setViewing(port, S);

    mocks.getCurrentMessageId.mockReturnValue(7);
    sendSessionStateToPort(port, {
      type: 'session_state',
      sessionId: S,
      messages: [assistantMsg([{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: '思考中' }])],
      isRunning: true,
    } as never);

    expect(sent.some((m) => m.type === 'session_state')).toBe(true);

    // seed 后的 cursor：(7, 0, text)=5, (7, 1, thinking)=3
    // 一个 ≤ 5 的 text delta 必须被丢弃
    broadcastToViewers(S, {
      type: 'stream_ops',
      sessionId: S,
      ops: [textAppend(7, 0, 'text', 'hello', 0, 5)],
    });
    expect(
      sent.some(
        (m) =>
          m.type === 'stream_ops' &&
          (m as Extract<ServerMessage, { type: 'stream_ops' }>).ops.some((o) => o.kind === 'tail_append'),
      ),
    ).toBe(false);

    // 一个超出 5 的 text delta（endOffset=6）必须透传
    broadcastToViewers(S, {
      type: 'stream_ops',
      sessionId: S,
      ops: [textAppend(7, 0, 'text', '!', 5, 6)],
    });
    expect(
      sent.some(
        (m) =>
          m.type === 'stream_ops' &&
          (m as Extract<ServerMessage, { type: 'stream_ops' }>).ops.some(
            (o) => o.kind === 'tail_append' && (o as Extract<StreamOp, { kind: 'tail_append' }>).delta === '!',
          ),
      ),
    ).toBe(true);
  });

  it('非 stream_ops 帧不进入 cursor 过滤（agent_start 等照发）', () => {
    const { port, sent } = makePort();
    setViewing(port, S);

    broadcastToViewers(S, { type: 'agent_start', sessionId: S } as never);
    expect(sent.some((m) => m.type === 'agent_start')).toBe(true);
  });
});
