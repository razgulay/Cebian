// Unit tests for `lib/telegram-gateway/worker-client.ts`.
//
// Strategy: inject a mock WebSocket via `WebSocketCtor` option. The mock
// implements the minimal subset of the WebSocket API that the client uses
// (readyState, send, addEventListener('open' | 'message' | 'close' | 'error'),
// close). We drive the mock's lifecycle manually inside each test — no real
// network involved. `setTimeout` calls are awaited with `vi.useFakeTimers()`
// + `vi.advanceTimersByTimeAsync()` for deterministic reconnect timing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerClient, type WorkerClientHandle } from './worker-client';
import type { ConnectionStatus, InboundMessage, OutboundAction, OutboundResult } from './types';

/** Minimal mock WebSocket — tracks listeners + a queue of sent strings, lets
 *  tests fire `open` / `close` / `error` / dispatch `message` synchronously. */
class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  /** WebSocket readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED. */
  readyState = 0;
  url: string;
  sent: string[] = [];
  /** key = event name ('open'|'message'|'close'|'error'); value = listener list. */
  listeners = new Map<string, Array<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(name: string, fn: (ev: unknown) => void): void {
    let arr = this.listeners.get(name);
    if (!arr) {
      arr = [];
      this.listeners.set(name, arr);
    }
    arr.push(fn);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', { code, reason });
  }

  /** Test helpers — fire lifecycle events. */
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch('open', {});
  }

  errorThenClose(): void {
    this.dispatch('error', {});
    this.close(1006, 'abnormal');
  }

  deliver(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) });
  }

  private dispatch(name: string, ev: unknown): void {
    for (const fn of this.listeners.get(name) ?? []) {
      try { fn(ev); } catch { /* ignore */ }
    }
  }
}

/** Returns `{ instances, ctor }` — every `new ctor(url)` pushes a MockWebSocket
 *  into `instances` so tests can drive each lifecycle independently. */
function freshInstances(): {
  instances: MockWebSocket[];
  ctor: new (url: string) => WebSocket;
} {
  const instances: MockWebSocket[] = [];
  const Ctor = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  } as unknown as new (url: string) => WebSocket;
  return { instances, ctor: Ctor };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createWorkerClient', () => {
  it('opens WS on construction; status transitions connecting → connected on `open`', () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'abc123',
      WebSocketCtor: Ctor,
    });

    expect(instances).toHaveLength(1);
    expect(client.getStatus()).toBe('connecting');

    instances[0]!.open();

    expect(client.getStatus()).toBe('connected');
    client.close();
  });

  it('sends outbound immediately when connected', async () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      WebSocketCtor: Ctor,
    });
    instances[0]!.open();

    const action: OutboundAction = { kind: 'sendMessage', request_id: 'r1', chat_id: 1, text: 'hi' };
    const ackPromise = client.sendOutbound(action);

    expect(instances[0]!.sent).toEqual([JSON.stringify(action)]);

    // Simulate Worker reply
    const reply: OutboundResult = { kind: 'sendMessage_result', request_id: 'r1', ok: true, message_id: 99 };
    instances[0]!.deliver(reply);

    await expect(ackPromise).resolves.toEqual(reply);
    client.close();
  });

  it('correlates gateway_result replies for sendChatAction / editMessage actions', async () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      WebSocketCtor: Ctor,
    });
    instances[0]!.open();

    const editAction: OutboundAction = {
      kind: 'editMessage',
      request_id: 'e1',
      chat_id: 1,
      message_id: 99,
      text: 'streaming…',
    };
    const editAck = client.sendOutbound(editAction);
    expect(instances[0]!.sent).toEqual([JSON.stringify(editAction)]);
    instances[0]!.deliver({ kind: 'gateway_result', request_id: 'e1', ok: true });
    await expect(editAck).resolves.toEqual({ kind: 'gateway_result', request_id: 'e1', ok: true });

    const typingAction: OutboundAction = {
      kind: 'sendChatAction',
      request_id: 't1',
      chat_id: 1,
      action: 'typing',
    };
    const typingAck = client.sendOutbound(typingAction);
    instances[0]!.deliver({
      kind: 'gateway_result',
      request_id: 't1',
      ok: false,
      error: 'chat_id not in whitelist',
    });
    await expect(typingAck).resolves.toEqual({
      kind: 'gateway_result',
      request_id: 't1',
      ok: false,
      error: 'chat_id not in whitelist',
    });

    client.close();
  });

  it('queues outbound when WS not yet OPEN; flushes on `open`', async () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      WebSocketCtor: Ctor,
    });

    // WS still CONNECTING — outbound should queue
    const action: OutboundAction = { kind: 'sendMessage', request_id: 'r2', chat_id: 1, text: 'q' };
    // Intentionally don't await — the test is checking the queue, not the ack.
    // `.catch(() => {})` suppresses the unhandled-rejection warning that vitest
    // flags when the test ends without the promise settling (close() rejects it).
    void client.sendOutbound(action).catch(() => {});
    expect(instances[0]!.sent).toEqual([]);
    expect(client.getStatus()).toBe('connecting');

    // WS opens → queue flushes
    instances[0]!.open();
    expect(instances[0]!.sent).toEqual([JSON.stringify(action)]);

    client.close();
  });

  it('delivers inbound messages to onMessage subscribers', () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      WebSocketCtor: Ctor,
    });
    instances[0]!.open();

    const received: InboundMessage[] = [];
    client.onMessage((m) => { received.push(m); });
    const inbound: InboundMessage = {
      kind: 'telegram_message',
      update_id: 1,
      message_id: 2,
      chat_id: 3,
      chat_type: 'private',
      text: 'hi',
      date: 1737000000,
      from: { id: 99 },
    };
    instances[0]!.deliver(inbound);

    expect(received).toEqual([inbound]);
    client.close();
  });

  it('on close → status reconnecting + new WS after backoff', async () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      initialBackoffMs: 100,
      WebSocketCtor: Ctor,
    });
    instances[0]!.open();

    // Close current socket
    instances[0]!.close();
    expect(client.getStatus()).toBe('reconnecting');

    // No new WS yet — backoff pending
    expect(instances).toHaveLength(1);

    // Advance past backoff
    await vi.advanceTimersByTimeAsync(150);

    // Second WS constructed
    expect(instances).toHaveLength(2);
    expect(instances[1]!.url).toContain('token=tok');

    client.close();
  });

  it('backoff doubles on each failure, caps at maxBackoffMs', async () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      initialBackoffMs: 100,
      maxBackoffMs: 400,
      WebSocketCtor: Ctor,
    });

    // First attempt fails immediately
    instances[0]!.errorThenClose();
    await vi.advanceTimersByTimeAsync(150);
    expect(instances).toHaveLength(2);

    // Second attempt fails
    instances[1]!.errorThenClose();
    await vi.advanceTimersByTimeAsync(250);
    expect(instances).toHaveLength(3);

    // Third attempt fails (backoff should now be 400 = capped)
    instances[2]!.errorThenClose();
    await vi.advanceTimersByTimeAsync(450);
    expect(instances).toHaveLength(4);

    client.close();
  });

  it('successful connect resets backoff to initialBackoffMs', async () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      initialBackoffMs: 100,
      maxBackoffMs: 800,
      WebSocketCtor: Ctor,
    });

    // First failure — backoff becomes 100 → 200
    instances[0]!.errorThenClose();
    await vi.advanceTimersByTimeAsync(150);
    expect(instances).toHaveLength(2);

    // Second succeeds — backoff should reset
    instances[1]!.open();

    // Now a third failure — backoff should start at 100 again, not 400
    instances[1]!.errorThenClose();
    await vi.advanceTimersByTimeAsync(150);
    expect(instances).toHaveLength(3);

    client.close();
  });

  it('close() during reconnect stops the loop', async () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      initialBackoffMs: 100,
      WebSocketCtor: Ctor,
    });
    instances[0]!.errorThenClose();
    expect(client.getStatus()).toBe('reconnecting');

    client.close();
    expect(client.getStatus()).toBe('disconnected');

    // Advance past backoff — no new WS should appear
    await vi.advanceTimersByTimeAsync(200);
    expect(instances).toHaveLength(1);
  });

  it('rejects all pending acks on close', async () => {
    const { instances, ctor: Ctor } = freshInstances();
    const client = createWorkerClient({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      WebSocketCtor: Ctor,
    });
    instances[0]!.open();

    const promises = [
      client.sendOutbound({ kind: 'sendMessage', request_id: 'r1', chat_id: 1, text: 'a' }),
      client.sendOutbound({ kind: 'sendMessage', request_id: 'r2', chat_id: 1, text: 'b' }),
    ];
    client.close();

    await expect(promises[0]).rejects.toThrow(/closed/);
    await expect(promises[1]).rejects.toThrow(/closed/);
  });
});
