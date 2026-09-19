// manager.test.ts — 「通电」测试：storage 落盘 → bootstrap (re)wiring 决策 +
// OpenClaw 式 session 隔离路由（确定性 UUID / 串行队列 / interactiveMode 门）。
//
// storage 用 fakeBrowser 真实实现（AGENTS.md 规则：不 mock chrome.storage，
// 用 setValue 驱动真实 watch 事件）；`bootstrapTelegramGateway`、
// `telegramGatewayChannel`、`sessionManager`、`sessionStore` mock 掉——
// sessionStore 走 Dexie（IndexedDB，单测环境没有 IDB 会挂起），用内存 fake
// 替代；manager.test 聚焦 manager 的判定逻辑。
//
// 去抖是 100ms setTimeout——fake timers 下 `advanceTimersByTimeAsync(200)`
// 确定性刷盘（microtask + timer 一起 drain）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { InboundMessage } from '@/lib/telegram-gateway/types';

const { mockBootstrap, mockPublishStatus, mockPrompt, mockCompactNow, mockSessions, broadcastTaps } = vi.hoisted(() => ({
  mockBootstrap: vi.fn(),
  mockPublishStatus: vi.fn(),
  mockPrompt: vi.fn(),
  mockCompactNow: vi.fn(async () => {}),
  mockSessions: new Map<string, { record: Record<string, unknown>; messages: unknown[] }>(),
  broadcastTaps: new Set<(msg: unknown) => void>(),
}));
vi.mock('@/lib/telegram-gateway/bootstrap', () => ({
  bootstrapTelegramGateway: mockBootstrap,
}));
vi.mock('@/lib/telegram-gateway/channel', () => ({
  telegramGatewayChannel: { publishStatus: mockPublishStatus },
}));
vi.mock('../chat/session-manager', () => ({
  sessionManager: { prompt: mockPrompt, compactNow: mockCompactNow },
}));
vi.mock('../chat/viewers', () => ({
  onBroadcastTap: vi.fn((cb: (msg: unknown) => void) => {
    broadcastTaps.add(cb);
    return () => { broadcastTaps.delete(cb); };
  }),
}));
vi.mock('../chat/session-store', () => ({
  appendSessionMessage: vi.fn(),
  sessionStore: {
    load: vi.fn(async (id: string) => mockSessions.get(id)?.record ?? null),
    open: vi.fn(async (id: string) => {
      const s = mockSessions.get(id);
      if (!s) return undefined;
      return { record: { ...s.record, messages: s.messages }, tree: {}, entryIds: [], branchInfo: {} };
    }),
    create: vi.fn(async (fields: { id: string }) => {
      if (mockSessions.has(fields.id)) {
        throw Object.assign(new Error('Session id already exists'), { code: 'already_exists' });
      }
      mockSessions.set(fields.id, { record: { ...fields }, messages: [] });
    }),
    createWithMessages: vi.fn(async (fields: { id: string }, messages: unknown[]) => {
      mockSessions.set(fields.id, { record: { ...fields, messages }, messages });
    }),
  },
}));

const { telegramGatewayConfig, telegramGatewaySecrets, lastSelectedModel } = await import(
  '@/lib/persistence/storage'
);

const EMPTY_CONFIG = { workerUrl: '', allowedChatIdsCsv: '', interactiveMode: false };
const VALID_CONFIG = (interactiveMode: boolean) => ({
  workerUrl: 'https://gw.example.workers.dev/ws',
  allowedChatIdsCsv: '',
  interactiveMode,
});
const VALID_SECRETS = (wsAuthToken: string) => [
  { id: 'default', botToken: 'bot', webhookSecret: 'wh', wsAuthToken },
];
const TEST_INBOUND: InboundMessage = {
  kind: 'telegram_message',
  update_id: 1,
  message_id: 1,
  chat_id: 965822571,
  chat_type: 'private',
  text: 'hello from telegram',
  date: 1737000000,
  from: { id: 42, username: 'tester' },
};

/** 刷过 100ms 去抖 + 全部 microtask。 */
const flushAsync = () => vi.advanceTimersByTimeAsync(200);

/** 取 manager 注册到（mock bootstrap 返回的）client 上的 inbound 回调。
 *  回调返回该 turn 的 Promise——await 它即等整个 turn 跑完（确定性时序）。 */
/** 模拟 chat 域的会话广播（触发 manager 的 broadcast tap）。 */
function fireBroadcast(msg: unknown): void {
  for (const cb of [...broadcastTaps]) cb(msg);
}

function inboundCallback(attempt = 0): (msg: InboundMessage) => Promise<void> {
  const result = mockBootstrap.mock.results[attempt]!.value as {
    client: { onMessage: ReturnType<typeof vi.fn> };
  };
  const cb = result.client.onMessage.mock.calls[0]?.[0];
  if (!cb) throw new Error('manager did not register an inbound listener');
  return cb;
}

// manager 持有模块级 `handle`——每个用例 resetModules 后重新 import，保证
// 用例之间互不泄漏（vi.mock 注册表在 resetModules 后仍然生效）。
let setupTelegramGatewayManager: typeof import('./manager')['setupTelegramGatewayManager'];
let telegramSessionId: typeof import('./manager')['telegramSessionId'];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  fakeBrowser.reset();
  mockBootstrap.mockReset();
  mockPublishStatus.mockReset();
  mockPrompt.mockReset();
  mockCompactNow.mockReset();
  mockSessions.clear();
  broadcastTaps.clear();
  mockBootstrap.mockImplementation(() => ({
    teardown: vi.fn(),
    client: {
      onMessage: vi.fn(),
      sendOutbound: vi.fn(async () => ({
        kind: 'sendMessage_result' as const,
        request_id: 'x',
        ok: true,
        message_id: 1,
      })),
    },
  }));
  ({ setupTelegramGatewayManager, telegramSessionId } = await import('./manager'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setupTelegramGatewayManager', () => {
  it('boot 时 storage 为空 → 不 bootstrap（未配置即不连线）', async () => {
    setupTelegramGatewayManager();
    await flushAsync();

    expect(mockBootstrap).not.toHaveBeenCalled();
    expect(mockPublishStatus).not.toHaveBeenCalled();
  });

  it('boot 时已有落盘配置 → 用 url + wsAuthToken 自动重连（SW 重启恢复）', async () => {
    await telegramGatewayConfig.setValue({
      workerUrl: 'https://gw.example.workers.dev',
      allowedChatIdsCsv: '123',
      interactiveMode: true,
    });
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok-boot'));
    mockBootstrap.mockClear();

    setupTelegramGatewayManager();
    await flushAsync();

    expect(mockBootstrap).toHaveBeenCalledTimes(1);
    expect(mockBootstrap).toHaveBeenCalledWith({
      url: 'https://gw.example.workers.dev',
      token: 'tok-boot',
    });
  });

  it('保存 config + secrets（两次 watch 连发）→ 合并成一次 bootstrap', async () => {
    // 先落一个有效配置并 flush——没有去抖的话，双写会产生 2 次 bootstrap
    // （url2+tok1、url2+tok2），有去抖则恰好 1 次；空种子测不出这个差别。
    await telegramGatewayConfig.setValue({
      workerUrl: 'https://gw1.example.workers.dev',
      allowedChatIdsCsv: '',
      interactiveMode: false,
    });
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok1'));
    setupTelegramGatewayManager();
    await flushAsync();
    expect(mockBootstrap).toHaveBeenCalledTimes(1);

    await telegramGatewayConfig.setValue({
      workerUrl: 'https://gw2.example.workers.dev',
      allowedChatIdsCsv: '',
      interactiveMode: false,
    });
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok2'));
    await flushAsync();

    // boot(1) + 合并后的保存(1) = 恰好 2 次；无去抖会是 3 次。
    expect(mockBootstrap).toHaveBeenCalledTimes(2);
    expect(mockBootstrap).toHaveBeenLastCalledWith({
      url: 'https://gw2.example.workers.dev',
      token: 'tok2',
    });
  });

  it('只改 secrets（换 token）→ teardown 旧实例并按新 token 重建', async () => {
    await telegramGatewayConfig.setValue({
      workerUrl: 'https://gw.example.workers.dev',
      allowedChatIdsCsv: '',
      interactiveMode: false,
    });
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok-old'));
    setupTelegramGatewayManager();
    await flushAsync();
    expect(mockBootstrap).toHaveBeenCalledTimes(1);

    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok-new'));
    await flushAsync();

    expect(mockBootstrap).toHaveBeenCalledTimes(2);
    const first = mockBootstrap.mock.results[0]!.value as { teardown: ReturnType<typeof vi.fn> };
    expect(first.teardown).toHaveBeenCalledTimes(1);
    expect(mockBootstrap).toHaveBeenLastCalledWith({
      url: 'https://gw.example.workers.dev',
      token: 'tok-new',
    });
  });

  it('清空 workerUrl → teardown + publishStatus(disconnected)，不再重建', async () => {
    await telegramGatewayConfig.setValue({
      workerUrl: 'https://gw.example.workers.dev',
      allowedChatIdsCsv: '',
      interactiveMode: false,
    });
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    setupTelegramGatewayManager();
    await flushAsync();
    expect(mockBootstrap).toHaveBeenCalledTimes(1);

    await telegramGatewayConfig.setValue(EMPTY_CONFIG);
    await flushAsync();

    expect(mockBootstrap).toHaveBeenCalledTimes(1); // 没有新的 bootstrap
    const only = mockBootstrap.mock.results[0]!.value as { teardown: ReturnType<typeof vi.fn> };
    expect(only.teardown).toHaveBeenCalledTimes(1);
    expect(mockPublishStatus).toHaveBeenCalledWith('disconnected');
  });

  it('secrets 为空数组（等于没配 token）→ 不 bootstrap', async () => {
    await telegramGatewayConfig.setValue({
      workerUrl: 'https://gw.example.workers.dev',
      allowedChatIdsCsv: '',
      interactiveMode: false,
    });
    await telegramGatewaySecrets.setValue([]);
    setupTelegramGatewayManager();
    await flushAsync();

    expect(mockBootstrap).not.toHaveBeenCalled();
  });

  // ─── OpenClaw 式 session 隔离路由 ───

  it('telegramSessionId：同 chat 永远映射到同一 UUID（v5 形状，通过 UUID-only 不变量）', async () => {
    const a = await telegramSessionId(965822571);
    const b = await telegramSessionId(965822571);
    const c = await telegramSessionId(42);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // UUID 形状：8-4-4-4-12 hex，v5 版本位 + RFC 4122 variant 位。
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('interactiveMode ON + inbound → prompt 路由到确定性 UUID session（带 Telegram 标题）', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG(true));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();

    const sessionId = await telegramSessionId(965822571);
    await inboundCallback(0)(TEST_INBOUND); // await 整个 turn

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(mockPrompt).toHaveBeenCalledWith(sessionId, 'hello from telegram');
    const record = mockSessions.get(sessionId)?.record;
    expect(record?.title).toBe('Telegram · @tester');
  });

  it('interactiveMode OFF → inbound 被忽略（不建 session、不跑 agent）', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG(false));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();

    await inboundCallback(0)(TEST_INBOUND);

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockSessions.size).toBe(0);
  });

  it('没有可用模型 → 不建行（孤儿 session 防御），prompt 不调', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG(true));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    setupTelegramGatewayManager();
    await flushAsync();

    await inboundCallback(0)(TEST_INBOUND);

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockSessions.size).toBe(0);
  });

  it('burst 2 条消息 → 串行队列逐条处理（第 2 条排队到第 1 条跑完才跑）', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG(true));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const cb = inboundCallback(0);

    // 两条消息同步背靠背入队：job1 先跑、job2 串行在后。turn 1 的 prompt 挂起
    // （由测试控制 release1），断言 turn 2 不会并发抢跑。telegramSessionId 是
    // 同步派生（无 real-macrotask 依赖），入队时序完全确定。
    let release1: (() => void) | undefined;
    mockPrompt.mockImplementationOnce(() => new Promise<void>((r) => { release1 = r; }));
    mockPrompt.mockImplementationOnce(() => Promise.resolve());
    void cb(TEST_INBOUND);
    void cb({ ...TEST_INBOUND, update_id: 2, message_id: 2, text: 'second message' });
    await flushAsync();

    expect(mockPrompt).toHaveBeenCalledTimes(1); // turn 2 仍在排队
    expect(mockPrompt).toHaveBeenNthCalledWith(1, expect.any(String), 'hello from telegram');

    release1!();
    await flushAsync();

    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(mockPrompt).toHaveBeenNthCalledWith(2, expect.any(String), 'second message');
  });

  it('prompt 完成后 → 从 session 取最后一条 assistant 文本经 WS 回 Telegram', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG(true));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    // 预建带 assistant 消息的 session（prompt mock 不会写 tree）→ dispatch 走
    // 「existing → prompt → open → reply」完整路径。
    const fields = {
      id: await telegramSessionId(965822571),
      title: 'Telegram · @tester',
      model: 'test-model',
      provider: 'test',
      userInstructions: '',
      thinkingLevel: 'medium' as const,
    };
    const { sessionStore } = await import('../chat/session-store');
    await sessionStore.create(fields);
    await sessionStore.createWithMessages(fields, [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello from telegram' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Xin chào! Tôi có thể giúp gì cho bạn?' }],
      },
    ] as never[]);
    setupTelegramGatewayManager();
    await flushAsync();

    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    client.sendOutbound.mockClear();

    await inboundCallback(0)(TEST_INBOUND); // await 整个 turn（prompt mock 不广播）
    // 模拟真实 session-manager 的完成广播 → 触发 finalizeTurn
    const sessionId = await telegramSessionId(965822571);
    fireBroadcast({
      type: 'agent_end',
      sessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Xin chào! Tôi có thể giúp gì cho bạn?' }] },
      ],
    });
    await flushAsync();
    expect(mockPrompt).toHaveBeenCalledWith(sessionId, 'hello from telegram');
    // 最终回复：editMessage 占位（Markdown）
    const editCalls = client.sendOutbound.mock.calls.filter(
      ([m]) => (m as { kind?: string }).kind === 'editMessage',
    );
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]![0]).toMatchObject({
      kind: 'editMessage',
      chat_id: 965822571,
      text: 'Xin chào! Tôi có thể giúp gì cho bạn?',
      parse_mode: 'Markdown',
    });
  });

  it('最后一帧 stopReason=error（run 失败）→ 不回退发旧文本', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG(true));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    const fields = {
      id: await telegramSessionId(965822571),
      title: 'Telegram · @tester',
      model: 'test-model',
      provider: 'test',
      userInstructions: '',
      thinkingLevel: 'medium' as const,
    };
    const { sessionStore } = await import('../chat/session-store');
    await sessionStore.create(fields);
    await sessionStore.createWithMessages(fields, [
      {
        role: 'user',
        content: [{ type: 'text', text: 'q1' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'old answer' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'q2' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        stopReason: 'error',
      },
    ] as never[]);
    setupTelegramGatewayManager();
    await flushAsync();

    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };

    await inboundCallback(0)({ ...TEST_INBOUND, text: 'q2', update_id: 2, message_id: 2 });

    expect(mockPrompt).toHaveBeenCalled();
    // 模拟完成广播：末帧 assistant stopReason=error → 占位改成失败标记，
    // 不回退发旧文本（'old answer'）。
    const sessionId = await telegramSessionId(965822571);
    fireBroadcast({
      type: 'agent_end',
      sessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'q2' }] },
        { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'error' },
      ] as never[],
    });
    await flushAsync();

    const kinds = client.sendOutbound.mock.calls.map(([m]) => (m as { kind?: string }).kind);
    expect(kinds).toContain('sendChatAction'); // typing keepalive 照常
    // sendMessage 只有占位消息 1 条——run 失败不补发旧文本，改为占位改失败标记
    expect(kinds.filter((k) => k === 'sendMessage')).toHaveLength(1);
    const editCalls2 = client.sendOutbound.mock.calls.filter(
      ([m]) => (m as { kind?: string }).kind === 'editMessage',
    );
    expect(editCalls2).toHaveLength(1);
    expect(editCalls2[0]![0]).toMatchObject({ text: '⚠️ Agent failed' });
  });

  // ─── Sliding window：每 5 turn 觸發 compaction ───

  it('sliding window：第 5 turn 後觸發 compactNow，前 4 turn 不觸發', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG(true));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const cb = inboundCallback(0);

    // Turn 1–4：不足 5 turn → 不觸發 compaction
    for (let i = 1; i <= 4; i++) {
      await cb({ ...TEST_INBOUND, update_id: i, message_id: i, text: `msg ${i}` });
      await flushAsync();
    }
    expect(mockCompactNow).not.toHaveBeenCalled();

    // Turn 5：達到 TELEGRAM_MAX_TURNS → 觸發 compaction
    await cb({ ...TEST_INBOUND, update_id: 5, message_id: 5, text: 'msg 5' });
    await flushAsync();
    expect(mockCompactNow).toHaveBeenCalledTimes(1);
    expect(mockCompactNow).toHaveBeenCalledWith(expect.any(String));
  });

  it('sliding window：interactiveMode OFF → 計數不增、不觸發 compaction', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG(false));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const cb = inboundCallback(0);

    for (let i = 1; i <= 6; i++) {
      await cb({ ...TEST_INBOUND, update_id: i, message_id: i, text: `msg ${i}` });
      await flushAsync();
    }

    expect(mockCompactNow).not.toHaveBeenCalled();
  });
});
