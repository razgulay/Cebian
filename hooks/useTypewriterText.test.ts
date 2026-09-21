// useTypewriterText.test.ts — 揭示节奏纯函数的单测（hook 壳不含逻辑，项目无
// @testing-library/react，照 useBackgroundAgent.test.ts 的「pure helper + 薄壳」
// 先例：把可回归的判定逻辑拆成 revealLength 钉住）。

import { describe, expect, it } from 'vitest';
import { revealLength } from '@/hooks/useTypewriterText';

describe('revealLength — typewriter 单 tick 揭示节奏', () => {
  it('pending ≤ 0 → 0（tick 无进展，不触发重渲染）', () => {
    expect(revealLength(0)).toBe(0);
    expect(revealLength(-5)).toBe(0);
  });

  it('涓流：小积压逐字前进（下限 1）', () => {
    expect(revealLength(1)).toBe(1);
    expect(revealLength(3)).toBe(1);
    expect(revealLength(12)).toBe(1);
  });

  it('自适应追赶：积压越大单 tick 揭示越多（~12 tick 追平），超大积压被上限截住', () => {
    expect(revealLength(24)).toBe(2);
    expect(revealLength(120)).toBe(10);
    expect(revealLength(600)).toBe(50);
    expect(revealLength(1200)).toBe(60); // ceil(1200/12)=100 → 被 MAX_REVEAL_PER_TICK 截为 60
  });

  it('上限 60：超大积压单帧也不跳超过 60 字符', () => {
    expect(revealLength(10_000)).toBe(60);
    expect(revealLength(Number.MAX_SAFE_INTEGER)).toBe(60);
  });
});
