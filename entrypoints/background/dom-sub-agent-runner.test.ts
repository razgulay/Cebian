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
const testState = vi.hoisted(() => ({
  createdAgents: [] as Array<{ complexity?: 'simple' | 'complex'; tabId?: number }>,
  promptsByAttempt: [] as Array<{ attempt: number; returnEmpty: boolean }>,
  // `responsesByAttempt[i]` is the assistant text the i-th attempt returns.
  // When undefined the mock falls back to the legacy hardcoded JSON so the
  // auto-escalation describe block (which only cares about empty vs non-empty)
  // keeps working unchanged.
  responsesByAttempt: [] as Array<{ assistantText: string }>,
  currentAttempt: 0,
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

import { runDomSubAgent } from './dom-sub-agent-runner';

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