import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the storage helpers so resolveDomSubAgent can read a synthetic model.
vi.mock('@/lib/persistence/storage', () => ({
  domSubAgentModel: { getValue: vi.fn(async () => ({ provider: 'openai', modelId: 'gpt-4o-mini' })) },
  providerCredentials: { getValue: vi.fn(async () => ({})) },
  customProviders: { getValue: vi.fn(async () => []) },
}));

// Hoist the cross-test mutable state so it lives outside any test body and is
// reset in beforeEach. Before this refactor, the state lived at module scope
// with no reset between tests — which made the suite depend on the test file
// running alone or in a specific order. (`vi.mock` factories are hoisted by
// vitest, but the closures they create over `createdAgents` / `promptsByAttempt`
// / `currentAttempt` captured whichever instance existed at module load time.)
//
// Subtask 3 added `responsesByAttempt` for the schema-validation block: tests
// that exercise the schema-fail → retry → escalate path need each attempt
// to return a distinct assistant text (sometimes a valid schema-compliant
// JSON, sometimes a non-matching JSON, sometimes plain text).
//
// Stage 2 / Subtask 2 added `fastPathCalls` + `fastPathResponses` for the
// fast-path block: tests need to know whether `complete()` was invoked (and
// how many times), and what response text each invocation returned. The
// fast path is single-shot so we mostly care about `fastPathCalls.length`
// and `fastPathResponses[0]` — but recording per-call lets us assert the
// "no retry" contract cleanly.
const testState = vi.hoisted(() => ({
  createdAgents: [] as Array<{ complexity?: 'simple' | 'complex' | 'fast'; tabId?: number }>,
  promptsByAttempt: [] as Array<{ attempt: number; returnEmpty: boolean }>,
  // `responsesByAttempt[i]` is the assistant text the i-th attempt returns.
  // When undefined the mock falls back to the legacy hardcoded JSON so the
  // auto-escalation describe block (which only cares about empty vs non-empty)
  // keeps working unchanged.
  responsesByAttempt: [] as Array<{ assistantText: string }>,
  currentAttempt: 0,
  // Fast-path mock state: `complete()` call count + per-call response text.
  // Tests set `fastPathResponses[0]` to control what the single LLM call
  // returns; `fastPathCalls` is auto-incremented so the test can assert
  // "called exactly once" / "called zero times" depending on the path.
  fastPathCalls: [] as Array<{ systemPrompt: string; messageCount: number }>,
  fastPathResponses: [] as Array<{ assistantText: string; stopReason?: 'stop' | 'error' | 'aborted' }>,
  // Article-body mock state: tests control what `convertArticleToMarkdown`
  // returns. `null` simulates the Readability-failed path (fast-path falls
  // back to raw-text extraction). `fastPathHtml` controls what
  // `executeInTabWithArgs(getDocumentHtml, ...)` returns.
  fastPathHtml: '<html><body><article>mock article body</article></body></html>' as string,
  fastPathMarkdown: 'mock article body in markdown' as string | null,
  // Plain-text fallback response (used when `fastPathMarkdown === null`).
  // Default is non-empty so the fast path doesn't bail with "extracted
  // article body is empty". Tests that want to exercise the empty path
  // can set it to ''.
  fastPathFallbackText: 'mock raw text fallback body' as string,
  // `fastPathThrowOnInjection` makes `executeInTabWithArgs` throw — exercises
  // the "fast-path injection failed" branch.
  fastPathThrowOnInjection: false as boolean,
}));

// Mock createDomSubAgent so each attempt creates a fresh agent whose state
// matches the prompt the test wants that attempt to "respond" with.
vi.mock('./dom-sub-agent', async () => {
  const real = await vi.importActual<typeof import('./dom-sub-agent')>('./dom-sub-agent');
  return {
    ...real,
    createDomSubAgent: vi.fn(async (_model, options) => {
      testState.createdAgents.push(options);
      const attempt = ++testState.currentAttempt;
      const wantEmpty = testState.promptsByAttempt[attempt - 1]?.returnEmpty ?? false;
      const override = testState.responsesByAttempt[attempt - 1]?.assistantText;
      const assistantText =
        override !== undefined
          ? override
          : '{"status":"success","data":"ok","reason":""}';
      return {
        agent: {
          state: {
            messages: wantEmpty
              ? []
              : [
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: assistantText }],
                    stopReason: 'stop',
                  },
                ],
          },
          prompt: async () => {},
          abort: () => {},
        } as any,
        tabId: options.tabId ?? null,
      } as any;
    }),
  };
});

// Mock the keep-alive helpers so they don't run setInterval in tests.
vi.mock('./lifecycle/keepalive', () => ({
  acquireKeepAlive: vi.fn(),
  releaseKeepAlive: vi.fn(),
}));

// ─── Stage 2 / Subtask 2 mocks ───
// Mock `complete()` from pi-ai/compat. Records every invocation into
// `fastPathCalls`; returns the response at `fastPathResponses[i]` (or a
// default schema-compliant JSON if unset). Tests push to
// `fastPathResponses` to exercise specific branches (schema fail,
// non-JSON, empty).
vi.mock('@earendil-works/pi-ai/compat', async () => {
  const real = await vi.importActual<typeof import('@earendil-works/pi-ai/compat')>(
    '@earendil-works/pi-ai/compat',
  );
  return {
    ...real,
    complete: vi.fn(async (_model, context) => {
      const i = testState.fastPathCalls.length;
      testState.fastPathCalls.push({
        systemPrompt: context.systemPrompt ?? '',
        messageCount: context.messages.length,
      });
      const response = testState.fastPathResponses[i];
      const assistantText =
        response?.assistantText ?? '{"status":"success","data":"fast-path default"}';
      const stopReason = response?.stopReason ?? 'stop';
      return {
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gpt-4o-mini',
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
      } as any;
    }),
  };
});

// Mock the article-extraction helpers from `read-page`. Spread the real
// module first so `dom-sub-agent.ts` (which imports `readPageTool` from
// the same file) still gets the production export; tests then override
// only `getDocumentHtml` + `convertArticleToMarkdown`. Tests control
// `fastPathHtml` (what the injected `getDocumentHtml` returns via
// `executeInTabWithArgs`) and `fastPathMarkdown` (what
// `convertArticleToMarkdown` returns). Setting `fastPathMarkdown = null`
// simulates the Readability-failed fallback path.
vi.mock('@/lib/tools/read-page', async () => {
  const real = await vi.importActual<typeof import('@/lib/tools/read-page')>(
    '@/lib/tools/read-page',
  );
  return {
    ...real,
    getDocumentHtml: vi.fn((_selector: string | null) => ({ html: '', url: '' })),
    // Read the current value of `testState.fastPathMarkdown` on each call
    // (vi.hoisted makes the closure mutable; the test resets it in
    // beforeEach). Returning `null` triggers the Readability-failed
    // fallback in the runner.
    convertArticleToMarkdown: vi.fn(async (_html: string, _url: string) =>
      testState.fastPathMarkdown,
    ),
  };
});

// Mock `executeInTabWithArgs`. Tests inject behavior by reading
// `testState.fastPathHtml` + `fastPathThrowOnInjection` from the closure.
// (vi.hoisted makes that closure mutable across tests.) The plain-text
// fallback path inside `runFastDomSubAgent` injects an inline function
// that references `document` — we short-circuit that to a fixed string
// because jsdom-less vitest has no `document`. `fastPathFallbackText`
// controls what the fallback returns (so tests can simulate both the
// success and empty-article branches).
//
// We dispatch on **function identity** (`func === getDocumentHtml`)
// rather than arg-shape heuristics. Branching on arg length + value
// (`args.length === 1 && args[0] === null`) would couple the test to
// the current `getDocumentHtml` signature — a harmless future change to
// the selector argument (or another injected call that happens to pass
// `[null]`) would silently route to the wrong mock branch. Reference
// comparison is robust: the mocked `getDocumentHtml` is a `vi.fn`
// whose identity is stable across the test file. The raw-text fallback
// uses an inline closure that is NOT `===` to `getDocumentHtml`, so the
// `else` branch always handles it.
vi.mock('@/lib/browser/tab-actions', () => ({
  executeInTabWithArgs: vi.fn(async <TArgs extends any[], T>(
    _tabId: number,
    func: (...args: TArgs) => T,
    _args: TArgs,
  ): Promise<T> => {
    if (testState.fastPathThrowOnInjection) {
      throw new Error('mocked injection failure');
    }
    // Branch on function identity. `getDocumentHtml` is the mocked
    // vi.fn imported into the test file at the top; the inline
    // `extractText` closure inside `runFastDomSubAgent` is a different
    // function reference so the `else` branch handles it.
    const isGetDocumentHtml = func === (getDocumentHtmlRef as unknown as typeof func);
    const result = isGetDocumentHtml
      ? { html: testState.fastPathHtml, url: 'https://example.com/' }
      : testState.fastPathFallbackText;
    return result as T;
  }),
}));

// Mock `resolveProviderApiKey`. Returns a fixed key — fast path doesn't
// validate the key, just threads it through. Real credentials resolution
// is exercised in unit tests for `lib/providers/*`.
vi.mock('./providers/credentials', () => ({
  resolveProviderApiKey: vi.fn(async () => 'mock-api-key'),
}));

import { runDomSubAgent } from './dom-sub-agent-runner';
import { convertArticleToMarkdown, getDocumentHtml } from '@/lib/tools/read-page';
import { complete } from '@earendil-works/pi-ai/compat';
import { executeInTabWithArgs } from '@/lib/browser/tab-actions';

// Capture the mocked `getDocumentHtml` reference once so the
// `executeInTabWithArgs` mock can branch on function identity. The
// mocked function is a `vi.fn` — its reference is stable across the
// test file's lifetime, so comparing `func === getDocumentHtmlRef`
// inside the mock factory reliably distinguishes `getDocumentHtml`
// calls from the inline raw-text fallback closure.
const getDocumentHtmlRef = getDocumentHtml;

describe('runDomSubAgent — auto-escalation simple → complex', () => {
  // Reset shared state between tests. The mock factory's `vi.fn` counter is
  // cleared by vi.clearAllMocks() — but our `createdAgents` / `promptsByAttempt`
  // / `currentAttempt` are plain arrays + number, so reset them manually.
  beforeEach(() => {
    vi.clearAllMocks();
    testState.createdAgents.length = 0;
    testState.promptsByAttempt.length = 0;
    testState.responsesByAttempt.length = 0;
    testState.currentAttempt = 0;
  });

  it('attempt 1 uses caller\'s complexity, attempt 2 escalates to "complex"', async () => {
    // attempt 1: empty response. attempt 2: success.
    testState.promptsByAttempt.push({ attempt: 1, returnEmpty: true });
    testState.promptsByAttempt.push({ attempt: 2, returnEmpty: false });

    const result = await runDomSubAgent({
      task: 'extract the table',
      complexity: 'simple',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain('"status":"success"');
    expect(result.tabId).toBe(73278874);

    // Verify the escalation pattern
    expect(testState.createdAgents.length).toBe(2);
    expect(testState.createdAgents[0].complexity).toBe('simple');
    expect(testState.createdAgents[1].complexity).toBe('complex');
    // tabId is forwarded on both attempts
    expect(testState.createdAgents[0].tabId).toBe(73278874);
    expect(testState.createdAgents[1].tabId).toBe(73278874);
  });

  it('caller already passed "complex" — first attempt uses complex, retry stays complex', async () => {
    testState.promptsByAttempt.push({ attempt: 1, returnEmpty: true });
    testState.promptsByAttempt.push({ attempt: 2, returnEmpty: false });

    const result = await runDomSubAgent({
      task: 'extract the table',
      complexity: 'complex',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    expect(testState.createdAgents.length).toBe(2);
    expect(testState.createdAgents[0].complexity).toBe('complex');
    expect(testState.createdAgents[1].complexity).toBe('complex');
  });

  it('succeeds on first attempt — no escalation triggered', async () => {
    testState.promptsByAttempt.push({ attempt: 1, returnEmpty: false });

    const result = await runDomSubAgent({
      task: 'extract the table',
      complexity: 'simple',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    // Only one attempt was made since the first succeeded
    expect(testState.createdAgents.length).toBe(1);
    expect(testState.createdAgents[0].complexity).toBe('simple');
  });
});

// ─── Subtask 3: schema validation ───
// Tests the post-hoc schema check + retry + auto-escalate path wired in
// `dom-sub-agent-runner.ts`. Same harness as the auto-escalation block —
// `createDomSubAgent` is mocked, and `responsesByAttempt` lets each attempt
// return a different assistant text (matching/non-matching JSON).
//
// The schema under test requires `{ status: 'success', data: string }`. The
// fixture JSONs deliberately miss one of those fields per attempt so the
// validation step fires and the retry/escalate path is exercised.
const STATUS_SUCCESS_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['status', 'data'],
  properties: { status: { const: 'success' }, data: { type: 'string' } },
});

describe('runDomSubAgent — schema validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.createdAgents.length = 0;
    testState.promptsByAttempt.length = 0;
    testState.responsesByAttempt.length = 0;
    testState.currentAttempt = 0;
  });

  it('schema-compliant JSON on first attempt → ok, no retry, no escalation', async () => {
    // JSON matches schema on attempt 1 → loop breaks immediately, the
    // retry/escalate path is never touched.
    testState.responsesByAttempt.push({
      assistantText: '{"status":"success","data":"all good"}',
    });

    const result = await runDomSubAgent({
      task: 'extract the table',
      expected_schema: STATUS_SUCCESS_SCHEMA,
      complexity: 'simple',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"status":"success","data":"all good"}');
    expect(testState.createdAgents.length).toBe(1);
    expect(testState.createdAgents[0].complexity).toBe('simple');
  });

  it('schema mismatch on attempt 1 → retry with escalate simple → complex; attempt 2 matches → ok', async () => {
    // Attempt 1 returns JSON that misses the required `data` field → schema
    // check fails → loop escalates to 'complex' for attempt 2.
    // Attempt 2 returns schema-compliant JSON → loop breaks at attempt 2.
    testState.responsesByAttempt.push({
      assistantText: '{"status":"success"}',
    });
    testState.responsesByAttempt.push({
      assistantText: '{"status":"success","data":"fixed"}',
    });

    const result = await runDomSubAgent({
      task: 'extract the table',
      expected_schema: STATUS_SUCCESS_SCHEMA,
      complexity: 'simple',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"status":"success","data":"fixed"}');
    expect(testState.createdAgents.length).toBe(2);
    // First attempt honors caller's 'simple'; retry escalates to 'complex'.
    expect(testState.createdAgents[0].complexity).toBe('simple');
    expect(testState.createdAgents[1].complexity).toBe('complex');
  });

  it('schema mismatch on both attempts → returns Schema validation failed error', async () => {
    // Both attempts return JSON missing the required `data` field. With
    // MAX_RETRIES=1, attempt 2 is the last attempt — when its schema check
    // also fails, the loop breaks with `ok=false` and the post-loop error
    // surfaces the dedicated `Schema validation failed:` message.
    testState.responsesByAttempt.push({
      assistantText: '{"status":"success"}',
    });
    testState.responsesByAttempt.push({
      assistantText: '{"status":"success"}',
    });

    const result = await runDomSubAgent({
      task: 'extract the table',
      expected_schema: STATUS_SUCCESS_SCHEMA,
      complexity: 'complex',
      tabId: 73278874,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Schema validation failed: /);
    // format mirror: ${instancePath}: ${message}
    expect(result.error).toMatch(/: /);
    expect(testState.createdAgents.length).toBe(2);
    // Caller asked 'complex' — first attempt uses 'complex', retry stays 'complex'.
    expect(testState.createdAgents[0].complexity).toBe('complex');
    expect(testState.createdAgents[1].complexity).toBe('complex');
  });

  it('malformed expected_schema (not valid JSON) → early-return, no LLM call', async () => {
    // parseExpectedSchema returns null → runner rejects the call before
    // touching the agent. createdAgents stays empty.
    const result = await runDomSubAgent({
      task: 'extract the table',
      expected_schema: '{ this is not json',
      complexity: 'simple',
      tabId: 73278874,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid expected_schema: not valid JSON');
    expect(testState.createdAgents.length).toBe(0);
  });

  it('non-JSON assistant output when schema requested → dedicated non-JSON retry path; retry emits JSON and succeeds', async () => {
    // When caller passed a schema but the LLM emits non-JSON prose,
    // `JSON.parse(rawText)` inside the schema-check block throws. The
    // runner has a dedicated fallback path for this case (separate from
    // the schema-mismatch path): it builds its own `<retry-feedback>`
    // block pointing at the parse failure, escalates `simple → complex`,
    // and retries. On the retry, the LLM emits schema-compliant JSON and
    // the schema check passes.
    testState.promptsByAttempt.push({ attempt: 1, returnEmpty: false });
    testState.responsesByAttempt.push({
      assistantText: 'some prose without any JSON at all',
    });
    testState.responsesByAttempt.push({
      assistantText: '{"status":"success","data":"json on retry"}',
    });

    const result = await runDomSubAgent({
      task: 'extract the table',
      expected_schema: STATUS_SUCCESS_SCHEMA,
      complexity: 'simple',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"status":"success","data":"json on retry"}');
    expect(testState.createdAgents.length).toBe(2);
  });
});

// ─── Fast-path dispatch ───
// 测 `complexity: 'fast'` 完全绕开 ReAct loop：
// - `createDomSubAgent` **绝不**调用（没 agent 创建）
// - `convertArticleToMarkdown` 只调用 1 次（article 提取）
// - `complete()` 只调用 1 次（single-shot LLM）
// - Schema 合法响应 → ok=true，attemptCount=1（不 retry）
// - Schema 不匹配 / 非 JSON → ok=false 立刻返回（不 retry）
//
// 所有 fast-path 测试都用 `testState.fastPathHtml` + `fastPathMarkdown`
// 设同一套 article 提取 mock。schema fixture 与上方的 schema-validation
// block 共享。
describe('runDomSubAgent — fast path (single-shot)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ReAct 循环的 state 也清——fast-path 测试不动它，但顺序变了的话
    // 残留 push 会污染后面的测试。
    testState.createdAgents.length = 0;
    testState.promptsByAttempt.length = 0;
    testState.responsesByAttempt.length = 0;
    testState.currentAttempt = 0;
    // 重置 fast-path mock state。
    testState.fastPathCalls.length = 0;
    testState.fastPathResponses.length = 0;
    testState.fastPathHtml = '<html><body><article>mock article body</article></body></html>';
    testState.fastPathMarkdown = 'mock article body in markdown';
    testState.fastPathFallbackText = 'mock raw text fallback body';
    testState.fastPathThrowOnInjection = false;
  });

  it('complexity: "fast" → createDomSubAgent NEVER called; complete() called once', async () => {
    // Fast path 完全绕开 createDomSubAgent——ReAct 循环根本没进。
    // 只发一次 LLM 调用（走 pi-ai/compat 的 `complete()`），article 提取
    // 也只跑一次 `convertArticleToMarkdown`。
    const result = await runDomSubAgent({
      task: 'summarize the article',
      complexity: 'fast',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"status":"success","data":"fast-path default"}');

    // ReAct 循环没跑。
    expect(testState.createdAgents.length).toBe(0);
    // 单次 LLM 调用（不 retry）。
    expect(testState.fastPathCalls.length).toBe(1);
    // article 提取只跑一次。
    expect(convertArticleToMarkdown).toHaveBeenCalledTimes(1);
    // 注入 tab 只跑一次（只 `getDocumentHtml`——mock 返回合法 markdown，
    // 所以不走 raw-text 回退）。
    expect(executeInTabWithArgs).toHaveBeenCalledTimes(1);
    // system prompt 跟 `FAST_DOM_SYSTEM_PROMPT` 对得上（防止错接到 ReAct 那条 prompt）。
    expect(testState.fastPathCalls[0].systemPrompt).toContain('fast DOM extraction agent');
    // 单条 user message（无 tools，无会话历史）。
    expect(testState.fastPathCalls[0].messageCount).toBe(1);
  });

  it('schema-compliant JSON on fast path → ok, no retry', async () => {
    // 默认 fast-path 返回 schema 合法 JSON（匹配下方的 STATUS_SUCCESS_SCHEMA）。
    // Schema 校验通过，函数立刻返回——不再发第二次 `complete()`，
    // 不 escalate。
    const result = await runDomSubAgent({
      task: 'extract the table',
      expected_schema: STATUS_SUCCESS_SCHEMA,
      complexity: 'fast',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"status":"success","data":"fast-path default"}');
    expect(testState.fastPathCalls.length).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('schema mismatch on fast path → ok=false immediately, no retry', async () => {
    // 返回缺 `data` 字段的 JSON。Fast path **没有** retry 预算——一次
    // LLM 调用后必须立刻返回 `Schema validation failed: ...`。ReAct 循环
    // 那套（escalate + retry + retry with feedback）这里不适用。
    testState.fastPathResponses.push({
      assistantText: '{"status":"success"}', // 缺 `data`
    });

    const result = await runDomSubAgent({
      task: 'extract the table',
      expected_schema: STATUS_SUCCESS_SCHEMA,
      complexity: 'fast',
      tabId: 73278874,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Schema validation failed: /);
    // 不 retry——单次 LLM 调用。
    expect(testState.fastPathCalls.length).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
    // ReAct 循环没跑。
    expect(testState.createdAgents.length).toBe(0);
  });

  it('non-JSON output on fast path with schema → ok=false immediately, dedicated error', async () => {
    // Fast-path single-shot 契约：caller 要 schema 但 LLM 吐了非 JSON 散文
    // → 专用错误 "Schema validation failed: response is not valid JSON"。
    // 跟 schema 不匹配一样的 single-shot 规则（不 retry）。
    testState.fastPathResponses.push({
      assistantText: 'just some prose without any JSON at all',
    });

    const result = await runDomSubAgent({
      task: 'extract the table',
      expected_schema: STATUS_SUCCESS_SCHEMA,
      complexity: 'fast',
      tabId: 73278874,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Schema validation failed: response is not valid JSON',
    );
    // No retry — single LLM call only.
    expect(testState.fastPathCalls.length).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});