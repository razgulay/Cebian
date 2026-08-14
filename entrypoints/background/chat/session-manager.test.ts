// Characterization tests for `entrypoints/background/chat/session-manager.ts`.
//
// Purpose: this file has 0% direct test coverage today. Before any refactor
// (AgentRun extraction, etc.), lock down the public API behavior so a future
// edit can't silently break invariants the production code relies on.
//
// Scope (focused, not exhaustive — covers the highest-risk invariants only):
//   1. `cancel()` dispatch by `AgentPhase` — the 4-case matrix.
//   2. The `commitCompactionCancel` / `commitRetryCancel` race guards that
//      skip persist+broadcast when the session has been removed from the
//      map (e.g. by `destroySession`).
//
// Out of scope (covered indirectly by chat integration tests + the existing
// helper-primitive tests in `lib/agent/`):
//   - Full prompt() / retry() / editAndRerun() round-trips
//   - `maybeCompact()` orchestration (only the primitive helpers are tested
//     in `lib/agent/compaction.test.ts`)
//
// How the tests inject state: `sessionManager` is a singleton with a private
// `sessions` Map. We cast `as any` to inject `AgentSession` stubs — pragmatic
// for characterization, removed when the AgentRun extraction lands (the
// extracted module will get a proper constructor).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock all heavy deps ───
//
// We mock every import the production file uses. Mocks live in `vi.hoisted`
// so they're available before the mock factories run. The mock surface for
// each module is minimal — just the surface cancel()/commit*Cancel() touch.

const mocks = vi.hoisted(() => {
  return {
    // sessionStore
    scheduleWrite: vi.fn(),
    flush: vi.fn(async () => {}),
    // broadcastToViewers
    broadcastToViewers: vi.fn(),
    // keep-alive
    acquireKeepAlive: vi.fn(),
    releaseKeepAlive: vi.fn(),
    // Agent from pi-agent-core (only the bits cancel() reads)
    Agent: vi.fn(),
    // provider resolution (loaded by createAgent — kept as noop stubs)
    resolveProviderApiKey: vi.fn(async () => undefined),
    // prompt composer
    composeUserMessage: vi.fn(),
    composeSystemPrompt: vi.fn(),
    // tools
    createSessionTools: vi.fn(),
    buildSessionToolArray: vi.fn(() => []),
    runSkillGate: vi.fn(() => ({ name: 'run_skill' })),
    createInteractiveBridge: vi.fn(() => ({
      getPending: vi.fn(() => null),
      cancel: vi.fn(),
      resolve: vi.fn(),
      request: vi.fn(),
    })),
    createPermissionGate: vi.fn(() => ({ name: 'permission_gate' })),
    // MCP
    getMCPManager: vi.fn(() => ({ subscribe: vi.fn(() => () => {}) })),
    // storage (lastSelectedThinkingLevel read by createAgent)
    lastSelectedThinkingLevel: { getValue: vi.fn(async () => 'medium') },
    // sessionStore (lazy import pattern)
    sessionStoreModule: {
      sessionStore: {} as Record<string, unknown>,
    },
    // The provider/credentials/storage items the production code touches at import
    resolveModel: vi.fn(() => null),
    // t() i18n
    t: vi.fn((s: string) => s),
    // Factory for the per-run agent — never invoked in these tests since we
    // inject sessions directly.
    createCebianAgent: vi.fn(),
  };
});

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: mocks.Agent,
  estimateContextTokens: vi.fn(() => 0),
  shouldCompact: vi.fn(() => false),
}));

vi.mock('@earendil-works/pi-ai', () => ({
  clampThinkingLevel: vi.fn((x: unknown) => x),
}));

vi.mock('../agent/factory', () => ({
  createCebianAgent: mocks.createCebianAgent,
}));

vi.mock('../agent/prompt-composer', () => ({
  composeUserMessage: mocks.composeUserMessage,
  composeSystemPrompt: mocks.composeSystemPrompt,
}));

vi.mock('../providers/credentials', () => ({
  resolveProviderApiKey: mocks.resolveProviderApiKey,
}));

vi.mock('@/lib/agent/compaction', () => ({
  COMPACTION_SETTINGS: { thresholdTokens: 100_000 },
  findCompactionCutPoint: vi.fn(() => 0),
  runCompaction: vi.fn(async () => null),
  createCompactionSummaryMessage: vi.fn(),
  isCompactionSummary: vi.fn(() => false),
  usableCompactionTarget: vi.fn(() => null),
}));

vi.mock('@/lib/tools', () => ({
  createSessionTools: mocks.createSessionTools,
  buildSessionToolArray: mocks.buildSessionToolArray,
}));

vi.mock('@/lib/tools/run-skill', () => ({
  runSkillGate: mocks.runSkillGate,
}));

vi.mock('@/lib/tools/interactive-bridge', () => ({
  createInteractiveBridge: mocks.createInteractiveBridge,
  INTERACTIVE_CANCELLED: Symbol.for('interactive-cancelled'),
}));

vi.mock('@/lib/agent/tool-permissions', () => ({
  createPermissionGate: mocks.createPermissionGate,
  createPermissionRequestMessage: vi.fn(),
  isPermissionRequest: vi.fn(() => false),
}));

vi.mock('@/lib/persistence/storage', () => ({
  lastSelectedThinkingLevel: mocks.lastSelectedThinkingLevel,
  providerCredentials: { getValue: vi.fn(async () => ({})) },
  customProviders: { getValue: vi.fn(async () => []) },
  lastSelectedModel: { getValue: vi.fn(async () => null) },
  compactionModel: { getValue: vi.fn(async () => null) },
  userInstructions: { getValue: vi.fn(async () => '') },
  memorySettings: { getValue: vi.fn(async () => ({ enabled: false })) },
}));

vi.mock('@/lib/mcp/manager', () => ({
  getMCPManager: mocks.getMCPManager,
}));

vi.mock('@/lib/providers/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/i18n', () => ({
  t: mocks.t,
}));

vi.mock('../lifecycle/keepalive', () => ({
  acquireKeepAlive: mocks.acquireKeepAlive,
  releaseKeepAlive: mocks.releaseKeepAlive,
}));

// sessionStore + viewers: lazy import in the production file. The mock
// module exposes the shape cancel()/commit*Cancel() read.
vi.mock('./session-store', () => ({
  sessionStore: {
    scheduleWrite: mocks.scheduleWrite,
    flush: mocks.flush,
  },
}));

vi.mock('./viewers', () => ({
  broadcastToViewers: mocks.broadcastToViewers,
}));

// ─── Test surface ───

import { sessionManager } from './session-manager';
import { broadcastToViewers } from './viewers';
import { sessionStore } from './session-store';
import { acquireKeepAlive, releaseKeepAlive } from '../lifecycle/keepalive';

type AgentPhase = 'idle' | 'preparing' | 'compacting' | 'running';

// Minimal AgentSession stub matching the interface in session-manager.ts (lines
// 118-149). Only the fields cancel()/commit*Cancel() actually touch are set.
function makeSession(opts: {
  sessionId: string;
  phase: AgentPhase;
  messages?: any[];
  sessionCreated?: boolean;
  prepareController?: AbortController;
  compactionController?: AbortController;
}) {
  const messages = opts.messages ?? [];
  const agent = {
    state: { messages },
    abort: vi.fn(),
    waitForIdle: vi.fn(async () => {}),
    unsubscribe: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    continue: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
  };
  return {
    agent,
    sessionId: opts.sessionId,
    sessionCreated: opts.sessionCreated ?? true,
    phase: opts.phase,
    prepareController: opts.prepareController,
    compactionController: opts.compactionController,
    modelKey: 'openai/gpt-4o-mini',
    toolCtx: {
      dispose: vi.fn(),
      getPendingRequests: vi.fn(() => []),
      resolve: vi.fn(),
    },
    permissionBridge: {
      cancel: vi.fn(),
      getPending: vi.fn(() => null),
      resolve: vi.fn(),
      request: vi.fn(),
    },
    unsubscribeAgent: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Drop any sessions injected by a previous test so test order doesn't matter.
  (sessionManager as any).sessions.clear();
  // keepAliveHeld starts false; reset defensively.
  (sessionManager as any).keepAliveHeld = false;
  // Default mocks for the teardown path.
  mocks.flush.mockResolvedValue(undefined);
});

describe('cancel() — dispatch by AgentPhase', () => {
  it('cancel on unknown sessionId is a no-op (no error, no broadcast)', async () => {
    await expect(sessionManager.cancel('does-not-exist')).resolves.toBeUndefined();
    expect(mocks.broadcastToViewers).not.toHaveBeenCalled();
    expect(mocks.scheduleWrite).not.toHaveBeenCalled();
  });

  it('cancel in `preparing` aborts prepareController + agent but does not evict or broadcast', async () => {
    const prepareController = new AbortController();
    const s = makeSession({
      sessionId: 'sess-prep',
      phase: 'preparing',
      prepareController,
    });
    (sessionManager as any).sessions.set('sess-prep', s);

    await sessionManager.cancel('sess-prep');

    expect(prepareController.signal.aborted).toBe(true);
    expect(s.agent.abort).toHaveBeenCalledTimes(1);
    // No teardown, no eviction, no broadcast, no persist.
    expect(s.toolCtx.dispose).not.toHaveBeenCalled();
    expect(s.unsubscribeAgent).not.toHaveBeenCalled();
    expect(s.permissionBridge.cancel).not.toHaveBeenCalled();
    expect(s.agent.waitForIdle).not.toHaveBeenCalled();
    expect(mocks.broadcastToViewers).not.toHaveBeenCalled();
    expect(mocks.scheduleWrite).not.toHaveBeenCalled();
    // Session still in the map (cancel only signals — retry path owns cleanup).
    expect((sessionManager as any).sessions.has('sess-prep')).toBe(true);
  });

  it('cancel in `compacting` aborts compactionController only (no agent.abort, no evict)', async () => {
    const compactionController = new AbortController();
    const s = makeSession({
      sessionId: 'sess-compact',
      phase: 'compacting',
      compactionController,
    });
    (sessionManager as any).sessions.set('sess-compact', s);

    await sessionManager.cancel('sess-compact');

    expect(compactionController.signal.aborted).toBe(true);
    // No active run yet — agent.abort is the wrong tool for the window.
    expect(s.agent.abort).not.toHaveBeenCalled();
    expect(mocks.broadcastToViewers).not.toHaveBeenCalled();
    expect(mocks.scheduleWrite).not.toHaveBeenCalled();
    // Session stays in map; maybeCompact() owns the cleanup path.
    expect((sessionManager as any).sessions.has('sess-compact')).toBe(true);
  });

  it('cancel in `running` does full teardown: agent.abort, unsubscribe, dispose, flush, broadcast agent_end, evict', async () => {
    const s = makeSession({
      sessionId: 'sess-running',
      phase: 'running',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    (sessionManager as any).sessions.set('sess-running', s);

    await sessionManager.cancel('sess-running');

    expect(s.agent.abort).toHaveBeenCalledTimes(1);
    expect(s.unsubscribeAgent).toHaveBeenCalledTimes(1);
    expect(s.toolCtx.dispose).toHaveBeenCalledTimes(1);
    expect(s.permissionBridge.cancel).toHaveBeenCalledTimes(1);
    expect(s.agent.waitForIdle).toHaveBeenCalledTimes(1);
    expect(mocks.flush).toHaveBeenCalledWith('sess-running');
    // Final broadcast: agent_end with the (still-1-message) state.
    expect(mocks.broadcastToViewers).toHaveBeenCalledTimes(1);
    const [sid, msg] = mocks.broadcastToViewers.mock.calls[0];
    expect(sid).toBe('sess-running');
    expect(msg.type).toBe('agent_end');
    expect(msg.messages).toHaveLength(1);
    // Session evicted from the map.
    expect((sessionManager as any).sessions.has('sess-running')).toBe(false);
  });

  it('cancel in `idle` (already-stopped agent) does NOT write a redundant persist or bump updatedAt', async () => {
    // idle case: agent was never running, so messages length does not change
    // when abort() is called. cancel() must skip the post-abort persist.
    const s = makeSession({
      sessionId: 'sess-idle',
      phase: 'idle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'done' }] }],
    });
    (sessionManager as any).sessions.set('sess-idle', s);

    await sessionManager.cancel('sess-idle');

    expect(s.agent.abort).toHaveBeenCalledTimes(1);
    expect(s.unsubscribeAgent).toHaveBeenCalledTimes(1);
    // No persist — length unchanged, the redundant-write guard at line 1470.
    expect(mocks.scheduleWrite).not.toHaveBeenCalled();
    // Still broadcasts agent_end so the client knows the agent has stopped.
    expect(mocks.broadcastToViewers).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastToViewers.mock.calls[0][1].type).toBe('agent_end');
    // Session evicted.
    expect((sessionManager as any).sessions.has('sess-idle')).toBe(false);
  });
});

describe('commit*Cancel() race guards — silent exit if session was destroyed', () => {
  // Reach into the private methods via `as any` for characterization purposes.
  // After the AgentRun extraction, these will become public/internal methods on
  // the extracted class with proper test seams.

  it('commitCompactionCancel: session absent → no persist, no broadcast', async () => {
    const s = makeSession({
      sessionId: 'sess-destroyed',
      phase: 'compacting',
      messages: [],
    });
    // Simulate destroySession having just removed the entry.
    (sessionManager as any).sessions.delete('sess-destroyed');

    await (sessionManager as any).commitCompactionCancel(s, {
      role: 'user',
      content: [{ type: 'text', text: 'pending' }],
    } as any);

    expect(mocks.scheduleWrite).not.toHaveBeenCalled();
    expect(broadcastToViewers).not.toHaveBeenCalled();
  });

  it('commitRetryCancel: session absent → no persist, no broadcast', async () => {
    const s = makeSession({
      sessionId: 'sess-destroyed',
      phase: 'preparing',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'old' }] }],
    });
    // buildAbortedMarker reads agent.state.model — stub it.
    (s.agent.state as any).model = { api: 'openai', provider: 'openai', id: 'gpt-4o-mini' };
    (sessionManager as any).sessions.delete('sess-destroyed');

    await (sessionManager as any).commitRetryCancel(s, [{ role: 'user', content: [{ type: 'text', text: 'truncated' }] }] as any);

    expect(mocks.scheduleWrite).not.toHaveBeenCalled();
    expect(broadcastToViewers).not.toHaveBeenCalled();
  });

  it('commitCompactionCancel: session present → persists + broadcasts (sanity check for the guard)', async () => {
    const s = makeSession({
      sessionId: 'sess-alive',
      phase: 'compacting',
      messages: [],
    });
    (s.agent.state as any).model = { api: 'openai', provider: 'openai', id: 'gpt-4o-mini' };
    (sessionManager as any).sessions.set('sess-alive', s);

    await (sessionManager as any).commitCompactionCancel(s, {
      role: 'user',
      content: [{ type: 'text', text: 'pending' }],
    } as any);

    expect(mocks.scheduleWrite).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastToViewers).toHaveBeenCalledTimes(1);
    const [sid, msg] = mocks.broadcastToViewers.mock.calls[0];
    expect(sid).toBe('sess-alive');
    expect(msg.type).toBe('session_state');
    expect(msg.isRunning).toBe(false);
    expect(msg.isCompacting).toBe(false);
  });
});

describe('keep-alive is balanced across cancel() teardown', () => {
  it('cancel in `running` releases the keep-alive token if one was held', async () => {
    // Pretend updateKeepAlive() previously acquired the token.
    (sessionManager as any).keepAliveHeld = true;
    // But with no live runs, updateKeepAlive() in cancel() should release.
    const s = makeSession({
      sessionId: 'sess-ka',
      phase: 'running',
      messages: [],
    });
    (sessionManager as any).sessions.set('sess-ka', s);

    await sessionManager.cancel('sess-ka');

    // acquireKeepAlive was called zero times in this test (no work happened),
    // but release should be called when the keepAliveHeld flag is cleared.
    // We don't assert the exact count — just that releaseKeepAlive is reachable
    // through the teardown path. The exhaustive accounting is in the helper test.
    expect(releaseKeepAlive).toHaveBeenCalled();
  });
});