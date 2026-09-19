// Unit tests for `entrypoints/background/scheduler/manager.ts`.
//
// BG manager runs entirely in extension context (service worker / sidepanel) but
// 不直接 import `chrome.*` API（除了通过 port-registry 的 broadcastAll）。这意味着
// 测试可以 mock 掉 `chrome.alarms` / `scheduledTasks` storage / `broadcastAll` 后
// 单纯验证 tick + dispatchTask + write-back + notification 逻辑，无需起 real Chrome。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks phải khai báo TRƯỚC import manager.ts (hoisting) ───

const storage = new Map<string, unknown>();
const setStorage = vi.fn(async (key: string, value: unknown) => {
  if (key === 'local:scheduledTasks') storage.set(key, value);
});
const getStorage = vi.fn(async (key: string) => storage.get(key));

vi.mock('@/lib/persistence/storage', () => ({
  scheduledTasks: {
    getValue: () => getStorage('local:scheduledTasks'),
    setValue: (v: unknown) => setStorage('local:scheduledTasks', v),
  },
}));

const broadcastCalls: unknown[] = [];
vi.mock('../ipc/port-registry', () => ({
  broadcastAll: (msg: unknown) => broadcastCalls.push(msg),
}));

const notificationCalls: Array<{ taskName: string; success: boolean }> = [];
vi.mock('./notify', () => ({
  sendTaskNotification: async (task: { name: string }, result: { ok: boolean }) => {
    notificationCalls.push({ taskName: task.name, success: result.ok });
  },
}));

// 现在 import manager（mocks 已挂上）
const { tick, dispatchTask, _internal, setupScheduler } = await import('./manager');

function makeTask(over: Partial<import('@/lib/scheduler/types').ScheduledTask> = {}): import('@/lib/scheduler/types').ScheduledTask {
  const now = Date.now();
  return {
    id: over.id ?? crypto.randomUUID(),
    name: over.name ?? 'Test task',
    schedule: over.schedule ?? { kind: 'interval', minutes: 15 },
    action: over.action ?? { kind: 'webcheck', url: 'https://example.com', condition: 'status_200' },
    notify: over.notify ?? { onSuccess: true, onFailure: true },
    enabled: over.enabled ?? true,
    createdAt: over.createdAt ?? now - 60_000,
    lastRunAt: over.lastRunAt ?? null,
    lastResult: over.lastResult ?? null,
  };
}

describe('BG scheduler manager — tick()', () => {
  beforeEach(() => {
    storage.clear();
    setStorage.mockClear();
    getStorage.mockClear();
    broadcastCalls.length = 0;
    notificationCalls.length = 0;
    _internal.resetForTest();
  });

  afterEach(() => {
    _internal.resetForTest();
  });

  it('dispatches every enabled task that is due', async () => {
    // 两个 enabled tasks lastRunAt 都已过 interval；一个 disabled lastRunAt 也是过去的（不该跑）。
    const due1 = makeTask({ name: 'due-1', lastRunAt: 1_000_000 });
    const due2 = makeTask({ name: 'due-2', lastRunAt: 1_000_000 });
    const skipped = makeTask({ name: 'skipped', lastRunAt: 1_000_000, enabled: false });
    storage.set('local:scheduledTasks', [due1, due2, skipped]);
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);

    await tick();

    // 广播两条 scheduler_result（每个 due 任务一条）；skipped 不出现。
    const resultBroadcasts = broadcastCalls.filter(
      (m) => (m as { type: string }).type === 'scheduler_result',
    );
    expect(resultBroadcasts).toHaveLength(2);
    expect((resultBroadcasts[0] as { taskId: string }).taskId).toBe(due1.id);
    expect((resultBroadcasts[1] as { taskId: string }).taskId).toBe(due2.id);

    // 桌面通知 — 两条都发（due1 + due2 成功 → onSuccess true）。
    expect(notificationCalls).toHaveLength(2);
    expect(notificationCalls[0].taskName).toBe('due-1');

    // 写回 lastRunAt + lastResult —— 任务现在是 interval 起点 + interval 后。
    const after = (await getStorage('local:scheduledTasks')) as import('@/lib/scheduler/types').ScheduledTask[];
    expect(after).toHaveLength(3);
    // lastRunAt = 上次 fire 的「时间锚」（不是 wall-clock now）：1_000_000 + 15*60_000 = 1_900_000。
    // 下次 tick 用这个锚 + interval 算下一次 fire —— 与 chrome.alarms period 语义一致。
    expect(after[0].lastRunAt).toBe(1_900_000);
    expect(after[0].lastResult).toBeTruthy();
    expect(after[0].lastResult?.ok).toBe(true);

    vi.useRealTimers();
  });

  it('skips tasks whose interval has not elapsed', async () => {
    // lastRunAt = now-2min, interval = 15min → 不到点
    const recent = makeTask({
      name: 'recent',
      lastRunAt: 1_000_000,
      schedule: { kind: 'interval', minutes: 15 },
    });
    storage.set('local:scheduledTasks', [recent]);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000 + 2 * 60_000); // 仅过去 2 分钟

    await tick();

    expect(broadcastCalls).toHaveLength(0);
    expect(notificationCalls).toHaveLength(0);

    const after = (await getStorage('local:scheduledTasks')) as import('@/lib/scheduler/types').ScheduledTask[];
    expect(after).toHaveLength(1);
    // lastRunAt 输入就是 recent.lastRunAt；tick 没跑所以 lastResult 仍为 null、name 也不变。
    expect(after[0].lastRunAt).toBe(1_000_000);
    expect(after[0].lastResult).toBeNull();
    expect(after[0].name).toBe('recent');

    vi.useRealTimers();
  });

  it('skips when storage is empty', async () => {
    storage.set('local:scheduledTasks', []);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    await tick();

    expect(broadcastCalls).toHaveLength(0);
    expect(notificationCalls).toHaveLength(0);
    vi.useRealTimers();
  });

  it('single-flight: second tick while first is in-flight is a no-op', async () => {
    // 第一次 tick 进入 in-flight 状态；第二次 tick 在 first 完成前调用应立即 return。
    // 用 never-resolving fetch 让 runTask 挂起（vfs.readFile never resolves）。
    // 但 runner 用 fetch + abort，测试环境 fetch 抛错也很快 resolve —— 改用更直接
    // 的方式：让 tasks 数量为 1 且 runTask 是同步抛错——其实更简单：直接断言 second
    // tick 没产生第二次广播。简单方案：用 vi.useFakeTimers + setSystemTime 让 tick
    // 同步跑完。
    const task1 = makeTask({ name: 't1', lastRunAt: 1_000_000 });
    storage.set('local:scheduledTasks', [task1]);
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);

    // 第一次 tick：in-flight 还没释放
    const first = tick();
    // 立刻再调第二次 — tickInFlight = true → 直接 return
    const second = tick();
    await Promise.all([first, second]);

    // 第二 tick 没新广播
    const broadcasts = broadcastCalls.filter(
      (m) => (m as { type: string }).type === 'scheduler_result',
    );
    // 第一 tick 至少跑了一次 task；第二 tick 跳过。
    expect(broadcasts).toHaveLength(1);

    vi.useRealTimers();
  });
});

describe('BG scheduler manager — dispatchTask()', () => {
  beforeEach(() => {
    storage.clear();
    setStorage.mockClear();
    getStorage.mockClear();
    broadcastCalls.length = 0;
    notificationCalls.length = 0;
    _internal.resetForTest();
  });

  it('returns RunResult + broadcasts + notifies (manual trigger)', async () => {
    const task = makeTask({ name: 'manual-1' });
    // dispatchTask 不写回 storage（manual trigger 不污染 lastRunAt/lastResult 时间线）——
    // 但 storage 必须预先包含 task 让 dispatchTask 能找到它。
    storage.set('local:scheduledTasks', [task]);

    const result = await dispatchTask(task);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Status 200');

    // broadcastAll 收到 scheduler_result，source='manual' 区分于 tick。
    const resultBroadcasts = broadcastCalls.filter(
      (m) => (m as { type: string }).type === 'scheduler_result',
    );
    expect(resultBroadcasts).toHaveLength(1);
    expect(
      (resultBroadcasts[0] as { source: string; taskId: string }).source,
    ).toBe('manual');
    expect(
      (resultBroadcasts[0] as { source: string; taskId: string }).taskId,
    ).toBe(task.id);

    // 桌面通知
    expect(notificationCalls).toHaveLength(1);
    expect(notificationCalls[0].success).toBe(true);

    // dispatchTask 不写回 lastRunAt/lastResult —— task 在存储中保留原状。
    const after = (await getStorage('local:scheduledTasks')) as import('@/lib/scheduler/types').ScheduledTask[];
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(task.id);
    expect(after[0].lastRunAt).toBeNull();
    expect(after[0].lastResult).toBeNull();
  });
});

describe('setupScheduler wiring', () => {
  beforeEach(() => {
    storage.clear();
    _internal.resetForTest();
  });

  it('registers chrome.alarms listener exactly once (BG re-load safety)', () => {
    const addListener = vi.fn();
    // 模拟 chrome.alarms.onAlarm.addListener 替换为 spy
    const originalAlarms = (globalThis as { chrome?: typeof chrome }).chrome?.alarms;
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        ...((globalThis as { chrome?: typeof chrome }).chrome ?? {}),
        alarms: {
          ...(originalAlarms ?? {}),
          onAlarm: { addListener },
          create: vi.fn(),
        },
      },
    });
    try {
      setupScheduler();
      setupScheduler(); // 第二次调用应该是 no-op（listenersRegistered = true）
      expect(addListener).toHaveBeenCalledTimes(1);
    } finally {
      // 还原 chrome — 避免污染其它测试
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: originalAlarms ? { ...((globalThis as { chrome?: unknown })) } : undefined,
      });
    }
  });
});
