// Unit tests for the canvas sidepanel channel's pure logic.
//
// Tests the publish/subscribe state machine that backs `useCanvasChannel`:
//   - snapshot caching per active session
//   - fanout to subscribers
//   - cross-session filtering (which the ST-A5 reviewer flagged as a real bug)
//   - port lifecycle (setPort → reset on null)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasChannel } from './sidepanel-channel';
import type { CanvasServerMessage } from './protocol';

const SESSION_A = 'session-A';
const SESSION_B = 'session-B';

function reset(): void {
  // 清掉上一次测试残留的 port + activeSession。setPort(null) 把 portRef
  // 置空，但 activeSessionId 与 snapshot 还要单独清——通过 setActiveSession(null)
  // 走，正常测试代码不该知道 channel 内部字段。
  canvasChannel.setActiveSession(null);
  canvasChannel.setPort(null);
}

describe('sidepanel-channel: snapshot cache (getLastSnapshot)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('cached snapshot for active session is returned', () => {
    canvasChannel.setActiveSession(SESSION_A);
    canvasChannel.handleMessage({
      type: 'canvas_opened',
      sessionId: SESSION_A,
      path: '/foo.html',
      content: '<p>hi</p>',
    } satisfies CanvasServerMessage);
    expect(canvasChannel.getLastSnapshot()).toEqual({
      sessionId: SESSION_A,
      openFile: {
        path: '/foo.html',
        content: '<p>hi</p>',
        updatedAt: expect.any(Number),
      },
    });
  });

  it('a snapshot for a different session is hidden when active sessionId is set', () => {
    canvasChannel.setActiveSession(SESSION_A);
    canvasChannel.handleMessage({
      type: 'canvas_opened',
      sessionId: SESSION_B,
      path: '/other.html',
      content: 'foreign',
    } satisfies CanvasServerMessage);
    // Active = A，但 cache 与 B 的事件无关（matchesActive 守门禁止写入 cache）。
    expect(canvasChannel.getLastSnapshot()).toBeNull();
  });

  it('snapshot hidden when activeSessionId is null (no session subscribed)', () => {
    canvasChannel.setActiveSession(null);
    canvasChannel.handleMessage({
      type: 'canvas_opened',
      sessionId: SESSION_A,
      path: '/foo.html',
      content: 'x',
    } satisfies CanvasServerMessage);
    expect(canvasChannel.getLastSnapshot()).toBeNull();
  });

  it('clears cached snapshot when activeSessionId flips to a different session', () => {
    canvasChannel.setActiveSession(SESSION_A);
    canvasChannel.handleMessage({
      type: 'canvas_opened',
      sessionId: SESSION_A,
      path: '/a.html',
      content: 'a',
    } satisfies CanvasServerMessage);
    canvasChannel.setActiveSession(SESSION_B);
    // B 的 cache 也还没建立；A 的旧 cache 已被 setActiveSession 清空。
    expect(canvasChannel.getLastSnapshot()).toBeNull();
  });
});

describe('sidepanel-channel: fanout (subscribeSnapshot)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('subscriber receives canvas_state pushed via handleMessage', () => {
    const received: unknown[] = [];
    canvasChannel.subscribeSnapshot((s) => {
      received.push(s);
    });
    canvasChannel.handleMessage({
      type: 'canvas_state',
      sessionId: SESSION_A,
      openPath: '/x.html',
      content: 'y',
    } satisfies CanvasServerMessage);
    expect(received).toHaveLength(1);
    expect((received[0] as { sessionId: string }).sessionId).toBe(SESSION_A);
  });

  it('listener error does not break sibling subscribers (try/catch)', () => {
    const a = vi.fn();
    const b = vi.fn();
    canvasChannel.subscribeSnapshot(() => {
      throw new Error('boom');
    });
    canvasChannel.subscribeSnapshot(a);
    canvasChannel.subscribeSnapshot(b);

    // Suppress console.warn noise for the deliberately-broken subscriber.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    canvasChannel.handleMessage({
      type: 'canvas_opened',
      sessionId: SESSION_A,
      path: '/x.html',
      content: 'y',
    } satisfies CanvasServerMessage);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('unsubscribe stops further deliveries', () => {
    const cb = vi.fn();
    const unsub = canvasChannel.subscribeSnapshot(cb);
    unsub();
    canvasChannel.handleMessage({
      type: 'canvas_file_changed',
      sessionId: SESSION_A,
      path: '/x.html',
      content: 'y',
    } satisfies CanvasServerMessage);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('sidepanel-channel: handleMessage cross-session guard', () => {
  beforeEach(reset);
  afterEach(reset);

  it('foreign-session canvas_file_changed is still fanned out (subscriber filters; this test pins the channel contract)', () => {
    canvasChannel.setActiveSession(SESSION_A);
    const cb = vi.fn();
    canvasChannel.subscribeSnapshot(cb);

    canvasChannel.handleMessage({
      type: 'canvas_file_changed',
      sessionId: SESSION_B,
      path: '/foreign.html',
      content: 'data',
    } satisfies CanvasServerMessage);

    // Channel 必须把消息推到 subscriber——filter 是 subscriber（useCanvasChannel）
    // 的职责，不是 channel。这里「锁定契约」防止后续误优化把 fanout 也按
    // activeSessionId 过滤掉，从而导致 UI 完全收不到 BG 推送。
    expect(cb).toHaveBeenCalledOnce();
    expect((cb.mock.calls[0][0] as { sessionId: string }).sessionId).toBe(SESSION_B);
    // 但 channel 自己的 lastSnapshot cache 不动——foreign session 不污染 active session 的视图。
    expect(canvasChannel.getLastSnapshot()).toBeNull();
  });

  it('canvas_state with openPath=null clears the active session cache', () => {
    canvasChannel.setActiveSession(SESSION_A);
    canvasChannel.handleMessage({
      type: 'canvas_opened',
      sessionId: SESSION_A,
      path: '/a.html',
      content: 'x',
    } satisfies CanvasServerMessage);
    expect(canvasChannel.getLastSnapshot()?.openFile).not.toBeNull();

    canvasChannel.handleMessage({
      type: 'canvas_state',
      sessionId: SESSION_A,
      openPath: null,
      content: null,
    } satisfies CanvasServerMessage);
    // matchesActive 通过 → cache 被覆写成 null content（关闭的文件）。
    expect(canvasChannel.getLastSnapshot()).toEqual({
      sessionId: SESSION_A,
      openFile: null,
    });
  });
});

describe('sidepanel-channel: port lifecycle (setPort)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('setPort(null) clears activeSessionId', () => {
    canvasChannel.setActiveSession(SESSION_A);
    expect(canvasChannel.getActiveSessionId()).toBe(SESSION_A);
    canvasChannel.setPort(null);
    expect(canvasChannel.getActiveSessionId()).toBeNull();
  });

  it('isConnected is false initially and stays false after setPort(null)', () => {
    // isConnected 在端口未注册时为 false；setPort(null) 幂等。
    // （构造一个真实的 chrome.runtime.Port 不在 unit test 范围内 —— 真正的
    // connect 路径走 useBackgroundAgent.connect 的 happy path）
    expect(canvasChannel.isConnected()).toBe(false);
    canvasChannel.setPort(null);
    expect(canvasChannel.isConnected()).toBe(false);
  });
});
