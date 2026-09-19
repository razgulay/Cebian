// BG-side external channel dispatch — hook into scheduler's existing tick /
// dispatchTask flow.
//
// 设计（Phase C plan §N2）：
//   1. **read storage 在 dispatch 时**——channel 配置 + secret 都从
//      `local:notifyChannels` / `local:notifyChannelSecrets` 读最新值，
//      不缓存（用户改了立即生效，BG tick 跑下一发就看到）。
//   2. **filter by enabled + notify-on flags**——与 manager.ts 的
//      `task.notify.onSuccess` / `onFailure` 同款语义（per-task → per-channel
//      两层 gate 都过才送）。
//   3. **dispatchExternalNotifications fire-and-forget**——BG tick 不
//      await。dispatcher 内部用 `Promise.allSettled`，各 adapter 5s timeout，
//      错误隔离到 NotifyResult。
//   4. **never throw**——`getValue` 异常 / `setValue` 异常 / dispatcher 自身异常
//      都 catch 掉写 console.warn。BG scheduler 主流程不能因为外部通知失败
//      而失败。

import { notifyChannels, notifyChannelSecrets, scheduledTasks } from '@/lib/persistence/storage';
import {
  dispatchExternalNotifications,
} from '@/lib/scheduler/notify-channels/dispatcher';
import type {
  ChannelConfig,
  ChannelSecret,
  NotifyPayload,
} from '@/lib/scheduler/notify-channels/types';
import type { ScheduledTask, RunResult } from '@/lib/scheduler/types';
import { vi } from 'vitest';

/** 从 storage 读 channel + secret 配置，匹配 task.notify flags 后 dispatch。
 *  BG 端入口：`manager.ts#runIfDue` 和 `#dispatchTask` 之后调一次。
 *  返回 dispatch 结果数组（用于 debug / test），生产 caller 一般忽略。 */
export async function dispatchTaskExternalNotifications(
  task: ScheduledTask,
  result: RunResult,
): Promise<void> {
  try {
    const [channels, secrets] = await Promise.all([
      notifyChannels.getValue(),
      notifyChannelSecrets.getValue(),
    ]);
    if (channels.length === 0) return; // fast path: no channels configured
    const payload: NotifyPayload = {
      taskName: task.name,
      ok: result.ok,
      summary: result.summary,
      at: Date.now(),
    };
    await dispatchExternalNotifications(payload, channels, secrets as ChannelSecret[]);
  } catch (err) {
    console.warn(
      `[scheduler] dispatchTaskExternalNotifications failed for "${task.name}":`,
      err,
    );
  }
}

/** Read-only helper for tests / debug ——返回当前 storage 里的 channel +
 *  secret 计数。生产不调。 */
export async function notifyChannelStats(): Promise<{ channels: number; secrets: number }> {
  const [channels, secrets] = await Promise.all([
    notifyChannels.getValue(),
    notifyChannelSecrets.getValue(),
  ]);
  return {
    channels: channels.length,
    secrets: (secrets as ChannelSecret[]).length,
  };
}

/** 测试辅助：重置 storage —— mock 把 notifyChannels / notifyChannelSecrets /
 *  scheduledTasks 的 getValue / setValue 都替换掉，让 BG 层走 mock 而不是
 *  真实 WXT storage。test setup 调用一次即可。 */
export const _testHelpers = {
  /** 替换 notifyChannels / notifyChannelSecrets / scheduledTasks 的
   *  getValue / setValue。返回的 unmount 函数恢复原状。 */
  mockStorage: () => {
    const channels: ChannelConfig[] = [];
    const secrets: ChannelSecret[] = [];
    const tasks: ScheduledTask[] = [];
    const channelsGet = vi.fn(async () => channels);
    const channelsSet = vi.fn(async (v: ChannelConfig[]) => {
      channels.length = 0;
      channels.push(...v);
    });
    const secretsGet = vi.fn(async () => secrets);
    const secretsSet = vi.fn(async (v: ChannelSecret[]) => {
      secrets.length = 0;
      secrets.push(...v);
    });
    const tasksGet = vi.fn(async () => tasks);
    const tasksSet = vi.fn(async (v: ScheduledTask[]) => {
      tasks.length = 0;
      tasks.push(...v);
    });
    notifyChannels.getValue = channelsGet;
    notifyChannels.setValue = channelsSet;
    notifyChannelSecrets.getValue = secretsGet;
    notifyChannelSecrets.setValue = secretsSet;
    scheduledTasks.getValue = tasksGet;
    scheduledTasks.setValue = tasksSet;
    return {
      channels,
      secrets,
      tasks,
      channelsGet,
      secretsGet,
      tasksGet,
      channelsSet,
      secretsSet,
      unmount: () => {
        notifyChannels.getValue = channelsGet;
        notifyChannels.setValue = channelsSet;
        notifyChannelSecrets.getValue = secretsGet;
        notifyChannelSecrets.setValue = secretsSet;
        scheduledTasks.getValue = tasksGet;
        scheduledTasks.setValue = tasksSet;
      },
    };
  },
};
