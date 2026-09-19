// Unit tests for lib/scheduler/cron.ts.
//
// cron.ts 是纯函数（无 chrome.* / 无 IO / 无 global state）：所有时间戳由调用方传入，
// 全部断言都基于具体数值。`validateCronExpression` 用真 cron-parser 验证格式；
// `computeNextFireMs` 用一组固定时间戳断言 next fire 的相对偏移。
//
// TZ=UTC：在文件顶部强制把进程时区设为 UTC——cron-parser 默认拿 local TZ，
// 在不同时区下断言 next fire 的具体小时会失败。本测试套件所有「具体小时」
// 断言都按 UTC 写。

process.env.TZ = 'UTC';

import { describe, expect, it } from 'vitest';
import {
  computeNextFireMs,
  intervalScheduleNextFireMs,
  isTaskDue,
  validateCronExpression,
} from './cron';
import type { ScheduledTask } from './types';

const T_MS = (s: number): number => s * 1000;
const MIN_MS = 60_000;

describe('validateCronExpression', () => {
  it('accepts a valid 5-field cron expression', () => {
    expect(validateCronExpression('*/5 * * * *')).toEqual({ ok: true });
  });

  it('accepts predefined aliases (@hourly, @daily, …)', () => {
    expect(validateCronExpression('@hourly')).toEqual({ ok: true });
    expect(validateCronExpression('@daily')).toEqual({ ok: true });
  });

  it('rejects empty / whitespace-only input', () => {
    expect(validateCronExpression('').ok).toBe(false);
    expect(validateCronExpression('   ').ok).toBe(false);
  });

  it('rejects malformed cron expression with descriptive error', () => {
    const result = validateCronExpression('not a cron');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('rejects out-of-range field values', () => {
    const result = validateCronExpression('60 * * * *'); // minute > 59
    expect(result.ok).toBe(false);
  });
});

describe('computeNextFireMs', () => {
  it('every-minute cron advances at least 1 minute from start', () => {
    const fromMs = T_MS(1700000000); // 固定时间戳（2023-11-14 22:13:20 UTC）
    const next = computeNextFireMs('* * * * *', fromMs);
    expect(next).toBeGreaterThan(fromMs);
    expect(next - fromMs).toBeLessThanOrEqual(MIN_MS + 5_000); // 安全余量防 DST 抖
  });

  it('every-5-minute cron lands on a minute multiple of 5', () => {
    const fromMs = T_MS(1700000000); // 22:13:20
    const next = computeNextFireMs('*/5 * * * *', fromMs);
    const nextDate = new Date(next);
    expect(nextDate.getMinutes() % 5).toBe(0);
  });

  it('daily-at-09:30 cron lands at next 09:30', () => {
    // 2024-01-01 12:00:00 UTC
    const fromMs = T_MS(1704110400);
    const next = computeNextFireMs('30 9 * * *', fromMs);
    const nextDate = new Date(next);
    expect(nextDate.getUTCHours()).toBe(9);
    expect(nextDate.getUTCMinutes()).toBe(30);
    // 12:00 → 09:30 next day → ~21.5h 后
    expect(next - fromMs).toBeGreaterThan(T_MS(60 * 60 * 21));
    expect(next - fromMs).toBeLessThan(T_MS(60 * 60 * 22));
  });

  it('tz option shifts the boundary (Asia/Shanghai 08:00 = UTC 00:00)', () => {
    // from = 2024-01-01 00:30 UTC. Asia/Shanghai 00:30 = 08:30 same day.
    // cron `0 0 * * *` in Asia/Shanghai = local midnight → next 00:00 local
    // = next 16:00 UTC. Diff from 00:30 UTC → 15.5h.
    const fromMs = T_MS(1704069000); // 2024-01-01 00:30 UTC
    const next = computeNextFireMs('0 0 * * *', fromMs, 'Asia/Shanghai');
    expect(next - fromMs).toBeGreaterThan(T_MS(60 * 60 * 15));
    expect(next - fromMs).toBeLessThan(T_MS(60 * 60 * 16));
  });
});

describe('intervalScheduleNextFireMs', () => {
  it('simple math: from + minutes', () => {
    const from = T_MS(1000);
    expect(intervalScheduleNextFireMs(15, from)).toBe(from + 15 * MIN_MS);
  });

  it('zero minutes = same instant (degenerate case)', () => {
    const from = T_MS(1000);
    expect(intervalScheduleNextFireMs(0, from)).toBe(from);
  });
});

describe('isTaskDue', () => {
  function task(over: Partial<ScheduledTask>): Pick<ScheduledTask, 'schedule' | 'createdAt' | 'lastRunAt'> {
    return {
      schedule: over.schedule ?? { kind: 'interval', minutes: 15 },
      createdAt: over.createdAt ?? T_MS(1000),
      lastRunAt: over.lastRunAt ?? null,
    };
  }

  it('interval task with lastRunAt set, interval elapsed → due', () => {
    const t = task({ lastRunAt: T_MS(1000), createdAt: T_MS(0) });
    // now is 16 minutes after lastRunAt, interval is 15 minutes → due
    const result = isTaskDue(t, T_MS(1000) + 16 * MIN_MS);
    expect(result.due).toBe(true);
    if (result.due) {
      expect(result.nextFireMs).toBe(T_MS(1000) + 15 * MIN_MS);
    }
  });

  it('interval task with lastRunAt set, interval NOT elapsed → not due', () => {
    const t = task({ lastRunAt: T_MS(1000) });
    const result = isTaskDue(t, T_MS(1000) + 5 * MIN_MS); // only 5 min elapsed
    expect(result.due).toBe(false);
  });

  it('never-run interval task with createdAt in past → due', () => {
    const t = task({ createdAt: T_MS(1000), lastRunAt: null });
    const result = isTaskDue(t, T_MS(1000) + 20 * MIN_MS);
    expect(result.due).toBe(true);
  });

  it('never-run interval task with createdAt recent → not due (avoid immediate firing)', () => {
    const t = task({ createdAt: T_MS(2000), lastRunAt: null });
    const result = isTaskDue(t, T_MS(2000) + 5 * MIN_MS);
    expect(result.due).toBe(false);
  });

  it('cron task with lastRunAt past a fire → due', () => {
    const t = task({
      schedule: { kind: 'cron', expr: '* * * * *' },
      lastRunAt: T_MS(3000),
    });
    const result = isTaskDue(t, T_MS(3000) + 90_000); // 90s later
    expect(result.due).toBe(true);
  });

  it('cron task with no fires after createdAt → not due', () => {
    // Future-only cron: minute 0 of hour 14 (UTC) only. From = 13:59:00 UTC,
    // 5 seconds later = 13:59:05 UTC. Next fire = 14:00:00 UTC, 55s away → not due.
    const t = task({
      schedule: { kind: 'cron', expr: '0 14 * * *' },
      createdAt: T_MS(1704069540), // ~13:59:00 UTC
      lastRunAt: null,
    });
    const result = isTaskDue(t, T_MS(1704069540) + T_MS(5)); // +5 seconds
    expect(result.due).toBe(false);
  });
});
