// ─── Mocks phải khai báo TRƯỚC import manager.ts (hoisting) ───

// ─── Mocks phải khai báo TRƯỚC import client-handlers (hoisting) ───

const storage = new Map<string, unknown>();
const setStorage = vi.fn(async (key: string, value: unknown) => {
  if (key === 'local:scheduledTasks') storage.set(key, value);
});
const getStorage = vi.fn(async (key: string) => {
  // 默认空数组——storage.clear() 后任何 get 都返回 []，让 handler 行为与
  // 「列表为空但存在」一致（避免 undefined 让 tasks.find 抛错）。
  return storage.get(key) ?? [];
});

vi.mock('@/lib/persistence/storage', () => ({
  scheduledTasks: {
    getValue: () => getStorage('local:scheduledTasks'),
    setValue: (v: unknown) => setStorage('local:scheduledTasks', v),
  },
}));

const notificationCalls: Array<{ taskName: string; success: boolean }> = [];
vi.mock('./notify', () => ({
  sendTaskNotification: async (task: { name: string }, result: { ok: boolean }) => {
    notificationCalls.push({ taskName: task.name, success: result.ok });
  },
}));

// manager.test.ts 用动态 await import 没出问题——本测试也用动态以保一致。动态
// import 在 hoisted mock 之后才 resolve，保证 mock factory 先 evaluate。
const { schedulerClientHandlers } = await import('./client-handlers');
import type { ClientMessage, ServerMessage } from '@/lib/ipc/protocol';
import type { ScheduledTask } from '@/lib/scheduler/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeMockPort(): { port: chrome.runtime.Port; posts: ServerMessage[] } {
  const posts: ServerMessage[] = [];
  // Real port-registry 用 port.postMessage；mock port 同名方法把消息落进 posts
  // 让 test 拿到。其他 chrome.runtime.Port 方法调用会 undefined 报错——这里不
  // 调所以安全。
  const port = {
    post: vi.fn(),
    postMessage: vi.fn((msg: unknown) => {
      posts.push(msg as ServerMessage);
    }),
    disconnect: vi.fn(),
  } as unknown as chrome.runtime.Port;
  return { port, posts };
}

function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
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

describe('schedulerClientHandlers — scheduler_list', () => {
  beforeEach(() => {
    storage.clear();
    setStorage.mockClear();
    getStorage.mockClear();
  });

  it('returns scheduler_list_result with current tasks', async () => {
    const t1 = makeTask({ name: 'a' });
    const t2 = makeTask({ name: 'b' });
    storage.set('local:scheduledTasks', [t1, t2]);

    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_list!(port, {
      type: 'scheduler_list',
    } as never);

    expect(posts).toHaveLength(1);
    expect(posts[0].type).toBe('scheduler_list_result');
    expect((posts[0] as { tasks: unknown[] }).tasks).toEqual([t1, t2]);
  });

  it('empty storage returns empty tasks array', async () => {
    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_list!(port, {
      type: 'scheduler_list',
    } as never);
    expect((posts[0] as { tasks: unknown[] }).tasks).toEqual([]);
  });
});

describe('schedulerClientHandlers — scheduler_create', () => {
  beforeEach(() => {
    storage.clear();
    setStorage.mockClear();
    getStorage.mockClear();
    // 默认空数组——「id not found」类测试不需要 pre-seed task，避免 tasks.find(undefined)
    // 抛 unhandled rejection。空数组 .find() 返回 undefined，是合法路径。
    storage.set('local:scheduledTasks', []);
  });

  it('happy path: valid task → scheduler_create_result with new id + task mirror', async () => {
    const existing = makeTask({ name: 'existing' });
    storage.set('local:scheduledTasks', [existing]);

    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_create!(port, {
      type: 'scheduler_create',
      task: {
        name: 'new-task',
        schedule: { kind: 'interval', minutes: 30 },
        action: { kind: 'fetch', url: 'https://example.com/api' },
        notify: { onSuccess: true, onFailure: false },
        enabled: true,
        createdAt: 1_700_000_000_000,
      },
    } as never);

    // 一次 post：scheduler_create_result（带 id + task），不是 scheduler_list_result。
    expect(posts).toHaveLength(1);
    expect(posts[0].type).toBe('scheduler_create_result');
    const reply = posts[0] as Extract<
      { type: 'scheduler_create_result'; id: string; task: unknown },
      { type: 'scheduler_create_result' }
    >;
    expect(typeof reply.id).toBe('string');
    expect(reply.id.length).toBeGreaterThan(0);

    // 任务列表里多了一条新 task，id 与 reply 一致。
    const tasks = (await getStorage('local:scheduledTasks')) as ScheduledTask[];
    expect(tasks).toHaveLength(2);
    expect(tasks[1].id).toBe(reply.id);
    expect(tasks[1].name).toBe('new-task');
  });

  it('invalid url (ftp://) → error reply (validation fail)', async () => {
    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_create!(port, {
      type: 'scheduler_create',
      task: {
        name: 'bad',
        schedule: { kind: 'interval', minutes: 15 },
        action: { kind: 'fetch', url: 'ftp://x.test/' },
        notify: { onSuccess: false, onFailure: false },
        enabled: true,
        createdAt: 1_700_000_000_000,
      },
    } as never);

    expect(posts).toHaveLength(1);
    expect(posts[0].type).toBe('error');
    expect((posts[0] as { error: string }).error).toContain('http or https');
    // 存储不变
    expect((await getStorage('local:scheduledTasks')) as unknown[]).toEqual([]);
  });

  it('interval = 0 minutes → reject (chrome.alarms floor)', async () => {
    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_create!(port, {
      type: 'scheduler_create',
      task: {
        name: 'bad',
        schedule: { kind: 'interval', minutes: 0 },
        action: { kind: 'webcheck', url: 'https://x.test/', condition: 'status_200' },
        notify: { onSuccess: false, onFailure: false },
        enabled: true,
        createdAt: 1_700_000_000_000,
      },
    } as never);

    expect((posts[0] as { error: string }).error).toContain('integer ≥ 1');
  });

  it('webcheck contains_text without expected → reject', async () => {
    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_create!(port, {
      type: 'scheduler_create',
      task: {
        name: 'bad',
        schedule: { kind: 'interval', minutes: 15 },
        action: { kind: 'webcheck', url: 'https://x.test/', condition: 'contains_text' },
        notify: { onSuccess: false, onFailure: false },
        enabled: true,
        createdAt: 1_700_000_000_000,
      },
    } as never);

    expect((posts[0] as { error: string }).error).toContain('expected');
  });
});

describe('schedulerClientHandlers — scheduler_update', () => {
  beforeEach(() => {
    storage.clear();
    setStorage.mockClear();
    getStorage.mockClear();
    storage.set('local:scheduledTasks', []);
  });

  it('happy path: patch merges into existing task', async () => {
    const t1 = makeTask({ name: 'before', enabled: true });
    storage.set('local:scheduledTasks', [t1]);

    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_update!(port, {
      type: 'scheduler_update',
      id: t1.id,
      patch: { name: 'after', enabled: false },
    } as never);

    expect(posts).toHaveLength(1);
    expect(posts[0].type).toBe('scheduler_list_result');

    const after = (await getStorage('local:scheduledTasks')) as ScheduledTask[];
    expect(after[0].name).toBe('after');
    expect(after[0].enabled).toBe(false);
    // 未改字段保留
    expect(after[0].schedule).toEqual(t1.schedule);
  });

  it('empty patch → error reply (BG reject min-1-field)', async () => {
    const t1 = makeTask({});
    storage.set('local:scheduledTasks', [t1]);

    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_update!(port, {
      type: 'scheduler_update',
      id: t1.id,
      patch: {},
    } as never);

    expect(posts[0].type).toBe('error');
    expect((posts[0] as { error: string }).error).toContain('at least one');
  });

  it('id not found → error reply (no list refresh)', async () => {
    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_update!(port, {
      type: 'scheduler_update',
      id: 'nonexistent-id',
      patch: { name: 'x' },
    } as never);

    expect(posts[0].type).toBe('error');
    expect((posts[0] as { error: string }).error).toContain('no task');
  });
});

describe('schedulerClientHandlers — scheduler_delete', () => {
  beforeEach(() => {
    storage.clear();
    setStorage.mockClear();
    getStorage.mockClear();
    storage.set('local:scheduledTasks', []);
  });

  it('removes the task by id and returns updated list', async () => {
    const t1 = makeTask({ name: 'keep' });
    const t2 = makeTask({ name: 'drop' });
    storage.set('local:scheduledTasks', [t1, t2]);

    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_delete!(port, {
      type: 'scheduler_delete',
      id: t2.id,
    } as never);

    expect(posts[0].type).toBe('scheduler_list_result');
    const after = (await getStorage('local:scheduledTasks')) as ScheduledTask[];
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(t1.id);
  });

  it('id not found → error reply (no list refresh)', async () => {
    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_delete!(port, {
      type: 'scheduler_delete',
      id: 'nonexistent-id',
    } as never);

    expect(posts[0].type).toBe('error');
    expect((posts[0] as { error: string }).error).toContain('no task');
  });
});

describe('schedulerClientHandlers — scheduler_run_now', () => {
  beforeEach(() => {
    storage.clear();
    setStorage.mockClear();
    getStorage.mockClear();
    notificationCalls.length = 0;
    storage.set('local:scheduledTasks', []);
  });

  it('happy path: returns scheduler_list_result + triggers notification', async () => {
    const task = makeTask({ name: 'run-now' });
    storage.set('local:scheduledTasks', [task]);

    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_run_now!(port, {
      type: 'scheduler_run_now',
      id: task.id,
    } as never);

    expect(posts[0].type).toBe('scheduler_list_result');
    expect(notificationCalls).toHaveLength(1);
    expect(notificationCalls[0].taskName).toBe('run-now');
  });

  it('id not found → error reply (no notification)', async () => {
    const { port, posts } = makeMockPort();
    await schedulerClientHandlers.scheduler_run_now!(port, {
      type: 'scheduler_run_now',
      id: 'nonexistent-id',
    } as never);

    expect(posts[0].type).toBe('error');
    expect(notificationCalls).toHaveLength(0);
  });
});
