// Scheduler 域 client message handlers — 6 routes (list / create / update /
// delete / run_now / test_channel)。BG manager 在 entrypoints/background/index.ts
// 启动序列里调用 `setupSchedulerClientHandlers()` 注册。每个 handler 走
// `lib/scheduler/validate.ts` 校验输入 + `lib/scheduler/sidepanel-channel.ts`
// 推 results + `scheduledTasks` storage 读写。

import type { ClientMessage, ServerMessage } from '@/lib/ipc/protocol';
import {
  notifyChannels,
  notifyChannelSecrets,
  scheduledTasks,
} from '@/lib/persistence/storage';
import type { RunResult, ScheduledTask } from '@/lib/scheduler/types';
import { validateNewTaskInput, validateTaskPatchInput } from '@/lib/scheduler/validate';
import { post } from '../ipc/port-registry';
import { registerClientHandlers, type ClientHandlerMap } from '../ipc/client-router';
import { dispatchTask } from './manager';
import { dispatchSingleChannelTest } from '@/lib/scheduler/notify-channels/dispatcher';
import { installSchedulerDirectPlugin } from '@/lib/scheduler/scheduler-ipc';
import type {
  ChannelConfig,
  ChannelSecret,
} from '@/lib/scheduler/notify-channels/types';

/** Reply 给发起端口：scheduler_list / create / update / delete 成功后回完整任务列表。
 *  `tasks` 字段类型留 `unknown[]`（不引入 `ScheduledTask[]` 在 lib/ipc），handler 自己
 *  持有强类型；wire 序列化跨 context 时类型擦除无碍。返回 Promise 让调用方
 *  `await` 确保 post 完成——避免「fire-and-forget」在测试里 race 出 false negative。 */
function replyList(port: chrome.runtime.Port): Promise<void> {
  return (async () => {
    const tasks = await scheduledTasks.getValue();
    post(port, {
      type: 'scheduler_list_result',
      tasks: tasks as unknown as unknown[],
    } satisfies ServerMessage);
  })();
}

/** Reply 给发起端口：失败时回 `error` ServerMessage（与 router 通用协议一致——
 *  路由层不区分领域，但领域错误与协议错误共享同一条 error 路径）。 */
function replyError(port: chrome.runtime.Port, sessionId: string | null, message: string): void {
  post(port, {
    type: 'error',
    sessionId,
    error: message,
  } satisfies ServerMessage);
}

/** 字符串 id 必填检查 + 在现有列表里找到对应 task。找不到时回 error 并返回 null。 */
async function locateTask(id: unknown, port: chrome.runtime.Port): Promise<ScheduledTask | null> {
  if (typeof id !== 'string' || id.length === 0) {
    replyError(port, null, 'scheduler: id must be a non-empty string.');
    return null;
  }
  const tasks = await scheduledTasks.getValue();
  const found = tasks.find((t) => t.id === id);
  if (!found) {
    replyError(port, null, `scheduler: no task with id "${id}".`);
    return null;
  }
  return found;
}

const schedulerClientHandlers: ClientHandlerMap = {
  async scheduler_list(port) {
    await replyList(port);
  },

  async scheduler_create(port, msg) {
    const validation = validateNewTaskInput(msg.task);
    if (!validation.ok) {
      replyError(port, null, `scheduler_create: ${validation.error}`);
      return;
    }
    const newTask: ScheduledTask = {
      ...validation.value,
      id: crypto.randomUUID(),
      lastRunAt: null,
      lastResult: null,
    };
    const tasks = await scheduledTasks.getValue();
    await scheduledTasks.setValue([...tasks, newTask]);
    // 回带 id 的「create_result」——`name` 在用户/已有同名校时不可靠，工具不能用
    // name-match 反查 id。BG 这里直接告诉 client「新任务的 id 是什么」+ 写完后的
    // 完整 task 镜像，让 LLM 立即知道长什么样。
    post(port, {
      type: 'scheduler_create_result',
      id: newTask.id,
      task: newTask as unknown,
    } satisfies ServerMessage);
  },

  async scheduler_update(port, msg) {
    const patchValidation = validateTaskPatchInput(msg.patch);
    if (!patchValidation.ok) {
      replyError(port, null, `scheduler_update: ${patchValidation.error}`);
      return;
    }
    const found = await locateTask(msg.id, port);
    if (!found) return;
    const updated: ScheduledTask = { ...found, ...patchValidation.value };
    const tasks = await scheduledTasks.getValue();
    await scheduledTasks.setValue(tasks.map((t) => (t.id === msg.id ? updated : t)));
    await replyList(port);
  },

  async scheduler_delete(port, msg) {
    const found = await locateTask(msg.id, port);
    if (!found) return;
    const tasks = await scheduledTasks.getValue();
    await scheduledTasks.setValue(tasks.filter((t) => t.id !== msg.id));
    await replyList(port);
  },

  async scheduler_run_now(port, msg) {
    const found = await locateTask(msg.id, port);
    if (!found) return;
    try {
      const result: RunResult = await dispatchTask(found);
      // 手动触发不写回 lastRunAt/lastResult（manager.ts dispatchTask 注释），
      // 所以「成功路径」回 list 不刷新任何 UI 字段；省一次 round-trip 直接返
      // 成功（不返 ack 帧——sidepanel 通过 subscribe scheduler_result pub/sub
      // 看到结果）。
      if (!result.ok) {
        replyError(port, null, `scheduler_run_now: ${result.summary}`);
        return;
      }
      await replyList(port);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      replyError(port, null, `scheduler_run_now crashed: ${message}`);
    }
  },

  async scheduler_test_channel(port, msg) {
    // 找 channel config + 对应 secret，按 id 配对；缺失即失败（ntfy 走公开
    // ntfy.sh 也算「secret 缺失但 adapter 仍能跑」——sendNtfy 内部用 null secret
    // 走默认 ntfy.sh）。BG 这层只报 channel found/not found。
    const [channels, secrets] = await Promise.all([
      notifyChannels.getValue(),
      notifyChannelSecrets.getValue(),
    ]);
    const config = (channels as ChannelConfig[]).find((c) => c.id === msg.id);
    if (!config) {
      replyError(port, null, `scheduler_test_channel: no channel with id "${msg.id}".`);
      return;
    }
    const secret = (secrets as ChannelSecret[]).find((s) => s.id === msg.id) ?? null;
    try {
      const result = await dispatchSingleChannelTest(
        { taskName: config.name, ok: true, summary: '(test)', at: Date.now() },
        config,
        secret,
      );
      // NotifyResult 没有 `type` field——显式构造 ServerMessage 形状（wire 与
      // 内部 adapter 形状脱钩，wire 协议未来变化时只动这一处）。
      if (result.success) {
        post(port, {
          type: 'scheduler_channel_test_result',
          channelId: result.channelId,
          channelKind: result.channelKind,
          success: true,
          latencyMs: result.latencyMs,
        } satisfies ServerMessage);
      } else {
        post(port, {
          type: 'scheduler_channel_test_result',
          channelId: result.channelId,
          channelKind: result.channelKind,
          success: false,
          latencyMs: result.latencyMs,
          error: result.error,
        } satisfies ServerMessage);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      replyError(port, null, `scheduler_test_channel crashed: ${message}`);
    }
  },
};

/** Register handlers. 在 `index.ts` 启动序列里、`setupPortRegistry()` 之前同步调用。 */
export function setupSchedulerClientHandlers(): void {
  registerClientHandlers(schedulerClientHandlers);

  // Direct-dispatch plugin: tools running INSIDE the BG SW can't reliably
  // round-trip through `chrome.runtime.sendMessage` (same-SW sendMessage
  // in MV3 is not guaranteed to deliver to its own onMessage before the
  // channel closes). The plugin lets in-SW callers hit the same handler
  // map directly. Sidepanel does not install a plugin, so it falls
  // through to the message-port bridge below.
  installSchedulerDirectPlugin(dispatchDirect);

  // sendMessage bridge: sidepanel / settings UI call scheduler_* via
  // `chrome.runtime.sendMessage` (see lib/scheduler/scheduler-ipc.ts).
  // The listener must return `true` synchronously to keep the channel
  // open while the async reply is composed; we use an IIFE so the
  // try/catch always calls `sendResponse` exactly once, even on throw.
  // Pattern mirrored from `mcp/bridge.ts`.
  console.log('[scheduler] setupSchedulerClientHandlers: installing sendMessage bridge');
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
      return false; // Not a scheduler message — let other listeners try.
    }
    const t = (msg as { type: string }).type;
    if (!t.startsWith('scheduler_')) return false; // Not ours.

    void (async () => {
      // Clear stale lastError before async work — if the previous
      // sendMessage left a flag set, it would surface in the caller as
      // "message port closed" even though we're about to reply.
      void chrome.runtime.lastError;
      try {
        const reply = await dispatchDirect(msg as ClientMessage);
        sendResponse(reply);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        sendResponse({ type: 'error', sessionId: null, error: `scheduler: ${t} crashed: ${error}` });
      }
    })();
    return true; // Async response: must return synchronously.
  });
}

/** Direct dispatch — run a scheduler_* message through the registered
 *  handler map without going through `chrome.runtime.sendMessage`. Used
 *  by tools that run inside the BG SW (same-SW sendMessage is
 *  unreliable) and by the sendMessage bridge for anything that does
 *  arrive through the port. Throws on no-handler / no-reply so callers
 *  (plugin + bridge) can surface a useful error. */
export async function dispatchDirect(msg: ClientMessage): Promise<ServerMessage> {
  const port = makeSyntheticPort();
  const handler = schedulerClientHandlers[msg.type as keyof typeof schedulerClientHandlers];
  if (!handler) {
    throw new Error(`scheduler: no handler for ${msg.type}`);
  }
  await (handler as (p: chrome.runtime.Port, m: ClientMessage) => Promise<void>)(port, msg);
  const reply = port.captured;
  if (reply === null) {
    throw new Error(`scheduler: ${msg.type} produced no reply`);
  }
  return reply;
}

// ─── sendMessage ↔ port-handler 桥 ───

/** 合成 port——让现有的 port-style handler 能直接用 `port.postMessage(...)`
 *  回信，我们把「第一条 post」捕获出来作为 sendResponse 载荷。
 *
 *  chrome.runtime.sendMessage 只允许一个 reply 载荷（不像 port 那样持续双向
 *  投递），所以这里只取首条 post；handler 的协议本来就是「一次调用一条终
 *  端回复」（`scheduler_list_result` / `scheduler_create_result` / `error`）。
 *  `scheduler_run_now` 成功路径靠 BG manager 通过 port-registry 的 pub/sub
 *  广播 `scheduler_result` 给所有连上的 sidepanel，originating sendMessage
 *  收不到也不需要收到（调用方要的是同步 ack + 列表刷新）。 */
function makeSyntheticPort(): chrome.runtime.Port & { captured: ServerMessage | null } {
  const ref: { current: ServerMessage | null } = { current: null };
  const port = {
    name: 'scheduler-sendmessage-adapter',
    postMessage(msg: ServerMessage) {
      if (ref.current === null) ref.current = msg;
    },
    disconnect() {
      /* noop */
    },
    // chrome.runtime.Port 的 onMessage / onDisconnect 是 EventObject；handler
    // 不会向合成 port 注册订阅，所以 addListener 留 noop 即可。
    onMessage: { addListener() { /* noop */ } },
    onDisconnect: { addListener() { /* noop */ } },
    sender: undefined,
  } as unknown as chrome.runtime.Port;
  // 用 defineProperty 装 accessor：不能 Object.assign getter——Object.assign 会
  // 读取源属性的当前值并作为普通值写入 target，accessor 不会保留（参
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign
  // 「The Object.assign() method only copies enumerable and own properties from a
  //  source object to a target object. It uses [[Get]] on the source and [[Set]]
  //  on the target」）。getter 会被消费为快照值，bridge 后续就读不到。
  return Object.defineProperty(port, 'captured', {
    get(): ServerMessage | null { return ref.current; },
    enumerable: true,
    configurable: true,
  }) as chrome.runtime.Port & { captured: ServerMessage | null };
}

/** Export 源 map（与 index.ts setup() 传给 registerClientHandlers 的对象是同一引用），
 *  供 `entrypoints/background/ipc/client-router.test.ts` 的穷尽性测试枚举。
 *  与 setupSchedulerClientHandlers 是同一对：setup 注册它，测试读它。 */
export { schedulerClientHandlers };
