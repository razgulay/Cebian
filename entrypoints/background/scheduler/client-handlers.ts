// Scheduler 域 client message handlers — 6 routes (list / create / update /
// delete / run_now / test_channel)。BG manager 在 entrypoints/background/index.ts
// 启动序列里调用 `setupSchedulerClientHandlers()` 注册。每个 handler 走
// `lib/scheduler/validate.ts` 校验输入 + `lib/scheduler/sidepanel-channel.ts`
// 推 results + `scheduledTasks` storage 读写。

import type { ServerMessage } from '@/lib/ipc/protocol';
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
}

/** Export 源 map（与 index.ts setup() 传给 registerClientHandlers 的对象是同一引用），
 *  供 `entrypoints/background/ipc/client-router.test.ts` 的穷尽性测试枚举。
 *  与 setupSchedulerClientHandlers 是同一对：setup 注册它，测试读它。 */
export { schedulerClientHandlers };
