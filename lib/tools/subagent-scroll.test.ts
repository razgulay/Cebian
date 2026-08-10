import { describe, it, expect, vi } from 'vitest';
import { subagentScrollTool } from './subagent-scroll';

vi.mock('@/lib/browser/tab-actions', () => ({
  executeInTabWithArgs: vi.fn(async (_tabId, _fn, args) => {
    const params = (args[0] ?? {}) as { selector?: string; deltaY?: number };
    if (params.selector === '.missing') {
      throw new Error('subagent_scroll: no element matches selector .missing');
    }
    return params.selector
      ? `Scrolled ${params.selector} by (0, ${params.deltaY ?? 500})`
      : `Scrolled page by (0, ${params.deltaY ?? 500})`;
  }),
}));

describe('subagent_scroll tool', () => {
  it('默认 deltaY = 500：滚动页面并返回汇总', async () => {
    const res = await subagentScrollTool.execute('c1', { tabId: 42 }, new AbortController().signal);
    expect((res.content[0] as { type: 'text'; text: string }).text).toBe(
      'Scrolled page by (0, 500)',
    );
  });

  it('带 selector：滚动内部元素并返回汇总', async () => {
    const res = await subagentScrollTool.execute(
      'c1',
      { tabId: 42, selector: '.feed', deltaY: 800 },
      new AbortController().signal,
    );
    expect((res.content[0] as { type: 'text'; text: string }).text).toBe(
      'Scrolled .feed by (0, 800)',
    );
  });

  it('selector 不存在时抛出 — 上层 tool card 标红', async () => {
    await expect(
      subagentScrollTool.execute('c1', { tabId: 42, selector: '.missing' }, new AbortController().signal),
    ).rejects.toThrow(/no element matches selector/);
  });
});
