// Hook: connects sidepanel to background agent manager via chrome.runtime Port.
// Replaces useAgentLifecycle + useSessionManager.

import { useState, useRef, useEffect, useCallback } from 'react';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage, type SessionMeta, type TurnSettings } from '@/lib/ipc/protocol';
import type { SessionRecord } from '@/lib/persistence/db';
import type { Attachment } from '@/lib/agent/attachments';
import type { PermissionRequest } from '@/lib/agent/tool-permissions';
import { truncateForRetry, truncateForEditRerun } from '@/lib/agent/message-helpers';
import { t } from '@/lib/i18n';
import { recorderChannel } from '@/lib/recorder/sidepanel-channel';
import { mcpAppResourceChannel } from '@/lib/mcp/sidepanel-channel';
import { myInstanceId } from '@/lib/ipc/instance-id';
import { debugLog, withSession } from '@/lib/debug/log';

// ─── Helpers ───

/**
 * Rewrite the last user message's text content in a messages array.
 * Used by every broadcast handler that replaces local state — the BG stores
 * the expanded prompt body for slash commands like `/writing`, but the user
 * bubble should show the short command form. Returns the same array reference
 * if no rewrite is needed (no user message present).
 */
function rewriteLastUserMessage(messages: AgentMessage[], displayText: string): AgentMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages;
  const m: any = messages[lastUserIdx];
  const rewritten: any[] = m.content.map((b: any) =>
    b?.type === 'text' ? { ...b, text: displayText } : b,
  );
  const out = [...messages];
  out[lastUserIdx] = { ...m, content: rewritten };
  return out;
}

// ─── State ───

export interface AgentPortState {
  messages: AgentMessage[];
  isAgentRunning: boolean;
  /** 后台正在执行发送前的上下文压缩时为 true。用于驱动一个与普通思考态不同的
   *  「压缩中」指示。 */
  isCompacting: boolean;
  sessionId: string | null;
  sessionTitle: string;
  connected: boolean;
  /** Last error message from the agent, cleared on next prompt. */
  lastError: string | null;
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
  onSessionLoaded?: (session: SessionRecord | null) => void;
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
    isAgentRunning: false,
    isCompacting: false,
    sessionId: null,
    sessionTitle: '',
    connected: false,
    lastError: null,
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
  // Stable callback refs to avoid re-creating the port listener
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
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
          // Apply any pending displayText overrides for slash commands that
          // were expanded at send-time. The BG stored the expanded prompt
          // body, so the authoritative message has the long text; we rewrite
          // the text content back to the short command form the user typed.
          //
          // The entry stays alive for the whole session lifetime — every
          // subsequent broadcast (streaming, message_end, agent_end, etc.)
          // carries the expanded text again, so we must keep rewriting until
          // the user sends a new prompt for the same session (which replaces
          // the entry in dispatchPrompt).
          setState(prev => {
            const pending = pendingDisplayTextRef.current.get(msg.sessionId);
            const mergedMessages = pending ? rewriteLastUserMessage(msg.messages, pending.displayText) : msg.messages;
            return {
              ...prev,
              sessionId: msg.sessionId,
              // Title is only included on initial subscribe (loaded from DB);
              // mid-stream rebuild broadcasts omit it, so preserve the existing
              // value rather than wiping the header.
              ...(msg.title !== undefined ? { sessionTitle: msg.title } : {}),
              // Length-aware merge to avoid a race-condition regression:
              // BG may emit an initial session_state broadcast BEFORE the agent's
              // first user message is fully committed to the in-memory state
              // (right after session_created). Naively overwriting here would
              // wipe the optimistic user bubble (added 0ms ago by dispatchPrompt)
              // and leave the chat looking empty for 2-3s until streaming starts.
              // Accept the broadcast only if it has at least as many messages
              // as our local state — i.e. monotonic with respect to the broadcast.
              // The authoritative final state is still produced by the streaming
              // session_state broadcasts that grow over time, so this never
              // permanently hides data.
              messages: mergedMessages.length >= prev.messages.length ? mergedMessages : prev.messages,
              isAgentRunning: msg.isRunning,
              isCompacting: msg.isCompacting ?? false,
            };
          });
          // 模型字段同样仅首次订阅携带（mid-stream rebuild 省略），用以回填 turn 草稿。
          if (msg.provider !== undefined) {
            callbacksRef.current.onSessionSettings?.(msg.provider, msg.model ?? '', msg.thinkingLevel ?? '');
          }
          break;

        case 'agent_start':
          if (!isCurrentSession(msg.sessionId)) break;
          debugLog.info('bg', 'recv:agent_start', withSession({ sessionId: msg.sessionId }, msg.sessionId));
          setState(prev => ({ ...prev, isAgentRunning: true, isCompacting: false }));
          break;

        case 'message_start' as never: {
          // Forward-compatible stub: BG's IPC protocol doesn't currently
          // emit a dedicated `message_start` event — message lifecycle is
          // bounded by `message_update` / `message_end`. Kept here so that
          // if/when BG adds a start-of-message broadcast, the sidepanel
          // hook will log it without further code changes. Cast the label
          // to `never` so TS doesn't reject the unknown case label.
          const m = msg as unknown as { sessionId?: string; role?: string };
          debugLog.info('bg', 'recv:message_start',
            withSession({ role: m.role ?? '' }, m.sessionId ?? ''));
          break;
        }

        case 'message_update':
          if (!isCurrentSession(msg.sessionId)) break;
          debugLog.info('hook', 'recv:message_update', {
            sessionId: msg.sessionId,
            msgRole: msg.message.role,
            stopReason: (msg.message as { stopReason?: string }).stopReason,
          });
          setState(prev => {
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant') {
              msgs[msgs.length - 1] = msg.message;
            } else {
              msgs.push(msg.message);
            }
            return { ...prev, messages: msgs };
          });
          break;

        case 'message_end':
          if (!isCurrentSession(msg.sessionId)) break;
          debugLog.info('hook', 'recv:message_end', {
            sessionId: msg.sessionId,
            msgsLen: msg.messages.length,
            lastRole: msg.messages.at(-1)?.role,
          });
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
          debugLog.info('hook', 'recv:agent_end', {
            sessionId: msg.sessionId,
            msgsLen: msg.messages.length,
          });
          setState(prev => {
            const pending = pendingDisplayTextRef.current.get(msg.sessionId);
            const rewritten = pending ? rewriteLastUserMessage(msg.messages, pending.displayText) : msg.messages;
            return {
              ...prev,
              // Length-aware merge (see session_state handler for the race
              // rationale). agent_end broadcasts can race with the optimistic
              // user bubble if a session change happens concurrently.
              messages: rewritten.length >= prev.messages.length ? rewritten : prev.messages,
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
          // through `broadcast()` (for `prompt`-born sessions, only ports
          // whose subscribedSession matches the new id) or, for `fork_session`,
          // by iterating ports subscribed to the source session. By the time
          // the message reaches this port, it IS relevant. Without this, the
          // fork flow can't navigate to the new id — `sessionIdRef.current`
          // is the source (the user is still viewing it), but msg.sessionId
          // is the new fork — they'd never match.
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
          // filters, and the `fork_session` handler explicitly targets the
          // port that requested the fork). For a freshly-forked session,
          // BG can deliver `session_loaded` immediately after `session_created`
          // — the React commit on `sessionId` is async, so `sessionIdRef.current`
          // is still the source when this arrives, and the guard would drop
          // the payload → empty UI on the new session.
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
              // Length-aware merge to preserve optimistic user bubble if the DB
              // hasn't flushed the new messages yet
              messages: loadedMessages.length >= prev.messages.length ? loadedMessages : prev.messages,
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
          callbacksRef.current.onSessionDeleted?.(msg.sessionId);
          break;

        case 'error':
          if (msg.sessionId && !isCurrentSession(msg.sessionId)) break;
          console.error('[AgentPort] Error:', msg.error);
          setState(prev => ({ ...prev, isAgentRunning: false, isCompacting: false, lastError: msg.error }));
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
        port = chrome.runtime.connect({ name: AGENT_PORT_NAME });
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
  ): boolean => {
    if (sessionIdRef.current !== expectedSessionId) return false;

    const port = portRef.current;
    if (!port) return false;

    const existingSessionId = sessionIdRef.current;
    const sessionId = existingSessionId ?? crypto.randomUUID();

    try {
      port.postMessage({ type: 'prompt', sessionId, text, attachments, model: turn?.model, thinkingLevel: turn?.thinkingLevel });
    } catch {
      if (portRef.current === port) {
        portRef.current = null;
        recorderChannel.setPort(null);
        mcpAppResourceChannel.setPort(null);
        setState(prev => ({ ...prev, connected: false }));
        scheduleRetryRef.current?.();
      }
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
  ): Promise<PromptDispatchResult> => {
    const trimmed = text.trim();
    if (!trimmed) return { status: 'notDispatched', reason: 'empty' };

    const startedSessionId = expectedSessionId;
    if (dispatchPrompt(trimmed, attachments, startedSessionId, turn, displayText)) return { status: 'dispatched' };

    const connected = await waitForConnected(PROMPT_RECONNECT_TIMEOUT_MS);
    if (!connected || sessionIdRef.current !== startedSessionId) {
      if (sessionIdRef.current === startedSessionId) {
        setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      }
      return { status: 'notDispatched', reason: 'unavailable' };
    }

    if (dispatchPrompt(trimmed, attachments, startedSessionId, turn, displayText)) return { status: 'dispatched' };

    setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
    return { status: 'notDispatched', reason: 'unavailable' };
  }, [dispatchPrompt, waitForConnected]);

  const cancel = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) postMessage({ type: 'cancel', sessionId });
  }, [postMessage]);

  const retry = useCallback((
    turn?: TurnSettings,
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
      const truncated = truncateForRetry(prev.messages);
      return {
        ...prev,
        messages: truncated ?? prev.messages,
        isAgentRunning: true,
        isCompacting: false,
        lastError: null,
      };
    });
    postMessage({ type: 'retry', sessionId, model: turn?.model, thinkingLevel: turn?.thinkingLevel });
  }, [postMessage]);

  const editAndRerun = useCallback((
    messageIndex: number,
    text: string,
    turn?: TurnSettings,
  ) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (!portRef.current) {
      setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      return;
    }
    // Optimistic local slice: same edit-and-truncate the BG will perform.
    // `truncateForEditRerun` is shared between hook and BG so both paths
    // compute the same array; when the authoritative `session_state` arrives
    // we converge to it without flicker.
    //
    // - Defensive bail on null (invalid index / empty text): skip the
    //   optimistic step so we don't strand the UI in a half-edited state.
    //   BG will surface the same error via `error` ServerMessage.
    // - Flipping `isAgentRunning` clears the prior assistant tail and hides
    //   any retry button on the truncated transcript.
    setState(prev => {
      const truncated = truncateForEditRerun(prev.messages, messageIndex, text);
      return {
        ...prev,
        messages: truncated ?? prev.messages,
        isAgentRunning: truncated != null,
        isCompacting: false,
        lastError: null,
      };
    });
    postMessage({
      type: 'edit_rerun',
      sessionId,
      messageIndex,
      text,
      model: turn?.model,
      thinkingLevel: turn?.thinkingLevel,
    });
  }, [postMessage]);

  const subscribe = useCallback((sessionId: string) => {
    const isSessionChange = sessionIdRef.current !== sessionId;
    if (isSessionChange) {
      setPendingTools(new Map());
      setPendingPermissions(new Map());
    }
    sessionIdRef.current = sessionId;
    setState(prev => isSessionChange
      ? {
          ...prev,
          messages: [],
          isAgentRunning: false,
          isCompacting: false,
          sessionTitle: '',
          lastError: null,
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
    }));
    setPendingTools(new Map());
    setPendingPermissions(new Map());
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
      isAgentRunning: false,
      isCompacting: false,
      sessionId: null,
      sessionTitle: '',
      connected: true,
      lastError: null,
    });
    setPendingTools(new Map());
    setPendingPermissions(new Map());
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
  const forkSession = useCallback((atAssistantIndex: number) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    postMessage({ type: 'fork_session', sourceSessionId: sessionId, atAssistantIndex });
  }, [postMessage]);

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
    editAndRerun,
    forkSession,
    subscribe,
    unsubscribe,
    clearSession,
    listSessions,
    deleteSession,
    resolveTool,
    cancelTool,
    resolvePermission,
  };
}
