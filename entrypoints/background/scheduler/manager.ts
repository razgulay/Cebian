// Scheduled-task BG 域：单一 alarm + 每分钟 tick + 逐任务 dispatch。
//
// 架构选择（来自 plan §「Phase B — ST-B3」与 plan §「Risk 5 / 10」）：
//
//   1. **一个 alarm `scheduler-tick` 每分钟**——chrome.alarms 的 periodInMinutes
//      最小为 1（MV3 强制），按分钟粒度足够覆盖 cron 表达式（cron-parser 也只
//      到分钟）；BG manager 在每个 tick 拉一次存储，遍历 enabled 任务，对到点的
//      用 `isTaskDue` 判断——「多 alarm 每任务」方案被否决，因为 (a) Chrome 对
//      同时存活的 alarm 数量有限制（manifest 默认 500 + 1MB alarm storage cap），
//      (b) 用户频繁建/删任务时需要 addListener / removeListener 同步生命周期，
//      单 alarm 中心化调度把这些复杂度消除掉。
//
//   2. **acquireKeepAlive 包整个 tick**——一个 tick 可能跑多个 task（>10 个
//      due 任务并发），每个 task 最多 30s，总时长可能撞 SW 30s idle 边界。包一层
//      keepalive 让 tick 期间 SW 不被回收；task 之间的 acquireKeepAlive 在外层
//      已经被覆盖，runner 内部不再额外 acquire（避免 refCount 漂移）。
//
//   3. **单飞行 tick** —— 若上一次 tick 还没跑完，下一次直接 skip。极端情况：
//      tick 跑超 5min（SW cap）——chrome.alarms 下次 fire 仍触发；新 tick 看到
//      tickInFlight=true 就 skip；下一次 fire 又重试。不会无限堆积。
//
//   4. **Alarm 持久化** —— Chrome ≥150 默认 persistAcrossSessions；Chrome <150 必须
//      显式在 `onStartup` / `onInstalled` 重建。我们两个都挂一份以兼容旧版（代价是
//      一次无害的重复 create——chrome.alarms 的同名 alarm 第二次 create 是 replace
//      语义，不是 duplicate listener）。
//
//   5. **Listener 注册幂等** —— `listenerRegistered` 模块级 flag 同时守
//      chrome.alarms.onAlarm 与 chrome.runtime.onStartup / onInstalled 三处
//      listener。BG 重载（hot-reload）会再走 `setupScheduler`，无 guard 会导致
//      listener 重复注册——每次 tick 触发 N 次、每次 startup 重做 alarm。`ensureAlarm`
//      本身幂等（同名 create = replace），但 listener 累积仍会让 N 个 callback
//      各自跑一次 tick，被 `tickInFlight` 守门兜住——双重防御。

import { acquireKeepAlive, releaseKeepAlive } from '../lifecycle/keepalive';
import { broadcastAll } from '../ipc/port-registry';
import type { ServerMessage } from '@/lib/ipc/protocol';
import { scheduledTasks } from '@/lib/persistence/storage';
import { isTaskDue } from '@/lib/scheduler/cron';
import { runTask } from '@/lib/scheduler/runner';
import type { RunResult, ScheduledTask } from '@/lib/scheduler/types';
import { sendTaskNotification } from './notify';
import { dispatchTaskExternalNotifications } from './notify-external';

const ALARM_NAME = 'scheduler-tick';
/** chrome.alarms periodInMinutes 最小 1，5 分钟 SW cap 不踩（runner 自带 30s
 *  hard timeout 守门，参见 lib/scheduler/runner.ts 的 TASK_TIMEOUT_MS）。 */
const TICK_INTERVAL_MINUTES = 1;

/** 三个 listener（onAlarm + onStartup + onInstalled）共用同一条幂等守门。
 *  重置走 `_internal.resetForTest`。 */
let listenersRegistered = false;

/** 单飞行 tick 守门：上一次 tick 还跑着就 skip 这次。 */
let tickInFlight = false;

// ─── 内部 helpers ───

/**
 * 主 tick：拉所有 enabled 任务，过 `isTaskDue`，对到点的 dispatch。BG 域入口，
 * 由 `chrome.alarms.onAlarm` 触发。整个函数包在 try/finally 里——任何路径下
 * 都要 release keepalive（防止 refCount 泄漏导致 SW 永远不被回收）。
 *
 *  Exported only for tests（`entrypoints/background/scheduler/manager.test.ts`）——生产
 *  入口在 `chrome.alarms.onAlarm` listener。生产侧不需要外部调用 `tick()` 直接调它。
 */
export async function tick(): Promise<void> {
  if (tickInFlight) {
    // 上一次 tick 还没完；按 plan §「edge cases — multiple ticks queue」，
    // 这一分钟就跳过——避免堆积 + 5 分钟 SW cap 撞墙。
    return;
  }
  tickInFlight = true;
  acquireKeepAlive();
  try {
    const tasks = await scheduledTasks.getValue();
    const enabled = tasks.filter((t) => t.enabled);
    const now = Date.now();

    for (const task of enabled) {
      try {
        await runIfDue(task, now);
      } catch (err) {
        // 单任务失败不能让整个 tick 翻车——吞掉、warn、继续下一个。
        // BG manager 内部对 `runIfDue` 也有 try/finally（写回 lastResult 是
        // fail-safe 的），但这里的 catch 是兜底「runIfDue 自己 throw」的极端 case。
        console.warn(
          `[scheduler] dispatch failed for "${task.name}":`,
          err,
        );
      }
    }
  } finally {
    tickInFlight = false;
    releaseKeepAlive();
  }
}

/** 单任务 dispatch + 写回 + 通知。单独 try/finally 围住 runTask + 写回 —— 写回失败
 *  不应让通知 / 反之亦然（顺序：runTask → 写回 lastRunAt/lastResult → 通知）。
 *  `source` 用于区分自动 tick vs 手动 trigger（UI 渲染不同动画）。
 *
 *  Result 推送：`broadcastAll` 把 `scheduler_result` 推到所有 BG port——sidepanel 端
 *  `useBackgroundAgent.handleMessage` 在 ST-B5 之后会负责把这个 wire 消息
 *  桥接到 `schedulerChannel.publishResult`。本模块不直接 import sidepanel-channel
 *  的 publish（避免 §「lib → entrypoints」边界 + Service Worker / extension page 是
 *  独立 JS bundle，`publishResult` 改 BG-bundle 内的 module-level 集合，UI 端订阅者
 *  收不到）。 */
async function runIfDue(task: ScheduledTask, nowMs: number, source: 'tick' | 'manual' = 'tick'): Promise<void> {
  const due = isTaskDue(task, nowMs);
  if (!due.due) return;

  // 本次 fire 的「时间锚」——写回 lastRunAt 用这个而非 wall-clock。下次
  // isTaskDue 算「自这次 fire 起 + interval」还是「自这次 fire 起的下一次 cron」，
  // 与 chrome.alarms 的语义一致（chrome.alarms 内部也用 fire time 而非 wall-clock
  // 处理 period）。
  const lastFireMs = due.nextFireMs;
  const result = await runTask(task, undefined);

  // 写回 lastRunAt + lastResult。只按 id 改这一条 —— 期间用户对其它任务的 CRUD
  //（新增/删除/改名）不被覆盖。读-改-写在 chrome.storage 上不是原子的，但
  // tickInFlight 单飞行保证两个 tick 不会并发；同 tick 内对不同 id 的写也无冲突。
  await writeBackResult(task, result, lastFireMs);

  // 跨 context 推送（BG → 所有 sidepanel port）。
  broadcastAll({
    type: 'scheduler_result',
    taskId: task.id,
    result,
    source,
  } satisfies ServerMessage);

  // 桌面通知：失败/成功按 task.notify 配置；permission 缺失 / API 异常在 notify.ts
  // 内部兜底（console.warn + 返回），不影响 tick 继续。
  await sendTaskNotification(task, result);

  // Phase C / N2：多通道外部通知（ntfy / telegram / webhook）。BG 读 channel
  // + secret 配置，按 enabled + onSuccess/onFailure 过滤，Promise.allSettled
  // 并发发送，各 adapter 5s timeout 独立。fire-and-forget — tick 不等外部网络。
  void dispatchTaskExternalNotifications(task, result);
}

/** Public — `scheduler_run_now` IPC handler 用：手动 trigger 一个 task 立刻跑。
 *  返回 RunResult 让 handler 回给发起端口；pub/sub 推送也走 BG broadcastAll。
 *  注意：手动触发不写回 lastRunAt/lastResult —— 这些是「alarm-driven 自动跑」的
 *  历史轨迹，手动触发更像 ad-hoc 测试，不污染时间线。 */
export async function dispatchTask(task: ScheduledTask): Promise<RunResult> {
  acquireKeepAlive();
  try {
    const result = await runTask(task, undefined);
    broadcastAll({
      type: 'scheduler_result',
      taskId: task.id,
      result,
      source: 'manual',
    } satisfies ServerMessage);
    await sendTaskNotification(task, result);
    // Phase C / N2：manual trigger 也走外部通道——用户在 Settings 点「Run now」想
    // 立刻知道结果，包括推送到手机。
    void dispatchTaskExternalNotifications(task, result);
    return result;
  } finally {
    releaseKeepAlive();
  }
}

async function writeBackResult(
  task: ScheduledTask,
  result: RunResult,
  lastFireMs: number,
): Promise<void> {
  const tasks = await scheduledTasks.getValue();
  const updated = tasks.map((t) =>
    t.id === task.id
      ? { ...t, lastRunAt: lastFireMs, lastResult: result }
      : t,
  );
  await scheduledTasks.setValue(updated);
}

/** Idempotent alarm registration. Chrome 150+ 默认 persistAcrossSessions；旧版
 *  在浏览器重启后 alarm 会消失，需要重新 create —— onStartup / onInstalled 回调
 *  会触发本函数补建。 */
function ensureAlarm(): void {
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: TICK_INTERVAL_MINUTES,
  });
}

// ─── 公共 API ───

/**
 * Wire 一份 alarm + onAlarm listener + 兼容 onStartup / onInstalled 重建。
 * 在 `entrypoints/background/index.ts` 启动序列里、`setupCanvas()` 之后调一次。
 * 模块级 `listenersRegistered` 防 listener 累积；alarm 重建用 `chrome.alarms.create`
 * （同名替换语义）。
 */
export function setupScheduler(): void {
  if (listenersRegistered) return;
  ensureAlarm();
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    tick().catch((err) => console.warn('[scheduler] tick failed:', err));
  });
  chrome.runtime.onStartup.addListener(() => {
    ensureAlarm();
  });
  chrome.runtime.onInstalled.addListener(() => {
    ensureAlarm();
  });
  listenersRegistered = true;
}

/** Test-only: 重置模块级 state。仅测试代码用。 */
export const _internal = {
  resetForTest(): void {
    listenersRegistered = false;
    tickInFlight = false;
  },
};
