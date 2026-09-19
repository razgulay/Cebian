// Scheduled task 时序纯函数：cron 表达式解析 + 下一个 fire time 计算。
//
// 所有函数都是纯函数（不调 `Date.now()`，时间戳由调用方传入，方便测试）。
// 复用社区库 `cron-parser`（详见 plan ST-B2「Dependencies」节，battle-tested 的
// 5-field cron 解析 + luxon 时区支持）——本模块把它包成与本项目时间类型
// （毫秒时间戳）相容的形状，对外不暴露 cron-parser 类型。
//
// 时区策略：默认用浏览器本地时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`）。
// 用户不显式配 tz 就用 local——绝大多数日常任务（"每个工作日下午 5 点跑"）按 local
// 时间最直观，DST 切换也由 luxon 自动处理。`computeNextFireMs` 接受可选 `tz`
// 覆盖，给 v2 提供 explicit timezone 的扩展点（UI 在 cron 表达式旁放个 tz
// dropdown 即可；v1 不暴露给用户）。

import { CronExpressionParser } from 'cron-parser';

/** 解析 + 校验 cron 表达式。返回 ok / 错误消息，不抛。
 *
 *  **字段数约定**：用户输入 5-field cron（minute hour dayOfMonth month dayOfWeek）。
 *  cron-parser v5 默认会 auto-pad 4-5 field 输入（补 leading 0 + 几个 *），`strict: true`
 *  才会强制要求正好 6 fields。我们不传 strict，让库把 5-field 当成
 *  `0 m h dom mon dow` 解析——用户写「每 5 分钟整」依然按分钟边界触发。代价：失去
 *  strict 模式下的 dayOfMonth / dayOfWeek 互斥校验——可接受的妥协，cron-parser 仍然会
 *  校验每个字段的取值范围与格式，UI 端 ST-B5 也可以做一层防御。 */
export function validateCronExpression(expr: string): { ok: true } | { ok: false; error: string } {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    return { ok: false, error: 'Cron expression is empty.' };
  }
  try {
    CronExpressionParser.parse(expr);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** 给定一个 cron 表达式 + 起点时间戳（毫秒），返回下一次 fire 的毫秒时间戳。
 *  5-field 输入会被 cron-parser 自动补成 seconds=0 m h dom mon dow。
 *  tz 不传则用浏览器本地时区。cron-parser 抛错（解析失败、到达时间跨度外）
 *  时本函数也抛——调用方（BG manager tick / Settings 校验）应先用
 *  validateCronExpression 过滤。 */
export function computeNextFireMs(expr: string, fromMs: number, tz?: string): number {
  const interval = CronExpressionParser.parse(expr, {
    ...(tz !== undefined ? { tz } : {}),
    currentDate: new Date(fromMs),
  });
  const next = interval.next();
  return next.getTime();
}

/** Interval 调度的「下一个 fire」：当前时间 + `minutes` 分钟。
 *  这里不复用 chrome.alarms——chrome.alarms 在 SW 启动时被 align，period
 *  从那时起算；BG manager 在 tick 时独立算「下一个 task 是否到点」需要「基于
 *  lastRunAt + minutes」——下面这个 helper 就是这块的纯计算。 */
export function intervalScheduleNextFireMs(minutes: number, fromMs: number): number {
  // interval 调度的「fire 时间」= 上次跑完 + interval minutes。简化：直接 fromMs + minutes。
  return fromMs + minutes * 60_000;
}

/** 给定一个 task 与当前时间，判断它现在是否该跑（返回 true）。BG manager
 *  在每个一分钟 tick 调一次，遍历所有 enabled 任务，对到点的任务调用 runner。
 *
 *  「上次跑完时间」语义：interval 用 lastRunAt；cron 用上次 fire（实际计算时
 *  我们用 lastRunAt 兜底——只要 task 没跑过，lastRunAt 为 null，按当前时间算
 *  next；跑过之后用 lastRunAt 算）。如果 lastRunAt 是 null（任务从未跑过），按
 *  「任务创建时间」为起点：避免用户刚创建一个 weekly cron 立即触发「过去 N 个
 *  周期都该跑」的连锁（v1 行为保守，宁可少跑不可错跑）。
 *
 *  返回「下次 fire 时间」给 BG manager 用作 lastRunAt 更新基准——避免两次
 *  tick 之间 fast-forward 多次。 */
export function isTaskDue(
  task: Pick<import('./types').ScheduledTask, 'schedule' | 'createdAt' | 'lastRunAt'>,
  nowMs: number,
  tz?: string,
): { due: true; nextFireMs: number } | { due: false } {
  if (task.lastRunAt !== null) {
    // 跑过：按 lastRunAt 算下一次。
    const next = nextFireMs(task.schedule, task.lastRunAt, nowMs, tz);
    return next <= nowMs ? { due: true, nextFireMs: next } : { due: false };
  }
  // 没跑过：以 createdAt 为起点。若 createdAt + 一次周期 > now 则还未到点。
  const next = nextFireMs(task.schedule, task.createdAt, nowMs, tz);
  return next <= nowMs ? { due: true, nextFireMs: next } : { due: false };
}

function nextFireMs(
  schedule: import('./types').Schedule,
  fromMs: number,
  nowMs: number,
  tz?: string,
): number {
  if (schedule.kind === 'interval') {
    return intervalScheduleNextFireMs(schedule.minutes, fromMs);
  }
  // cron：用 fromMs 作为「上次 fire 时间」算下次 fire——lastRunAt 是上次 fire
  // 的代理；createdAt 作为 fallback 兜底。
  // 这里复用 `computeNextFireMs` 但加一道防御：万一 cron-parser 抛错（用户 cron
  // 表达式刚好在初始化与 tick 之间被改坏——ST-B5 校验会挡，但 BG 还是兜底 catch），
  // 我们返回 +Infinity 表示「不到点」，BG 不调用 runner。
  try {
    return computeNextFireMs(schedule.expr, fromMs, tz);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
