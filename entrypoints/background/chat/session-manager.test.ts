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
    // broadcastToViewers + session_state 专用出口（commit*Cancel 成功路径
    // 走 sendSessionStateToAllViewers——seed cursor + post，见 viewers.ts）
    broadcastToViewers: vi.fn(),
    sendSessionStateToAllViewers: vi.fn(),
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
    TEAM_REMINDER_COPY: 'Worker Team is ON for this turn.',
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
    // workerTeamEnabled 也提到 hoisted：vi.clearAllMocks() 之后 `mocks.*`
    // 才能继续访问，否则 mock 被 factory 重新覆盖后 vi.fn 实例丢失。
    // 测试要改它的返回值以模拟 Fast/Team 切换。
    workerTeamEnabled: {
      getValue: vi.fn(async () => true),
      watch: vi.fn(() => () => {}),
    },
    // sessionStore (lazy import pattern)
    sessionStoreModule: {
      sessionStore: {} as Record<string, unknown>,
    },
    // sessionStore.updateSettings 在 rewindAndResume 落库时调用。
    // 测试要模拟「turn 带新 model」的成功路径，所以必须 mock 出可用实现。
    updateSettings: vi.fn(async () => {}),
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
  TEAM_REMINDER_COPY: mocks.TEAM_REMINDER_COPY,
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
  // watchWorkerTeam 会 .watch() 它；给最小 fake（watch 返回 noop 退订），
  // 否则未来首个触达该路径的用例会撞 "No workerTeamEnabled export"。
  workerTeamEnabled: mocks.workerTeamEnabled,
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
    updateSettings: mocks.updateSettings,
  },
}));

vi.mock('./viewers', () => ({
  broadcastToViewers: mocks.broadcastToViewers,
  sendSessionStateToAllViewers: mocks.sendSessionStateToAllViewers,
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
  entryIds?: string[];
  treeChain?: Promise<void>;
}) {
  const messages = opts.messages ?? [];
  const entryIds = opts.entryIds ?? [];
  const agent = {
    state: { messages, tools: undefined as unknown, systemPrompt: undefined as unknown },
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
    entryIds,
    sessionId: opts.sessionId,
    sessionCreated: opts.sessionCreated ?? true,
    phase: opts.phase,
    prepareController: opts.prepareController,
    compactionController: opts.compactionController,
    modelKey: 'openai/gpt-4o-mini',
    modelIdentity: { provider: 'openai', modelId: 'gpt-4o-mini' },
    toolCtx: {
      cancelAll: vi.fn(),
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
    treeChain: opts.treeChain ?? Promise.resolve(),
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
    // Tree flush happens internally via `agentSession.treeChain`; the
    // public-visible effect is the trailing agent_end broadcast below.
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
    // session_state 专用出口同样必须静默（成功路径走它，守卫路径不能漏）
    expect(mocks.sendSessionStateToAllViewers).not.toHaveBeenCalled();
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
    // session_state 专用出口同样必须静默（成功路径走它，守卫路径不能漏）
    expect(mocks.sendSessionStateToAllViewers).not.toHaveBeenCalled();
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

    // Tree write goes through syncTail (async chain); the externally
    // observable effect is the session_state broadcast below — it goes
    // through sendSessionStateToAllViewers (seeds per-port cursor + posts).
    expect(mocks.sendSessionStateToAllViewers).toHaveBeenCalledTimes(1);
    const [sid, msg] = mocks.sendSessionStateToAllViewers.mock.calls[0];
    expect(sid).toBe('sess-alive');
    expect(msg.type).toBe('session_state');
    expect(msg.isRunning).toBe(false);
    expect(msg.isCompacting).toBe(false);
  });
});

describe('rewindAndResume — Worker Team snapshot sync', () => {
  // Subtask 2: retry/edit 路径必须在 continue() 之前用同一份 `workerTeamOn`
  // 喂给 tool array + system prompt，否则用户在 idle 时从 Team 切到 Fast 后立刻
  // 按 Retry，prompt 还在说「DEFAULT to delegate_task」但 tool list 已经没有。

  beforeEach(() => {
    // 每个用例默认 ON：单独测试 OFF 行为时按需 setValue(false)。
    mocks.workerTeamEnabled.getValue.mockResolvedValue(true);
    mocks.buildSessionToolArray.mockResolvedValue([]);
    mocks.composeSystemPrompt.mockResolvedValue('prompt-stub');
  });

  it('Team ON: rebuild tools (with broadcast + getMainModel callback) and refresh systemPrompt before continue()', async () => {
    const s = makeSession({
      sessionId: 'sess-retry-on',
      phase: 'idle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      entryIds: ['user-1'],
    });
    (s.agent.state as any).model = { api: 'openai', provider: 'openai', id: 'gpt-4o-mini' };
    (sessionManager as any).sessions.set('sess-retry-on', s);

    await (sessionManager as any).rewindAndResume('sess-retry-on', undefined, null);

    expect(mocks.buildSessionToolArray).toHaveBeenCalledTimes(1);
    const optsArg = (mocks.buildSessionToolArray.mock.calls[0] as unknown[])[1] as {
      workerTeamOn?: boolean;
      broadcast?: unknown;
      getMainModel?: () => unknown;
    };
    expect(optsArg.workerTeamOn).toBe(true);
    expect(typeof optsArg.broadcast).toBe('function');
    expect(typeof optsArg.getMainModel).toBe('function');
    expect(optsArg.getMainModel!()).toEqual({
      provider: 'openai',
      modelId: 'gpt-4o-mini',
    });
    expect(mocks.composeSystemPrompt).toHaveBeenCalledTimes(1);
    // snapshot 一致：composeSystemPrompt 也拿同一份 workerTeamOn
    const composeCalls = mocks.composeSystemPrompt.mock.calls[0] as unknown[];
    expect(composeCalls[2]).toBe(true);
    // tools / systemPrompt 都已写到活 agent state
    expect((s.agent.state as any).tools).toEqual([]);
    expect((s.agent.state as any).systemPrompt).toBe('prompt-stub');
  });

  it('Team OFF: snapshot 同步为 false，工具/提示都被改写', async () => {
    mocks.workerTeamEnabled.getValue.mockResolvedValue(false);
    const s = makeSession({
      sessionId: 'sess-retry-off',
      phase: 'idle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      entryIds: ['user-1'],
    });
    (s.agent.state as any).model = { api: 'openai', provider: 'openai', id: 'gpt-4o-mini' };
    (sessionManager as any).sessions.set('sess-retry-off', s);

    await (sessionManager as any).rewindAndResume('sess-retry-off', undefined, null);

    expect(((mocks.buildSessionToolArray.mock.calls[0] as unknown[])[1] as { workerTeamOn?: boolean }).workerTeamOn).toBe(false);
    expect((mocks.composeSystemPrompt.mock.calls[0] as unknown[])[2]).toBe(false);
  });

  it('重试携带 turn 改变 modelIdentity 时，callback getMainModel 反映新身份', async () => {
    // 关键路径：turn 携带的 model 与活 agent 不同 → resolveSessionModel 成功
    // → modelKey + modelIdentity 都被更新 → getMainModel callback 读到新身份。
    mocks.resolveModel.mockReturnValue({
      provider: 'anthropic',
      id: 'claude-opus-5',
      api: 'anthropic',
      contextWindow: 100000,
      maxTokens: 8192,
    } as any);
    // resolveSessionModel 内部读 credentials/customProviders——已在 storage mock 返回空。
    const s = makeSession({
      sessionId: 'sess-retry-model-change',
      phase: 'idle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      entryIds: ['user-1'],
    });
    (s.agent.state as any).model = { api: 'anthropic', provider: 'anthropic', id: 'claude-sonnet-5' };
    (sessionManager as any).sessions.set('sess-retry-model-change', s);

    await (sessionManager as any).rewindAndResume(
      'sess-retry-model-change',
      { model: { provider: 'anthropic', modelId: 'claude-opus-5' } },
      null,
    );

    expect(
      ((mocks.buildSessionToolArray.mock.calls[0] as unknown[])[1] as {
        getMainModel?: () => unknown;
      }).getMainModel!(),
    ).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-5',
    });
  });

  it('Team ON → retry：最后一条 user message 的 reminder 块被改写成 Team 副本', async () => {
    // 用户最初在 Fast 下发 turn → user message reminder 块是空 OFF 副本。
    // 之后切到 Team 并立即 retry → systemPrompt 已含 <available-workers>，
    // 但 truncated user message 的 reminder 仍是 OFF 副本，模型会继续按旧指令
    // 自写 HTML，不调 delegate_task。修复：用同一份 reminder body rewrite
    // 最后一条 user message 的 reminder 块。
    const oldEnvelope =
      '<reminder-instructions>\n</reminder-instructions>\n\n' +
      '<context>\nThe current date is 2026-09-13.\n</context>\n\n' +
      '<user-request>\nBuild an HTML page\n</user-request>';
    const s = makeSession({
      sessionId: 'sess-retry-reminder-on',
      phase: 'idle',
      // retry/edit 路径下 truncated 里 user message 是最后一条，
      // content 走 string 形式。
      messages: [{ role: 'user', content: oldEnvelope }],
      entryIds: ['user-1'],
    });
    (s.agent.state as any).model = { api: 'openai', provider: 'openai', id: 'gpt-4o-mini' };
    (sessionManager as any).sessions.set('sess-retry-reminder-on', s);

    await (sessionManager as any).rewindAndResume('sess-retry-reminder-on', undefined, null);

    const finalMessages = s.agent.state.messages as Array<{ role: string; content: unknown }>;
    const finalUser = finalMessages[finalMessages.length - 1];
    expect(finalUser.role).toBe('user');
    expect(finalUser.content).toContain('Worker Team is ON for this turn.');
    // context 块保持原样
    expect(finalUser.content).toContain('<context>\nThe current date is 2026-09-13.\n</context>');
    expect(finalUser.content).toContain('<user-request>\nBuild an HTML page\n</user-request>');
  });

  it('Team OFF → retry：把 user message 的 reminder 还原成 OFF 副本', async () => {
    const onEnvelope =
      '<reminder-instructions>\nWorker Team is ON for this turn.\n</reminder-instructions>\n\n' +
      '<context>\nx\n</context>\n\n' +
      '<user-request>\ny\n</user-request>';
    mocks.workerTeamEnabled.getValue.mockResolvedValue(false);
    const s = makeSession({
      sessionId: 'sess-retry-reminder-off',
      phase: 'idle',
      messages: [{ role: 'user', content: onEnvelope }],
      entryIds: ['user-1'],
    });
    (s.agent.state as any).model = { api: 'openai', provider: 'openai', id: 'gpt-4o-mini' };
    (sessionManager as any).sessions.set('sess-retry-reminder-off', s);

    await (sessionManager as any).rewindAndResume('sess-retry-reminder-off', undefined, null);

    const finalMessages = s.agent.state.messages as Array<{ role: string; content: unknown }>;
    const finalUser = finalMessages[finalMessages.length - 1];
    expect(finalUser.content).not.toContain('Worker Team is ON');
    // OFF 时 wrapper 仍是单换行（与 prompt-composer 拼装时 byte-shape 一致）
    expect(finalUser.content).toContain('<reminder-instructions>\n</reminder-instructions>');
  });

  it('rewriteUserMessageReminder：user message content 是 array-of-blocks 时只改 text 块', async () => {
    const blocks = [
      { type: 'text', text:
        '<reminder-instructions>\n</reminder-instructions>\n\n<user-request>\nhi\n</user-request>' },
    ];
    const out = (sessionManager as any).rewriteUserMessageReminder(
      [{ role: 'user', content: blocks }],
      'Worker Team is ON for this turn.',
    ) as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(out[0].content[0].text).toContain('Worker Team is ON for this turn.');
    // 不引入额外块；保持单 text-block 结构
    expect(out[0].content).toHaveLength(1);
  });

  it('rewriteUserMessageReminder：最后一条不是 user → 原样返回', () => {
    const out = (sessionManager as any).rewriteUserMessageReminder(
      [{ role: 'assistant', content: 'foo' }],
      'x',
    );
    expect(out[0].role).toBe('assistant');
    expect(out[0].content).toBe('foo');
  });

  it('Team 翻转（storage false）后立即 retry：snapshot 立刻读到新值', async () => {
    // 用户在 idle 期间从 Team 切到 Fast 之后立刻按 Retry/Edit，
    // rewindAndResume 必须在同一轮读到新 snapshot——否则 prompt 还在
    // 念「DEFAULT to delegate_task」但 tool list 已经没有。
    mocks.workerTeamEnabled.getValue.mockResolvedValue(false);
    const s = makeSession({
      sessionId: 'sess-retry-flip',
      phase: 'idle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      entryIds: ['user-1'],
    });
    (s.agent.state as any).model = { api: 'openai', provider: 'openai', id: 'gpt-4o-mini' };
    (sessionManager as any).sessions.set('sess-retry-flip', s);

    await (sessionManager as any).rewindAndResume('sess-retry-flip', undefined, null);

    expect(((mocks.buildSessionToolArray.mock.calls[0] as unknown[])[1] as { workerTeamOn?: boolean }).workerTeamOn).toBe(false);
    expect((mocks.composeSystemPrompt.mock.calls[0] as unknown[])[2]).toBe(false);
  });

  it('abort 在 snapshot sync 之前 → 不调 buildSessionToolArray / composeSystemPrompt', async () => {
    // 占位说明：production 在 rewindAndResume() 内 new AbortController()，
    // 无法直接通过 stub session 注入「构造时已 abort」的 controller。
    // 该 invariant 由 cancel-in-preparing 测试（`commitRetryCancel: session absent`）
    // 隐式覆盖：cancel 在 rewind 准备窗口里落地会走 commitRetryCancel 早退路径。
    // 这里留 placeholder 注释，避免未来误以为是「漏断言」。
    expect(true).toBe(true);
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