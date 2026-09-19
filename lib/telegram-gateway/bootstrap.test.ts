// Tests for `lib/telegram-gateway/bootstrap.ts`. The bootstrap helper wires:
//   - createWorkerClient →
//   - broadcastAll `telegram_gateway_status` / `telegram_gateway_inbound` (BG 侧
//     跨 context 桥；useBackgroundAgent.handleMessage 在 sidepanel 把它们喂回
//     本侧 channel) →
//   - acquireKeepAlive / releaseKeepAlive lifecycle hooks.
//
// We mock `createWorkerClient` so the test stays focused on the bootstrap wiring
// (not on worker-client's reconnect logic — that's covered by D2 tests). The
// fake client exposes minimal `onMessage` / `onStatus` / `close` so the bootstrap's
// registered listeners can be invoked directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerClientHandle } from './worker-client';
import type { ConnectionStatus, InboundMessage } from './types';

// Hoisted mocks — declared before import so vitest's auto-mock captures them.
const { mockAcquire, mockRelease } = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
}));
vi.mock('@/entrypoints/background/lifecycle/keepalive', () => ({
  acquireKeepAlive: mockAcquire,
  releaseKeepAlive: mockRelease,
}));

const { mockCreateWorkerClient } = vi.hoisted(() => ({
  mockCreateWorkerClient: vi.fn(),
}));
vi.mock('./worker-client', () => ({
  createWorkerClient: mockCreateWorkerClient,
}));

const { mockBroadcastAll } = vi.hoisted(() => ({
  mockBroadcastAll: vi.fn(),
}));
vi.mock('@/entrypoints/background/ipc/port-registry', () => ({
  broadcastAll: mockBroadcastAll,
  post: vi.fn(),
}));

// Import after mocks are hoisted.
const { bootstrapTelegramGateway } = await import('./bootstrap');

interface FakeClient extends WorkerClientHandle {
  /** Manually fire an inbound message to all subscribers (simulates Worker
   *  delivery). */
  fireInbound: (msg: InboundMessage) => void;
  /** Manually fire a status change. */
  fireStatus: (s: ConnectionStatus) => void;
}

function makeFakeClient(): FakeClient {
  const messageListeners = new Set<(m: InboundMessage) => void>();
  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  const handle: FakeClient = {
    onMessage: (cb: (m: InboundMessage) => void) => {
      messageListeners.add(cb);
      return () => {
        messageListeners.delete(cb);
      };
    },
    onStatus: (cb: (s: ConnectionStatus) => void) => {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },
    sendOutbound: vi.fn(async () => ({
      kind: 'sendMessage_result' as const,
      request_id: 'x',
      ok: true,
      message_id: 1,
    })),
    close: vi.fn(),
    getStatus: () => 'connected' as ConnectionStatus,
    fireInbound(msg: InboundMessage) {
      for (const cb of messageListeners) cb(msg);
    },
    fireStatus(s: ConnectionStatus) {
      for (const cb of statusListeners) cb(s);
    },
  } as unknown as WorkerClientHandle & FakeClient;
  return handle as FakeClient;
}

beforeEach(() => {
  mockAcquire.mockClear();
  mockRelease.mockClear();
  mockCreateWorkerClient.mockReset();
  mockBroadcastAll.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bootstrapTelegramGateway', () => {
  it('creates a worker-client with the provided url + token', () => {
    const fake = makeFakeClient();
    mockCreateWorkerClient.mockReturnValue(fake);

    bootstrapTelegramGateway({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
    });

    expect(mockCreateWorkerClient).toHaveBeenCalledWith({
      url: 'wss://gw.example.com/ws',
      token: 'tok',
      initialBackoffMs: undefined,
      maxBackoffMs: undefined,
      signal: undefined,
    });
  });

  it('acquires keepalive on boot, releases on teardown', () => {
    const fake = makeFakeClient();
    mockCreateWorkerClient.mockReturnValue(fake);

    const handle = bootstrapTelegramGateway({ url: 'u', token: 't' });
    expect(mockAcquire).toHaveBeenCalledTimes(1);
    expect(mockRelease).not.toHaveBeenCalled();

    handle.teardown();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('bridges worker-client.sendOutbound via the returned handle', async () => {
    // Outbound 不再走 channel（UI 侧 channel.outboundSender 始终为 null）——
    // BG 侧 client-handlers 的 `telegram_gateway_send` 走返回的 handle。
    const fake = makeFakeClient();
    mockCreateWorkerClient.mockReturnValue(fake);

    const handle = bootstrapTelegramGateway({ url: 'u', token: 't' });

    const action = {
      kind: 'sendMessage' as const,
      request_id: 'r1',
      chat_id: 1,
      text: 'hi',
    };
    const result = await handle.client.sendOutbound(action);
    expect(fake.sendOutbound).toHaveBeenCalledWith(action);
    expect(result.kind).toBe('sendMessage_result');
  });

  it('broadcastAll telegram_gateway_inbound when worker-client fires inbound', () => {
    const fake = makeFakeClient();
    mockCreateWorkerClient.mockReturnValue(fake);

    bootstrapTelegramGateway({ url: 'u', token: 't' });

    fake.fireInbound({
      kind: 'telegram_message',
      update_id: 1,
      message_id: 1,
      chat_id: 100,
      chat_type: 'private',
      text: 'hello',
      date: 1737000000,
      from: { id: 99 },
    });

    expect(mockBroadcastAll).toHaveBeenCalledWith({
      type: 'telegram_gateway_inbound',
      message: expect.objectContaining({ text: 'hello', chat_id: 100 }),
    });
  });

  it('broadcastAll telegram_gateway_status when worker-client fires status', () => {
    const fake = makeFakeClient();
    mockCreateWorkerClient.mockReturnValue(fake);

    bootstrapTelegramGateway({ url: 'u', token: 't' });

    fake.fireStatus('reconnecting');
    fake.fireStatus('connected');

    expect(mockBroadcastAll).toHaveBeenCalledWith({
      type: 'telegram_gateway_status',
      status: 'reconnecting',
    });
    expect(mockBroadcastAll).toHaveBeenCalledWith({
      type: 'telegram_gateway_status',
      status: 'connected',
    });
  });

  it('teardown closes the client', () => {
    const fake = makeFakeClient();
    mockCreateWorkerClient.mockReturnValue(fake);

    const handle = bootstrapTelegramGateway({ url: 'u', token: 't' });

    handle.teardown();

    expect(fake.close).toHaveBeenCalled();
  });

  it('teardown is idempotent (calling twice does not double-release keepalive)', () => {
    const fake = makeFakeClient();
    mockCreateWorkerClient.mockReturnValue(fake);

    const handle = bootstrapTelegramGateway({ url: 'u', token: 't' });
    handle.teardown();
    handle.teardown();

    // The bootstrap helper guards against double-release: second teardown is
    // a no-op via a closed flag (releaseKeepAlive must only fire once per
    // acquireKeepAlive to keep the keepalive reference counter balanced).
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
