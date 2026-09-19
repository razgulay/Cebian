// Unit tests for `entrypoints/background/scheduler/notify-external.ts`.
//
// 用 `_testHelpers.mockStorage` 替换 `notifyChannels` / `notifyChannelSecrets`
// 的 getValue / setValue（不真打 IndexedDB / chrome.storage），mock `globalThis.fetch`
// 替换网络层。覆盖 happy / filter enabled / filter onSuccess / missing secret / error
// isolation。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelConfig, ChannelSecret } from '@/lib/scheduler/notify-channels/types';
import type { RunResult, ScheduledTask } from '@/lib/scheduler/types';
import { notifyChannels } from '@/lib/persistence/storage';

const realFetch = globalThis.fetch;

const {
  dispatchTaskExternalNotifications,
  notifyChannelStats,
  _testHelpers,
} = await import('./notify-external');

function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: over.id ?? 'task-1',
    name: over.name ?? 'demo-task',
    schedule: over.schedule ?? { kind: 'interval', minutes: 15 },
    action: over.action ?? {
      kind: 'webcheck',
      url: 'https://example.test/',
      condition: 'status_200',
    },
    notify: over.notify ?? { onSuccess: true, onFailure: true },
    enabled: true,
    createdAt: 1737000000000,
    lastRunAt: null,
    lastResult: null,
  };
}

function successResult(): RunResult {
  return { ok: true, summary: 'Status 200 OK', at: 1737000000000 };
}

function failureResult(): RunResult {
  return { ok: false, summary: 'Status 500', at: 1737000000000, error: 'server' };
}

function ntfyConfig(over: Partial<ChannelConfig & { kind: 'ntfy' }> = {}): ChannelConfig {
  return {
    id: over.id ?? 'ch-ntfy',
    kind: 'ntfy',
    name: over.name ?? 'ntfy-channel',
    enabled: over.enabled ?? true,
    notifyOnSuccess: over.notifyOnSuccess ?? true,
    notifyOnFailure: over.notifyOnFailure ?? true,
    topic: over.topic ?? 'cebian-alerts',
  };
}

function ntfySecret(over: Partial<ChannelSecret & { kind: 'ntfy' }> = {}): ChannelSecret {
  return { id: over.id ?? 'ch-ntfy', kind: 'ntfy', endpoint: over.endpoint ?? null };
}

function webhookConfig(over: Partial<ChannelConfig & { kind: 'webhook' }> = {}): ChannelConfig {
  return {
    id: over.id ?? 'ch-hook',
    kind: 'webhook',
    name: over.name ?? 'hook-channel',
    enabled: over.enabled ?? true,
    notifyOnSuccess: over.notifyOnSuccess ?? true,
    notifyOnFailure: over.notifyOnFailure ?? true,
  };
}

function webhookSecret(over: Partial<ChannelSecret & { kind: 'webhook' }> = {}): ChannelSecret {
  return { id: over.id ?? 'ch-hook', kind: 'webhook', url: over.url ?? 'https://example.test/hook' };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('dispatchTaskExternalNotifications', () => {
  let storage: ReturnType<typeof _testHelpers.mockStorage>;

  beforeEach(() => {
    storage = _testHelpers.mockStorage();
  });

  afterEach(() => {
    storage.unmount();
  });

  it('empty channels list → no fetch', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    await dispatchTaskExternalNotifications(makeTask(), successResult());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('happy path: ok + channel.notifyOnSuccess=true → fetch called once with expected body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await storage.channelsSet([ntfyConfig()]);
    await storage.secretsSet([ntfySecret()]);

    await dispatchTaskExternalNotifications(makeTask({ name: 'demo' }), successResult());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Title).toContain('demo');
    expect(headers.Priority).toBe('high');
    expect(init.body).toBe('Status 200 OK');
  });

  it('failure + notifyOnFailure=true → fetch called with urgent priority', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await storage.channelsSet([ntfyConfig()]);
    await storage.secretsSet([ntfySecret()]);

    await dispatchTaskExternalNotifications(makeTask(), failureResult());

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Priority).toBe('urgent');
  });

  it('enabled=false channel → no fetch', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await storage.channelsSet([ntfyConfig({ enabled: false })]);
    await storage.secretsSet([ntfySecret()]);

    await dispatchTaskExternalNotifications(makeTask(), successResult());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('ok result but channel.notifyOnSuccess=false → no fetch', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await storage.channelsSet([ntfyConfig({ notifyOnSuccess: false })]);
    await storage.secretsSet([ntfySecret()]);

    await dispatchTaskExternalNotifications(makeTask(), successResult());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('ntfy without secret uses public ntfy.sh (one fetch to ntfy.sh)', async () => {
    // ntfy 公开 server 不需要 secret——sendNtfy fallback 到 https://ntfy.sh/<topic>，
    // 这正是「ntfy without secret 仍能工作」的设计（用户用公开 topic 当通知）。
    // 与 Telegram / webhook 不同（那些 secret = URL/token，没有就发不出去）。
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await storage.channelsSet([ntfyConfig({ id: 'no-secret' })]);

    await dispatchTaskExternalNotifications(makeTask(), successResult());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://ntfy.sh/cebian-alerts');
  });

  it('telegram without secret → channel reported as failure, no fetch', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await storage.channelsSet([
      {
        id: 'tg-1',
        kind: 'telegram',
        name: 'tg',
        enabled: true,
        notifyOnSuccess: true,
        notifyOnFailure: true,
        chatId: '12345',
      },
    ]);

    await expect(
      dispatchTaskExternalNotifications(makeTask(), successResult()),
    ).resolves.toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('webhook without secret → channel reported as failure, no fetch', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await storage.channelsSet([webhookConfig({ id: 'hook-1' })]);

    await expect(
      dispatchTaskExternalNotifications(makeTask(), successResult()),
    ).resolves.toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('multiple channels: one channel throws fetch, others still dispatch', async () => {
    let callIdx = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const idx = callIdx++;
      if (idx === 0) throw new TypeError('Failed to fetch');
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await storage.channelsSet([
      ntfyConfig({ id: 'ch-a' }),
      webhookConfig({ id: 'ch-b' }),
    ]);
    await storage.secretsSet([
      ntfySecret({ id: 'ch-a' }),
      webhookSecret({ id: 'ch-b' }),
    ]);

    await dispatchTaskExternalNotifications(makeTask(), successResult());

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('storage getValue throws → dispatchTaskExternalNotifications swallows it', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    // 把 getValue 替换成抛错版本——直接 mutate module-level 的 storage import
    // （mockStorage 已经把 notifyChannels.getValue 替换为 closure，重新 mutate
    // 这个 closure 即可让 storage 报 throw）。
    const originalGet = notifyChannels.getValue;
    notifyChannels.getValue = vi.fn().mockRejectedValue(new Error('storage broken')) as never;

    // 不应 throw——BG tick 不能因为外部通知失败而 crash
    await expect(
      dispatchTaskExternalNotifications(makeTask(), successResult()),
    ).resolves.toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    notifyChannels.getValue = originalGet;
  });
});

describe('notifyChannelStats', () => {
  let storage: ReturnType<typeof _testHelpers.mockStorage>;

  beforeEach(() => {
    storage = _testHelpers.mockStorage();
  });

  afterEach(() => {
    storage.unmount();
  });

  it('returns counts of channels and secrets', async () => {
    await storage.channelsSet([
      ntfyConfig({ id: 'a' }),
      webhookConfig({ id: 'b' }),
      ntfyConfig({ id: 'c', enabled: false }),
    ]);
    await storage.secretsSet([
      ntfySecret({ id: 'a' }),
      webhookSecret({ id: 'b' }),
      // c 无 secret
    ]);

    const stats = await notifyChannelStats();
    expect(stats).toEqual({ channels: 3, secrets: 2 });
  });
});
