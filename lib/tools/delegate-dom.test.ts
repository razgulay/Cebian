import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDelegateDomTool } from './delegate-dom';

vi.mock('@/entrypoints/background/dom-sub-agent-runner', () => ({
  runDomSubAgent: vi.fn(async ({ task, expected_schema, complexity, tabId }: { task: string; expected_schema?: string; complexity?: string; tabId?: number }) => {
    if (task.includes('fail')) {
      return { text: '', modelKey: 'openai/gpt-4o-mini', ok: false, error: 'Network error' };
    }
    // Mock always returns clean JSON regardless of inputs
    const data = expected_schema ? [{ mocked: true, task, complexity, tabId }] : `Summary of ${task}`;
    return {
      text: JSON.stringify({ status: 'success', data, reason: '' }),
      modelKey: 'openai/gpt-4o-mini',
      ok: true,
    };
  }),
}));

describe('createDelegateDomTool — delegate_dom 工具', () => {
  // Reset mock.calls between tests so `mock.calls[0]` reads from THIS test's
  // call, not from a previous test that ran earlier in the file. Without this,
  // vitest's file-shuffle order can expose call history from sibling tests.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const tool = createDelegateDomTool();

  it('task 为空时返回错误 content', async () => {
    const res = await tool.execute('call-1', { task: '' }, new AbortController().signal);
    expect(res.content[0]).toEqual({
      type: 'text',
      text: 'Error: `task` is required and must not be empty.',
    });
  });

  it('子代理成功：返回抽出的 JSON 注解 modelKey', async () => {
    const res = await tool.execute('call-1', { task: 'summarize pricing' }, new AbortController().signal);
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    // Both raw JSON extraction text and the attribution are present
    expect(text).toContain('"status":"success"');
    expect(text).toContain('"data"');
    expect(text).toContain('Summary of summarize pricing');
    expect(text).toContain('— via DOM sub-agent (openai/gpt-4o-mini)');
  });

  it('expected_schema、complexity、tabId 都被转发给 runner', async () => {
    await tool.execute(
      'call-1',
      {
        task: 'list products',
        expected_schema: '[{ name: string, price: number }]',
        complexity: 'complex',
        tabId: 73278874,
      },
      new AbortController().signal,
    );
    const { runDomSubAgent } = await import('@/entrypoints/background/dom-sub-agent-runner');
    expect(runDomSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        expected_schema: '[{ name: string, price: number }]',
        complexity: 'complex',
        tabId: 73278874,
      }),
    );
  });

  it('不传 tabId 时也能正常调用（runner 用 chrome.tabs.query 兜底）', async () => {
    await tool.execute('call-1', { task: 'list products' }, new AbortController().signal);
    const { runDomSubAgent } = await import('@/entrypoints/background/dom-sub-agent-runner');
    // Assert on the most recent call (this test's only call) — `mock.calls[0]`
    // would be ambiguous across tests even with `clearAllMocks` because
    // `import()` returns the same cached module whose mock counter increments
    // globally; reading the last call sidesteps the index dependency.
    expect(runDomSubAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ task: 'list products' }),
    );
    const callArgs = (runDomSubAgent as any).mock.calls.at(-1)[0];
    expect(callArgs.tabId).toBeUndefined();
  });

  it('子代理失败返回错误说明', async () => {
    const res = await tool.execute('call-1', { task: 'fail this' }, new AbortController().signal);
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('DOM sub-agent failed (openai/gpt-4o-mini): Network error');
  });
});
