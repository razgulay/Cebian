// Hook: connects sidepanel to the background session manager via chrome.runtime Port.
// Replaces useAgentLifecycle + useSessionManager.

// [DIAG:edit-btn] 诊断「Edit 按钮在 Exa tool 第二次以后消失」的临时开关。
// Bug 修完后删除所有 [DIAG:edit-btn] 代码块，并将此 flag 改为 false。
const __DIAG_EDIT_BTN__ = true;

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  CLIENT_PORT,
  type BranchEntryInfo,
  type BroadcastMessage,
  type ClientMessage,
  type ServerMessage,
  type SessionMeta,
  type SessionSnapshot,
  type TurnSettings,
} from '@/lib/ipc/protocol';
import type { Attachment } from '@/lib/agent/attachments';
import { applyStreamOps } from '@/lib/agent/stream-replica';
import type { PermissionRequest } from '@/lib/agent/tool-permissions';
import { replaceUserText, truncateForRetry } from '@/lib/agent/message-helpers';
import { rewriteLastUserMessage } from '@/lib/agent/rewrite-last-user-message';
import { estimateContextTokensForUi } from '@/lib/agent/compaction';
import type { Message } from '@earendil-works/pi-ai';
import { t } from '@/lib/i18n';
import { recorderChannel } from '@/lib/recorder/sidepanel-channel';
import { mcpAppResourceChannel } from '@/lib/mcp/sidepanel-channel';
import { compactionChannel } from '@/lib/agent/compaction-sidepanel-channel';
import { myInstanceId } from '@/lib/ipc/instance-id';
import { debugLog, withSession } from '@/lib/debug/log';
import { startTrace } from '@/lib/debug/trace';

// ─── Helpers ───

// `rewriteLastUserMessage` lives in `@/lib/agent/rewrite-last-user-message`
// (extracted so its behavior is unit-testable directly rather than via a
// local copy hidden inside the hook's test file). The directive / separator
// constants and rationale comments are kept there.

// ─── State ───

export interface AgentPortState {
  /** 广播形态：消息 + 可选的树 entryId（消息编辑用它定位；乐观 / 流式消息没有）。 */
  messages: BroadcastMessage[];
  /** 当前分支的分支点信息（稀疏，键为 entryId）。只在结构可能变化的帧下发，
   *  缺省帧保持上一次的值。 */
  branchInfo: Record<string, BranchEntryInfo>;
  isAgentRunning: boolean;
  /** 后台正在执行发送前的上下文压缩时为 true。用于驱动一个与普通思考态不同的
   *  「压缩中」指示。 */
  isCompacting: boolean;
  sessionId: string | null;
  sessionTitle: string;
  connected: boolean;
  /** Last error message from the agent, cleared on next prompt. */
  lastError: string | null;
  /**
   * 400 context-overflow recovery state. Set when the BG broadcasts
   * `context_overflow` (auto-recovery failed twice and handed control to
   * the user). The chat panel renders a card with Retry/Stop buttons
   * when this is non-null; the agent remains idle until the user picks
   * one. Cleared when the user responds (Retry/Stop) or sends a new
   * prompt, which resets the BG counter.
   */
  contextOverflow: { attempts: number; lastError: string } | null;
  /** Active model's `contextWindow`（来自 pi-ai Model 的同名字段）。caller 在
   *  `currentModel` / provider 列表变化时通过 `setContextWindow` 推过来；初始
   *  为 null（无模型 / 解析失败时由 `useContextUsage` 在 effect 里设回 null）。
   *  ContextUsagePill 用它算 percent = tokens / contextWindow——无 window 就
   *  隐藏整张 pill，不显示「未知」占位。 */
  contextWindow: number | null;
  /** 当前消息流的本地 token 估算。`messages` 改变时通过 effect 重算；BG
   *  `compaction_skipped` 广播时会用权威数字覆写（BG 的 `state.messages` 采样
   *  点可能与 hook 端有毫秒级差异，权威值更可靠），下一次 messages 变化时
   *  本地值自然接管。空会话为 0。 */
  contextTokenEstimate: number;
}

// ─── Pending interactive tool info (for UI rendering) ───

export interface PendingToolInfo {
  toolCallId: string;
  args: any;
}

// 权限提示卡片的请求形状（PermissionRequest）来自 @/lib/agent/tool-permissions，
// UI 需要时直接从那里 import；本 hook 仅在内部按 toolCallId 维护活 pending。

export type PromptDispatchResult =
  | { status: 'dispatched' }
  | { status: 'notDispatched'; reason: 'empty' | 'unavailable' };

const PROMPT_RECONNECT_TIMEOUT_MS = 1_500;

// ─── Callbacks ───

export interface AgentPortCallbacks {
  onSessionCreated?: (sessionId: string, title: string) => void;
  onSessionLoaded?: (session: SessionSnapshot | null) => void;
  /** 重新订阅一个仍有活 agent 的会话时，后台走 `session_state`（带消息但非完整
   *  会话行）。这里把该会话的 provider / model / 思考档单独回传，供上层回填本地的
   *  turn 草稿——与 `onSessionLoaded` 对齐，修复「发消息后进设置再返回模型被重置」。 */
  onSessionSettings?: (provider: string, model: string, thinkingLevel: string) => void;
  onSessionList?: (sessions: SessionMeta[]) => void;
  onSessionDeleted?: (sessionId: string) => void;
}

// ─── Hook ───

export function useBackgroundAgent(callbacks: AgentPortCallbacks) {
  const [state, setState] = useState<AgentPortState>({
    messages: [],
    branchInfo: {},
    isAgentRunning: false,
    isCompacting: false,
    sessionId: null,
    sessionTitle: '',
    connected: false,
    lastError: null,
    contextOverflow: null,
    contextWindow: null,
    contextTokenEstimate: 0,
  });

  const [pendingTools, setPendingTools] = useState<Map<string, PendingToolInfo>>(new Map());

  // Live permission prompts keyed by toolCallId. Drives the answerable-vs-expired
  // distinction for permissionRequest cards: a card whose toolCallId is absent
  // here has no live agent awaiting it.
  const [pendingPermissions, setPendingPermissions] = useState<Map<string, PermissionRequest>>(new Map());

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const connectedWaitersRef = useRef<Set<(connected: boolean) => void>>(new Set());
  const scheduleRetryRef = useRef<(() => void) | null>(null);
  // 流式副本漂移时的重同步：重发 subscribe 拉权威快照（session_state）。
  // 幂等 + 1s 时间去重——它可能从 setState updater 里被调用（含 StrictMode
  // 双调用），重复触发的代价只是一帧多余的快照。
  const lastResyncAtRef = useRef(0);
  const requestResyncRef = useRef<((sessionId: string) => void) | null>(null);
  requestResyncRef.current = (sessionId: string) => {
    // updater 可能延迟到会话已切换后才执行——重发过期会话的 subscribe 会把
    // background 的 viewer 路由改回旧会话，新会话从此收不到广播。只为当前
    // 会话重同步
    if (sessionIdRef.current !== sessionId) return;
    const now = Date.now();
    if (now - lastResyncAtRef.current < 1_000) return;
    lastResyncAtRef.current = now;
    portRef.current?.postMessage({ type: 'subscribe', sessionId } satisfies ClientMessage);
  };
  // Stable callback refs to avoid re-creating the port listener
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  // 临时诊断：键 = sessionId，值 = 本轮 send→reply 的 trace t0 锚点。
  // `dispatchPrompt` 把 `send()` 收到的 t0 暂存；`handleMessage` 在收到对应
  // 会话的事件时按需重建 hook 端 trace handle（let t0 = `pendingTraceT0Ref.get(...)`）。
  // 终点（agent_end / cancel / 切会话等）都 `delete` 释放，避免下一轮 stale
  // 复用（用户在 agent 跑完前连发两条的情况）。
  const pendingTraceT0Ref = useRef<Map<string, number>>(new Map());
  // 临时诊断：hook 端「首 token 哨兵」，每个会话每轮只打一次 `hook:first_token`。
  // agent_start 处清空（新一轮重新计）；agent_end 与各种 bail-out 路径同步清。
  const hookFirstTokenSeenRef = useRef<Set<string>>(new Set());
  // Display-text overrides for the most recent optimistic user message.
  // When a slash command like `/writing` is resolved at send-time, the BG
  // stores and broadcasts back the *expanded* prompt text — but the user
  // bubble should keep showing `/writing`. This map records `{sessionId,
  // messageTimestamp, displayText}` so the session_state handler can rewrite
  // the authoritative message's text content when it arrives.
  // Cleared as soon as it's been applied to an incoming broadcast.
  const pendingDisplayTextRef = useRef<Map<string, { sessionId: string; timestamp: number; displayText: string }>>(new Map());

  // Connect to background on mount, with auto-reconnect on disconnect.
  useEffect(() => {
    let unmounted = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const MAX_RETRY_DELAY = 30_000;
    const BASE_DELAY = 500;

    const handleMessage = (msg: ServerMessage) => {
      if (unmounted) return;
      const isCurrentSession = (sessionId: string | null | undefined) =>
        sessionId != null && sessionId === sessionIdRef.current;
      switch (msg.type) {
        case 'connected': {
          retryCount = 0;
          setState(prev => ({ ...prev, connected: true, lastError: null }));
          const waiters = Array.from(connectedWaitersRef.current);
          connectedWaitersRef.current.clear();
          for (const resolve of waiters) resolve(true);
          break;
        }

        case 'session_state':
          if (!isCurrentSession(msg.sessionId)) break;
          if (msg.pendingTools) {
            const next = new Map<string, PendingToolInfo>();
            for (const pending of msg.pendingTools) {
              next.set(pending.toolName, {
                toolCallId: pending.toolCallId,
                args: pending.args,
              });
            }
            setPendingTools(next);
          }
          if (msg.pendingPermissions) {
            const nextPerms = new Map<string, PermissionRequest>();
            for (const req of msg.pendingPermissions) {
              nextPerms.set(req.toolCallId, req);
            }
            setPendingPermissions(nextPerms);
          }
          setState(prev => ({
            ...prev,
            sessionId: msg.sessionId,
            // Title is only included on initial subscribe (loaded from DB);
            // mid-stream rebuild broadcasts omit it, so preserve the existing
            // value rather than wiping the header.
            ...(msg.title !== undefined ? { sessionTitle: msg.title } : {}),
            // Slash-command display preservation: BG stores and broadcasts
            // back the expanded prompt body, but the user bubble should keep
            // showing what they typed (e.g. `/writing`). Rewrite the
            // authoritative text content back to the short command form.
            messages: (() => {
              const pending = pendingDisplayTextRef.current.get(msg.sessionId);
              return pending ? rewriteLastUserMessage(msg.messages, pending.displayText) : msg.messages;
            })(),
            // 分支信息只在结构可能变化的帧携带；缺省帧保持现值，避免切换器闪没
            branchInfo: msg.branchInfo ?? prev.branchInfo,
            isAgentRunning: msg.isRunning,
            isCompacting: msg.isCompacting ?? false,
          }));
          // 模型字段同样仅首次订阅携带（mid-stream rebuild 省略），用以回填 turn 草稿。
          if (msg.provider !== undefined) {
            callbacksRef.current.onSessionSettings?.(msg.provider, msg.model ?? '', msg.thinkingLevel ?? '');
          }
          break;

        case 'agent_start':
          if (!isCurrentSession(msg.sessionId)) break;
          debugLog.info('bg', 'recv:agent_start', withSession({ sessionId: msg.sessionId }, msg.sessionId));
          // 临时诊断：用本轮 ship 过来的 t0 重建 hook 端 trace handle，打
          // `hook:recv_agent_start` 标记；缺 t0（旧客户端 / 切会话未派发的
          // 旧会话）则静默跳过。新一轮开始：清掉 hook 端的首 token 哨兵
          // （与 BG 端 `firstTokenSeen.delete` 对齐）。
          {
            const t0 = pendingTraceT0Ref.current.get(msg.sessionId);
            if (t0 !== undefined) {
              const trace = startTrace('hook', msg.sessionId, t0);
              trace.mark('hook:recv_agent_start');
            }
            hookFirstTokenSeenRef.current.delete(msg.sessionId);
          }
          setState(prev => ({ ...prev, isAgentRunning: true, isCompacting: false }));
          break;

case 'stream_ops':
          if (!isCurrentSession(msg.sessionId)) break;
          debugLog.info('hook', 'recv:stream_ops', {
            sessionId: msg.sessionId,
            opsLen: msg.ops.length,
            opKinds: msg.ops.map((o) => o.kind),
          });
          // 临时诊断：stream_ops 路径下「首 token 抵达」改为检测 ops 里是否带
          // 文本增量（首次 tail_replace 引入 assistant 文本块、或第一条
          // tail_append text/thinking）。`hookFirstTokenSeenRef` 守卫同前，
          // 每个会话每轮只打一次。
          if (!hookFirstTokenSeenRef.current.has(msg.sessionId)) {
            const hasTextOp = msg.ops.some((op) => {
              if (op.kind === 'tail_append' && (op.field === 'text' || op.field === 'thinking')) {
                return true;
              }
              if (op.kind === 'tail_replace') {
                const m = op.message;
                return m.role === 'assistant' && (m.content ?? []).some(
                  (b) => b.type === 'text' || b.type === 'thinking',
                );
              }
              return false;
            });
            if (hasTextOp) {
              hookFirstTokenSeenRef.current.add(msg.sessionId);
              const t0 = pendingTraceT0Ref.current.get(msg.sessionId);
              if (t0 !== undefined) {
                const trace = startTrace('hook', msg.sessionId, t0);
                trace.mark('hook:first_token', { opsLen: msg.ops.length });
              }
            }
          }
          setState(prev => {
            const next = applyStreamOps(prev.messages, msg.ops);
            if (next === null) {
              // 副本漂移（正常流程不该发生）：保持现状，请求重新订阅拉取
              // 权威快照。副本在 message_end / agent_end 的全量 transcript
              // 边界也会被整体校正，这里只是提前自愈。
              // 在 updater 里发起副作用不理想，但 requestResync 幂等且带
              // 时间去重（StrictMode 双调用也只发一次），坏处有界。
              requestResyncRef.current?.(msg.sessionId);
              return prev;
            }
            return { ...prev, messages: next };
          });
          break;

        case 'message_end':
          if (!isCurrentSession(msg.sessionId)) break;
          debugLog.info('hook', 'recv:message_end', {
            sessionId: msg.sessionId,
            msgsLen: msg.messages.length,
            lastRole: msg.messages.at(-1)?.role,
          });
          {
            const t0 = pendingTraceT0Ref.current.get(msg.sessionId);
            if (t0 !== undefined) {
              const trace = startTrace('hook', msg.sessionId, t0);
              trace.mark('hook:recv_message_end');
            }
          }
          // Length-aware merge (see session_state handler for the race-condition
          // rationale). message_end broadcasts can race with the optimistic
          // user bubble if a previous turn is still finalising when the new
          // turn starts; a stale empty messages array would wipe the
          // optimistic bubble.
          setState(prev => {
            const pending = pendingDisplayTextRef.current.get(msg.sessionId);
            const rewritten = pending ? rewriteLastUserMessage(msg.messages, pending.displayText) : msg.messages;
            return {
              ...prev,
              messages: rewritten.length >= prev.messages.length ? rewritten : prev.messages,
            };
          });
          break;

        case 'agent_end':
          if (!isCurrentSession(msg.sessionId)) break;
          // 临时诊断：最后一帧——用 t0 重建 handle 打 `hook:recv_agent_end`，
          // 然后清掉 t0 与首 token 哨兵，防止下一轮 stale 复用。
          {
            const t0 = pendingTraceT0Ref.current.get(msg.sessionId);
            if (t0 !== undefined) {
              const trace = startTrace('hook', msg.sessionId, t0);
              trace.mark('hook:recv_agent_end');
            }
          }
          pendingTraceT0Ref.current.delete(msg.sessionId);
          hookFirstTokenSeenRef.current.delete(msg.sessionId);
          setState(prev => {
            const pending = pendingDisplayTextRef.current.get(msg.sessionId);
            const rewritten = pending ? rewriteLastUserMessage(msg.messages, pending.displayText) : msg.messages;
            return {
              ...prev,
              messages: rewritten,
              branchInfo: msg.branchInfo ?? prev.branchInfo,
              isAgentRunning: false,
              isCompacting: false,
            };
          });
          setPendingTools(new Map());
          setPendingPermissions(new Map());
          break;

        case 'tool_pending':
          if (!isCurrentSession(msg.sessionId)) break;
          setPendingTools(prev => {
            const next = new Map(prev);
            next.set(msg.toolName, { toolCallId: msg.toolCallId, args: msg.args });
            return next;
          });
          break;

        case 'tool_resolved':
          if (!isCurrentSession(msg.sessionId)) break;
          setPendingTools(prev => {
            const next = new Map(prev);
            next.delete(msg.toolName);
            return next;
          });
          break;

        case 'session_created':
          // No `isCurrentSession` guard: the BG already routes this event
          // through `broadcast()` so the message only reaches ports subscribed
          // to the new session. By the time it arrives here it IS relevant;
          // without the guard, navigate-to-different-session flows could be
          // dropped because `sessionIdRef.current` lags the React commit.
          setPendingTools(new Map());
          setPendingPermissions(new Map());
          setState(prev => {
            // Detect fork / navigate-to-different-session: clear the
            // previous session's message list so the upcoming
            // `session_loaded` (with the new session's messages) doesn't
            // get overridden by the length-aware merge below. Without this,
            // a fork from a 2-turn source into a 1-bubble new session
            // would keep the source's messages in state — the merge sees
            // loadedMessages.length (1) < prev.messages.length (2) and
            // prefers prev, leaving the user staring at the source's
            // bubbles inside the new /chat/<newId> route.
            //
            // For the brand-new-session path (prev.sessionId === null),
            // prev.messages is already [], so clearing is a no-op.
            const isSessionChange = prev.sessionId !== msg.sessionId;
            return {
              ...prev,
              sessionId: msg.sessionId,
              sessionTitle: msg.title,
              messages: isSessionChange ? [] : prev.messages,
              isAgentRunning: false,
              isCompacting: false,
            };
          });
          callbacksRef.current.onSessionCreated?.(msg.sessionId, msg.title);
          break;

        case 'session_loaded':
          // No `isCurrentSession` guard: BG only posts this to the port
          // currently subscribed to `msg.sessionId` (subscribe handler
          // filters). BG may deliver `session_loaded` immediately after
          // `session_created` — the React commit on `sessionId` is async, so
          // `sessionIdRef.current` can lag, and the guard would drop the
          // payload → empty UI on the newly-active session.
          setPendingTools(new Map());
          setPendingPermissions(new Map());
          if (msg.session) {
            // Apply pending displayText for slash commands (same logic as
            // session_state — rewrite the last user message's text content
            // to the short command form). The entry persists across
            // broadcasts for the session lifetime.
            const pending = pendingDisplayTextRef.current.get(msg.sessionId);
            const loadedMessages = pending
              ? rewriteLastUserMessage(msg.session!.messages, pending.displayText)
              : msg.session!.messages;
            setState(prev => ({
              ...prev,
              sessionId: msg.session!.id,
              sessionTitle: msg.session!.title,
              messages: msg.session!.messages,
              branchInfo: msg.session!.branchInfo ?? {},
              isAgentRunning: false,
              isCompacting: false,
            }));
          }
          callbacksRef.current.onSessionLoaded?.(msg.session);
          break;

        case 'session_list_result':
          callbacksRef.current.onSessionList?.(msg.sessions);
          break;

        case 'session_deleted':
          pendingDisplayTextRef.current.delete(msg.sessionId);
          // 临时诊断：BG 已销毁会话—— t0 与首 token 哨兵同步释放，避免老
          // 锚点在下一次同 id 复用的会话（罕见但可能：用户删了又立刻再建）
          // 时误命中。
          pendingTraceT0Ref.current.delete(msg.sessionId);
          hookFirstTokenSeenRef.current.delete(msg.sessionId);
          callbacksRef.current.onSessionDeleted?.(msg.sessionId);
          break;

        case 'error':
          if (msg.sessionId && !isCurrentSession(msg.sessionId)) break;
          console.error('[AgentPort] Error:', msg.error);
          setState(prev => ({ ...prev, isAgentRunning: false, isCompacting: false, lastError: msg.error }));
          // 临时诊断：BG 报错——当前会话的 trace t0 与首 token 哨兵同步释放。
          if (msg.sessionId) {
            pendingTraceT0Ref.current.delete(msg.sessionId);
            hookFirstTokenSeenRef.current.delete(msg.sessionId);
          }
          break;

        case 'context_overflow':
          // 400-out-of-context. The agent already auto-retried twice; this
          // broadcast hands control to the user via the recovery card.
          // We clear the same trace sentinel as `error` so a subsequent
          // Retry/Stop starts a clean timing window.
          if (msg.sessionId && !isCurrentSession(msg.sessionId)) break;
          setState(prev => ({
            ...prev,
            isAgentRunning: false,
            isCompacting: false,
            contextOverflow: { attempts: msg.attempts, lastError: msg.lastError },
          }));
          if (msg.sessionId) {
            pendingTraceT0Ref.current.delete(msg.sessionId);
            hookFirstTokenSeenRef.current.delete(msg.sessionId);
          }
          break;

        case 'recorder_status':
          recorderChannel.publishStatus({
            isRecording: msg.isRecording,
            startedAt: msg.startedAt,
            eventCount: msg.eventCount,
            truncated: msg.truncated,
            initiatorInstanceId: msg.initiatorInstanceId,
            activeWindowId: msg.activeWindowId,
          });
          break;

        case 'recorder_session':
          recorderChannel.publishSession(msg.session);
          break;

        case 'recorder_start_rejected':
          recorderChannel.publishRejection({ reason: msg.reason });
          break;

        case 'compaction_skipped':
          // Subtask 5：BG 主动 80% 预检想压缩但找不到可用切点时通知。前端把这个
          // 透给 toast 订阅者；这是 fire-and-forget，不动 `AgentPortState`、
          // 不清 trace 哨兵（事件发生在 agent.prompt() 真正开始之前，trace t0
          // 还没记上）。
          if (msg.sessionId && !isCurrentSession(msg.sessionId)) break;
          compactionChannel.publishSkipped({
            tokens: msg.tokens,
            contextWindow: msg.contextWindow,
          });
          // Subtask 2：BG 在那一刻采样的 token 数是权威值——本地 estimate 可能
          // 因为 BG 的 state.messages 与 hook 端存在毫秒级差异而漂移。把
          // estimate 覆写为 BG 的 `tokens`，让 pill 在高负载区间不再与 toast
          // 显示不同数字。下次 messages 改变时本地 effect 自然接管。
          setState(prev => prev.contextTokenEstimate === msg.tokens
            ? prev
            : { ...prev, contextTokenEstimate: msg.tokens });
          break;

        case 'mcp_resource_result':
          mcpAppResourceChannel.handleResult(msg);
          break;
      }
    };

    function scheduleRetry() {
      if (unmounted) return;
      const delay = Math.min(BASE_DELAY * 2 ** retryCount, MAX_RETRY_DELAY);
      retryCount++;
      if (retryCount === 5) {
        setState(prev => ({
          ...prev,
          lastError: t('chat.session.reconnecting'),
        }));
      }
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    }

    scheduleRetryRef.current = scheduleRetry;

    function connect() {
      if (unmounted) return;
      const sessionToRestore = sessionIdRef.current;

      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connect({ name: CLIENT_PORT });
      } catch {
        scheduleRetry();
        return;
      }
      portRef.current = port;
      // Expose to the recorder channel so useRecorder can post start/stop.
      recorderChannel.setPort(port);
      // Expose to the MCP App resource channel so useMCPAppResource can
      // fetch `ui://` HTML for inline iframe rendering.
      mcpAppResourceChannel.setPort(port);

      port.onMessage.addListener(handleMessage);

      let disconnected = false;
      const handleDisconnect = () => {
        if (unmounted) return;
        if (disconnected) return;
        disconnected = true;
        if (portRef.current === port) {
          portRef.current = null;
          recorderChannel.setPort(null);
          mcpAppResourceChannel.setPort(null);
          setState(prev => ({ ...prev, connected: false }));
        }
        scheduleRetry();
      };
      port.onDisconnect.addListener(handleDisconnect);

      // Tell the background which sidepanel/tab instance this port belongs
      // to so the recorder can gate stop() and detect initiator-disconnect.
      // Sent synchronously — the instance id is generated at module load
      // and doesn't require an async Chrome API — so the BG sees the hello
      // before any other message we might post on this port.
      try {
        port.postMessage({
          type: 'hello',
          instanceId: myInstanceId,
        } satisfies ClientMessage);
        if (sessionToRestore) {
          port.postMessage({ type: 'subscribe', sessionId: sessionToRestore } satisfies ClientMessage);
        }
      } catch {
        handleDisconnect();
      }
    }

    connect();

    return () => {
      unmounted = true;
      if (retryTimer) clearTimeout(retryTimer);
      scheduleRetryRef.current = null;
      const waiters = Array.from(connectedWaitersRef.current);
      connectedWaitersRef.current.clear();
      for (const resolve of waiters) resolve(false);
      portRef.current?.disconnect();
      portRef.current = null;
      recorderChannel.setPort(null);
      mcpAppResourceChannel.setPort(null);
    };
  }, []);

  // ─── Actions ───

  const postMessage = useCallback((msg: ClientMessage) => {
    portRef.current?.postMessage(msg);
  }, []);

  const waitForConnected = useCallback((timeoutMs: number): Promise<boolean> => {
    if (portRef.current) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        connectedWaitersRef.current.delete(finish);
        resolve(connected && !!portRef.current);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      connectedWaitersRef.current.add(finish);
    });
  }, []);

  const dispatchPrompt = useCallback((
      text: string,
    attachments: Attachment[] | undefined,
    expectedSessionId: string | null,
    turn?: TurnSettings,
    displayText?: string,
    t0?: number,
  ): boolean => {
    if (sessionIdRef.current !== expectedSessionId) return false;

    const port = portRef.current;
    if (!port) return false;

    const existingSessionId = sessionIdRef.current;
    const sessionId = existingSessionId ?? crypto.randomUUID();

    // 临时诊断：把渲染端捕获的 t0 锚点随消息送到 BG，让 BG 与 hook 各自创建
    // 自己的 trace handle（BG 端已有；hook 端在 `handleMessage` 里收到事件
    // 时按 sessionId 取 t0 重建 handle）。这样 handle source 与各端子的
    // debugLog 写入约定对齐：hook 端写 `source: 'hook'`，BG 端写
    // `source: 'bg'`，UI 端写 `source: 'ui'`，导出的日志 source 字段自描述、
    // 与既有的 `debugLog.info('hook', 'recv:*')` / `debugLog.info('bg',
    // 'recv:*')` 共存无歧义。handle 仅活本轮（agent_end 释放），下一轮
    // 重新注入新 t0。
    if (t0 !== undefined) {
      // 把 t0 暂存到 sessionId→t0 映射；handleMessage 收到对应 sessionId
      // 的事件时按需重建 hook 端 trace handle。这一段与上面 `t0` 透传
      // IPC 的字段同步更新——当 `msg.t0` 在 BG 端被读走做 trace 后，hook 端
      // 也用同一个 t0 接续。
      pendingTraceT0Ref.current.set(sessionId, t0);
    }
    try {
      port.postMessage({
        type: 'prompt',
        sessionId,
        text,
        attachments,
        model: turn?.model,
        thinkingLevel: turn?.thinkingLevel,
        ...(t0 !== undefined ? { t0 } : {}),
      } satisfies ClientMessage);
    } catch {
      if (portRef.current === port) {
        portRef.current = null;
        recorderChannel.setPort(null);
        mcpAppResourceChannel.setPort(null);
        setState(prev => ({ ...prev, connected: false }));
        scheduleRetryRef.current?.();
      }
      pendingTraceT0Ref.current.delete(sessionId);
      return false;
    }

    // 真正投递成功后再写入新 sessionId，避免重连等待期间订阅一个尚未创建的会话。
    if (!existingSessionId) {
      sessionIdRef.current = sessionId;
    }

    // Optimistically add user message to local state for immediate UI feedback
    const userTimestamp = Date.now();
    setState(prev => {
      // The backend sends the fully-expanded prompt (e.g. a long template body
      // for `/writing`), but the user bubble should show what they actually
      // typed (e.g. just `/writing`). `displayText` is the original user-facing
      // text; fallback to the expanded text for non-slash-command sends.
      const bubbleText = (displayText ?? text).trim();
      const content: any[] = [{ type: 'text' as const, text: bubbleText }];
      // Include image attachments in optimistic message for preview
      if (attachments) {
        for (const att of attachments) {
          if (att.type === 'image') {
            content.push({ type: 'image', data: att.data, mimeType: att.mimeType });
          }
        }
      }
      const userMsg = { role: 'user' as const, content, timestamp: userTimestamp };
      return {
        ...prev,
        sessionId,
        messages: [...prev.messages, userMsg as any],
        isAgentRunning: true,
        isCompacting: false,
        lastError: null,
      };
    });

    // Record the displayText override so every subsequent session_state
    // broadcast (which carries the expanded text) can rewrite the user
    // message back to the short command form. The entry stays alive for
    // the session's lifetime — replaced when the user sends a new prompt
    // for the same session.
    if (displayText && displayText.trim() !== text.trim()) {
      pendingDisplayTextRef.current.set(sessionId, {
        sessionId,
        timestamp: userTimestamp,
        displayText: displayText.trim(),
      });
    } else if (!displayText || displayText.trim() === text.trim()) {
      // Non-slash-command send: clear any stale entry from a previous turn
      // on this session (the previous user message should already have its
      // own finalized displayText or no override).
      pendingDisplayTextRef.current.delete(sessionId);
    }
    return true;
  }, []);

  const send = useCallback(async (
    text: string,
    attachments?: Attachment[],
    expectedSessionId: string | null = sessionIdRef.current,
    turn?: TurnSettings,
    displayText?: string,
    t0?: number,
  ): Promise<PromptDispatchResult> => {
    const trimmed = text.trim();
    if (!trimmed) return { status: 'notDispatched', reason: 'empty' };

    const startedSessionId = expectedSessionId;
    if (dispatchPrompt(trimmed, attachments, startedSessionId, turn, displayText, t0)) return { status: 'dispatched' };

    const connected = await waitForConnected(PROMPT_RECONNECT_TIMEOUT_MS);
    if (!connected || sessionIdRef.current !== startedSessionId) {
      if (sessionIdRef.current === startedSessionId) {
        setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      }
      return { status: 'notDispatched', reason: 'unavailable' };
    }

    if (dispatchPrompt(trimmed, attachments, startedSessionId, turn, displayText, t0)) return { status: 'dispatched' };

    setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
    return { status: 'notDispatched', reason: 'unavailable' };
  }, [dispatchPrompt, waitForConnected]);

  const cancel = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) postMessage({ type: 'cancel', sessionId });
  }, [postMessage]);

  /**
   * 手动触发上下文压缩（user clicked the pill's adjacent compact button）。
   * 走和 proactive 80% 预检同一条流水线，只跳过阈值门。session 必须 idle；
   // busy 时 BG 抛错并通过 `error` ServerMessage 反馈，UI 在那里打 toast 并
   // 退出 button 的 loading 态。无 session 或断连时本地直接 return。
   */
  const compactNow = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (!portRef.current) return;
    postMessage({ type: 'compact_now', sessionId });
  }, [postMessage]);

  /**
   * 把当前会话的「resolved contextWindow」从 caller（一般是 useContextUsage，
   * 通过 resolveModel + storage 推算出来的）推入 hook state。null 表示无模型
   * / 解析失败，pill 与 popover 在 null 时隐藏整张图。effect 在 caller
   * 里驱动——这里只管 setState。
   */
  const setContextWindow = useCallback((window: number | null) => {
    setState(prev => prev.contextWindow === window ? prev : { ...prev, contextWindow: window });
  }, []);

  /**
   * User response to a 400 context-overflow card. Retry triggers a fresh
   * attempt on the BG with a deeper (50%) message drop; Stop clears the
   * card and re-enables the composer so the user can start a new turn.
   * In both cases we clear local `contextOverflow` so the card hides
   * immediately, before the BG acknowledges — the BG's reply will be
   * a fresh agent_start (Retry) or a session_state with the cleared
   * state (Stop).
   */
  const sendContextOverflowResponse = useCallback((action: 'retry' | 'stop') => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    postMessage({ type: 'context_overflow_response', sessionId, action });
    setState(prev => ({ ...prev, contextOverflow: null }));
  }, [postMessage]);

  /** 编辑一条已发送的 user 消息并从该点重新生成（issue #44）。乐观更新：本地按
   *  entryId 截断到该消息之前、放入换好文案的 user 气泡（复用后台同款
   *  replaceUserText，附件徽标不闪），随后的权威广播完成收敛。 */
  const editMessage = useCallback((entryId: string, text: string, turn?: TurnSettings) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (!portRef.current) {
      setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      return;
    }
    setState(prev => {
      const index = prev.messages.findIndex(m => m.entryId === entryId);
      if (index < 0) return prev;
      // 剥掉旧 entryId：编辑产生的是尚未落树的新消息，保留旧 id 会与后台
      // 广播帧的「未提交消息无 id」约定冲突
      const { entryId: _stale, ...edited } = {
        ...replaceUserText(prev.messages[index] as Message, text),
        timestamp: Date.now(),
      } as BroadcastMessage;
      return {
        ...prev,
        messages: [...prev.messages.slice(0, index), edited],
        isAgentRunning: true,
        isCompacting: false,
        lastError: null,
      };
    });
    postMessage({ type: 'edit_message', sessionId, entryId, text, model: turn?.model, thinkingLevel: turn?.thinkingLevel });
  }, [postMessage]);

  /** 切换到分支点上的另一个兄弟版本。后台 moveLane + 重投影后以 session_state
   *  （带 branchInfo）广播回来，本地不做乐观切换（树在后台，无从预知目标分支内容）。 */
  const switchBranch = useCallback((targetEntryId: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (!portRef.current) {
      setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      return;
    }
    postMessage({ type: 'switch_branch', sessionId, targetEntryId });
  }, [postMessage]);

  const retry = useCallback((
    turn?: TurnSettings,
    entryId?: string,
  ) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (!portRef.current) {
      setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      return;
    }
    // Optimistic update: locally apply the SAME truncation the background
    // will perform (drop everything after the last user message) and flip
    // `isAgentRunning` to true. Three effects, all immediate:
    //
    //   1. The errored / unwanted assistant bubble disappears right away —
    //      no waiting for the BG round-trip's `session_state` broadcast,
    //      which used to leave the streaming cursor stranded at the end
    //      of the old bubble for ~100–300ms.
    //   2. Retry button hides instantly so a double-click in this window
    //      can't fire a second IPC.
    //   3. Prior `lastError` clears.
    //
    // Multi-window safety: every subscribed window receives the BG's
    // authoritative `session_state` later; this window's local state
    // converges to that broadcast without flicker because the shared
    // `truncateForRetry` helper guarantees we computed the same array.
    // Defensive bail: if there's somehow no user message to retry from,
    // skip the optimistic step and let the background's own no-op path
    // surface the issue (matches BG's defensive throw).
    setState(prev => {
      // 指定轮重试：截到目标 user 消息（含）；缺省沿用最后一轮语义
      const truncated = entryId
        ? (() => {
            const index = prev.messages.findIndex(m => m.entryId === entryId);
            return index >= 0 ? prev.messages.slice(0, index + 1) : null;
          })()
        : truncateForRetry(prev.messages);
      return {
        ...prev,
        messages: truncated ?? prev.messages,
        isAgentRunning: true,
        isCompacting: false,
        lastError: null,
      };
    });
    postMessage({ type: 'retry', sessionId, entryId, model: turn?.model, thinkingLevel: turn?.thinkingLevel });
  }, [postMessage]);

  const subscribe = useCallback((sessionId: string) => {
    const previousSessionId = sessionIdRef.current;
    const isSessionChange = previousSessionId !== sessionId;
    if (isSessionChange) {
      setPendingTools(new Map());
      setPendingPermissions(new Map());
      // 临时诊断：切会话——上一个会话的 t0 与首 token 哨兵（如还在的话）
      // 主动释放，避免持有老锚点。
      if (previousSessionId) {
        pendingTraceT0Ref.current.delete(previousSessionId);
        hookFirstTokenSeenRef.current.delete(previousSessionId);
      }
    }
    sessionIdRef.current = sessionId;
    setState(prev => isSessionChange
      ? {
          ...prev,
          messages: [],
          branchInfo: {},
          isAgentRunning: false,
          isCompacting: false,
          sessionTitle: '',
          lastError: null,
          // 切到另一个已有会话：估算清零（messages 即将被新会话覆盖，保留
          // 旧估算只会让 pill 闪一下旧数字）。contextWindow 留待 useContextUsage
          // 在新会话的 currentModel 落定后通过 setContextWindow 推过来。
          contextTokenEstimate: 0,
        }
      : { ...prev, sessionId });
    postMessage({ type: 'subscribe', sessionId });
  }, [postMessage]);

  // Mirror state.sessionId into sessionIdRef so dispatchPrompt's
  // "sessionIdRef.current === expectedSessionId" guard passes for sessions
  // that arrived via session_loaded (e.g. fork — there's no explicit
  // `subscribe` call, so sessionIdRef would otherwise stay pinned to the
  // source session and dispatchPrompt would silently no-op → user types
  // a message, hits Enter, nothing happens).
  useEffect(() => {
    sessionIdRef.current = state.sessionId;
  }, [state.sessionId]);

  // 用 messages 引用变化来驱动 token 估算刷新。estimateContextTokensForUi
  // 与 BG maybeCompact 同形状（sanitize → lastSummary → sinceLast → estimate），
  // 把 BG 的「真·视图」代价折在每次 messages 引用变的时候。一次 render 的 16ms
  // 滞后对 pill 来说无感——它本来就是按状态变化闪的。BG `compaction_skipped`
  // 广播会在收到时直接把数字覆写到 state（见 handleMessage 内的 case 分支），
  // 下一次 messages 改变时本地又接管。
  useEffect(() => {
    setState(prev => {
      const next = estimateContextTokensForUi(state.messages);
      return prev.contextTokenEstimate === next ? prev : { ...prev, contextTokenEstimate: next };
    });
  }, [state.messages]);

  const unsubscribe = useCallback(() => {
    // Don't reset messages here — that wipes the optimistic user bubble
    // when the chat page re-runs the subscribe-effect after `activeSessionId`
    // flips from null to the new sessionId. The next `subscribe` or the
    // natural in-flow `session_state` will provide the authoritative state.
    sessionIdRef.current = null;
    setState(prev => ({
      ...prev,
      isAgentRunning: false,
      isCompacting: false,
      sessionId: null,
      sessionTitle: '',
      connected: true,
      lastError: null,
      // 卸载会话：contextWindow 跟着清，避免下次挂载到别的会话时短暂保留旧
      // 模型的窗口；estimate 不在这里清——unsubscribe() 保留 prev.messages，
      // 估计仍属当前快照，clearSession() 才是真正全清的场景。
      contextWindow: null,
    }));
    setPendingTools(new Map());
    setPendingPermissions(new Map());
    // 临时诊断：卸载会话——清掉残留的 t0 与首 token 哨兵，避免下一轮 stale 复用。
    pendingTraceT0Ref.current.clear();
    hookFirstTokenSeenRef.current.clear();
    postMessage({ type: 'unsubscribe' });
  }, [postMessage]);

  /**
   * Reset hook state for an explicit "New Chat" navigation by the user.
   * This is heavier than `unsubscribe` — it also clears messages, because
   * the user wants a fresh empty chat. The chat page calls this when
   * navigating to `/chat/new` so the old chat's messages don't linger.
   * Does NOT post any IPC message — purely a local reset.
   */
  const clearSession = useCallback(() => {
    sessionIdRef.current = null;
    setState({
      messages: [],
      branchInfo: {},
      isAgentRunning: false,
      isCompacting: false,
      sessionId: null,
      sessionTitle: '',
      connected: true,
      lastError: null,
      contextOverflow: null,
      contextWindow: null,
      contextTokenEstimate: 0,
    });
    setPendingTools(new Map());
    setPendingPermissions(new Map());
    // 临时诊断：New Chat 导航——清掉残留 t0 与首 token 哨兵。
    pendingTraceT0Ref.current.clear();
    hookFirstTokenSeenRef.current.clear();
  }, []);

  const listSessions = useCallback(() => {
    postMessage({ type: 'session_list' });
  }, [postMessage]);

  const deleteSession = useCallback((sessionId: string) => {
    postMessage({ type: 'session_delete', sessionId });
  }, [postMessage]);

  /**
   * Fork the current session at the assistant message at
   * `atAssistantIndex`. Background creates a new session seeded with ONLY
   * that assistant bubble (no user bubble, no prior turns) and broadcasts
   * `session_created`; the requesting sidepanel's `onSessionCreated`
   * callback handles the navigate-to-new-id + subscribe. Errors propagate
   * via the `error` ServerMessage just like `prompt` / `retry`.
   *
   * Caller is responsible for navigating (we don't navigate here so the
   * hook stays renderer-agnostic). The source session's agent keeps
   * running — fork is a pure copy.
   */
  const resolveTool = useCallback((toolName: string, response: any) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      postMessage({ type: 'resolve_tool', sessionId, toolName, response });
      setPendingTools(prev => {
        const next = new Map(prev);
        next.delete(toolName);
        return next;
      });
    }
  }, [postMessage]);

  const cancelTool = useCallback((toolName: string) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      postMessage({ type: 'cancel_tool', sessionId, toolName });
      setPendingTools(prev => {
        const next = new Map(prev);
        next.delete(toolName);
        return next;
      });
    }
  }, [postMessage]);

  // Answer a tool's pre-execution permission prompt. We do NOT optimistically
  // clear `pendingPermissions` here: the BG resolves the bridge, writes the
  // decision back onto the permissionRequest message, and re-broadcasts a
  // single `session_state` carrying both the decided message AND an empty
  // pendingPermissions — so the card transitions answerable→decided in one
  // atomic update. Clearing locally first would momentarily leave the message
  // as `pending` with no live entry, which `PermissionRequestBlock` would
  // render as the "expired" state — a misleading flash on a valid click.
  const resolvePermission = useCallback(
    (toolCallId: string, decision: 'once' | 'always' | 'denied') => {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        postMessage({ type: 'resolve_permission', sessionId, toolCallId, decision });
      }
    },
    [postMessage],
  );

  return {
    state,
    pendingTools,
    pendingPermissions,
    send,
    cancel,
    retry,
    editMessage,
    switchBranch,
    subscribe,
    unsubscribe,
    clearSession,
    listSessions,
    deleteSession,
    resolveTool,
    cancelTool,
    resolvePermission,
    sendContextOverflowResponse,
    compactNow,
    setContextWindow,
  };
}

/** `useBackgroundAgent()` 的返回类型。导出是为了让组合 hook（典型如
 *  `useContextUsage`）能拿到精确签名——不必自己抄一遍返回 shape，也不必用
 *  `ReturnType<typeof import(...)>` 这种绕开导出的取巧写法。签名漂移时
 *  tsc 直接报红，比手动维护一份近似的 `interface` 更安全。 */
export type UseBackgroundAgentReturn = ReturnType<typeof useBackgroundAgent>;
