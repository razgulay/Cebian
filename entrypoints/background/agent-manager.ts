// Background Agent Manager — singleton that manages Agent instances.
// Each session gets its own Agent + SessionToolContext (per-session isolation).
//
// TODO(架构重构): 当前这个类同时承担了「会话编排 + 消息同步/落库 + 广播 + 单个
// agent 生命周期」四种职责，已接近上帝类（prompt/retry/cancel/maybeCompact 都几百行）。
// 计划拆成两层：
//   - SessionManager（单例）：Map<id, AgentSession>、creating 去重、keep-alive、
//     MCP 订阅、DB gating（sessionCreated + scheduleWrite + flush）、广播注入。
//   - AgentSession（每会话一个实例）：持有 agent + toolCtx + phase + controllers，
//     负责单会话的 prompt/retry/cancel/compaction，通过回调把「该落库了」告诉上层。
// 前置条件：先完成 rebuilding 简化（retry 原地复用活 agent，退役 rebuilding phase），
// 让 AgentSession 生命周期变干净后再拆，避免「边拆边改逻辑」。详见讨论记录。

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  estimateContextTokens,
  shouldCompact,
} from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { clampThinkingLevel } from '@earendil-works/pi-ai';
import { createCebianAgent, resolveProviderApiKey, composeUserMessage, composeSystemPrompt } from './agent';
import {
  COMPACTION_SETTINGS,
  findCompactionCutPoint,
  runCompaction,
  createCompactionSummaryMessage,
  isCompactionSummary,
  usableCompactionTarget,
  type CompactionSummaryMessage,
  type CompactionTarget,
} from '@/lib/agent/compaction';
import { sessionStore } from './session-store';
import { extractImages, type Attachment } from '@/lib/agent/attachments';
import { createSessionTools, buildSessionToolArray } from '@/lib/tools';
import { runSkillGate } from '@/lib/tools/run-skill';
import type { SessionToolContext } from '@/lib/tools/session-context';
import {
  createInteractiveBridge,
  INTERACTIVE_CANCELLED,
  type InteractiveBridge,
} from '@/lib/tools/interactive-bridge';
import {
  createPermissionGate,
  createPermissionRequestMessage,
  isPermissionRequest,
  type PermissionRequest,
  type PermissionDecision,
  type ToolGate,
} from '@/lib/agent/tool-permissions';
import type { ServerMessage, TurnSettings } from '@/lib/ipc/protocol';
import type { SessionRecord } from '@/lib/persistence/db';
import { truncateForRetry, truncateForEditRerun, sanitizeAgentMessages, extractUserText } from '@/lib/agent/message-helpers';
import type { Message } from '@earendil-works/pi-ai';
import { debugLog, withSession } from '@/lib/debug/log';
import {
  providerCredentials,
  customProviders as customProvidersStorage,
  lastSelectedModel,
  compactionModel,
  lastSelectedThinkingLevel,
  userInstructions as userInstructionsStorage,
  memorySettings,
  type ModelIdentity,
  type ThinkingLevel,
} from '@/lib/persistence/storage';
import { getMCPManager } from '@/lib/mcp/manager';
import { resolveModel } from '@/lib/providers/resolve-model';
import { t } from '@/lib/i18n';
import { acquireKeepAlive, releaseKeepAlive } from './sw-keepalive';

/**
 * Best-effort size of `JSON.stringify(value)` in characters. Returns 0 on
 * circular reference or other stringify failure. Used by the debug log to
 * surface payload sizes without dumping the full content (which may carry
 * secrets — credentials, file contents, etc.). The actual log entry is just
 * the integer size, not the stringified value itself.
 */
function safeStringifySize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * Per-token `message_update` events are filtered out by `NOISY_PREFIXES` in
 * the debug-log layer (one log row per token would drown the timeline). To
 * still give a sense of streaming throughput, we accumulate the count
 * client-side and emit `stream:progress` every N tokens per session. The
 * threshold is small enough to surface stalls but large enough that a 500-
 * token reply produces only ~10 progress rows instead of 500.
 */
const STREAM_DELTA_LOG_THRESHOLD = 50;

// ─── Types ───

/**
 * Lifecycle phase of a managed session.
 *
 * - `idle`: agent exists but is not running — waiting for next prompt/retry.
 *   This is the initial state and the resting state after `agent_end`.
 * - `preparing`: a `retry()` has been accepted and the session is doing async
 *   preparation before the agent resumes streaming — refreshing
 *   model / instructions / messages off storage. The `ManagedSession`
 *   entry stays in `sessions` throughout this phase so external operations
 *   (notably `cancel`) can still reach it. This phase only ever moves forward
 *   to `running` (via the `agent_start` event) or back to `idle` (on
 *   cancel / error) — never the reverse. (A model switch refreshes the live
 *   agent in place during `prompt()` without entering this phase — it has no
 *   independent resume/cancel window.)
 * - `running`: the agent is actively streaming a turn. Set by the
 *   `agent_start` event, cleared by `agent_end`.
 * - `compacting`: a context-compaction step is running before a fresh turn
 *   is dispatched — an independent `generateSummary` LLM call that may take
 *   several seconds. Entered by `maybeCompact()` right before `agent.prompt()`
 *   when the context exceeds the threshold; reset back to `idle` in that
 *   method's `finally`. Treated as "busy" everywhere (`updateKeepAlive`,
 *   `getSessionState`, the prompt guard) so the SW stays alive and concurrent
 *   prompts are dropped, mirroring the `preparing` window.
 *
 * Invariant: a session entry is in `sessions` iff its lifetime hasn't ended.
 * The previous design temporarily evicted entries during rebuild, which
 *  made `cancel()` silently no-op when it raced the preparation window — that
 * is exactly the bug this phase machine fixes.
 */
type ManagedPhase = 'idle' | 'preparing' | 'running' | 'compacting';

/**
 * 注册了执行前授权门禁的工具策略（ToolGate）集合。policy 对象本身是
 * session-independent 的纯策略，所以放模块级单一来源；每个会话只是用它
 * 构造一个绑定到自身 `requestPermissionDecision` 的 `beforeToolCall` 闭包。
 *
 * 目前只有 run_skill 接入；未来 chrome_api / execute_js 等要执行前授权时，
 * 在各自工具文件里实现 ToolGate 并加进这个数组即可，本编排层零改动。
 */
const PERMISSION_GATES: ToolGate[] = [runSkillGate];

interface ManagedSession {
  agent: Agent;
  sessionId: string;
  sessionCreated: boolean;
  phase: ManagedPhase;
  /**
   * Set while `phase === 'preparing'`. `cancel()` aborts this signal to
   * interrupt a retry's async preparation; the retry path checks `signal.aborted`
   * at each await boundary and bails cleanly without calling `agent.continue()`.
   * Cleared back to `undefined` when preparation ends (either success or abort).
   */
  prepareController?: AbortController;
  /**
   * Set while `phase === 'compacting'`. `cancel()` aborts this signal to
   * interrupt an in-flight `generateSummary` call; `maybeCompact()` then
   * skips inserting the summary, resets the phase, and signals `prompt()`
   * to abandon the turn. Cleared back to `undefined` when compaction ends.
   */
  compactionController?: AbortController;
  /** Cumulative delta count for the current assistant stream. Reset on
   *  `message_start`, incremented on each `message_update` (assistant
   *  role), used to emit `stream:progress` every
   *  `STREAM_DELTA_LOG_THRESHOLD` tokens for observability without
   *  per-token log spam. */
  streamDeltaCount: number;
  /** Wall-clock timestamp of `message_start` for the active stream, used
   *  to compute `stream:progress.durationMs` deltas. Reset on message_start. */
  streamStartedAt: number;
  /** LLM latency marker: wall-clock of the most recent `agent_start` (i.e.
   *  when we handed control to the model). Reset to 0 on `agent_end` after
   *  emitting `llm:request:end`. Used to compute TTFT and total request
   *  duration. */
  llmRequestStartedAt: number;
  /** LLM latency marker: wall-clock of the FIRST assistant `message_start`
   *  in the current turn (= TTFT point). Set once per turn, reset on
   *  `agent_end`. A turn can have multiple assistant messages (one per tool
   *  round) — only the first one is the user-visible TTFT. */
  llmFirstTokenAt: number;
  /** LLM latency marker: count of assistant message_starts in the current
   *  turn. Equal to the number of LLM rounds (initial + N tool rounds).
   *  Reset on `agent_end`. Useful to spot turns with excessive tool loops. */
  llmRounds: number;
  modelKey: string;
  /** Unified interactive tool bridge manager for this session. */
  toolCtx: SessionToolContext;
  /**
   * Per-session bridge for tool pre-execution permission prompts. Kept
   * separate from `toolCtx` because a permission prompt is NOT an LLM tool —
   * it pauses an otherwise-normal tool inside its `beforeToolCall` gate and
   * uses the dedicated permission broadcast path, not `tool_pending`.
   * At most one request is in-flight at a time (gate preflight is sequential).
   */
  permissionBridge: InteractiveBridge<PermissionRequest, PermissionDecision>;
  unsubscribeAgent: () => void;
}

type BroadcastFn = (sessionId: string, msg: ServerMessage) => void;

// ─── Agent Manager ───

class AgentManager {
  private sessions = new Map<string, ManagedSession>();
  /** Guards against concurrent getOrCreateAgent calls for the same session. */
  private creating = new Map<string, Promise<ManagedSession>>();
  private broadcast: BroadcastFn = () => {};
  /** True iff we're currently holding a SW keep-alive token. Tracked so
   *  acquire/release stay balanced even across error paths. */
  private keepAliveHeld = false;
  /** Subscription to MCPManager change notifications; pushes refreshed tools into every live session. */
  private mcpUnsubscribe?: () => void;

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
    // Subscribe to MCPManager so we react AFTER its internal entries map is
    // reconciled — avoids racing two independent storage watchers.
    if (!this.mcpUnsubscribe) {
      this.mcpUnsubscribe = getMCPManager().subscribe(() => {
        void this.refreshAllSessionTools();
      });
    }
  }

  private getPendingToolSnapshot(managed: ManagedSession): { toolName: string; toolCallId: string; args: any }[] {
    return managed.toolCtx.getPendingRequests().map(({ toolName, pending }) => ({
      toolName,
      toolCallId: pending.toolCallId,
      args: pending.request,
    }));
  }

  /** Snapshot of the session's in-flight permission prompt (0 or 1). */
  private getPendingPermissions(managed: ManagedSession): PermissionRequest[] {
    const pending = managed.permissionBridge.getPending();
    return pending ? [pending.request] : [];
  }

  /**
   * Broadcast a full `session_state` snapshot for the session. Used by the
   * permission flow to push the inserted / updated `permissionRequest` card
   * plus the live `pendingPermissions` set in one shot — mirroring how
   * `maybeCompact` delivers an inserted `compactionSummary`.
   */
  private broadcastSessionSnapshot(managed: ManagedSession): void {
    this.broadcast(managed.sessionId, {
      type: 'session_state',
      sessionId: managed.sessionId,
      messages: [...managed.agent.state.messages],
      isRunning: managed.phase !== 'idle',
      isCompacting: managed.phase === 'compacting',
      pendingTools: this.getPendingToolSnapshot(managed),
      pendingPermissions: this.getPendingPermissions(managed),
    });
  }

  /**
   * Injected as the permission gate's `RequestDecisionFn`. Runs while a tool
   * is paused in its `beforeToolCall` gate (loop is suspended here).
   *
   * Flow: insert a `pending` permissionRequest message → persist + broadcast →
   * await the user's click on the bridge → write the final decision back onto
   * that message → persist + broadcast → return the decision to the gate.
   *
   * The inserted message lands between the assistant(toolCall) and the
   * (not-yet-produced) toolResult — exactly the order needed so `convertToLlm`
   * filtering keeps toolCall↔toolResult adjacent for the provider.
   *
   * Terminal mapping: an explicit `bridge.resolve(decision)` returns that
   * decision; a `bridge.cancel()` / abort (user sent a new message, or the
   * session is being torn down) surfaces `INTERACTIVE_CANCELLED` → `dismissed`.
   */
  private async requestPermissionDecision(
    sessionId: string,
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    const managed = this.sessions.get(sessionId);
    // No live session (shouldn't happen — gate fires only for a live agent),
    // fail closed as dismissed so the tool does not execute.
    if (!managed) return 'dismissed';

    // ① 插入 pending 卡片消息（setter 赋值，与 compaction 同款）。
    managed.agent.state.messages = [
      ...managed.agent.state.messages,
      createPermissionRequestMessage(request),
    ];

    // ② 先发起 bridge 请求——它会**同步**置上 pending（Promise executor 同步执行），
    // 这样紧接着的 broadcast 才能在 pendingPermissions 里带上本次请求。若先广播
    // 再 request，那一帧 pendingPermissions 会是空的，UI 会把刚插入的卡片误判为
    // 已失效（失效判定 = toolCallId 不在活 pending 快照里）。
    const decisionPromise = managed.permissionBridge.request(request.toolCallId, request, signal);
    if (managed.sessionCreated) {
      sessionStore.scheduleWrite(sessionId, [...managed.agent.state.messages]);
    }
    this.broadcastSessionSnapshot(managed);

    // ③ 等用户在卡片上点击（或被取消 / abort）。
    const result = await decisionPromise;
    const decision: PermissionDecision =
      result === INTERACTIVE_CANCELLED ? 'dismissed' : result;

    // 会话在等待期间被销毁 / 替换：放弃回写与广播，避免复活已删会话行。
    if (this.sessions.get(sessionId) !== managed) return decision;

    // ④ 把最终决策回写到那条 pending 卡片上（按 toolCallId 定位）。
    managed.agent.state.messages = managed.agent.state.messages.map((m) =>
      isPermissionRequest(m) && m.toolCallId === request.toolCallId
        ? { ...m, decision }
        : m,
    );
    if (managed.sessionCreated) {
      sessionStore.scheduleWrite(sessionId, [...managed.agent.state.messages]);
    }
    this.broadcastSessionSnapshot(managed);

    return decision;
  }

  /**
   * Rebuild every live session's tool array from current MCP config.
   * Called when the user adds, removes, enables, disables, or edits an MCP
   * server. The agent's `state.tools` setter accepts a fresh array, so a
   * mid-run update is safe — the next assistant turn picks up the new tools.
   *
   * Sessions refresh in parallel; manager-level dedup prevents fan-out reconnects.
   */
  private async refreshAllSessionTools(): Promise<void> {
    if (this.sessions.size === 0) return;
    await Promise.allSettled(
      Array.from(this.sessions.values()).map(async (managed) => {
        try {
          const tools = await buildSessionToolArray(managed.toolCtx);
          managed.agent.state.tools = tools;
        } catch (err) {
          console.warn(`[mcp] failed to refresh tools for session ${managed.sessionId}:`, err);
        }
      }),
    );
  }

  /**
   * Acquire / release a SW keep-alive token based on whether any session
   * has active work in flight. Counts both `running` (agent streaming) and
   * `preparing` (a retry's async setup) so the SW doesn't suspend
   * mid-preparation — a suspension there would leave the session with
   * phase='preparing' but no actual work in flight, since phase is in-memory
   * state.
   *
   * Uses the shared ref-counted helper in `sw-keepalive.ts` so multiple
   * subsystems (agent runs, active recordings, ...) coexist without
   * stomping each other.
   */
  private updateKeepAlive(): void {
    const hasActive = [...this.sessions.values()].some(s => s.phase !== 'idle');
    if (hasActive && !this.keepAliveHeld) {
      this.keepAliveHeld = true;
      acquireKeepAlive();
    } else if (!hasActive && this.keepAliveHeld) {
      this.keepAliveHeld = false;
      releaseKeepAlive();
    }
  }

  /** 是否有任一会话非 idle。供自动整理调度的 idle 门控：有活跃对话则不自动整理。 */
  hasActiveSession(): boolean {
    return [...this.sessions.values()].some((s) => s.phase !== 'idle');
  }

  /**
   * 解析「本会话该用哪个模型」成 pi-ai 运行时 `Model`。读存储（凭据 + 自定义 provider）
   * 后委托纯函数 `resolveModel`。
   *
   * `identity` 是「本会话的模型身份」——来自会话行或 prompt/retry 携带值；缺省（undefined）
   * 时回退到全局 `lastSelectedModel` 充当「新对话默认种子」（向后兼容：旧消息 / 旧会话行
   * 无模型时仍能解析）。解析失败返回 null，由调用方诚实报错。
   */
  private async resolveSessionModel(
    identity?: ModelIdentity,
  ): Promise<{ model: Model<Api>; provider: string; modelId: string } | null> {
    const [globalModel, creds, customProvs] = await Promise.all([
      identity ? Promise.resolve(null) : lastSelectedModel.getValue(),
      providerCredentials.getValue(),
      customProvidersStorage.getValue(),
    ]);
    const modelCfg = identity ?? globalModel;
    if (!modelCfg) return null;

    const model = resolveModel(modelCfg, creds, customProvs ?? []);
    if (!model) return null;

    return { model, provider: modelCfg.provider, modelId: modelCfg.modelId };
  }

  /**
   * 解析压缩（摘要）该用哪个模型 + 凭证。读全局 `compactionModel` 配置：
   * - 未配置（null）→ 跟随主模型 `fallback`（默认语义）。
   * - 配置了但解析不出（模型被删 / provider 没了）或无可用凭证 → console.warn
   *   后静默回退主模型。压缩是后台增益，绝不因配错而中断本轮发送。
   *
   * 返回 `{ model, apiKey }`；apiKey 可能为 undefined（连主模型都无凭证），由
   * maybeCompact 现有的「无 key 则裸发」分支处理。
   */
  private async resolveCompactionModel(fallback: Model<Api>): Promise<CompactionTarget> {
    const configuredId = await compactionModel.getValue();
    if (configuredId) {
      const resolved = await this.resolveSessionModel(configuredId);
      if (!resolved) {
        console.warn('[compaction] configured model cannot be resolved (possibly deleted), falling back to main model', configuredId);
      } else {
        const apiKey = await resolveProviderApiKey(resolved.model.provider);
        const usable = usableCompactionTarget({ model: resolved.model, apiKey });
        if (usable) return usable;
        console.warn('[compaction] configured model has no usable credentials, falling back to main model', configuredId);
      }
    }
    // 回退主模型（未配置 / 解析失败 / 无凭证）：此刻才解析主模型凭证，避免配置可用时
    // 对主 provider 做无谓的 OAuth 刷新。
    return { model: fallback, apiKey: await resolveProviderApiKey(fallback.provider) };
  }

  /** Get or create a managed agent for a session */
  private async getOrCreateAgent(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    // Guard against concurrent creation
    const pending = this.creating.get(sessionId);
    if (pending) return pending;

    const promise = this.createAgent(sessionId);
    this.creating.set(sessionId, promise);
    try {
      const managed = await promise;
      return managed;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  /**
   * 创建并安装一个 managed 会话（每会话仅一次，由 `getOrCreateAgent` 的 `creating`
   * 去重守卫）。流程：加载会话行（本会话模型 / 思考档的真相来源）→ 解析模型 →
   * 造每会话独立工具 + 授权 bridge → 一次成形 systemPrompt → 构造 Agent → wire 订阅
   * → 入 map。
   *
   * 到达这里时会话行一定已存在：brand-new 会话的行由 prompt() 在本函数前写好（带本轮
   * 携带的选择），已有会话的行带它自己存的选择。in-place 的 retry / 切模型路径复用活
   * agent，不走这里。
   */
  private async createAgent(sessionId: string): Promise<ManagedSession> {
    // 会话行 = 本会话模型 / 思考档的真相来源。
    const existingSession = await sessionStore.load(sessionId);
    // sessionStore.load 已把历史整形回类型契约（issue #43），此处拿到的即干净数据
    const messages: AgentMessage[] = existingSession?.messages ?? [];
    const sessionCreated = !!existingSession;

    // 从会话行自己的模型身份解析（而非全局 lastSelectedModel）。行里没有可用模型（空串 /
    // 旧备份恢复来的）时传 undefined，让 resolveSessionModel 回退全局；仍解析不出则
    // throw（诚实报错，让用户重选），与 prompt / retry 三路一致。
    const sessionIdentity: ModelIdentity | undefined =
      existingSession?.provider && existingSession?.model
        ? { provider: existingSession.provider, modelId: existingSession.model }
        : undefined;
    const resolved = await this.resolveSessionModel(sessionIdentity);
    if (!resolved) throw new Error('No model selected or model not found');

    const thinkingLvl = existingSession?.thinkingLevel || (await lastSelectedThinkingLevel.getValue());

    // 每会话独立的工具 + bridge。
    const { tools: sessionTools, ctx: toolCtx } = await createSessionTools(sessionId);

    // 工具执行前授权门禁：每会话一个独立 bridge；用它构造绑定到本会话
    // `requestPermissionDecision` 的 beforeToolCall 闭包。requestDecision 在
    // gate 真正触发时才按 sessionId 反查 managed（那时一定已入 map），因此
    // 这里不构成与 agent/managed 的循环依赖。
    const permissionBridge = createInteractiveBridge<PermissionRequest, PermissionDecision>();
    const beforeToolCall = createPermissionGate(
      PERMISSION_GATES,
      (request, signal) => this.requestPermissionDecision(sessionId, request, signal),
    );

    // systemPrompt 一次成形（含 skills 索引 + 用户指令）。composeSystemPrompt 是
    // systemPrompt 的单一来源，与切模型 / retry / 派发前刷新走同一条路径，保证四处
    // 产出逐字节一致。
    const systemPrompt = await composeSystemPrompt(sessionId);

    // 档位夹到该模型支持范围：off→强制思考模型取最低支持档、超限档取上限、未知值兜底，
    // 保证实际发出的 effective 档与 ChatInput 的 displayThinkingLevel 一致
    const agent = createCebianAgent({
      model: resolved.model,
      systemPrompt,
      thinkingLevel: clampThinkingLevel(resolved.model, (thinkingLvl || 'medium') as ThinkingLevel),
      messages,
      tools: sessionTools,
      beforeToolCall,
    });

    const managed: ManagedSession = {
      agent,
      sessionId,
      sessionCreated,
      phase: 'idle',
      modelKey: `${resolved.provider}/${resolved.modelId}`,
      toolCtx,
      permissionBridge,
      unsubscribeAgent: () => {},
      streamDeltaCount: 0,
      streamStartedAt: 0,
      llmRequestStartedAt: 0,
      llmFirstTokenAt: 0,
      llmRounds: 0,
    };
    this.wireSubscriptions(managed);
    this.sessions.set(sessionId, managed);
    return managed;
  }

  /**
   * Wire agent + toolCtx event subscriptions into a managed session.
   *
   * Only ever called once per entry, from `createAgent` — the in-place
   * retry / model-switch paths reuse the live agent and toolCtx, so there is
   * no re-wiring. The toolCtx listener is intentionally fire-and-forget:
   * every teardown path (`cancel`, `destroySession`) calls `toolCtx.dispose()`,
   * which clears its listeners, so we don't keep a separate unsubscribe handle
   * for it. The agent listener does keep `unsubscribeAgent` because teardown
   * detaches it explicitly before disposing.
   *
   * The subscription callbacks close over `managed`, so the agent / toolCtx
   * fields stay reachable as the object's own properties — there is no stale
   * closure problem.
   */
  private wireSubscriptions(managed: ManagedSession): void {
    managed.unsubscribeAgent = managed.agent.subscribe(async (event: AgentEvent) => {
      await this.handleAgentEvent(managed, event);
    });
    managed.toolCtx.subscribe((toolName, pending) => {
      if (pending) {
        const args = pending.request as Record<string, unknown> | undefined;
        const argsSize = args ? safeStringifySize(args) : 0;
        debugLog.info('tool', 'tool:dispatch', withSession({
          toolName,
          toolCallId: pending.toolCallId,
          argsKeys: args ? Object.keys(args) : [],
          argsSize,
        }, managed.sessionId));
        this.broadcast(managed.sessionId, {
          type: 'tool_pending',
          sessionId: managed.sessionId,
          toolName,
          toolCallId: pending.toolCallId,
          args: pending.request,
        });
      } else {
        // toolCtx.subscribe fires with pending=null on both resolve() and
        // cancel(); the InteractiveBridge doesn't expose which one happened
        // via the callback signature, so we can't tell apart "user answered"
        // from "user bypassed/cancelled" without extra plumbing. The agent
        // will surface tool errors as separate AgentEvent 'tool_resolved'
        // variants downstream, so the resultSize is best-effort (0 here).
        // `ok: true` reflects "the request cycle completed normally" —
        // downstream `recv:tool_failed` events capture actual tool errors.
        debugLog.info('tool', 'tool:resolved', withSession({
          toolName,
          ok: true,
          resultSize: 0,
        }, managed.sessionId));
        this.broadcast(managed.sessionId, {
          type: 'tool_resolved',
          sessionId: managed.sessionId,
          toolName,
        });
      }
    });
  }

  private async handleAgentEvent(managed: ManagedSession, event: AgentEvent): Promise<void> {
    const { sessionId, agent } = managed;

    // Emit type-aware variants for the most-queried AgentEvent boundaries
    // so log filters can target a single transition by message prefix instead
    // of grepping JSON-stringified payloads from the generic `event:${type}`
    // log below. The generic entry still fires for backward compat and for
    // events that don't have a dedicated variant.
    //
    // Note: tool_pending / tool_resolved live on the toolCtx subscription
    // (not AgentEvent), so their type-aware logs are added there below.
    switch (event.type) {
      case 'message_start': {
        const start = event as Extract<AgentEvent, { type: 'message_start' }>;
        debugLog.info('stream', 'message:start', withSession({
          role: start.message?.role ?? 'unknown',
        }, sessionId));
        // Reset streaming counter at the start of each new assistant message
        // so progress rows are scoped to the current stream, not cumulative
        // across multiple messages in one turn.
        if (start.message?.role === 'assistant') {
          managed.streamDeltaCount = 0;
          managed.streamStartedAt = Date.now();
          // LLM latency marker: first assistant message_start is the
          // user-visible TTFT. Only fire on the FIRST message in this turn
          // (a turn can have multiple assistant messages when tool calls
          // happen — we only care about the first one for TTFT, subsequent
          // ones are tool-round continuations).
          if (managed.llmRequestStartedAt > 0 && managed.llmFirstTokenAt === 0) {
            managed.llmFirstTokenAt = Date.now();
            const ttftMs = managed.llmFirstTokenAt - managed.llmRequestStartedAt;
            debugLog.info('llm', 'llm:request:first_token', withSession({
              ttftMs,
              round: managed.llmRounds + 1,
            }, sessionId));
            managed.llmRounds += 1;
          }
        }
        break;
      }
      case 'agent_start':
        debugLog.info('stream', 'agent:start', withSession({
          msgsLen: agent.state.messages.length,
        }, sessionId));
        // LLM latency marker: marks the moment we hand control to the model.
        // Paired with `llm:request:first_token` (on first assistant message)
        // and `llm:request:end` (on agent_end) so we can compute time-to-
        // first-token (TTFT) and total request duration from the log alone.
        managed.llmRequestStartedAt = Date.now();
        debugLog.info('llm', 'llm:request:start', withSession({
          modelKey: managed.modelKey,
          msgsLen: agent.state.messages.length,
        }, sessionId));
        break;
      case 'agent_end': {
        const end = event as Extract<AgentEvent, { type: 'agent_end' }>;
        const ok = !(end as { error?: unknown }).error;
        debugLog.info('stream', 'agent:end', withSession({
          ok,
          msgsLen: agent.state.messages.length,
        }, sessionId));
        // LLM latency marker: end of the entire LLM request (after any tool
        // rounds inside the turn). `totalDurationMs` covers thinking + tool
        // execution + streaming. `tokensCount` is the cumulative delta count
        // for the assistant messages in this turn. `ttftMs` is the wall-clock
        // from request start to the first assistant message_start (the most
        // user-visible latency — "how long until I see the first character").
        if (managed.llmRequestStartedAt > 0) {
          const totalDurationMs = Date.now() - managed.llmRequestStartedAt;
          debugLog.info('llm', 'llm:request:end', withSession({
            ok,
            totalDurationMs,
            ttftMs: managed.llmFirstTokenAt > 0
              ? managed.llmFirstTokenAt - managed.llmRequestStartedAt
              : null,
            tokensCount: managed.streamDeltaCount,
            rounds: managed.llmRounds,
          }, sessionId));
          // Reset markers so the next turn starts clean.
          managed.llmRequestStartedAt = 0;
          managed.llmFirstTokenAt = 0;
          managed.llmRounds = 0;
        }
        break;
      }
      case 'tool_execution_start': {
        // Tool execution boundary (from pi-agent-core). We log tool name +
        // arg sizes only — never the args themselves (they can carry file
        // paths, URLs, partial prompts). Pairs with `tool_execution_end`
        // below for timing.
        const te = event as Extract<AgentEvent, { type: 'tool_execution_start' }> & {
          toolCallId?: string;
          toolName?: string;
          args?: unknown;
        };
        debugLog.info('tool', 'tool:exec:start', withSession({
          toolName: te.toolName ?? 'unknown',
          toolCallId: te.toolCallId ?? null,
          argsSize: safeStringifySize(te.args),
        }, sessionId));
        break;
      }
      case 'tool_execution_end': {
        const te = event as Extract<AgentEvent, { type: 'tool_execution_end' }> & {
          toolCallId?: string;
          toolName?: string;
          result?: unknown;
          isError?: boolean;
        };
        debugLog.info('tool', 'tool:exec:end', withSession({
          toolName: te.toolName ?? 'unknown',
          toolCallId: te.toolCallId ?? null,
          resultSize: safeStringifySize(te.result),
          isError: !!te.isError,
        }, sessionId));
        break;
      }
      // 'message_update' is intentionally not variant-logged — per-token
      // events are filtered by NOISY_PREFIXES in the debug-log layer.
    }

    debugLog.info('agent', `event:${event.type}`, {
      sessionId,
      msgsLen: agent.state.messages.length,
      lastRole: agent.state.messages.at(-1)?.role,
      lastStopReason: (agent.state.messages.at(-1) as { stopReason?: string } | undefined)?.stopReason,
      phase: managed.phase,
    });

    switch (event.type) {
      case 'agent_start':
        // Any path that calls `agent.continue()` / `agent.prompt()` ends up
        // here — including retry, which leaves phase='preparing' until this
        // event flips it forward to 'running'. Direct prompt() entries go
        // 'idle' → 'running'; both transitions are valid and collapse to a
        // single line.
        //
        // 状态机硬约束：进入 running 的唯一入口就是本事件，且只能从
        // preparing / idle 前进（preparing → running 单向不可逆）。其他
        // 任何地方不准手动置 running；这里断言锁死方向。
        if (managed.phase !== 'preparing' && managed.phase !== 'idle') {
          console.warn(
            `[agent-manager] agent_start from unexpected phase '${managed.phase}' for ${sessionId}`,
          );
        }
        managed.phase = 'running';
        this.broadcast(sessionId, { type: 'agent_start', sessionId });
        this.updateKeepAlive();
        break;

      case 'message_update':
        if (event.message.role === 'assistant') {
          // Count text_delta events to surface streaming throughput without
          // per-token log spam. Each delta is one or a few tokens; we
          // emit `stream:progress` every STREAM_DELTA_LOG_THRESHOLD tokens
          // so a 500-token reply produces ~10 progress rows instead of 500.
          // The `recv:message_update` per-token log is filtered by the
          // NOISY_PREFIXES rule at the debug-log layer; this counter is
          // the summary view that survives that filter.
          const ame = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
            .assistantMessageEvent;
          if (ame?.type === 'text_delta') {
            managed.streamDeltaCount += 1;
            if (managed.streamDeltaCount % STREAM_DELTA_LOG_THRESHOLD === 0) {
              const durationMs = Date.now() - managed.streamStartedAt;
              debugLog.info('stream', 'stream:progress', withSession({
                deltas: managed.streamDeltaCount,
                tokensPerSec: durationMs > 0
                  ? Math.round((managed.streamDeltaCount / durationMs) * 1000)
                  : 0,
                durationMs,
              }, sessionId));
            }
          }
          this.broadcast(sessionId, {
            type: 'message_update',
            sessionId,
            message: event.message,
          });
        }
        break;

      case 'message_end': {
        const messages = [...agent.state.messages];
        this.broadcast(sessionId, { type: 'message_end', sessionId, messages });
        // Emit a final progress summary on message_end for the assistant
        // stream so the log always shows the closing delta count, even when
        // the total was under STREAM_DELTA_LOG_THRESHOLD. Skip user/tool
        // messages — they don't accumulate text_delta events.
        const lastMessage = messages.at(-1);
        if (lastMessage?.role === 'assistant' && managed.streamDeltaCount > 0) {
          const durationMs = Date.now() - managed.streamStartedAt;
          debugLog.info('stream', 'stream:progress:done', withSession({
            deltas: managed.streamDeltaCount,
            tokensPerSec: durationMs > 0
              ? Math.round((managed.streamDeltaCount / durationMs) * 1000)
              : 0,
            durationMs,
          }, sessionId));
        }
        if (managed.sessionCreated) {
          sessionStore.scheduleWrite(sessionId, messages);
        }
        break;
      }

      case 'agent_end': {
        managed.phase = 'idle';
        this.updateKeepAlive();
        // Cancel any pending interactive tools on this session
        managed.toolCtx.cancelAll();
        // 同理取消在途的授权请求（→ dismissed），否则 run 结束后 gate 还在
        // await 一个永不到来的点击。
        managed.permissionBridge.cancel();
        const messages = [...agent.state.messages];
        this.broadcast(sessionId, { type: 'agent_end', sessionId, messages });
        // Persist final state before flushing. Normally the trailing
        // `message_end` already scheduled a write with the same content,
        // but pi-agent-core's `handleRunFailure` (abort/error path) appends
        // a synthetic assistant marker straight to `state.messages` and
        // fires `agent_end` without a preceding `message_end` — so without
        // this schedule the marker reaches subscribed clients via the
        // broadcast above but never lands in DB, and disappears on the
        // next cold-load. The scheduler is idempotent for unchanged
        // content so this is safe to call unconditionally on every
        // agent_end.
        if (managed.sessionCreated) {
          sessionStore.scheduleWrite(sessionId, messages);
        }
        await sessionStore.flush(sessionId);
        break;
      }
    }
  }

  /** Send a prompt to the agent for a session.
   *
   *  `turn` 是页面随本条消息携带的「本次发送所用的模型 / 思考档」——属于该会话
   *  的选择。新会话据它建行；已有会话据它就地刷新活 agent 并落库到会话行（会话
   *  行是真相）。缺省时回退全局 lastSelectedModel 充当「新对话默认种子」（向后兼容）。 */
  async prompt(
    sessionId: string,
    text: string,
    attachments: Attachment[] = [],
    turn?: TurnSettings,
  ): Promise<void> {
    const dispatchStartedAt = performance.now();
    let dispatchOk = false;
    debugLog.info('agent', 'dispatch_prompt',
      withSession({ textLen: text.length, attachmentsLen: attachments.length }, sessionId));
    try {
      // Persist + broadcast 'session_created' for brand-new sessions BEFORE any
      // agent setup work (model resolve, tool factory, MCP, createAgent — easily
      // several hundred ms). Without this the UI stays on /chat/new with an empty
      // title and a no-op "new chat" button until the first agent_start arrives.
    //
    // Detection: not in the live sessions map AND no DB record. The DB record
    // we write here is what getOrCreateAgent's sessionStore.load() will find,
    // so `managed.sessionCreated` is set to true by createAgent() naturally,
    // and we don't need a second persist-and-broadcast inside this method.
    if (!this.sessions.has(sessionId)) {
      const existing = await sessionStore.load(sessionId);
      if (!existing) {
        const [globalModel, instructions, globalThinking] = await Promise.all([
          lastSelectedModel.getValue(),
          userInstructionsStorage.getValue(),
          lastSelectedThinkingLevel.getValue(),
        ]);
        // 建行用本轮携带的 turn；缺省回退全局种子。模型仍为空则拒绝建行
        // （否则后续 getOrCreateAgent 会 throw，留下一条空模型的孤儿会话行）。
        const modelCfg = turn?.model ?? globalModel;
        const thinkingLvl = turn?.thinkingLevel ?? globalThinking;
        if (!modelCfg) {
          throw new Error('No model selected or model not found');
        }
        const trimmed = text.trim();
        const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
        const session: SessionRecord = {
          id: sessionId,
          title: title || t('common.newChat'),
          model: modelCfg.modelId,
          provider: modelCfg.provider,
          userInstructions: instructions || '',
          thinkingLevel: thinkingLvl || 'medium',
          messageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        };
        try {
          await sessionStore.create(session);
          debugLog.info('agent', 'session:created:dispatch', { sessionId });
          this.broadcast(sessionId, {
            type: 'session_created',
            sessionId,
            title: session.title,
          });
        } catch (err: any) {
          // Race: another concurrent prompt() for the same brand-new id won
          // the create. Re-throw anything that isn't a duplicate-key violation;
          // the winning call has already broadcast 'session_created'.
          if (err?.name !== 'ConstraintError') throw err;
        }
      }
    }

    const managed = await this.getOrCreateAgent(sessionId);
    debugLog.info('agent', 'prompt:entry', {
      sessionId,
      phase: managed.phase,
      msgsLen: managed.agent.state.messages.length,
      lastRole: managed.agent.state.messages.at(-1)?.role,
      lastStopReason: (managed.agent.state.messages.at(-1) as { stopReason?: string } | undefined)?.stopReason,
      textLen: text.length,
    });

    if (managed.phase !== 'idle') {
      // Preparing (retry / model-switch setup), compacting, or running.
      // The UI gates the composer to prevent concurrent prompts, but a stale
      // or out-of-order IPC could still arrive — dispatching a fresh turn
      // now would race the in-flight `continue()` / compaction / streaming
      // and corrupt the phase machine. Silently dropping matches `retry()`'s
      // phase-guard pattern; the in-flight work's broadcasts reconcile every
      // subscribed window to the correct state.
      console.debug('[agent-manager] prompt: phase busy, ignored', sessionId, managed.phase);
      return;
    }

    // 模型 / 思考档切换检测：以本轮携带的 turn 为准（而非全局）。model 与
    // thinkingLevel 在协议里各自可选，故分别判断、分别落库——只要任一项变了就刷新活
    // agent 并把变的字段写回会话行（会话行是真相）。turn 缺省（旧客户端不带）时整段
    // 跳过，活 agent 保持会话选择不动。
    if (turn) {
      const turnKey = turn.model
        ? `${turn.model.provider}/${turn.model.modelId}`
        : null;
      const modelChanged = turnKey != null && turnKey !== managed.modelKey;
      if (modelChanged) {
        // 就地刷新活 agent。与 retry 不同，这里没有 resume/cancel 窗口：换字段是同步
        // 赋值，下面正常派发会触发 agent_start，故不进 preparing、不挂 controller。
        // `resolveSessionModel` 按 turn 身份解析（自定义 provider 查表 / copilot OAuth
        // baseUrl / openrouter 头一致）。解析失败（模型被删 / 凭据被并行 tab 拔掉）则
        // throw，与 createAgent / retry 三路一致地诚实报错。
        const resolved = await this.resolveSessionModel(turn.model);
        if (!resolved) throw new Error('No model selected or model not found');
        managed.agent.state.model = resolved.model;
        managed.modelKey = turnKey!;
      }
      // 思考档：把 turn 携带的原始偏好对（可能刚换的）当前模型夹成 effective 档，只有
      // effective 变了才更新 + 落库。这样「只换模型、档位没跟着换但新模型不支持现档」也会
      // 重夹（如切到强制思考模型，off→最低支持档）；而原始 'max' 在只到 'high' 的模型上夹成
      // 'high' 不算变化，避免每轮空写。落库写已夹的 effective 档；原始高档偏好留在全局种子，
      // 各读取点（createAgent / seedTurnFromSession）都会再按模型 clamp
      const nextThinking = turn.thinkingLevel != null
        ? clampThinkingLevel(managed.agent.state.model, turn.thinkingLevel)
        : null;
      const thinkingChanged = nextThinking != null && nextThinking !== managed.agent.state.thinkingLevel;
      if (thinkingChanged) {
        managed.agent.state.thinkingLevel = nextThinking!;
      }
      // 落库到会话行——会话行是真相来源。只写变了的字段；全都没变则不调 updateSettings。
      if (managed.sessionCreated && (modelChanged || thinkingChanged)) {
        await sessionStore.updateSettings(sessionId, {
          provider: modelChanged ? turn.model!.provider : undefined,
          model: modelChanged ? turn.model!.modelId : undefined,
          thinkingLevel: thinkingChanged ? managed.agent.state.thinkingLevel : undefined,
        });
      }
    }

    // 本轮记忆开关的单一快照：同时喂给 user 消息注入与 system prompt 刷新，
    // 保证一轮内两处读同一个值（原子门控，避免读到两个快照而前后不一致）。
    const memoryEnabled = (await memorySettings.getValue()).enabled;
    const enriched = await composeUserMessage(text, attachments, memoryEnabled);

    const images = extractImages(attachments);

    // Liveness guard. Everything from `getOrCreateAgent` down to the dispatch
    // below runs while `phase === 'idle'` (model resolve, settings reads,
    // `composeUserMessage` — the latter can be slow for image
    // attachments). A `cancel()` landing in that window takes its idle
    // teardown branch (abort + dispose + `sessions.delete`), leaving `managed`
    // detached. Dispatching now would steer/prompt a disposed agent, waste an
    // API call, and let `maybeCompact`'s persist resurrect the deleted row.
    // If the entry is gone (or was replaced), the user already stopped this
    // turn — bail; `cancel()` already broadcast the authoritative end state.
    if (this.sessions.get(sessionId) !== managed) return;

    const refreshedSystemPrompt = await composeSystemPrompt(sessionId, memoryEnabled);
    if (this.sessions.get(sessionId) !== managed) return;
    managed.agent.state.systemPrompt = refreshedSystemPrompt;

    // If any interactive tool OR a permission prompt is pending, the agent is
    // paused waiting for the user — steer the new message into the loop and
    // cancel the pending prompt instead of starting a fresh turn. A cancelled
    // permission prompt surfaces as `dismissed` (implicit non-grant), which
    // blocks the gated tool; the steered message then drives the next turn.
    if (managed.toolCtx.hasPending() || managed.permissionBridge.getPending()) {
      const content: any[] = [{ type: 'text', text: enriched }];
      if (images.length > 0) content.push(...images);
      const userMessage: AgentMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
      } as AgentMessage;
      // Enqueue BEFORE cancelling so getSteeringMessages() sees it when the loop drains.
      managed.agent.steer(userMessage);
      managed.toolCtx.cancelAll();
      managed.permissionBridge.cancel();
    } else {
      // 构造本轮「待投递」的用户消息，形状对齐 steering 分支。压缩成功路径不会
      // 用它（由 agent.prompt() 自行 append 真实用户消息），它只用于压缩期间的
      // 广播展示，以及压缩中取消时补进 state 充当「已取消」前的那条用户气泡。
      const pendingContent: any[] = [{ type: 'text', text: enriched }];
      if (images.length > 0) pendingContent.push(...images);
      const pendingUserMessage: AgentMessage = {
        role: 'user',
        content: pendingContent,
        timestamp: Date.now(),
      } as AgentMessage;

      // Before a fresh turn, compact the transcript if the context is over
      // threshold (state layer: generate + insert summary + persist +
      // broadcast). Gated on `phase === 'idle'`: a stale prompt arriving
      // mid-run (phase 'running', no pending tool) must NOT enter compaction
      // and clobber the phase machine — compaction is strictly a
      // start-of-turn step. Returns true iff the compaction was cancelled
      // mid-flight, in which case the user's stop click means we abandon this
      // turn and don't dispatch to the model.
      if (managed.phase === 'idle') {
        const cancelled = await this.maybeCompact(managed, pendingUserMessage);
        if (cancelled) return;
      }

      // Drop a trailing synthetic `assistant{aborted}` marker left behind by
      // pi-agent-core's `handleRunFailure` after a cancel. Without this, the
      // new user message would be appended onto `[..., user, assistant{stopReason:
      // 'aborted'}]` and sent to the provider; some providers (notably
      // Gemini) reject the empty aborted assistant turn and silently return
      // an empty response. Crucially, only the marker itself is dropped —
      // everything earlier in the transcript (including the previous turn's
      // real assistant text / tool calls / tool results) is preserved so the
      // user sees their full conversation history, not a partial slice.
      const msgs = managed.agent.state.messages as Array<{ role: string; stopReason?: string }>;
      if (msgs.length > 0) {
        const last = msgs[msgs.length - 1]!;
        if (last.role === 'assistant' && last.stopReason === 'aborted') {
          debugLog.info('agent', 'prompt:drop-aborted-marker', { sessionId });
          msgs.pop();
        }
      }
      debugLog.info('agent', 'prompt:dispatch', { sessionId, msgsLen: managed.agent.state.messages.length });
      await managed.agent.prompt(enriched, images.length > 0 ? images : undefined);
      debugLog.info('agent', 'prompt:done', { sessionId, msgsLen: managed.agent.state.messages.length });
      dispatchOk = true;
    }
    } finally {
      debugLog.info('agent', 'dispatch_prompt:done',
        withSession({ ok: dispatchOk, durationMs: performance.now() - dispatchStartedAt }, sessionId));
    }
  }

  /**
   * Compact the session transcript before a fresh turn when the context
   * exceeds the configured threshold.
   *
   * Lossless design: the original messages stay in
   * `agent.state.messages` forever — we only *insert* a `compactionSummary`
   * marker at a turn-start boundary. The LLM-facing fold (keep only the last
   * summary + everything after it) happens later in `transformContext`; this
   * method never drops history.
   *
   * Flow:
   * 1. Estimate context tokens (last assistant `usage.totalTokens` +
   *    trailing char/4) and bail if under threshold.
   * 2. Find a cut point aligned to a user turn-start (excludes toolResult
   *    mid-turn — this is the root-cause fix for issue #9's orphan toolResult
   *    → provider 400).
   * 3. Roll the summary: the summarized region is the delta *since the
   *    last summary*, and the previous summary text is fed to `generateSummary`
   *    as `previousSummary` for an UPDATE-style merge. Multiple summaries
   *    accumulate physically; `transformContext` only ever sends the last one.
   * 4. On success, splice the new summary right before the cut user message
   *    and persist. On failure (after one internal retry), skip the
   *    summary and send anyway — the turn-start-aligned cut guarantees no 400.
   *
   * Concurrency: runs under `phase === 'compacting'` with a dedicated
   * `compactionController`. `cancel()` aborts it; the top-of-`prompt()` guard
   * drops concurrent prompts. Keep-alive is held automatically because
   * `phase !== 'idle'`.
   *
   * @param pendingUserMessage 本轮「待投递」的用户消息。压缩成功不消费它；压缩中
   *        被取消时由 `commitCompactionCancel` 把它连同 aborted 标记补进 state，
   *        使取消后界面与普通取消一致（用户气泡 + 「已取消」）。
   * @returns `true` iff the compaction was cancelled and the caller should
   *          abandon the turn; `false` otherwise (no-op skip or success).
   */
  private async maybeCompact(managed: ManagedSession, pendingUserMessage: AgentMessage): Promise<boolean> {
    if (!COMPACTION_SETTINGS.enabled) return false;

    const { sessionId } = managed;
    // 估算 / 切点 / 摘要 / 回写都基于这份消息：先整形回类型契约（null text/thinking/name
    // → ''），否则 estimateContextTokens / findCompactionCutPoint 对 assistant 块取 .length
    // 会崩（issue #43）。copy-on-write：无坏数据时返回同一引用、零分配（仅一次线性扫描）；
    // 有坏数据时顺带把治好的版本随摘要回写进 state
    const messages = sanitizeAgentMessages(managed.agent.state.messages);
    const model = managed.agent.state.model;

    // token 估算：优先读最后一条 assistant 的真实 usage，尾部按 char/4 估算。
    const { tokens } = estimateContextTokens(messages);
    if (!shouldCompact(tokens, model.contextWindow, COMPACTION_SETTINGS)) return false;

    // 切点对齐到 user turn-start（排除 toolResult 中间），修 issue #9。
    const cut = findCompactionCutPoint(messages, COMPACTION_SETTINGS.keepRecentTokens);

    // 滚动摘要：定位上一条摘要，待摘要区间是「上一条摘要之后 → 新切点」的增量
    //（更早的历史已被旧摘要覆盖，无需重复总结），旧摘要文本作为 previousSummary
    // 喂给 generateSummary 做 UPDATE 合并。
    let lastSummaryIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isCompactionSummary(messages[i])) {
        lastSummaryIdx = i;
        break;
      }
    }
    // baseIdx：上一条摘要之后的起点；为 0 表示尚无摘要。
    const baseIdx = lastSummaryIdx + 1;

    // 切点未越过「上一条摘要之后」→ 自上次压缩以来没有新的可摘要历史，跳过。
    if (cut <= baseIdx) return false;

    // 进入 compacting 阶段：占用非 idle 状态（自动保活 + 阻止并发 prompt）。
    // 这一步在「任何 await 之前」同步完成，把可取消的忙碌态原子地占住——否则在
    // 解析 apiKey 的 await 窗口里若发生 cancel，会落进 idle 分支拆掉会话，导致
    // 本方法事后往已删除的会话写入并广播（评审指出的竞态）。
    managed.phase = 'compacting';
    managed.compactionController = new AbortController();
    const signal = managed.compactionController.signal;
    this.updateKeepAlive();
    this.broadcast(sessionId, {
      type: 'session_state',
      sessionId,
      // 带上待投递的用户消息，压缩期间用户气泡保持可见（前端 session_state 全量
      // 替换，不带就会冲掉乐观插入的气泡）。
      messages: [...messages, pendingUserMessage],
      isRunning: true,
      isCompacting: true,
      pendingTools: [],
    });

    try {
      // 解析压缩模型：配置了专用小模型且凭证可用就用它，否则回退主模型（静默）。
      const { model: compactModel, apiKey } = await this.resolveCompactionModel(model);
      // 取消优先：解析期间被 cancel，丢弃压缩并让调用方放弃本轮。
      if (signal.aborted) return await this.commitCompactionCancel(managed, pendingUserMessage);
      // 无凭证无法发起独立的摘要请求，本轮裸发、下一轮再尝试压缩（不致 400：
      // transformContext 仍会带上已有的最后一条摘要）。
      if (!apiKey) return false;

      const previousSummary =
        lastSummaryIdx >= 0
          ? (messages[lastSummaryIdx] as CompactionSummaryMessage).summary
          : undefined;
      const messagesToSummarize = messages.slice(baseIdx, cut);

      const summary = await runCompaction({
        messagesToSummarize,
        model: compactModel,
        apiKey,
        previousSummary,
        signal,
        thinkingLevel: managed.agent.state.thinkingLevel,
        sessionId: managed.sessionId,
      });

      // 取消：丢弃这次压缩，不插摘要，并通知调用方放弃本轮发送。
      if (signal.aborted) return await this.commitCompactionCancel(managed, pendingUserMessage);

      if (summary) {
        // 在切点首条 user 之前插入摘要（不变式：摘要紧贴 user turn-start，
        // 保证 truncateForRetry 与 transformContext 无需特判）。原始消息全保留。
        const updated = [
          ...messages.slice(0, cut),
          createCompactionSummaryMessage(summary, tokens),
          ...messages.slice(cut),
        ];
        managed.agent.state.messages = updated;
        if (managed.sessionCreated) {
          sessionStore.scheduleWrite(sessionId, updated);
          await sessionStore.flush(sessionId);
        }
        this.broadcast(sessionId, {
          type: 'session_state',
          sessionId,
          // 同样带上待投递的用户消息，避免摘要插入后到 agent.prompt() 之间
          // 这一帧用户气泡闪掉。agent.prompt() 随后会 append 真实的同内容消息。
          messages: [...updated, pendingUserMessage],
          isRunning: true,
          isCompacting: true,
          pendingTools: [],
        });
      }
      // summary 为 null → 降级：runCompaction 内部已重试一次，这里不插摘要、
      // 照常发送。findCompactionCutPoint 的 turn-start 对齐保证不会 400。
      return false;
    } finally {
      managed.compactionController = undefined;
      // 若仍停在 compacting（未被其他路径推进），复位回 idle。
      if (managed.phase === 'compacting') {
        managed.phase = 'idle';
        this.updateKeepAlive();
      }
    }
  }

  /**
   * 压缩中被取消的收尾。压缩跑在 `agent.prompt()` 之前，本轮用户消息此刻还没进
   * `state.messages`——若直接丢弃，取消后这条消息会凭空消失。这里手动把它连同一条
   * aborted 标记补进 state、持久化并广播，使取消后界面与普通运行中取消一致：
   * 用户气泡保留 + 一行灰斜体「已取消」。
   *
   * 复用 `buildAbortedMarker` 造与 pi-agent-core `handleRunFailure` 同形状的标记，
   * 前端 `stopReason === 'aborted'` 的渲染规则一条通吃。
   *
   * 若会话已被 `destroySession` 移除（它也会 abort 同一个 controller），静默退出，
   * 不持久化/广播，避免复活刚删掉的会话行。
   *
   * @returns 恒为 `true` —— 调用方据此放弃本轮发送。
   */
  private async commitCompactionCancel(
    managed: ManagedSession,
    pendingUserMessage: AgentMessage,
  ): Promise<true> {
    const { sessionId } = managed;
    // destroySession 先 abort 再从 map 移除；命中这里说明是销毁而非用户取消，静默退出。
    if (!this.sessions.has(sessionId)) return true;

    const finalMessages: AgentMessage[] = [
      ...managed.agent.state.messages,
      pendingUserMessage,
      this.buildAbortedMarker(managed),
    ];
    // 同步内存态，否则下一轮 prompt 会基于缺这两条的旧 state 续写并覆盖 DB。
    managed.agent.state.messages = finalMessages;

    if (managed.sessionCreated) {
      sessionStore.scheduleWrite(sessionId, finalMessages);
      try {
        await sessionStore.flush(sessionId);
      } catch (err) {
        console.warn(`[agent-manager] flush on compaction cancel failed for ${sessionId}:`, err);
        // 继续广播——DB 落后可恢复，不该把停止按钮卡在界面上。
      }
    }

    this.broadcast(sessionId, {
      type: 'session_state',
      sessionId,
      messages: finalMessages,
      isRunning: false,
      isCompacting: false,
      pendingTools: [],
    });
    return true;
  }

  /**
   * Fork the source session at the assistant message at `atAssistantIndex`.
   * The new `SessionRecord` is seeded with ONLY that assistant bubble
   * (no user message, no prior turns) — the branch point is the response,
   * not the question. The user then types a new message in the new session
   * and the agent continues from there with the assistant bubble as context.
   *
   * The source session is untouched — its agent (if any) keeps running,
   * the BG keeps serving subscribers, etc. The fork is a pure copy.
   *
   * Title is taken from the user message that triggered this assistant
   * turn (walked back in `source.messages`) so the new session has a
   * meaningful label in HistoryPanel. The trigger user bubble does NOT
   * appear in the new session's messages — only the assistant response
   * does.
   *
   * Returns the new session id + title (callers use it to notify the
   * sidepanel that initiated the fork). Does NOT broadcast — the typical
   * `broadcast()` filter is keyed on the requesting port's subscribed
   * session, which is the source, not the new fork. The caller routes
   * `session_created` to the right port(s) explicitly. Throws if the
   * source row can't be loaded, or if `atAssistantIndex` points at a
   * non-assistant message.
   */
  async forkSession(
    sourceSessionId: string,
    atAssistantIndex: number,
  ): Promise<{ newSessionId: string; title: string }> {
    const startedAt = performance.now();
    debugLog.info('agent', 'fork:entry',
      withSession({ atAssistantIndex, sourceMsgsLen: -1 }, sourceSessionId));
    // Flush the source session before reading: the sidepanel may click
    // "fork" right after the LLM finishes streaming, when the React state
    // shows the just-finished assistant bubble (idx = N) but the throttled
    // session writer hasn't committed it to Dexie yet. Without this flush,
    // `sessionStore.load` returns a row missing the tail bubble(s) and the
    // user-passed index falls off the end → "not an assistant message"
    // error. Flushing first forces a sync write so the row reflects what
    // the user actually sees.
    await sessionStore.flush(sourceSessionId);
    const source = await sessionStore.load(sourceSessionId);
    if (!source) {
      debugLog.error('agent', 'fork:fail:source-not-found',
        withSession({ atAssistantIndex }, sourceSessionId));
      throw new Error(`forkSession: source session ${sourceSessionId} not found`);
    }
    // Re-log entry now that we know the source length — keeps a single
    // timeline point per fork so we can correlate dispatch → load.
    debugLog.info('agent', 'fork:loaded-source',
      withSession({ atAssistantIndex, sourceMsgsLen: source.messages.length }, sourceSessionId));
    if (
      atAssistantIndex < 0
      || atAssistantIndex >= source.messages.length
      || source.messages[atAssistantIndex].role !== 'assistant'
    ) {
      debugLog.error('agent', 'fork:fail:bad-index',
        withSession({
          atAssistantIndex,
          sourceMsgsLen: source.messages.length,
          actualRole: source.messages[atAssistantIndex]?.role ?? 'undefined',
        }, sourceSessionId));
      throw new Error(`forkSession: atAssistantIndex ${atAssistantIndex} is not an assistant message`);
    }
    // New session chỉ chứa duy nhất assistant bubble được chọn — không kèm
    // user bubble hay các turn trước đó. Branch point = response, không phải
    // question. User sẽ gõ message mới; agent coi assistant bubble làm context.
    const slice = source.messages.slice(atAssistantIndex, atAssistantIndex + 1);

    // Title vẫn lấy từ user message đã trigger turn này (walk back trong
    // source.messages) để HistoryPanel có label có nghĩa. User bubble
    // không nằm trong new session.messages — chỉ dùng cho title.
    let triggerContent = '';
    for (let i = atAssistantIndex - 1; i >= 0; i--) {
      if (source.messages[i].role === 'user') {
        triggerContent = extractUserText(source.messages[i] as Message);
        break;
      }
    }
    const trimmed = triggerContent.trim();
    const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '')
      || source.title
      || t('common.newChat');

    const newSessionId = crypto.randomUUID();
    const now = Date.now();
    const forked: SessionRecord = {
      id: newSessionId,
      title,
      model: source.model,
      provider: source.provider,
      userInstructions: source.userInstructions,
      thinkingLevel: source.thinkingLevel,
      messageCount: slice.length,
      createdAt: now,
      updatedAt: now,
      messages: slice,
      // Snapshot source identity so the sidepanel can render a "Forked from:
      // <title>" badge with a back link even if the source is later edited or
      // deleted. Title is taken from source.title (the current display title),
      // not from the trigger message, so the badge matches what the user sees
      // in HistoryPanel for the source.
      forkedFrom: { sessionId: source.id, title: source.title },
      // Remember which assistant bubble in the source this branch was forked
      // from, so navigating back via the badge scrolls the source back to
      // the same message instead of dropping the user at the bottom of the
      // (now likely empty) source.
      forkedAtIndex: atAssistantIndex,
    };
    await sessionStore.create(forked);
    // NOTE: deliberately not calling `this.broadcast(...)` here. `broadcast`
    // filters ports by `subscribedSession === sessionId`, so passing the
    // new fork id would skip every port that's still on the source.
    // The port handler in `entrypoints/background/index.ts` is responsible
    // for routing `session_created` to the right port(s).
    debugLog.info('agent', 'fork:done',
      withSession({
        atAssistantIndex,
        newSessionId,
        title,
        sliceLen: slice.length,
        durationMs: Math.round(performance.now() - startedAt),
      }, sourceSessionId));
    return { newSessionId, title };
  }

  /**
   * Re-run the last user turn for a session.
   *
   * Drops trailing assistant / toolResult messages after the most recent
   * user message and resumes the agent loop from there. Used by the chat
   * UI's "Retry" button — covers both genuine failures (`stopReason: 'error'`)
   * and successful turns the user is unhappy with.
   *
   * # In-place refresh (no rebuild)
   *
   * The live agent is reused as-is. We truncate, then refresh the mutable
   * `state.messages` / `model` / `thinkingLevel` / `systemPrompt` fields in
   * place to pick up any settings the user changed while idle, then call
   * `continue()`. Tools are kept current by `refreshAllSessionTools` (MCP
   * changes), so they're not touched here. Because the agent is never torn
   * down, a `cancel()` racing this flow always finds a live agent — this is
   * the root-cause fix for the historical "stop button stuck after retry"
   * bug (there is no agent-less window to get stuck in).
   *
   * # Abort handling
   *
   * `prepareController.signal` is checked once, right before `continue()`.
   * If aborted, `commitRetryCancel` appends a synthetic aborted marker to
   * the truncated transcript, writes it back onto the still-live agent,
   * persists, and broadcasts `session_state { isRunning: false }`. No
   * teardown and no map eviction — the agent is reused for the next prompt.
   *
   * No-op if no user message exists in the transcript (defensive throw),
   * or if phase is already non-`idle` (concurrent retry or live run).
   *
   * `turn` 同 prompt：本轮重试携带的模型 / 思考档。带它且与活 agent 当前选择不同
   * 时才换并落库；不带（或相同）时保持活 agent 当前的会话选择不动。
   */
  async retry(
    sessionId: string,
    turn?: TurnSettings,
  ): Promise<void> {
    // Cold-load if needed. If multiple retry() calls land concurrently for
    // a session not yet in the map, they all await the same in-flight
    // createAgent promise via the `creating` map, then race for the
    // synchronous phase check below. JavaScript's microtask semantics
    // guarantee one of them flips phase to 'preparing' before any other
    // awakened microtask reads it — so we don't need a separate mutex.
    const managed = await this.getOrCreateAgent(sessionId);

    if (managed.phase !== 'idle') {
      // Concurrent retry already in flight (`preparing`) or agent currently
      // streaming (`running`). Silent no-op so the duplicate window doesn't
      // see a misleading toast — the in-flight run's broadcasts reconcile
      // every subscribed window to the correct state.
      console.debug('[agent-manager] retry: phase not idle, ignored', sessionId, managed.phase);
      return;
    }

    // Take the preparing slot synchronously, BEFORE any further await. A
    // concurrent retry that wakes up after our await(s) below will hit the
    // phase guard above and bail.
    managed.phase = 'preparing';
    managed.prepareController = new AbortController();
    const signal = managed.prepareController.signal;
    this.updateKeepAlive();
    let busySnapshot: AgentMessage[] | null = null;

    try {
      const messages = [...managed.agent.state.messages];
      const truncated = truncateForRetry(messages);
      if (!truncated) {
        // The UI only shows retry on the latest assistant turn, which by
        // definition has a preceding user message. Throwing surfaces the bug
        // instead of silently no-oping.
        throw new Error('No user message found to retry');
      }
      busySnapshot = truncated;
      this.broadcast(sessionId, {
        type: 'session_state',
        sessionId,
        messages: truncated,
        isRunning: true,
        pendingTools: this.getPendingToolSnapshot(managed),
      });

      // Persist truncation BEFORE continue. An SW restart mid-run must not
      // resurrect the failed turn from disk. `flush` collapses the
      // throttler's pending timer and writes immediately.
      if (managed.sessionCreated) {
        sessionStore.scheduleWrite(sessionId, truncated);
        await sessionStore.flush(sessionId);
      }

      // 模型 / 思考档：仅当 retry 携带 turn（用户在重试前切了模型 / 思考）且与活
      // agent 当前选择不同时才换并落库；否则保持不动——没有「空闲时改了
      // 全局」需要补读的场景。Tools 由 `refreshAllSessionTools` 保活（MCP 变更），
      // 此处不动。model 与 thinking 各自可选、分别判断、分别落库。
      const turnKey = turn?.model
        ? `${turn.model.provider}/${turn.model.modelId}`
        : null;
      const modelChanged = turnKey != null && turnKey !== managed.modelKey;
      const resolved = modelChanged ? await this.resolveSessionModel(turn!.model) : null;
      if (modelChanged && !resolved) throw new Error('No model selected or model not found');

      // Single abort checkpoint — cancel landed during the DB flush or the
      // async settings load, both BEFORE we mutate the agent. Commit an
      // aborted marker and bail; the live agent is left untouched.
      if (signal.aborted) {
        await this.commitRetryCancel(managed, truncated);
        return;
      }

      // Apply the refreshed state onto the live agent. `cancelAll` defensively
      // drops any stale pending interactive request (the UI hides retry while
      // a tool is pending, but a late port message could still arrive).
      managed.toolCtx.cancelAll();
      managed.permissionBridge.cancel();
      managed.agent.state.messages = truncated;
      if (resolved) {
        managed.agent.state.model = resolved.model;
        managed.modelKey = turnKey!;
      }
      // 思考档：把 turn 携带的原始偏好对（可能刚换的）当前模型夹成 effective 档，只有
      // effective 变了才更新 + 落库——覆盖「只换模型、现档不被新模型支持」的情形，并避免
      // 原始档 vs 夹后档的每轮空写
      const nextThinking = turn?.thinkingLevel != null
        ? clampThinkingLevel(managed.agent.state.model, turn.thinkingLevel)
        : null;
      const thinkingChanged = nextThinking != null && nextThinking !== managed.agent.state.thinkingLevel;
      if (thinkingChanged) {
        managed.agent.state.thinkingLevel = nextThinking!;
      }
      // 落库到会话行——会话行是真相来源。只写变了的字段。
      if (managed.sessionCreated && (modelChanged || thinkingChanged)) {
        await sessionStore.updateSettings(sessionId, {
          provider: modelChanged ? turn!.model!.provider : undefined,
          model: modelChanged ? turn!.model!.modelId : undefined,
          thinkingLevel: thinkingChanged ? managed.agent.state.thinkingLevel : undefined,
        });
      }

      // Re-broadcast busy. `continue()` is invoked on the very next line and
      // fires `agent_start` on entry, so the agent IS effectively running.
      // Broadcasting `false` here would flicker the composer back on.
      this.broadcast(sessionId, {
        type: 'session_state',
        sessionId,
        messages: truncated,
        isRunning: true,
        pendingTools: this.getPendingToolSnapshot(managed),
      });

      // Resume the agent loop against the truncated transcript (last message
      // is user). Fires `agent_start` which flips phase to 'running';
      // subsequent `agent_end` flips it back to 'idle'.
      await managed.agent.continue();
    } catch (err) {
      // In-place refresh never tears down the agent, so the managed entry
      // stays consistent — there is no half-built zombie to evict (contrast
      // the old rebuild path, which had to delete the entry on failure).
      //
      // But if we threw AFTER pre-persisting the truncated transcript yet
      // BEFORE mutating the agent (e.g. `resolveSessionModel` rejected), the live
      // agent still holds the OLD full transcript while DB holds the truncated
      // one. Align in-memory state to the truncated snapshot so the next prompt
      // doesn't resurrect the messages retry just dropped, then unblock the UI.
      // Guarded on `phase === 'preparing'`: once `continue()` has fired
      // `agent_start` (phase `running`), the `agent_end` path owns state +
      // broadcast and we must not clobber a marker it may have appended.
      if (busySnapshot && managed.phase === 'preparing') {
        managed.agent.state.messages = busySnapshot;
        this.broadcast(managed.sessionId, {
          type: 'session_state',
          sessionId: managed.sessionId,
          messages: busySnapshot,
          isRunning: false,
          pendingTools: [],
        });
      }
      throw err;
    } finally {
      managed.prepareController = undefined;
      // If the success path ran, agent_start already flipped phase to
      // 'running' (and agent_end will later flip to 'idle'). If we threw, or
      // bailed via `commitRetryCancel` on abort, phase is still 'preparing' —
      // reset it to 'idle' so the next retry can proceed. The agent is never
      // torn down, so the managed entry is always live here.
      if (managed.phase === 'preparing') {
        managed.phase = 'idle';
        this.updateKeepAlive();
      }
    }
  }

  /**
   * Edit a previous user message and resume the agent from that turn.
   *
   * Mirrors `retry()`'s in-place refresh + continue flow: same phase machine
   * guards, same abort checkpoint, same model / thinking override path, same
   * broadcast cadence. The only structural difference is the slice: instead
   * of `truncateForRetry` (drops everything after the most recent user), we
   * call `truncateForEditRerun` which rewrites that user's `<user-request>`
   * text in place (preserving attached context / images) and then drops the
   * tail.
   *
   * Throws when `messageIndex` doesn't point at a user message (UI should
   * not let this happen — defensive), or when `text` is empty / whitespace
   * only (same), or when the agent is currently running / preparing
   * (silent no-op, same as `retry`).
   */
  async editAndRerun(
    sessionId: string,
    messageIndex: number,
    text: string,
    turn?: TurnSettings,
  ): Promise<void> {
    const managed = await this.getOrCreateAgent(sessionId);

    if (managed.phase !== 'idle') {
      console.debug('[agent-manager] editAndRerun: phase not idle, ignored', sessionId, managed.phase);
      return;
    }

    managed.phase = 'preparing';
    managed.prepareController = new AbortController();
    const signal = managed.prepareController.signal;
    this.updateKeepAlive();
    let busySnapshot: AgentMessage[] | null = null;

    try {
      const messages = [...managed.agent.state.messages];
      const truncated = truncateForEditRerun(messages, messageIndex, text);
      if (!truncated) {
        throw new Error('Cannot edit: target is not a user message or text is empty');
      }
      busySnapshot = truncated;
      this.broadcast(sessionId, {
        type: 'session_state',
        sessionId,
        messages: truncated,
        isRunning: true,
        pendingTools: this.getPendingToolSnapshot(managed),
      });

      // Persist edit BEFORE continue — same SW-restart protection as retry.
      if (managed.sessionCreated) {
        sessionStore.scheduleWrite(sessionId, truncated);
        await sessionStore.flush(sessionId);
      }

      // Same model / thinking override path as retry.
      const turnKey = turn?.model
        ? `${turn.model.provider}/${turn.model.modelId}`
        : null;
      const modelChanged = turnKey != null && turnKey !== managed.modelKey;
      const resolved = modelChanged ? await this.resolveSessionModel(turn!.model) : null;
      if (modelChanged && !resolved) throw new Error('No model selected or model not found');

      if (signal.aborted) {
        await this.commitRetryCancel(managed, truncated);
        return;
      }

      managed.toolCtx.cancelAll();
      managed.permissionBridge.cancel();
      managed.agent.state.messages = truncated;
      if (resolved) {
        managed.agent.state.model = resolved.model;
        managed.modelKey = turnKey!;
      }
      const nextThinking = turn?.thinkingLevel != null
        ? clampThinkingLevel(managed.agent.state.model, turn.thinkingLevel)
        : null;
      const thinkingChanged = nextThinking != null && nextThinking !== managed.agent.state.thinkingLevel;
      if (thinkingChanged) {
        managed.agent.state.thinkingLevel = nextThinking!;
      }
      if (managed.sessionCreated && (modelChanged || thinkingChanged)) {
        await sessionStore.updateSettings(sessionId, {
          provider: modelChanged ? turn!.model!.provider : undefined,
          model: modelChanged ? turn!.model!.modelId : undefined,
          thinkingLevel: thinkingChanged ? managed.agent.state.thinkingLevel : undefined,
        });
      }

      this.broadcast(sessionId, {
        type: 'session_state',
        sessionId,
        messages: truncated,
        isRunning: true,
        pendingTools: this.getPendingToolSnapshot(managed),
      });

      await managed.agent.continue();
    } catch (err) {
      if (busySnapshot && managed.phase === 'preparing') {
        managed.agent.state.messages = busySnapshot;
        this.broadcast(managed.sessionId, {
          type: 'session_state',
          sessionId: managed.sessionId,
          messages: busySnapshot,
          isRunning: false,
          pendingTools: [],
        });
      }
      throw err;
    } finally {
      managed.prepareController = undefined;
      if (managed.phase === 'preparing') {
        managed.phase = 'idle';
        this.updateKeepAlive();
      }
    }
  }

  /**
   * Commit a retry that was cancelled during its `preparing` window (before
   * `continue()` started). Appends a synthetic aborted marker to the
   * truncated transcript, writes it back onto the still-live agent, persists,
   * and broadcasts so the UI shows the cancel indicator and re-enables the
   * composer.
   *
   * Unlike the old rebuild-abort path, this neither disposes the agent nor
   * evicts the entry: the in-place agent is reused as-is for the next prompt
   * (which appends a fresh user message, so an assistant-aborted tail is
   * fine). Mirrors `commitCompactionCancel`'s shape so all three cancel paths
   * (running / compaction / retry-preparing) leave the same kind of end-state
   * and the UI needs only one rendering rule for "this turn was cancelled".
   */
  private async commitRetryCancel(
    managed: ManagedSession,
    truncated: AgentMessage[],
  ): Promise<void> {
    // destroySession aborts `prepareController` then removes the entry; if we
    // reached here because of that (not a user cancel), bail without
    // persist/broadcast so we don't resurrect a just-deleted session row.
    // Mirrors `commitCompactionCancel`'s guard.
    if (!this.sessions.has(managed.sessionId)) return;

    const finalMessages: AgentMessage[] = [
      ...truncated,
      this.buildAbortedMarker(managed),
    ];
    managed.agent.state.messages = finalMessages;
    if (managed.sessionCreated) {
      sessionStore.scheduleWrite(managed.sessionId, finalMessages);
      try {
        await sessionStore.flush(managed.sessionId);
      } catch (err) {
        console.warn(
          `[agent-manager] flush on retry cancel failed for ${managed.sessionId}:`,
          err,
        );
      }
    }
    this.broadcast(managed.sessionId, {
      type: 'session_state',
      sessionId: managed.sessionId,
      messages: finalMessages,
      isRunning: false,
      pendingTools: [],
    });
  }

  /**
   * Construct a synthetic `stopReason: 'aborted'` assistant message that
   * mirrors the shape pi-agent-core produces inside `handleRunFailure` when
   * a streaming agent is aborted. Used by `commitRetryCancel` (and
   * `commitCompactionCancel`) so cancelling during the `preparing` /
   * `compacting` window leaves the same kind of marker the running path
   * leaves naturally.
   *
   * Pulls model identity (api / provider / id) off the agent's current
   * state — readable on both the still-wired old agent and the
   * just-installed new agent without needing async model resolution.
   * `usage` is zeroed since no tokens were spent.
   */
  private buildAbortedMarker(managed: ManagedSession): AssistantMessage {
    const model = managed.agent.state.model;
    const marker: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'aborted',
      timestamp: Date.now(),
    };
    return marker;
  }

  /**
   * Cancel an active or in-flight agent for a session.
   *
   * Dispatch by phase:
   *
   * - `preparing`: a `retry()` is mid-preparation. Abort its
   *   `prepareController` so the single signal checkpoint exits via
   *   `commitRetryCancel`, AND call `agent.abort()` defensively in case
   *   `continue()` has already been kicked off (the window after the
   *   checkpoint but before `agent_start` fires). `agent.abort()` is
   *   idempotent — on a dormant or already-dead agent it's a no-op; on an
   *   in-flight agent it stops the loop and `agent_end` broadcasts naturally
   *   through the handler.
   *
   *   We deliberately do NOT touch `sessions`, dispose, or broadcast here:
   *   `retry()`'s own flow (either `commitRetryCancel` for the
   *   pre-`continue()` window or the `agent_end` handler for the
   *   post-`continue()` window) owns those side effects. Duplicating them
   *   from cancel would either flicker the UI between states or double-dispose
   *   a tool context.
   *
   * - `idle`: silent no-op. The agent is already settled — no event will
   *   fire and no broadcast is needed (the listener's earlier `agent_end`
   *   already reconciled the UI). A stale stop click after the agent
   *   finished must not churn state.
   *
   * - `running`: signal abort and wait for the loop to settle, then force
   *   `phase = 'idle'` synchronously. The already-attached listener (via
   *   `wireSubscriptions`) handles `agent_end` naturally — broadcasts
   *   `agent_end`, persists, clears pending tools / permissions. Keeping
   *   the entry alive (vs. evicting it from `sessions`) lets the next
   *   prompt reuse the in-memory agent instead of cold-loading from the
   *   half-flushed DB snapshot, which is what previously caused
   *   "I clicked stop and the next message won't go through". The forced
   *   phase reset closes a tiny race window where the listener's async
   *   broadcast hasn't reached `setState({ phase: 'idle' })` yet but a
   *   follow-up `prompt()` has already arrived.
   *
   * No-op if no managed entry exists — the session has nothing to cancel
   * (either never started or already cleaned up).
   */
  async cancel(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    debugLog.info('agent', 'cancel:start', { sessionId, phase: managed.phase, msgsLen: managed.agent.state.messages.length });

    if (managed.phase === 'preparing') {
      // Signal the preparation to bail at its checkpoint, AND stop the agent
      // if it has already entered `continue()`. Cleanup and broadcast are
      // retry()'s responsibility — see method JSDoc.
      managed.prepareController?.abort();
      managed.agent.abort();
      return;
    }

    if (managed.phase === 'compacting') {
      // A pre-turn compaction is running. Abort the in-flight
      // `generateSummary`; `maybeCompact()` detects the abort and routes to
      // `commitCompactionCancel()`, which commits the pending user message +
      // an aborted marker, persists, broadcasts `isRunning: false`, and
      // returns `true` so `prompt()` abandons the turn. No agent run exists
      // yet, so there's nothing to `agent.abort()`. Cleanup and broadcast are
      // the owning method's responsibility — mirrors the `preparing` split
      // where cancel only signals.
      managed.compactionController?.abort();
      return;
    }

    if (managed.phase === 'idle') {
      // Already settled — no event will fire, no broadcast needed. A stale
      // stop click after the agent finished must not churn state.
      debugLog.info('agent', 'cancel:noop:idle', { sessionId });
      return;
    }

    // phase === 'running' — signal abort and wait for the loop to settle.
    // After `waitForIdle()` resolves, the loop is done from pi-agent-core's
    // perspective, but the async event-listener pipeline (which handles
    // `agent_end` → phase reset / broadcast / persist) may still be in
    // flight on a separate microtask. Force the phase to `idle` synchronously
    // so a follow-up `prompt()` arriving the moment cancel returns doesn't
    // hit the phase guard and silently no-op. The listener will still run
    // and emit its own broadcast, but `phase` is already correct for any
    // race winner; idempotent resets in `agent_end` are a no-op.
    debugLog.info('agent', 'cancel:abort', { sessionId, msgsLen: managed.agent.state.messages.length });
    managed.agent.abort();
    await managed.agent.waitForIdle();
    debugLog.info('agent', 'cancel:settled', {
      sessionId,
      msgsLen: managed.agent.state.messages.length,
      lastRole: managed.agent.state.messages.at(-1)?.role,
      lastStopReason: (managed.agent.state.messages.at(-1) as { stopReason?: string } | undefined)?.stopReason,
    });
    managed.phase = 'idle';
    this.updateKeepAlive();
  }

  /** Resolve an interactive tool's pending request */
  resolveTool(sessionId: string, toolName: string, response: any): void {
    const managed = this.sessions.get(sessionId);
    // ctx subscription handles broadcasting tool_resolved
    managed?.toolCtx.resolve(toolName, response);
  }

  /** Cancel a specific interactive tool */
  cancelTool(sessionId: string, toolName: string): void {
    const managed = this.sessions.get(sessionId);
    // ctx subscription handles broadcasting tool_resolved
    managed?.toolCtx.cancel(toolName);
  }

  /**
   * Resolve a tool's pending pre-execution permission prompt with the user's
   * explicit choice. `toolCallId` must match the in-flight request (a stale
   * click on an already-resolved / superseded prompt is ignored). The
   * write-back of the decision onto the permissionRequest message and the
   * broadcast happen inside `requestPermissionDecision`, which is awaiting
   * this bridge.
   */
  resolvePermission(
    sessionId: string,
    toolCallId: string,
    decision: 'once' | 'always' | 'denied',
  ): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    const pending = managed.permissionBridge.getPending();
    const matched = pending?.toolCallId === toolCallId;
    debugLog.info('agent', 'permission:resolved',
      withSession({
        toolName: (pending?.request as { toolName?: string } | undefined)?.toolName ?? '',
        decision: matched ? decision : 'stale',
      }, sessionId));
    if (!matched) return; // stale / mismatched
    managed.permissionBridge.resolve(decision);
  }

  /** Get current state for a session (for reconnecting clients).
   *
   *  `isRunning` is the sidepanel's "busy" signal: true while the session
   *  cannot accept a normal prompt yet. That includes active streaming, a
   *  retry's `preparing` window, and the `compacting` window, so a
   *  reconnecting or second window keeps the composer blocked instead of
   *  dispatching a prompt the manager would ignore while `phase !== 'idle'`. */
  getSessionState(sessionId: string): {
    messages: AgentMessage[];
    isRunning: boolean;
    isCompacting: boolean;
    pendingTools: { toolName: string; toolCallId: string; args: any }[];
    pendingPermissions: PermissionRequest[];
  } | null {
    const managed = this.sessions.get(sessionId);
    if (!managed) return null;
    return {
      messages: [...managed.agent.state.messages],
      isRunning: managed.phase !== 'idle',
      isCompacting: managed.phase === 'compacting',
      pendingTools: this.getPendingToolSnapshot(managed),
      pendingPermissions: this.getPendingPermissions(managed),
    };
  }

  /** Destroy a managed session entirely */
  destroySession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      // Abort in-flight async tails so they can't resurrect a just-deleted
      // session row. Both the compaction path (`maybeCompact` →
      // `commitCompactionCancel`) and the retry preparing path (`retry` →
      // `commitRetryCancel`) check their controller's `signal.aborted` after
      // each await and bail via an entry-presence guard before persisting or
      // broadcasting.
      managed.compactionController?.abort();
      managed.prepareController?.abort();
      managed.unsubscribeAgent();
      managed.toolCtx.dispose();
      managed.permissionBridge.cancel();
      managed.agent.abort();
      this.sessions.delete(sessionId);
      this.updateKeepAlive();
    }
  }
}

export const agentManager = new AgentManager();
