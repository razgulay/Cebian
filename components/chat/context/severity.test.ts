import { describe, it, expect } from 'vitest';
import {
  USAGE_WARN_RATIO,
  USAGE_CRITICAL_RATIO,
  getUsageSeverity,
  type UsageSeverity,
} from '@/components/chat/context/severity';

describe('USAGE_WARN_RATIO / USAGE_CRITICAL_RATIO 常量', () => {
  it('琥珀门对齐 BG 的 80% proactive threshold', () => {
    expect(USAGE_WARN_RATIO).toBe(0.8);
  });

  it('危险门固定在 0.95（留出 BG findCutPoint 找不到切点的余量）', () => {
    expect(USAGE_CRITICAL_RATIO).toBe(0.95);
  });

  it('两阈值保持 warn < critical', () => {
    expect(USAGE_WARN_RATIO).toBeLessThan(USAGE_CRITICAL_RATIO);
  });
});

describe('getUsageSeverity — 正常档位边界', () => {
  const cases: ReadonlyArray<{
    name: string;
    tokens: number;
    contextWindow: number;
    expected: { severity: UsageSeverity; percent: number };
  }> = [
    // ─ ok 档（< 80%）──
    { name: '0%',       tokens: 0,    contextWindow: 100, expected: { severity: 'ok', percent: 0 } },
    { name: '1%',       tokens: 1,    contextWindow: 100, expected: { severity: 'ok', percent: 1 } },
    { name: '50%',      tokens: 50,   contextWindow: 100, expected: { severity: 'ok', percent: 50 } },
    { name: '79%',      tokens: 79,   contextWindow: 100, expected: { severity: 'ok', percent: 79 } },
    // ─ warn 档（[80%, 95%)）── 边界：ratio === 0.8 → warn（对齐 BG proactive）
    { name: '80% 边界', tokens: 80,   contextWindow: 100, expected: { severity: 'warn', percent: 80 } },
    { name: '80.4%',    tokens: 80.4, contextWindow: 100, expected: { severity: 'warn', percent: 80 } },
    { name: '94%',      tokens: 94,   contextWindow: 100, expected: { severity: 'warn', percent: 94 } },
    // ─ critical 档（≥ 95%）── 边界：ratio === 0.95 → critical
    { name: '95% 边界', tokens: 95,   contextWindow: 100, expected: { severity: 'critical', percent: 95 } },
    { name: '99%',      tokens: 99,   contextWindow: 100, expected: { severity: 'critical', percent: 99 } },
    // ─ 超出 100% 仍然 clamp 到 critical ──
    { name: '200% (clamp)', tokens: 200, contextWindow: 100, expected: { severity: 'critical', percent: 100 } },
  ];

  for (const { name, tokens, contextWindow, expected } of cases) {
    it(`${name} → ${expected.severity} ${expected.percent}%`, () => {
      const r = getUsageSeverity(tokens, contextWindow);
      expect(r.severity).toBe(expected.severity);
      expect(r.percent).toBe(expected.percent);
    });
  }
});

describe('getUsageSeverity — ratio 字段', () => {
  it('正常输入：ratio == clamp01(tokens / contextWindow)', () => {
    const r = getUsageSeverity(50, 200);
    expect(r.ratio).toBe(0.25);
  });

  it('超出 1：ratio clamp 到 1', () => {
    const r = getUsageSeverity(150, 100);
    expect(r.ratio).toBe(1);
  });
});

describe('getUsageSeverity — 输入防御（不能让 UI 显示 NaN%/负%）', () => {
  it('contextWindow === 0 → 落到 ok 0%（未知态）', () => {
    const r = getUsageSeverity(0, 0);
    expect(r).toEqual({ severity: 'ok', percent: 0, ratio: 0 });
  });

  it('tokens === NaN → 落到 ok 0%（未知态）', () => {
    const r = getUsageSeverity(NaN, 100);
    expect(r).toEqual({ severity: 'ok', percent: 0, ratio: 0 });
  });

  it('contextWindow === NaN → 落到 ok 0%（未知态）', () => {
    const r = getUsageSeverity(80, NaN);
    expect(r).toEqual({ severity: 'ok', percent: 0, ratio: 0 });
  });

  it('负 token → 视为 0', () => {
    // v1 备份迁移可能携带异常字段；这里不让负数穿透到 UI。
    const r = getUsageSeverity(-50, 100);
    expect(r).toEqual({ severity: 'ok', percent: 0, ratio: 0 });
  });

  it('Infinity token → 落到 ok 0%（未知态，不假装是 100%）', () => {
    // 极端：sanitize 后仍可能有 Infinity 字段；Infinity 不是真值，不能
    // 假装成 100% 让用户以为「满载」。落到未知态与 NaN 同源，更诚实。
    const r = getUsageSeverity(Number.POSITIVE_INFINITY, 100);
    expect(r).toEqual({ severity: 'ok', percent: 0, ratio: 0 });
  });

  it('负 contextWindow → 落到 ok 0%（防御）', () => {
    const r = getUsageSeverity(50, -100);
    expect(r).toEqual({ severity: 'ok', percent: 0, ratio: 0 });
  });
});