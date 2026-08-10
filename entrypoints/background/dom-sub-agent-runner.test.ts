import { describe, it, expect, vi } from 'vitest';

// Mock the storage helpers so resolveDomSubAgent can read a synthetic model.
const fakeModel = { provider: 'openai', id: 'gpt-4o-mini', api: 'openai-completions' } as any;
vi.mock('@/lib/persistence/storage', () => ({
  domSubAgentModel: { getValue: vi.fn(async () => ({ provider: 'openai', modelId: 'gpt-4o-mini' })) },
  providerCredentials: { getValue: vi.fn(async () => ({})) },
  customProviders: { getValue: vi.fn(async () => []) },
}));

// Mock createDomSubAgent to capture the complexity passed on each attempt.
const createdAgents: Array<{ complexity?: 'simple' | 'complex'; tabId?: number }> = [];
vi.mock('./dom-sub-agent', () => ({
  createDomSubAgent: vi.fn(async (_model, options) => {
    createdAgents.push(options);
    return {
      agent: {
        state: { messages: [] },
        prompt: async () => {},
        abort: () => {},
      } as any,
      tabId: options.tabId ?? null,
    } as any;
  }),
}));

// Mock the keep-alive helpers so they don't run setInterval in tests.
vi.mock('./sw-keepalive', () => ({
  acquireKeepAlive: vi.fn(),
  releaseKeepAlive: vi.fn(),
}));

// Mock the agent.prompt to return empty on first attempt, non-empty on retry.
// We do this by swapping the create of the agent per attempt.
const promptsByAttempt: Array<{ attempt: number; returnEmpty: boolean }> = [];
let currentAttempt = 0;
vi.mock('./dom-sub-agent', async () => {
  const real = await vi.importActual<typeof import('./dom-sub-agent')>('./dom-sub-agent');
  return {
    ...real,
    createDomSubAgent: vi.fn(async (_model, options) => {
      createdAgents.push(options);
      const attempt = ++currentAttempt;
      const wantEmpty = promptsByAttempt[attempt - 1]?.returnEmpty ?? false;
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

import { runDomSubAgent } from './dom-sub-agent-runner';

describe('runDomSubAgent — auto-escalation simple → complex', () => {
  it('attempt 1 uses caller\'s complexity, attempt 2 escalates to "complex"', async () => {
    createdAgents.length = 0;
    promptsByAttempt.length = 0;
    currentAttempt = 0;

    // attempt 1: empty response. attempt 2: success.
    promptsByAttempt.push({ attempt: 1, returnEmpty: true });
    promptsByAttempt.push({ attempt: 2, returnEmpty: false });

    const result = await runDomSubAgent({
      task: 'extract the table',
      complexity: 'simple',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain('"status":"success"');
    expect(result.tabId).toBe(73278874);

    // Verify the escalation pattern
    expect(createdAgents.length).toBe(2);
    expect(createdAgents[0].complexity).toBe('simple');
    expect(createdAgents[1].complexity).toBe('complex');
    // tabId is forwarded on both attempts
    expect(createdAgents[0].tabId).toBe(73278874);
    expect(createdAgents[1].tabId).toBe(73278874);
  });

  it('caller already passed "complex" — first attempt uses complex, retry stays complex', async () => {
    createdAgents.length = 0;
    promptsByAttempt.length = 0;
    currentAttempt = 0;

    promptsByAttempt.push({ attempt: 1, returnEmpty: true });
    promptsByAttempt.push({ attempt: 2, returnEmpty: false });

    const result = await runDomSubAgent({
      task: 'extract the table',
      complexity: 'complex',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    expect(createdAgents.length).toBe(2);
    expect(createdAgents[0].complexity).toBe('complex');
    expect(createdAgents[1].complexity).toBe('complex');
  });

  it('succeeds on first attempt — no escalation triggered', async () => {
    createdAgents.length = 0;
    promptsByAttempt.length = 0;
    currentAttempt = 0;

    promptsByAttempt.push({ attempt: 1, returnEmpty: false });

    const result = await runDomSubAgent({
      task: 'extract the table',
      complexity: 'simple',
      tabId: 73278874,
    });

    expect(result.ok).toBe(true);
    // Only one attempt was made since the first succeeded
    expect(createdAgents.length).toBe(1);
    expect(createdAgents[0].complexity).toBe('simple');
  });
});
