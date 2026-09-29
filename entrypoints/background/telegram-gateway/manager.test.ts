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
import type { InboundMessage, TelegramCallback } from '@/lib/telegram-gateway/types';

const { mockBootstrap, mockPublishStatus, mockPrompt, mockCompactNow, mockResolveTool, mockCancelTool, mockSessions, broadcastTaps, mockToolLabel, toolExecutionCbs } = vi.hoisted(() => ({
  mockBootstrap: vi.fn(),
  mockPublishStatus: vi.fn(),
  mockPrompt: vi.fn(),
  mockCompactNow: vi.fn(async () => {}),
  mockResolveTool: vi.fn(),
  mockCancelTool: vi.fn(),
  mockSessions: new Map<string, { record: Record<string, unknown>; messages: unknown[] }>(),
  broadcastTaps: new Set<(msg: unknown) => void>(),
  mockToolLabel: vi.fn(() => 'Browsing web'),
  toolExecutionCbs: new Set<(sessionId: string, toolName: string, args: unknown) => void>(),
}));
vi.mock('@/lib/telegram-gateway/bootstrap', () => ({
  bootstrapTelegramGateway: mockBootstrap,
}));
vi.mock('@/lib/telegram-gateway/channel', () => ({
  telegramGatewayChannel: { publishStatus: mockPublishStatus },
}));
// getToolLabel 走 i18n t()——单测环境没有 locale 上下文会 throw，且 label 文案
// 不是 manager 的判定逻辑，给固定默认值（单个用例可 mockReturnValueOnce 换 label）。
vi.mock('@/lib/tools/labels', () => ({
  getToolLabel: mockToolLabel,
}));
vi.mock('../chat/session-manager', () => ({
  sessionManager: {
    prompt: mockPrompt,
    compactNow: mockCompactNow,
    resolveTool: mockResolveTool,
    cancelTool: mockCancelTool,
    onToolExecution: vi.fn((cb: (sessionId: string, toolName: string, args: unknown) => void) => {
      toolExecutionCbs.add(cb);
      return () => {
        toolExecutionCbs.delete(cb);
      };
    }),
  },
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

/** 取 manager 注册到 client 上的 telegram_callback 回调（au: / cap_ 路由入口）。 */
function telegramCallback(attempt = 0): (msg: TelegramCallback) => Promise<void> {
  const result = mockBootstrap.mock.results[attempt]!.value as {
    client: { onTelegramCallback: ReturnType<typeof vi.fn> };
  };
  const cb = result.client.onTelegramCallback.mock.calls[0]?.[0];
  if (!cb) throw new Error('manager did not register a callback listener');
  return cb;
}

/** 模擬 agent 開始執行一個 tool（sessionManager.onToolExecution tap）。 */
function fireToolExecution(sessionId: string, toolName = 'web_search'): void {
  for (const cb of [...toolExecutionCbs]) cb(sessionId, toolName, {});
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
  mockResolveTool.mockReset();
  mockCancelTool.mockReset();
  mockSessions.clear();
  broadcastTaps.clear();
  toolExecutionCbs.clear();
  mockBootstrap.mockImplementation(() => ({
    teardown: vi.fn(),
    client: {
      onMessage: vi.fn(),
      onTelegramCallback: vi.fn(),
      sendOutbound: vi.fn(async () => ({
        kind: 'sendMessage_result' as const,
        request_id: 'x',
        ok: true,
        message_id: 1,
      })),
      // manager 的 agent_state one-way emit 走这里（gateway 不回 ack）
      sendState: vi.fn(),
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
    // abortTurnUx：reaction 换 ❌（失败可见，零打扰）
    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    expect(reactions(client).at(-1)).toMatchObject({ emoji: '❌' });
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

  // ─── Reaction lifecycle（👀 运行 → 👌 完成 / ❌ 失败）───

  /** 标准 turn 前置：配置 + 模型落盘、setup、连接、拿到 mock client。 */
  async function startTurnHarness(): Promise<{ sendOutbound: ReturnType<typeof vi.fn> }> {
    await telegramGatewayConfig.setValue(VALID_CONFIG(true));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    client.sendOutbound.mockClear();
    return client;
  }

  /** 全部 reaction（setMessageReaction）。 */
  function reactions(client: { sendOutbound: ReturnType<typeof vi.fn> }) {
    return client.sendOutbound.mock.calls
      .map(([m]) => m as { kind?: string; message_id?: number; emoji?: string })
      .filter((m) => m.kind === 'setMessageReaction');
  }

  /** 全部 sendMessage（finalize 落位的块）。 */
  function sentMessages(client: { sendOutbound: ReturnType<typeof vi.fn> }) {
    return client.sendOutbound.mock.calls
      .map(([m]) => m as {
        kind?: string;
        text?: string;
        reply_to_message_id?: number;
        parse_mode?: string;
        disable_notification?: boolean;
        disable_link_preview?: boolean;
      })
      .filter((m) => m.kind === 'sendMessage');
  }

  it('inbound turn → reaction 👀 贴上用户消息，不发送任何占位消息', async () => {
    const client = await startTurnHarness();

    await inboundCallback(0)(TEST_INBOUND);
    await flushAsync();

    expect(reactions(client)).toEqual([
      expect.objectContaining({ chat_id: 965822571, message_id: 1, emoji: '👀' }),
    ]);
    expect(sentMessages(client)).toHaveLength(0); // 不再有 Thinking... 占位
    // typing keepalive 照常
    expect(
      client.sendOutbound.mock.calls.some(([m]) => (m as { kind?: string }).kind === 'sendChatAction'),
    ).toBe(true);
  });

  it('finalize（回复短）→ 👌 + Block 1 sendMessage reply_to 用户 + Markdown', async () => {
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
      { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Xin chào! Tôi có thể giúp gì cho bạn?' }] },
    ] as never[]);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    client.sendOutbound.mockClear();

    await inboundCallback(0)(TEST_INBOUND);
    const sessionId = await telegramSessionId(965822571);
    fireBroadcast({
      type: 'agent_end',
      sessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Xin chào! Tôi có thể giúp gì cho bạn?' }] },
      ] as never[],
    });
    await flushAsync();

    expect(reactions(client)[1]).toMatchObject({ message_id: 1, emoji: '👌' });
    const sends = sentMessages(client);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      chat_id: 965822571,
      text: 'Xin chào! Tôi có thể giúp gì cho bạn?',
      reply_to_message_id: 1,
      parse_mode: 'Markdown',
    });
    // Block 1 保留通知与 link preview
    expect(sends[0]!.disable_notification).toBeUndefined();
    expect(sends[0]!.disable_link_preview).toBeUndefined();
  });

  it('finalize（回复长）→ Block 1 reply-to，Block 2+ 静默 + 关 link preview', async () => {
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
    const long = ['A'.repeat(900), 'B'.repeat(900), 'C'.repeat(900)].join('\n\n');
    await sessionStore.createWithMessages(fields, [
      { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
      { role: 'assistant', content: [{ type: 'text', text: long }] },
    ] as never[]);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    client.sendOutbound.mockClear();

    await inboundCallback(0)(TEST_INBOUND);
    const sessionId = await telegramSessionId(965822571);
    fireBroadcast({
      type: 'agent_end',
      sessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
        { role: 'assistant', content: [{ type: 'text', text: long }] },
      ] as never[],
    });
    await flushAsync();

    const sends = sentMessages(client);
    // splitReply：Block 1 = 第一段，Block 2 = B+C 分组（≤2000）
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({
      text: 'A'.repeat(900),
      reply_to_message_id: 1,
      parse_mode: 'Markdown',
    });
    expect(sends[0]!.disable_notification).toBeUndefined();
    expect(sends[1]).toMatchObject({
      text: `${'B'.repeat(900)}\n\n${'C'.repeat(900)}`,
      disable_notification: true,
      disable_link_preview: true,
      parse_mode: 'Markdown',
    });
    expect(sends[1]!.reply_to_message_id).toBeUndefined();
  });

  it('prompt 抛错 → reaction ❌、零消息、typing 停', async () => {
    const client = await startTurnHarness();
    mockPrompt.mockRejectedValueOnce(new Error('model unavailable'));

    await inboundCallback(0)(TEST_INBOUND);
    await flushAsync();

    expect(reactions(client).at(-1)).toMatchObject({ emoji: '❌' });
    expect(sentMessages(client)).toHaveLength(0);
    // typing keepalive 已随 clearTurnTimers 清掉——推进 9s 静默。
    const countAfterError = client.sendOutbound.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(client.sendOutbound.mock.calls.slice(countAfterError)).toHaveLength(0);
    // abort 路径显式发 idle——gateway agentStates 不能停在 thinking
    //（否则 stall fire-gate 误报一次，且 /status 对死 turn 谎报状态）。
    const sendState = (client as unknown as { sendState: ReturnType<typeof vi.fn> }).sendState;
    const states = sendState.mock.calls.map(([f]) => (f as { state?: string }).state);
    expect(states).toContain('idle');
  });

  it('finalize：末帧 stopReason=error → reaction ❌ 锚到本轮消息，零消息', async () => {
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
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'error' },
    ] as never[]);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    client.sendOutbound.mockClear();

    // 第二轮 turn——顺带钉住 per-turn userMessageId 隔离（锚 = message_id 2）
    await inboundCallback(0)({ ...TEST_INBOUND, text: 'q2', update_id: 2, message_id: 2 });
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

    expect(reactions(client).at(-1)).toMatchObject({ message_id: 2, emoji: '❌' });
    expect(sentMessages(client)).toHaveLength(0); // 不回退发旧文本
  });

  it('reply 目标缺失 → 三级兜底降级（reply+MD → reply+plain → 无 reply）仍送达', async () => {
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
      { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Xin chào! Tôi có thể giúp gì cho bạn?' }] },
    ] as never[]);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    client.sendOutbound.mockClear();
    client.sendOutbound.mockImplementation(async (m: unknown) => {
      const a = m as { kind?: string; reply_to_message_id?: number };
      // 带 reply_to 的 sendMessage 一律失败（模拟用户已删消息）
      if (a.kind === 'sendMessage' && a.reply_to_message_id) {
        return {
          kind: 'sendMessage_result' as const,
          request_id: 'x',
          ok: false,
          error: 'Bad Request: message to be replied not found',
        };
      }
      return { kind: 'sendMessage_result' as const, request_id: 'x', ok: true, message_id: 2 };
    });

    await inboundCallback(0)(TEST_INBOUND);
    const sessionId = await telegramSessionId(965822571);
    fireBroadcast({
      type: 'agent_end',
      sessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Xin chào! Tôi có thể giúp gì cho bạn?' }] },
      ] as never[],
    });
    await flushAsync();

    const sends = sentMessages(client);
    expect(sends).toHaveLength(3);
    expect(sends[0]!.reply_to_message_id).toBe(1);
    expect(sends[0]!.parse_mode).toBe('Markdown');
    expect(sends[1]!.reply_to_message_id).toBe(1);
    expect(sends[1]!.parse_mode).toBeUndefined();
    expect(sends[2]!.reply_to_message_id).toBeUndefined();
    expect(sends[2]!.text).toBe('Xin chào! Tôi có thể giúp gì cho bạn?');
  });

  // ─── Step-Progress 工具狀態行 ───

  function statusEdits(client: { sendOutbound: ReturnType<typeof vi.fn> }) {
    return client.sendOutbound.mock.calls
      .map(([m]) => m as { kind?: string; message_id?: number; text?: string })
      .filter((m) => m.kind === 'editMessage');
  }
  function statusDeletes(client: { sendOutbound: ReturnType<typeof vi.fn> }) {
    return client.sendOutbound.mock.calls
      .map(([m]) => m as { kind?: string; message_id?: number })
      .filter((m) => m.kind === 'deleteMessage');
  }

  it('首个 tool_execution_start → 静默状态行（1 条）；在途回执前换 label → 回执后补一次节流 edit', async () => {
    const client = await startTurnHarness();
    await inboundCallback(0)(TEST_INBOUND);
    const sessionId = await telegramSessionId(965822571);

    // 第一個 tool execution：狀態行 sendMessage 在途
    fireToolExecution(sessionId);
    // 回執未落地時第二個 tool 換 label——只更新 pendingStatusText，不發第二條
    mockToolLabel.mockReturnValueOnce('Reading file');
    fireToolExecution(sessionId, 'fs_read');

    await flushAsync(); // 回執落位 → statusMessageId 就位 + 補發 edit 的節流窗口啟動 + 動畫 timer 啟動
    const sends = sentMessages(client);
    expect(sends).toHaveLength(1); // 在途合併：只有 1 條狀態行
    expect(sends[0]).toMatchObject({ text: '🔧 Browsing web...', disable_notification: true });

    // 節流窗口內：label change 的 edit 未放行；動畫 tick 因 pendingStatusText != null 也跳過
    await vi.advanceTimersByTimeAsync(500);
    expect(statusEdits(client)).toHaveLength(0);

    // 走過節流窗口：label change 落地。動畫在 pending 清掉後續接會再發 edit，
    // 我們只斷言「label change 的 edit 存在」+「它是首個 edit」（priority 體現）。
    await vi.advanceTimersByTimeAsync(3_000);
    const edits = statusEdits(client);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[0]).toMatchObject({ message_id: 1, text: '🔧 Reading file...' });
  });

  // ─── 工具狀態行動畫（1Hz emoji 旋轉；遞歸 setTimeout）───

  it('狀態行發出後 1Hz 動畫：editMessage 依 cycle 切換 emoji 前綴', async () => {
    const client = await startTurnHarness();
    await inboundCallback(0)(TEST_INBOUND);
    await flushAsync(); // 狀態行尚未發出
    const sessionId = await telegramSessionId(965822571);

    fireToolExecution(sessionId); // 狀態行發出：frame 0 (🔧 Browsing web...)
    await flushAsync(); // 狀態行落地、動畫 timer 排到 +1s

    // 推進 2.5s：動畫 tick 在 +1s、+2s 各發一次 edit
    await vi.advanceTimersByTimeAsync(2_500);
    const edits = statusEdits(client);
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits[0]).toMatchObject({ message_id: 1, text: '⚙️ Browsing web...' });
    expect(edits[1]).toMatchObject({ message_id: 1, text: '🛠️ Browsing web...' });
  });

  it('動畫 cycle 4 幀：🔧 → ⚙️ → 🛠️ → 🔩 → 🔧（frame 4 回到 frame 0 的字形，仍與上一幀 🔩 不同 → 照常 fire）', async () => {
    const client = await startTurnHarness();
    await inboundCallback(0)(TEST_INBOUND);
    await flushAsync();
    const sessionId = await telegramSessionId(965822571);

    fireToolExecution(sessionId);
    await flushAsync();

    // 5 ticks × 1s = 5s；cycle 4 + 1 wrap。預期 edits: ⚙️, 🛠, 🔩, 🔧, ⚙️
    await vi.advanceTimersByTimeAsync(5_500);
    const edits = statusEdits(client);
    expect(edits.map((e) => e.text)).toEqual([
      '⚙️ Browsing web...',
      '🛠️ Browsing web...',
      '🔩 Browsing web...',
      '🔧 Browsing web...',
      '⚙️ Browsing web...',
    ]);
  });

  it('label 變更（pendingStatusText != null）期間動畫 tick 跳過 edit、不覆蓋排隊中的 label edit', async () => {
    const client = await startTurnHarness();
    await inboundCallback(0)(TEST_INBOUND);
    const sessionId = await telegramSessionId(965822571);

    // tool 1：狀態行發出
    fireToolExecution(sessionId);
    // tool 2（同 1s 內）：label 變更排隊到 pendingStatusText
    mockToolLabel.mockReturnValueOnce('Reading file');
    fireToolExecution(sessionId, 'fs_read');

    await flushAsync(); // 狀態行落地 + 動畫 timer + throttle timer 排隊

    // 推進到 throttle 窗口前：動畫 tick 期間 pendingStatusText 仍非空 → 跳過 edit
    await vi.advanceTimersByTimeAsync(2_500);
    expect(statusEdits(client)).toHaveLength(0);

    // 走過 throttle 窗口：label change edit 落地
    await vi.advanceTimersByTimeAsync(3_000);
    const edits = statusEdits(client);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[0]).toMatchObject({ text: '🔧 Reading file...' });
  });

  it('finalize (agent_end) 後 stopStatusAnimation，後續不再觸發 editMessage', async () => {
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
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    ] as never[]);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    client.sendOutbound.mockClear();

    await inboundCallback(0)(TEST_INBOUND);
    const sessionId = await telegramSessionId(965822571);
    fireToolExecution(sessionId);
    await flushAsync(); // 狀態行落地、動畫啟動

    // 動畫先 tick 幾次（驗證它真的在跑）
    await vi.advanceTimersByTimeAsync(3_000);
    const editsBeforeFinalize = statusEdits(client).length;
    expect(editsBeforeFinalize).toBeGreaterThanOrEqual(1);

    // finalize → stopStatusAnimation + deleteStatusMessage
    fireBroadcast({
      type: 'agent_end',
      sessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      ] as never[],
    });
    await flushAsync();
    expect(statusDeletes(client)).toHaveLength(1);

    // 推 5s：動畫已停，不會再發 editMessage。
    const editsAtFinalize = statusEdits(client).length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statusEdits(client).length).toBe(editsAtFinalize);
  });

  it('abort (prompt throw) 後 stopStatusAnimation + statusDead，後續 tick 不再 fire', async () => {
    const client = await startTurnHarness();
    mockPrompt.mockImplementationOnce(async () => {
      const sessionId = await telegramSessionId(965822571);
      fireToolExecution(sessionId);
      throw new Error('mid-run failure');
    });

    await inboundCallback(0)(TEST_INBOUND);
    await flushAsync(); // abort 已跑：reaction ❌ + status line 被刪

    const editsAtAbort = statusEdits(client).length;
    expect(statusDeletes(client)).toHaveLength(1);

    // 推 5s：動畫已停，statusDead=true，runStatusAnimationFrame 早返。
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statusEdits(client).length).toBe(editsAtAbort);
  });

  it('status 首發失敗 → 本輪放棄（不重試），finalize 照常送達', async () => {
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
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Trả lời' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Đáp án' }] },
    ] as never[]);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    client.sendOutbound.mockClear();

    await inboundCallback(0)({ ...TEST_INBOUND, text: 'q2', update_id: 2, message_id: 2 });
    await flushAsync();
    // mockImplementationOnce 消耗在下一個呼叫——此時 reaction / typing 已發，
    // 下一個 sendMessage 正是狀態行首發（讓它失敗）
    client.sendOutbound.mockImplementationOnce(async (m: unknown) => {
      const a = m as { kind?: string };
      if (a.kind === 'sendMessage') {
        return { kind: 'sendMessage_result' as const, request_id: 'x', ok: false, error: 'blocked' };
      }
      return { kind: 'gateway_result' as const, request_id: 'x', ok: true };
    });

    const sessionId = await telegramSessionId(965822571);
    fireToolExecution(sessionId);
    await flushAsync();
    expect(sentMessages(client)).toHaveLength(1); // 失敗的狀態行嘗試

    fireToolExecution(sessionId);
    await flushAsync();
    expect(sentMessages(client)).toHaveLength(1); // statusDead → 無重試

    fireBroadcast({
      type: 'agent_end',
      sessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Đáp án' }] },
      ] as never[],
    });
    await flushAsync();

    // finalize 照常：👌 + Block 1（reply）送達；status 不存在 → 無 deleteMessage
    expect(reactions(client).at(-1)).toMatchObject({ emoji: '👌' });
    const answer = sentMessages(client).filter((m) => m.reply_to_message_id !== undefined);
    expect(answer).toHaveLength(1);
    expect(statusDeletes(client)).toHaveLength(0);
  });

  it('prompt 中途抛错 → 状态行删除 + ❌（迟到回执自删，不留孤儿）', async () => {
    const client = await startTurnHarness();
    mockPrompt.mockImplementationOnce(async () => {
      const sessionId = await telegramSessionId(965822571);
      fireToolExecution(sessionId);
      throw new Error('mid-run failure');
    });

    await inboundCallback(0)(TEST_INBOUND);
    await flushAsync();

    // 状态行已发出 → abort 删除。此刻回执未到、deleteStatusMessage 排不了队
    // （id 尚为 null）——真正的 deleteMessage 由迟到的首发回执自删路径补上
    expect(sentMessages(client)).toHaveLength(1);
    expect(reactions(client).at(-1)).toMatchObject({ emoji: '❌' });
    expect(statusDeletes(client)).toHaveLength(1);
  });

  // ─── Sliding window：每 15 turn 觸發 compaction ───

  it('sliding window：第 15 turn 後觸發 compactNow，前 14 turn 不觸發', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG(true));
    await telegramGatewaySecrets.setValue(VALID_SECRETS('tok'));
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const cb = inboundCallback(0);

    // Turn 1–14：不足 15 turn → 不觸發 compaction
    for (let i = 1; i <= 14; i++) {
      await cb({ ...TEST_INBOUND, update_id: i, message_id: i, text: `msg ${i}` });
      await flushAsync();
    }
    expect(mockCompactNow).not.toHaveBeenCalled();

    // Turn 15：達到 TELEGRAM_MAX_TURNS → 觸發 compaction
    await cb({ ...TEST_INBOUND, update_id: 15, message_id: 15, text: 'msg 15' });
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

    // 跑滿一整個 sliding window（15）+ 1 次：OFF 時 inbound 在計數前就 return，
    // 因此永遠不會累積到門檻。跑超過門檻才能證明擋的是 gate 而不是「還沒到數」。
    for (let i = 1; i <= 16; i++) {
      await cb({ ...TEST_INBOUND, update_id: i, message_id: i, text: `msg ${i}` });
      await flushAsync();
    }

    expect(mockCompactNow).not.toHaveBeenCalled();
  });

  // ─── Inline-image 媒体分发（finalizeTurn 的 sendPhoto / sendMediaGroup 路由）───

  /** 全部媒体发送（sendPhoto / sendMediaGroup）。 */
  function mediaSends(client: { sendOutbound: ReturnType<typeof vi.fn> }) {
    return client.sendOutbound.mock.calls
      .map(([m]) => m as {
        kind?: string;
        image_url?: string;
        caption?: string;
        parse_mode?: string;
        reply_to_message_id?: number;
        media?: Array<{ type: string; media: string; caption?: string }>;
      })
      .filter((m) => m.kind === 'sendPhoto' || m.kind === 'sendMediaGroup');
  }

  /** 图片路径用例的前置：建 session + 跑 turn + 广播 agent_end（回复文本可带图）。
   *  `outboundFor` 决定媒体类 action 的回执（默认 ok）。 */
  async function runImageTurn(
    assistantText: string,
    outboundFor?: (kind: string | undefined) => unknown,
  ): Promise<{ sendOutbound: ReturnType<typeof vi.fn> }> {
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
      { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
      { role: 'assistant', content: [{ type: 'text', text: assistantText }] },
    ] as never[]);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();
    const client = mockBootstrap.mock.results[0]!.value.client as {
      sendOutbound: ReturnType<typeof vi.fn>;
    };
    client.sendOutbound.mockClear();
    client.sendOutbound.mockImplementation(async (m: unknown) => {
      const kind = (m as { kind?: string }).kind;
      if (kind === 'sendPhoto' || kind === 'sendMediaGroup') {
        return (outboundFor?.(kind) ?? { kind: 'gateway_result', request_id: 'x', ok: true }) as never;
      }
      return { kind: 'sendMessage_result', request_id: 'x', ok: true, message_id: 1 } as never;
    });

    await inboundCallback(0)(TEST_INBOUND);
    const sessionId = await telegramSessionId(965822571);
    fireBroadcast({
      type: 'agent_end',
      sessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
        { role: 'assistant', content: [{ type: 'text', text: assistantText }] },
      ] as never[],
    });
    await flushAsync();
    return { sendOutbound: client.sendOutbound };
  }

  it('finalize 回复含 1 图 + 短文本 → sendPhoto(image_url + caption ≤1024 + reply_to)，无文本块', async () => {
    const { sendOutbound: send } = await runImageTurn(
      '![a cat](https://cdn.test/cat.jpg) Xin chào!',
    );
    const media = mediaSends({ sendOutbound: send });
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      kind: 'sendPhoto',
      image_url: 'https://cdn.test/cat.jpg',
      caption: 'Xin chào!',
      parse_mode: 'Markdown',
      reply_to_message_id: 1,
    });
    // caption 已带图片正文 → 不再有 sendMessage 块。
    const texts = sentMessages({ sendOutbound: send });
    expect(texts).toHaveLength(0);
  });

  it('1 图 + 首块 >1024 → sendPhoto 无 caption；整块文本静默补发', async () => {
    const long = 'A'.repeat(1500);
    const { sendOutbound: send } = await runImageTurn(`![img](https://cdn.test/i.jpg)\n\n${long}`);
    const media = mediaSends({ sendOutbound: send });
    expect(media[0]!.kind).toBe('sendPhoto');
    expect(media[0]!.caption).toBeUndefined();
    // 文本块静默补发（Block 2+ 语义：无 reply_to、disable_notification）。
    const texts = sentMessages({ sendOutbound: send });
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe(long);
    expect(texts[0]!.reply_to_message_id).toBeUndefined();
    expect(texts[0]!.disable_notification).toBe(true);
  });

  it('2 图 → sendMediaGroup，caption 只挂第一项；reply_to 透传', async () => {
    const { sendOutbound: send } = await runImageTurn(
      'Look ![a](https://x.test/1.png) and ![b](https://x.test/2.png)',
    );
    const media = mediaSends({ sendOutbound: send });
    expect(media).toHaveLength(1);
    expect(media[0]!.kind).toBe('sendMediaGroup');
    expect(media[0]!.media).toEqual([
      { type: 'photo', media: 'https://x.test/1.png', caption: 'Look  and' },
      { type: 'photo', media: 'https://x.test/2.png' },
    ]);
    expect(media[0]!.reply_to_message_id).toBe(1);
  });

  it('sendPhoto 被拒（ok:false）→ fallback 干净文本块 + 🖼 链接块（Block 1 reply_to）', async () => {
    const { sendOutbound: send } = await runImageTurn(
      'Nè ![broken](https://cdn.test/dead.jpg) xin chào',
      () => ({ kind: 'gateway_result', request_id: 'x', ok: false, error: '400: Bad Request' }),
    );
    // 媒体重试 1 次后放弃（无重试），转文本。
    expect(mediaSends({ sendOutbound: send })).toHaveLength(1);
    const texts = sentMessages({ sendOutbound: send });
    expect(texts).toHaveLength(2);
    // Block 1：干净文本（图片标签剥离）+ reply_to + Markdown。
    expect(texts[0]).toMatchObject({
      text: 'Nè  xin chào',
      reply_to_message_id: 1,
      parse_mode: 'Markdown',
    });
    // 尾块：纯链接（无 markdown 图片残渣）、静默。
    expect(texts[1]!.text).toBe('🖼 https://cdn.test/dead.jpg');
    expect(texts[1]!.disable_notification).toBe(true);
  });

  it('sendMediaGroup 上限 10 张：第 11 张以 🖼 链接块补发（不静默丢弃）', async () => {
    const images = Array.from({ length: 11 }, (_, i) => `![i${i}](https://x.test/${i}.png)`).join(' ');
    const { sendOutbound: send } = await runImageTurn(images);
    const media = mediaSends({ sendOutbound: send });
    expect(media).toHaveLength(1);
    expect(media[0]!.kind).toBe('sendMediaGroup');
    expect(media[0]!.media).toHaveLength(10);
    expect(media[0]!.media![9]!.media).toBe('https://x.test/9.png');
    // 溢出的第 11 张以链接块补在文本后面。
    const texts = sentMessages({ sendOutbound: send });
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('🖼 https://x.test/10.png');
    expect(texts[0]!.disable_notification).toBe(true);
  });

  it('sendPhoto 挂起（旧 relay 不回执）→ 8s 超时 → fallback 文本送达', async () => {
    // outboundFor 返回永不 resolve 的 promise——模拟旧 relay 对未知 kind 静默丢弃。
    const { sendOutbound: send } = await runImageTurn(
      '![img](https://cdn.test/i.jpg) hi',
      () => new Promise(() => {}) as never,
    );
    // 推进 9s：超过 8s 超时——fallback 文本路径落地。
    await vi.advanceTimersByTimeAsync(9_000);

    const texts = sentMessages({ sendOutbound: send });
    expect(texts).toHaveLength(2);
    expect(texts[0]!.text).toBe('hi');
    expect(texts[1]!.text).toBe('🖼 https://cdn.test/i.jpg');
  });

  // ─── ask_user → inline keyboard（au: 路由 + dismiss 后串行队列继续跑）───

  const ASK_ARGS = {
    questions: [{ id: 'q1', question: 'Chọn?', options: [{ label: 'A' }, { label: 'B' }] }],
  };

  /** 起 turn（prompt 挂起、release 手动放行）→ fire tool_pending(ask_user) →
   *  返回 session id 与发出的 keyboard token。 */
  async function startAskHarness(client: { sendOutbound: ReturnType<typeof vi.fn> }): Promise<{
    sessionId: string;
    token: string;
    release: () => void;
  }> {
    let release!: () => void;
    mockPrompt.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    void inboundCallback(0)(TEST_INBOUND);
    await flushAsync();
    const sessionId = await telegramSessionId(965822571);
    fireBroadcast({
      type: 'tool_pending',
      sessionId,
      toolName: 'ask_user',
      toolCallId: 'tc1',
      args: ASK_ARGS,
    });
    await flushAsync();
    const askSend = client.sendOutbound.mock.calls
      .map(([m]) => m as {
        kind?: string;
        text?: string;
        reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      })
      .find((m) => m.kind === 'sendMessage' && m.text?.startsWith('❓'));
    if (!askSend?.reply_markup) throw new Error('ask keyboard was not sent');
    const token = askSend.reply_markup.inline_keyboard[0]![0]!.callback_data.split(':')[1]!;
    return { sessionId, token, release };
  }

  /** 全部含 ❓ 的 sendMessage（ask 键盘题面）。 */
  function askSends(client: { sendOutbound: ReturnType<typeof vi.fn> }) {
    return client.sendOutbound.mock.calls
      .map(([m]) => m as { kind?: string; text?: string })
      .filter((m) => m.kind === 'sendMessage' && m.text?.startsWith('❓'));
  }

  it('wiring：tool_pending(ask_user) → 键盘题面发出（❓ + reply_markup，一 option 一行）', async () => {
    const client = await startTurnHarness();
    await startAskHarness(client);
    expect(askSends(client)).toHaveLength(1);
    const send = askSends(client)[0] as {
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(send.reply_markup!.inline_keyboard.map((row) => row[0]!.text)).toEqual([
      'A',
      'B',
      '✍️ Nhập tay',
    ]);
    // agent_state one-way emit：turn 开始 thinking，ask_user pending → waiting_user
    const states = (client as unknown as { sendState: ReturnType<typeof vi.fn> }).sendState.mock.calls
      .map(([f]) => f as { state?: string; tool?: string });
    expect(states[0]).toMatchObject({ kind: 'agent_state', state: 'thinking' });
    expect(states.at(-1)).toMatchObject({ state: 'waiting_user' });
  });

  it('wiring：非本 turn session / 非 ask_user 的 tool_pending → 忽略；其他 tool 状态行照常', async () => {
    const client = await startTurnHarness();
    let release!: () => void;
    mockPrompt.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    void inboundCallback(0)(TEST_INBOUND);
    await flushAsync();
    const sessionId = await telegramSessionId(965822571);

    fireBroadcast({ type: 'tool_pending', sessionId: 'no-such-turn', toolName: 'ask_user', toolCallId: 'tc', args: ASK_ARGS });
    fireBroadcast({ type: 'tool_pending', sessionId, toolName: 'web_search', toolCallId: 't2', args: {} });
    await flushAsync();
    expect(askSends(client)).toHaveLength(0);

    // 其他 tool 的 🔧 状态行不受 ask_user skip 影响（回归）
    fireToolExecution(sessionId, 'web_search');
    await flushAsync();
    expect(
      client.sendOutbound.mock.calls.some(([m]) => (m as { text?: string }).text === '🔧 Browsing web...'),
    ).toBe(true);
    release();
    await flushAsync();
  });

  it('au: callback → 路由适配层 → resolveTool 收到 answers；cap_ 仍走 /tabs 流程', async () => {
    const client = await startTurnHarness();
    const { sessionId, token, release } = await startAskHarness(client);

    await telegramCallback(0)({
      kind: 'telegram_callback',
      callback_query_id: 'c1',
      data: `au:${token}:1`,
      chat_id: 965822571,
      message_id: 1,
      from: null,
    });
    expect(mockResolveTool).toHaveBeenCalledTimes(1);
    expect(mockResolveTool).toHaveBeenCalledWith(sessionId, 'ask_user', {
      answers: { q1: { selected: ['B'], free_text: '', skipped: false } },
    });

    // cap_ 回归：走 /tabs 截图流程（fakeBrowser 无 tab 999 → capture 抛错 →
    // dispatchTabsCallback 兜底 ⚠️ edit）。snapshot 前后 call 数必须增长 ——
    // 若 cap_ 被误路由进适配层（parse 返回 null 静默吞），这里不会有新 call。
    const callsBeforeCap = client.sendOutbound.mock.calls.length;
    await telegramCallback(0)({
      kind: 'telegram_callback',
      callback_query_id: 'c2',
      data: 'cap_999',
      chat_id: 965822571,
      message_id: 1,
      from: null,
    });
    await flushAsync();
    expect(mockResolveTool).toHaveBeenCalledTimes(1); // cap_ 不进适配层
    expect(client.sendOutbound.mock.calls.length).toBeGreaterThan(callsBeforeCap);
    release();
    await flushAsync();
  });

  it('ask pending → 普通文本 dismiss（cancelTool）→ agent_end 后队列继续跑下一条', async () => {
    const client = await startTurnHarness();
    const { sessionId, token, release } = await startAskHarness(client);
    // 先注册 pending（startAskHarness 内），后注册第 2 条的 resolve —— Once 按
    // 注册顺序消费，顺序不能反。
    mockPrompt.mockImplementationOnce(() => Promise.resolve()); // 第 2 条消息的 turn

    // 不按 ✍️、keyboard 挂着：普通文本 → dismiss（cancelTool）+ 消息照常排队
    void inboundCallback(0)({ ...TEST_INBOUND, update_id: 2, message_id: 2, text: 'thôi cứ làm đi' });
    await flushAsync();
    expect(mockCancelTool).toHaveBeenCalledTimes(1);
    expect(mockCancelTool).toHaveBeenCalledWith(sessionId, 'ask_user');
    expect(mockResolveTool).not.toHaveBeenCalled(); // dismiss 走 cancel 不走 resolve
    expect(
      client.sendOutbound.mock.calls.some(
        ([m]) => (m as { kind?: string; text?: string }).kind === 'editMessage'
          && (m as { text?: string }).text === '⏭ Đã bỏ qua câu hỏi.',
      ),
    ).toBe(true);
    // turn 1 的 prompt 仍挂着 → 第 2 条还在排队（没有并发抢跑）
    expect(mockPrompt).toHaveBeenCalledTimes(1);

    release(); // turn 1 收口（bridge 已被 dismiss 取消，run 正常落位）
    fireBroadcast({
      type: 'agent_end',
      sessionId,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello from telegram' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ] as never[],
    });
    await flushAsync();

    // agent_state: agent_end → idle（只有 agent_end 会发 idle——真正的 turn 终结
    // 信号；队列 unblock 由下方 mockPrompt 两次的断言证明）
    const sendState = (client as unknown as { sendState: ReturnType<typeof vi.fn> }).sendState;
    const states = sendState.mock.calls.map(([f]) => (f as { state?: string }).state);
    expect(states).toContain('idle');

    // 队列 unblock：第 2 条消息作为正常聊天跑 prompt（挂起期间没有被吞）
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(mockPrompt).toHaveBeenNthCalledWith(2, sessionId, 'thôi cứ làm đi');
  });
});
