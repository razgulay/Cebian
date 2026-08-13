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
const testState = vi.hoisted(() => ({
  createdAgents: [] as Array<{ complexity?: 'simple' | 'complex'; tabId?: number }>,
  promptsByAttempt: [] as Array<{ attempt: number; returnEmpty: boolean }>,
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
      return {
        agent: {
          state: {
            messages: wantEmpty
              ? []
              : [
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: '{"status":"success","data":"ok","reason":""}' }],
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