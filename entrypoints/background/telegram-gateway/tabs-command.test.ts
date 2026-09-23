// tabs-command.test.ts — `/tabs` command 的单元 + 集成测试。
//
// 覆盖三层：
//   1. `buildTabsKeyboard` / `parseTabCallbackData`（纯函数，无 mock 依赖）
//   2. `dispatchInbound` 的 `/tabs` 拦截（interactiveMode OFF 依然工作 ——
//      显式命令不走 LLM 路由，也不吃 interactiveMode gate）
//   3. 回归：非命令文本在 interactiveMode OFF 时被忽略（拦截不能过宽）
//
// Mock 脚手架 mirror `manager.test.ts`（storage 用 fakeBrowser 真实实现，
// bootstrap/channel/session-manager/session-store/viewers mock 掉）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { InboundMessage } from '@/lib/telegram-gateway/types';

const { mockBootstrap, mockPrompt, mockCompactNow, mockSessions, broadcastTaps, mockToolLabel, toolExecutionCbs } = vi.hoisted(() => ({
  mockBootstrap: vi.fn(),
  mockPrompt: vi.fn(),
  mockCompactNow: vi.fn(async () => {}),
  mockSessions: new Map<string, { record: Record<string, unknown>; messages: unknown[] }>(),
  broadcastTaps: new Set<(msg: unknown) => void>(),
  mockToolLabel: vi.fn(() => 'Browsing web'),
  toolExecutionCbs: new Set<(sessionId: string, toolName: string, args: unknown) => void>(),
}));
vi.mock('@/lib/telegram-gateway/bootstrap', () => ({
  bootstrapTelegramGateway: mockBootstrap,
}));
vi.mock('@/lib/telegram-gateway/channel', () => ({
  telegramGatewayChannel: { publishStatus: vi.fn() },
}));
// getToolLabel 走 i18n t()——单测环境没有 locale 上下文会 throw，固定值即可。
vi.mock('@/lib/tools/labels', () => ({
  getToolLabel: mockToolLabel,
}));
vi.mock('../chat/session-manager', () => ({
  sessionManager: {
    prompt: mockPrompt,
    compactNow: mockCompactNow,
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
    return () => {
      broadcastTaps.delete(cb);
    };
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
    delete: vi.fn(async () => {}),
  },
}));

const { telegramGatewayConfig, telegramGatewaySecrets, lastSelectedModel } = await import(
  '@/lib/persistence/storage'
);

const VALID_CONFIG = { workerUrl: 'https://gw.example.workers.dev/ws', allowedChatIdsCsv: '', interactiveMode: false };
const VALID_SECRETS = [{ id: 'default', botToken: 'bot', webhookSecret: 'wh', wsAuthToken: 'tok' }];

/** 刷过 100ms 去抖 + 全部 microtask。 */
const flushAsync = () => vi.advanceTimersByTimeAsync(200);

/** mock bootstrap client 注册的 onMessage listener（第一个）。 */
let inboundListener: ((msg: InboundMessage) => unknown) | undefined;

let buildTabsKeyboard: typeof import('./manager')['buildTabsKeyboard'];
let parseTabCallbackData: typeof import('./manager')['parseTabCallbackData'];
let setupTelegramGatewayManager: typeof import('./manager')['setupTelegramGatewayManager'];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  fakeBrowser.reset();
  mockBootstrap.mockReset();
  mockPrompt.mockReset();
  mockSessions.clear();
  broadcastTaps.clear();
  toolExecutionCbs.clear();
  inboundListener = undefined;
  mockBootstrap.mockImplementation(() => ({
    teardown: vi.fn(),
    client: {
      onMessage: vi.fn((cb: (msg: InboundMessage) => unknown) => {
        inboundListener = cb;
      }),
      onTelegramCallback: vi.fn(),
      sendOutbound: vi.fn(async () => ({
        kind: 'sendMessage_result' as const,
        request_id: 'x',
        ok: true,
        message_id: 1,
      })),
    },
  }));
  ({ buildTabsKeyboard, parseTabCallbackData, setupTelegramGatewayManager } = await import('./manager'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildTabsKeyboard (pure)', () => {
  it('builds 1 button per row with cap_<id> callback_data', () => {
    const { keyboard, overflow } = buildTabsKeyboard([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ]);
    expect(keyboard).toHaveLength(2);
    expect(keyboard[0]).toEqual([{ text: 'A', callback_data: 'cap_1' }]);
    expect(keyboard[1]).toEqual([{ text: 'B', callback_data: 'cap_2' }]);
    expect(overflow).toBe(0);
  });

  it('clips titles longer than 48 chars to 47 + ellipsis', () => {
    const long = 'x'.repeat(80);
    const { keyboard } = buildTabsKeyboard([{ id: 7, title: long }]);
    expect(keyboard[0][0].text).toBe(`${'x'.repeat(47)}…`);
  });

  it('falls back to "(untitled)" for empty / whitespace / missing titles', () => {
    const { keyboard } = buildTabsKeyboard([
      { id: 1, title: '' },
      { id: 2, title: '   ' },
      { id: 3 },
    ]);
    expect(keyboard.map((row) => row[0].text)).toEqual(['(untitled)', '(untitled)', '(untitled)']);
  });

  it('caps at max rows and reports the overflow count', () => {
    const tabs = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, title: `T${i}` }));
    const { keyboard, overflow } = buildTabsKeyboard(tabs);
    expect(keyboard).toHaveLength(10);
    expect(overflow).toBe(5);
  });

  it('filters out tabs without a numeric id (discarded/prerender)', () => {
    const { keyboard, overflow } = buildTabsKeyboard([{ id: 1, title: 'ok' }, { title: 'no-id' }]);
    expect(keyboard).toHaveLength(1);
    expect(overflow).toBe(0);
  });

  it('empty input → empty keyboard, zero overflow', () => {
    expect(buildTabsKeyboard([])).toEqual({ keyboard: [], overflow: 0 });
  });
});

describe('parseTabCallbackData (pure)', () => {
  it('parses cap_<digits> → number', () => {
    expect(parseTabCallbackData('cap_123')).toBe(123);
    expect(parseTabCallbackData('cap_0')).toBe(0);
  });

  it('rejects non-numeric / non-cap / empty payloads', () => {
    expect(parseTabCallbackData('cap_abc')).toBeNull();
    expect(parseTabCallbackData('cap_')).toBeNull();
    expect(parseTabCallbackData('cap_12x')).toBeNull();
    expect(parseTabCallbackData('foo')).toBeNull();
    expect(parseTabCallbackData('')).toBeNull();
  });

  it('rejects ids beyond Number.MAX_SAFE_INTEGER', () => {
    expect(parseTabCallbackData(`cap_${'9'.repeat(20)}`)).toBeNull();
  });
});

describe('/tabs interception (integration)', () => {
  it('/tabs → sendMessage with inline keyboard, không vào LLM — kể cả interactiveMode OFF', async () => {
    // 显式命令不吃 interactiveMode gate —— 这里故意 OFF。
    await telegramGatewayConfig.setValue(VALID_CONFIG);
    await telegramGatewaySecrets.setValue(VALID_SECRETS);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();

    // Stub chrome.tabs.query（fakeBrowser 提供真 tabs API，这里替换成固定
    // 结果 —— 集成测试只关心 manager 的 dispatch 逻辑，不关心 tabs store）。
    // 直接赋值而非 vi.spyOn：@types/chrome 的 query 有 callback overload，
    // spyOn 的类型推断会落到 `void` 返回值上。
    const fakeTabs = [
      { id: 101, title: 'Docs', url: 'https://docs', active: true, windowId: 1, index: 0 },
      { id: 102, title: 'Mail', url: 'https://mail', active: false, windowId: 1, index: 1 },
    ] as chrome.tabs.Tab[];
    const originalQuery = chrome.tabs.query;
    chrome.tabs.query = () => Promise.resolve(fakeTabs);
    try {
      await inboundListener!({
        kind: 'telegram_message',
        update_id: 1,
        message_id: 1,
        chat_id: 965822571,
        chat_type: 'private',
        text: '/tabs',
        date: 1737000000,
        from: { id: 42, username: 'tester' },
      });
      await flushAsync();
    } finally {
      chrome.tabs.query = originalQuery;
    }

    const client = mockBootstrap.mock.results[0]!.value.client;
    expect(client.sendOutbound).toHaveBeenCalled();
    const sent = client.sendOutbound.mock.calls[0][0];
    expect(sent.kind).toBe('sendMessage');
    expect(sent.chat_id).toBe(965822571);
    expect(sent.reply_markup?.inline_keyboard).toHaveLength(2);
    expect(sent.reply_markup!.inline_keyboard[0][0]).toEqual({
      text: 'Docs',
      callback_data: 'cap_101',
    });
    // 关键断言：/tabs 不进 LLM。
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it('/tabs@botname also matches the interception regex', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG);
    await telegramGatewaySecrets.setValue(VALID_SECRETS);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();

    // 同上：直接赋值绕开 callback-overload 的类型推断问题。
    const originalQuery = chrome.tabs.query;
    chrome.tabs.query = () => Promise.resolve([]);
    try {
      await inboundListener!({
        kind: 'telegram_message',
        update_id: 2,
        message_id: 2,
        chat_id: 965822571,
        chat_type: 'private',
        text: '/tabs@cebian_bot',
        date: 1737000000,
        from: { id: 42, username: 'tester' },
      });
      await flushAsync();
    } finally {
      chrome.tabs.query = originalQuery;
    }

    const client = mockBootstrap.mock.results[0]!.value.client;
    const sent = client.sendOutbound.mock.calls[0][0];
    expect(sent.kind).toBe('sendMessage');
    // 0 tab → fallback 文案，不附带 keyboard。
    expect(sent.text).toContain('Không có tab nào');
    expect(sent.reply_markup).toBeUndefined();
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it('regression: 非命令文本在 interactiveMode OFF 下仍然被忽略（拦截不能过宽）', async () => {
    await telegramGatewayConfig.setValue(VALID_CONFIG); // interactiveMode: false
    await telegramGatewaySecrets.setValue(VALID_SECRETS);
    await lastSelectedModel.setValue({ provider: 'test', modelId: 'test-model' });
    setupTelegramGatewayManager();
    await flushAsync();

    await inboundListener!({
      kind: 'telegram_message',
      update_id: 3,
      message_id: 3,
      chat_id: 965822571,
      chat_type: 'private',
      text: '/tabss Extra', // 前缀相似但不匹配 regex
      date: 1737000000,
      from: { id: 42, username: 'tester' },
    });
    await flushAsync();

    const client = mockBootstrap.mock.results[0]!.value.client;
    expect(client.sendOutbound).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
  });
});
