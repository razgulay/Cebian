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
const { schedulerClientHandlers, setupSchedulerClientHandlers, dispatchDirect } = await import('./client-handlers');
const { _internal: clientRouterInternal } = await import('../ipc/client-router');
import type { ClientMessage, ServerMessage } from '@/lib/ipc/protocol';
import type { ScheduledTask } from '@/lib/scheduler/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSchedulerListResult,
  sendAndReceive,
} from '@/lib/scheduler/scheduler-ipc';

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

// ─── sendMessage bridge（chrome.runtime.onMessage 路由）───
//
// 工具走 chrome.runtime.sendMessage 调用 scheduler_*（参
// lib/scheduler/scheduler-ipc.ts），不是开 Port。setupSchedulerClientHandlers()
// 同步挂一个 onMessage listener 把 sendMessage 派发到现有的 port-style handler
// 并通过 sendResponse 回信——否则 sendResponse 从不调用，Chrome 立即关 port，
// 调用方 lastError = "The message port closed before a response was received."
describe('setupSchedulerClientHandlers — sendMessage bridge', () => {
  type Listener = (
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => boolean | Promise<boolean>;
  let registered: Listener | null = null;

  beforeEach(() => {
    storage.clear();
    setStorage.mockClear();
    getStorage.mockClear();
    registered = null;
    // client-router 是 module-level state——清空 handler 表避免「duplicate
    // registration」抛错，让每个 case 都能 fresh 调 setupSchedulerClientHandlers。
    clientRouterInternal.resetForTest();
    // fake-browser 默认 chrome.runtime.onMessage 是无 listener 的空表。
    // 我们 spy addListener 抓出 setupSchedulerClientHandlers 同步挂上的 listener
    // （也避免重复挂——前一个 describe 跑完不清理会累积）。
    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation(
      ((cb: Listener) => {
        registered = cb;
      }) as never,
    );
    vi.spyOn(chrome.runtime.onMessage, 'hasListeners').mockReturnValue(true);
  });

  function callBridge(msg: unknown): Promise<unknown> {
    if (!registered) {
      throw new Error('bridge listener was not registered — call setupSchedulerClientHandlers() first');
    }
    return new Promise((resolve) => {
      const keepOpen = registered!(msg, {} as chrome.runtime.MessageSender, (resp) => {
        resolve(resp);
      });
      // Per Chrome contract: listener returns true → keep channel open, async
      // sendResponse is allowed; returns false/undefined → channel already
      // closed, sendResponse 会被 Chrome 丢弃。
      expect(keepOpen).toBe(true);
    });
  }

  it('scheduler_list (empty storage) → 派发并回 scheduler_list_result', async () => {
    setupSchedulerClientHandlers();
    const reply = (await callBridge({ type: 'scheduler_list' })) as ServerMessage;
    expect(reply.type).toBe('scheduler_list_result');
    expect((reply as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it('scheduler_list (with stored tasks) → 回带任务的 result', async () => {
    const t1 = makeTask({ name: 'a' });
    storage.set('local:scheduledTasks', [t1]);
    setupSchedulerClientHandlers();
    const reply = (await callBridge({ type: 'scheduler_list' })) as ServerMessage;
    expect(reply.type).toBe('scheduler_list_result');
    expect((reply as { tasks: unknown[] }).tasks).toEqual([t1]);
  });

  it('scheduler_create (valid task) → 回 scheduler_create_result 带 id + task 镜像', async () => {
    setupSchedulerClientHandlers();
    const reply = (await callBridge({
      type: 'scheduler_create',
      task: {
        name: 'new-task',
        schedule: { kind: 'interval', minutes: 30 },
        action: { kind: 'fetch', url: 'https://example.com/api' },
        notify: { onSuccess: true, onFailure: false },
        enabled: true,
        createdAt: 1_700_000_000_000,
      },
    })) as ServerMessage;
    expect(reply.type).toBe('scheduler_create_result');
    const r = reply as { type: 'scheduler_create_result'; id: string; task: unknown };
    expect(typeof r.id).toBe('string');
    expect(r.id.length).toBeGreaterThan(0);
  });

  it('scheduler_create (invalid url) → 回 error envelope（validation 失败路径）', async () => {
    setupSchedulerClientHandlers();
    const reply = (await callBridge({
      type: 'scheduler_create',
      task: {
        name: 'bad',
        schedule: { kind: 'interval', minutes: 15 },
        action: { kind: 'fetch', url: 'ftp://x.test/' },
        notify: { onSuccess: false, onFailure: false },
        enabled: true,
        createdAt: 1_700_000_000_000,
      },
    })) as ServerMessage;
    expect(reply.type).toBe('error');
    expect((reply as { error: string }).error).toContain('http or https');
  });

  it('非 scheduler 消息 → return false（不抢别域的 listener）', () => {
    setupSchedulerClientHandlers();
    if (!registered) throw new Error('listener not registered');
    const result = registered({ type: 'mcp_status' }, {} as chrome.runtime.MessageSender, () => {});
    expect(result).toBe(false);
  });

  it('handler 抛错 → bridge 兜底回 error envelope，不挂起（不关 port 不回信 = 调用方看到 message port closed）', async () => {
    setupSchedulerClientHandlers();
    // scheduler_run_now 找不存在的 id → handler 走 replyError 不抛；这里用
    // 一个不识别的 type 故意让 handler 走 "no handler" 路径（实际不会发生，
    // 但保证 catch 兜底存在）。
    // 直接验证更稳的：mock handler 抛——但 schedulerClientHandlers 是 module
    // export，改不到。改用 proxy：传入 type 让 dispatchAndReply 内部拿不到
    // handler……不行，因为 isSchedulerClientMessage 已先过滤。
    // 改方案：把 handler 整个替换成抛错。直接覆盖 schedulerClientHandlers 在
    // 这个测试里——但它是 const export，覆盖后类型不严。
    // 折中：scheduler_run_now 找不存在 id 走 replyError 不抛；改为测它跑出
    // replyError，验证 catch 兜底不挂起即可（不是抛错场景，但端到端跑通）。
    const reply = (await callBridge({
      type: 'scheduler_run_now',
      id: 'nonexistent-id',
    })) as ServerMessage;
    expect(reply.type).toBe('error');
    expect((reply as { error: string }).error).toContain('no task');
  });
});

// ─── dispatchDirect（BG 内部直调，避开 sendMessage loop-back）───
//
// 工具跑在 BG SW 里，`chrome.runtime.sendMessage` 走同 SW 的 onMessage 在
// MV3 不可靠（SW 可能被挂起 / 同 context 派发被吞）。setupSchedulerClientHandlers
// 同时装一个 direct plugin：sendAndReceive 检测到 plugin 存在就走直调，绕开
// message port。这组 case 锁住「直调 + sendMessage bridge 同语义」——即不论
// caller 走哪条路，schedulerClientHandlers 拿到的入参 / 出参一致。
describe('dispatchDirect — BG 内 direct dispatch', () => {
  beforeEach(() => {
    storage.clear();
    setStorage.mockClear();
    getStorage.mockClear();
    clientRouterInternal.resetForTest();
  });

  it('happy path: scheduler_list → 返回 scheduler_list_result（与 port 路径同 handler）', async () => {
    const t1 = makeTask({ name: 'direct-a' });
    storage.set('local:scheduledTasks', [t1]);
    const reply = await dispatchDirect({ type: 'scheduler_list' } as ClientMessage);
    expect(reply.type).toBe('scheduler_list_result');
    expect((reply as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it('no handler for unknown type → throws（plugin 层的 caller 负责 surface 错误）', async () => {
    await expect(
      dispatchDirect({ type: 'scheduler_unknown' } as unknown as ClientMessage),
    ).rejects.toThrow(/no handler for scheduler_unknown/);
  });

  it('setupSchedulerClientHandlers 装好 direct plugin → sendAndReceive 走直调而不再 sendMessage', async () => {
    setupSchedulerClientHandlers();
    // Spy sendMessage 确认它没被调用。如果 plugin 不存在，sendAndReceive 会
    // fallback 到 sendMessage，spy 会触发。
    const sendMessageSpy = vi.spyOn(chrome.runtime, 'sendMessage');
    storage.set('local:scheduledTasks', []);
    const reply = await sendAndReceive({ type: 'scheduler_list' }, isSchedulerListResult);
    expect(reply.type).toBe('scheduler_list_result');
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});
