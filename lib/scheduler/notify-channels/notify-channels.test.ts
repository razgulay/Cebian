// Unit tests for lib/scheduler/notify-channels/* adapters + dispatcher.
//
// 全 mock `globalThis.fetch`（每个 test 用 vi.spyOn 替换、afterEach 还原）。
// 覆盖 happy path / 网络失败 / 非 2xx / timeout / malformed URL / 各 adapter
// 边界。dispatcher 测 0 channel / 1 channel / 3 channel mixed result。

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelConfig,
  ChannelSecret,
  NotifyPayload,
} from './types';
import { sendNtfy } from './ntfy';
import { sendTelegram } from './telegram';
import { sendWebhook } from './webhook';
import {
  dispatchExternalNotifications,
  dispatchSingleChannelTest,
} from './dispatcher';

const realFetch = globalThis.fetch;

function mockFetchOnce(impl: Parameters<typeof fetch>[1] extends infer _ ? typeof fetch : never): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(impl);
}

function payload(over: Partial<NotifyPayload> = {}): NotifyPayload {
  return {
    taskName: over.taskName ?? 'demo-task',
    ok: over.ok ?? true,
    summary: over.summary ?? 'Status 200 OK',
    at: over.at ?? 1737000000000,
  };
}

function ntfyConfig(over: Partial<Extract<ChannelConfig, { kind: 'ntfy' }>> = {}): Extract<ChannelConfig, { kind: 'ntfy' }> {
  return {
    id: over.id ?? 'ch-1',
    kind: 'ntfy',
    name: over.name ?? 'my ntfy',
    enabled: over.enabled ?? true,
    notifyOnSuccess: over.notifyOnSuccess ?? true,
    notifyOnFailure: over.notifyOnFailure ?? true,
    topic: over.topic ?? 'cebian-alerts',
  };
}

function ntfySecret(over: Partial<Extract<ChannelSecret, { kind: 'ntfy' }>> = {}): Extract<ChannelSecret, { kind: 'ntfy' }> {
  return {
    id: over.id ?? 'ch-1',
    kind: 'ntfy',
    endpoint: over.endpoint ?? null,
  };
}

function telegramConfig(over: Partial<Extract<ChannelConfig, { kind: 'telegram' }>> = {}): Extract<ChannelConfig, { kind: 'telegram' }> {
  return {
    id: over.id ?? 'ch-1',
    kind: 'telegram',
    name: over.name ?? 'my tg',
    enabled: over.enabled ?? true,
    notifyOnSuccess: over.notifyOnSuccess ?? true,
    notifyOnFailure: over.notifyOnFailure ?? true,
    chatId: over.chatId ?? '12345',
  };
}

function telegramSecret(over: Partial<Extract<ChannelSecret, { kind: 'telegram' }>> = {}): Extract<ChannelSecret, { kind: 'telegram' }> {
  return {
    id: over.id ?? 'ch-1',
    kind: 'telegram',
    token: over.token ?? 'fake-bot-token',
  };
}

function webhookConfig(over: Partial<Extract<ChannelConfig, { kind: 'webhook' }>> = {}): Extract<ChannelConfig, { kind: 'webhook' }> {
  return {
    id: over.id ?? 'ch-1',
    kind: 'webhook',
    name: over.name ?? 'my hook',
    enabled: over.enabled ?? true,
    notifyOnSuccess: over.notifyOnSuccess ?? true,
    notifyOnFailure: over.notifyOnFailure ?? true,
  };
}

function webhookSecret(over: Partial<Extract<ChannelSecret, { kind: 'webhook' }>> = {}): Extract<ChannelSecret, { kind: 'webhook' }> {
  return {
    id: over.id ?? 'ch-1',
    kind: 'webhook',
    url: over.url ?? 'https://example.test/hook',
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ─── ntfy adapter ───

describe('sendNtfy', () => {
  it('happy path: 2xx → success with latencyMs', async () => {
    const fetchMock = mockFetchOnce(async () => {
      return new Response('ok', { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendNtfy(
      payload({ ok: true, taskName: 'my-task' }),
      ntfyConfig({ topic: 'cebian' }),
      ntfySecret({ endpoint: null }), // null → default to ntfy.sh
    );

    expect(result.success).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.channelKind).toBe('ntfy');
    // URL 用了默认 host + topic
    const callUrl = fetchMock.mock.calls[0]![0] as string;
    expect(callUrl).toBe('https://ntfy.sh/cebian');
    // Headers + body
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Title).toContain('my-task');
    expect((init.headers as Record<string, string>).Priority).toBe('high');
    expect(init.body).toBe('Status 200 OK');
    expect(init.method).toBe('POST');
  });

  it('priority uses "urgent" when payload.ok is false', async () => {
    const fetchMock = mockFetchOnce(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendNtfy(payload({ ok: false }), ntfyConfig(), ntfySecret());

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Priority).toBe('urgent');
  });

  it('endpoint with trailing slash is normalized', async () => {
    const fetchMock = mockFetchOnce(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendNtfy(payload(), ntfyConfig({ topic: 'alerts' }), ntfySecret({ endpoint: 'https://self.test/' }));

    expect(fetchMock.mock.calls[0]![0]).toBe('https://self.test/alerts');
  });

  it('non-2xx response → failure with status in error', async () => {
    globalThis.fetch = mockFetchOnce(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch;

    const result = await sendNtfy(payload(), ntfyConfig(), ntfySecret());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('401');
  });

  it('network failure (fetch throws TypeError) → failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    const result = await sendNtfy(payload(), ntfyConfig(), ntfySecret());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Failed to fetch');
      expect(result.error).toContain('ntfy.sh'); // host-only, no path
    }
  });

  it('timeout (AbortError) → failure with timeout message', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')) as unknown as typeof fetch;

    const result = await sendNtfy(payload(), ntfyConfig(), ntfySecret());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('timed out');
  });

  it('endpoint with ?user=&pass= → adds Basic auth header', async () => {
    const fetchMock = mockFetchOnce(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendNtfy(
      payload(),
      ntfyConfig({ topic: 'private' }),
      ntfySecret({ endpoint: 'https://ntfy.example.com/?user=alice&pass=wonderland' }),
    );

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    // btoa('alice:wonderland') = 'YWxpY2U6d29uZGVybGFuZA=='
    expect(headers.Authorization).toBe('Basic YWxpY2U6d29uZGVybGFuZA==');
  });
});

// ─── Telegram adapter ───

describe('sendTelegram', () => {
  it('happy path: returns ok → success', async () => {
    globalThis.fetch = mockFetchOnce(async () => new Response('{"ok":true,"result":{"message_id":42}}', { status: 200 })) as unknown as typeof fetch;

    const result = await sendTelegram(
      payload({ taskName: 'my-tg' }),
      telegramConfig(),
      telegramSecret(),
    );

    expect(result.success).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('400 (markdown parse error) → fallback plain text retry succeeds', async () => {
    const fetchMock = vi
      .fn()
      // 第一次：markdown parse error
      .mockResolvedValueOnce(
        new Response('{"ok":false,"description":"Bad Request: can\'t parse entities"}', { status: 400 }),
      )
      // 第二次：plain text 成功
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendTelegram(payload(), telegramConfig(), telegramSecret());

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 第二次调用不带 parse_mode
    const retryBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string) as { parse_mode?: string };
    expect(retryBody.parse_mode).toBeUndefined();
  });

  it('500 (server error) → no retry, immediate failure', async () => {
    globalThis.fetch = mockFetchOnce(async () => new Response('{"ok":false,"description":"internal"}', { status: 500 })) as unknown as typeof fetch;

    const result = await sendTelegram(payload(), telegramConfig(), telegramSecret());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('500');
  });

  it('missing token (secret=null) → failure without network call', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const result = await sendTelegram(payload(), telegramConfig(), null);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('missing bot token');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('network failure → failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('NetworkError')) as unknown as typeof fetch;

    const result = await sendTelegram(payload(), telegramConfig(), telegramSecret());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('NetworkError');
  });
});

// ─── Webhook adapter ───

describe('sendWebhook', () => {
  it('happy path: 2xx → success with latency', async () => {
    globalThis.fetch = mockFetchOnce(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const result = await sendWebhook(payload({ ok: false, summary: 'fail' }), webhookConfig(), webhookSecret());

    expect(result.success).toBe(true);
  });

  it('body is structured JSON with source + taskName + ok + summary + at', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url, init) => {
      captured = { url: url as string, init: init as RequestInit };
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await sendWebhook(
      payload({ taskName: 'demo', ok: false, summary: 'boom', at: 1737000000000 }),
      webhookConfig({ id: 'ch-x' }),
      webhookSecret({ url: 'https://hook.test/abc' }),
    );

    expect(captured).not.toBeNull();
    const body = JSON.parse(captured!.init.body as string) as Record<string, unknown>;
    expect(body.source).toBe('cebian-scheduler');
    expect(body.taskName).toBe('demo');
    expect(body.ok).toBe(false);
    expect(body.summary).toBe('boom');
    expect(body.at).toBe(1737000000000);
  });

  it('non-2xx → failure', async () => {
    globalThis.fetch = mockFetchOnce(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;

    const result = await sendWebhook(payload(), webhookConfig(), webhookSecret());

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('404');
  });

  it('missing url (secret=null) → failure without network call', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const result = await sendWebhook(payload(), webhookConfig(), null);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('missing URL');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('timeout → failure with host-only in error (no token/path leak)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')) as unknown as typeof fetch;

    const result = await sendWebhook(payload(), webhookConfig(), webhookSecret({ url: 'https://secret-hook.example.test/path?token=abc' }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('timed out');
      expect(result.error).toContain('secret-hook.example.test'); // host only
      expect(result.error).not.toContain('token=abc'); // path scrubbed
    }
  });
});

// ─── dispatcher ───

describe('dispatchExternalNotifications', () => {
  it('empty channels list → empty result, no dispatch', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const results = await dispatchExternalNotifications(payload(), [], []);
    expect(results).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('all channels disabled → no dispatch', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const channels: ChannelConfig[] = [
      { ...ntfyConfig({ id: 'c1', enabled: false }), topic: 'a' },
      { ...webhookConfig({ id: 'c2', enabled: false }) },
    ];
    const secrets: ChannelSecret[] = [ntfySecret({ id: 'c1' }), webhookSecret({ id: 'c2' })];
    const results = await dispatchExternalNotifications(payload(), channels, secrets);
    expect(results).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('filters by notifyOnSuccess / notifyOnFailure', async () => {
    globalThis.fetch = mockFetchOnce(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const channels: ChannelConfig[] = [
      // ok=true, only notifyOnSuccess → send
      { ...ntfyConfig({ id: 'success', notifyOnSuccess: true, notifyOnFailure: false }), topic: 's' },
      // ok=true, only notifyOnFailure → SKIP
      { ...ntfyConfig({ id: 'failure', notifyOnSuccess: false, notifyOnFailure: true }), topic: 'f' },
    ];
    const secrets: ChannelSecret[] = [ntfySecret({ id: 'success' }), ntfySecret({ id: 'failure' })];

    await dispatchExternalNotifications(payload({ ok: true }), channels, secrets);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![0] as string)).toContain('/s');
  });

  it('mixed success / failure across channels → allSettled, one failure does not stop others', async () => {
    let callIdx = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const idx = callIdx;
      callIdx++;
      if (idx === 0) return new Response('ok', { status: 200 });
      if (idx === 1) throw new TypeError('Failed to fetch');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const channels: ChannelConfig[] = [
      ntfyConfig({ id: 'c1', topic: 'a' }),
      webhookConfig({ id: 'c2' }),
      telegramConfig({ id: 'c3', chatId: '123' }),
    ];
    const secrets: ChannelSecret[] = [
      ntfySecret({ id: 'c1' }),
      webhookSecret({ id: 'c2' }),
      telegramSecret({ id: 'c3' }),
    ];

    const results = await dispatchExternalNotifications(payload(), channels, secrets);

    expect(results).toHaveLength(3);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[2]!.success).toBe(true);
    // 三个 channel 都被尝试过，webhook 失败不阻塞另外两个。
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('missing secret → channel reported as failure, not crashed', async () => {
    globalThis.fetch = mockFetchOnce(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const channels: ChannelConfig[] = [
      ntfyConfig({ id: 'c1', topic: 'a' }),
      webhookConfig({ id: 'c2' }),
    ];
    // 只给 c1 secret，c2 没有 secret
    const secrets: ChannelSecret[] = [ntfySecret({ id: 'c1' })];

    const results = await dispatchExternalNotifications(payload(), channels, secrets);

    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    if (!results[1]!.success) expect(results[1]!.error).toContain('missing URL');
  });

  it('dispatchSingleChannelTest routes to right adapter', async () => {
    const fetchMock = mockFetchOnce(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await dispatchSingleChannelTest(
      payload(),
      ntfyConfig({ id: 'only', topic: 'lone' }),
      ntfySecret({ id: 'only' }),
    );

    expect(result.success).toBe(true);
    expect(result.channelId).toBe('only');
    expect(result.channelKind).toBe('ntfy');
  });
});
