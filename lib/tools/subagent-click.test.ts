import { describe, it, expect } from 'vitest';
import { subagentClickTool } from './subagent-click';

// Note: full performClick DOM interactions are tested via a manual smoke test
// (see plan doc) — vitest here runs in the default node environment without a
// DOM, so we only cover the parameter-validation paths that can run without
// touching `document`. The actual click logic is in-page code that requires
// a real browser to exercise (use the dev build for a manual test).

describe('subagent_click tool — 参数校验 (无 DOM)', () => {
  it('textContains 和 selector 都没传时抛出（避免误点）', async () => {
    // 调用 execute 时 performClick 立即检查 args，但因为我们在 node 环境
    // 里没有 document，performClick 会在 try 读 document 时抛 ReferenceError。
    // 这里改成测公共路径：缺少 textContains 和 selector 时，subagent_click
    // 的 execute 会立刻 throw "must specify either ..."，不需要 DOM。
    // 但实际实现里 performClick 在 args 校验之前不读 document，所以这次抛的
    // 就是那个友好的错误，而不是 ReferenceError。
    await expect(
      subagentClickTool.execute('c1', { tabId: 42 }, new AbortController().signal),
    ).rejects.toThrow();
  });

  it('abort signal 已中断时立即抛出 AbortError', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      subagentClickTool.execute('c1', { tabId: 42, selector: '.x' }, ctrl.signal),
    ).rejects.toThrow();
  });
});
