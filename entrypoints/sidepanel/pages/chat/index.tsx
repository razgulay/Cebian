import { useEffect, useState, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowDown } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// Scope selector used by SelectionQuoteButton to detect text selections
// inside chat messages. Kept in sync with the `role` attribute on the
// messages container rendered below.
const CHAT_MESSAGES_SELECTOR = '[role="chat-messages"]';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { SelectionQuoteButton } from '@/components/chat/SelectionQuoteButton';
import { WelcomeScreen } from '@/components/chat/WelcomeScreen';
import { useChatFontSize } from '@/hooks/useChatFontSize';
import {
  UserMessageBubble,
  AgentMessage,
  AgentTextBlock,
  ThinkingBlock,
  CompactionDivider,
  CompactionPlaceholder,
  PermissionRequestBlock,
} from '@/components/chat/Message';
import { ToolCard } from '@/components/chat/ToolCard';
import { ToolCardWithUI } from '@/components/chat/ToolCardWithUI';
import { isMcpAppResult } from '@/lib/tools/mcp-tool';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  getAssistantText,
  getThinkingBlocks,
  getToolCalls,
  findToolResult,
  extractUserText,
} from '@/lib/agent/message-helpers';
import { getToolLabel } from '@/lib/tools/labels';
import { uiToolRegistry } from '@/lib/tools/ui-registry';
import { isCompactionSummary } from '@/lib/agent/compaction';
import { isPermissionRequest } from '@/lib/agent/tool-permissions';
import { useBackgroundAgent } from '@/hooks/useBackgroundAgent';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import { useStorageItem } from '@/hooks/useStorageItem';
import { lastSelectedModel, lastSelectedThinkingLevel as thinkingLevelStorage, providerCredentials, customProviders, type ModelIdentity, type ThinkingLevel } from '@/lib/persistence/storage';
import { hasUsableModel } from '@/lib/providers/usable-models';
import type { Attachment } from '@/lib/agent/attachments';
import type { SessionRecord } from '@/lib/persistence/db';
import { debugLog, withSession } from '@/lib/debug/log';
import { t } from '@/lib/i18n';

// ─── ChatPage ───

export function ChatPage({
  onOpenSettings,
  onOpenStorage,
  onTitleChange,
  onForkedFromChange,
  pendingScrollToIndex,
  onPendingScrollConsumed,
}: {
  onOpenSettings?: () => void;
  onOpenStorage?: () => void;
  onTitleChange?: (title: string) => void;
  /** Push fork identity (source + branched-at index) up to App so the Header
   *  badge can render it. `forkedAtIndex` is the index in the source's
   *  messages array — used to scroll the source back to the right spot when
   *  the user clicks "Go to original". Null when not on a forked session. */
  onForkedFromChange?: (forkedFrom: { sessionId: string; title: string; forkedAtIndex: number | null } | null) => void;
  /** One-shot scroll target staged by App when the user clicks the fork
   *  badge's back link. ChatPage consumes it in `onSessionLoaded` to scroll
   *  the source's forked bubble to the viewport top, then calls
   *  `onPendingScrollConsumed` to clear the intent. Null on normal navigations. */
  pendingScrollToIndex?: number | null;
  onPendingScrollConsumed?: () => void;
}) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const isNewChat = !routeSessionId || routeSessionId === 'new';
  const navigate = useNavigate();

  // Apply the user-selected chat font size as a CSS variable on the document
  // root so all child elements (Message, MarkdownRenderer, ChatInput) pick
  // it up via `text-[length:var(--chat-font-size)]`.
  useChatFontSize();

  // 本窗口 / 本对话「当前选中的模型 / 思考档」本地草稿。发送 / 重试时随消息带出作
  // turn；新对话从全局种子 seed、已有会话从会话行（onSessionLoaded）seed。不直连全局
  // storage，以免一个窗口切模型影响另一个。
  const [turnModel, setTurnModel] = useState<ModelIdentity | null>(null);
  const [turnThinking, setTurnThinking] = useState<ThinkingLevel>('medium');
  const hasUserOverrideModelRef = useRef(false);
  const hasUserOverrideThinkingRef = useRef(false);

  // 是否存在至少一个可选模型（= 用户至少配好一个 provider）。驱动欢迎页空状态文案：
  // 有 → 显示示例（引导去底部选模型）；无 → 引导去设置。响应式订阅 provider 凭据 /
  // 自定义 provider——用户刚在设置里配好就实时反映，这正是 watch 的正当用途。
  const [creds] = useStorageItem(providerCredentials, {});
  const [customs] = useStorageItem(customProviders, []);
  const canStartChat = useMemo(() => hasUsableModel(creds, customs), [creds, customs]);

  // 新对话：seed 自全局「新对话默认种子」（= 用户上次切到的）。全局种子只是持久化
  // 偏好、不驱动任何实时 UI（真正响应式的是上面的 turn 草稿），故这里直接异步读一次
  // 即可，不用 useStorageItem 订阅——避免 watch 回调的多余重渲染 + 自写触发的 seed
  // 空跑 + 双切闪烁竞态。代价：另一个窗口在新对话里切模型不会实时同步到本窗口的未
  // 动过新对话（WYSIWYG，反而更可预期），种子仍正确写入不丢。
  useEffect(() => {
    if (!isNewChat) return;
    let mounted = true;
    Promise.all([lastSelectedModel.getValue(), thinkingLevelStorage.getValue()]).then(([m, l]) => {
      if (!mounted) return;
      if (!hasUserOverrideModelRef.current) setTurnModel(m);
      if (!hasUserOverrideThinkingRef.current) setTurnThinking(l ?? 'medium');
    });
    return () => { mounted = false; };
  }, [isNewChat]);

  // 重置 user-override 标记 when 切换会话
  useEffect(() => {
    hasUserOverrideModelRef.current = false;
    hasUserOverrideThinkingRef.current = false;
  }, [routeSessionId]);

  // 把会话行存的选择 seed 进本地 turn 草稿。若用户在发送前已手动切了模型/思考档，
  // 优先保留用户的在途选择，避免 session_state 广播将用户刚选的新模型盖回旧模型。
  const seedTurnFromSession = useCallback((provider?: string, model?: string, thinkingLevel?: string) => {
    if (!hasUserOverrideModelRef.current) {
      setTurnModel(provider && model ? { provider, modelId: model } : null);
    }
    if (!hasUserOverrideThinkingRef.current) {
      setTurnThinking((thinkingLevel as ThinkingLevel) || 'medium');
    }
  }, []);

  // 切模型 / 思考档：更新本地草稿 + 标记 user-override + 回写全局种子（供下一个新对话用）。
  const handleModelChange = useCallback((m: ModelIdentity) => {
    hasUserOverrideModelRef.current = true;
    setTurnModel(m);
    void lastSelectedModel.setValue(m);
  }, []);
  const handleThinkingChange = useCallback((l: ThinkingLevel) => {
    hasUserOverrideThinkingRef.current = true;
    setTurnThinking(l);
    void thinkingLevelStorage.setValue(l);
  }, []);

  // 句柄：欢迎页示例卡片通过它把 prompt 填入输入框。
  const inputRef = useRef<ChatInputHandle>(null);

  // When the user selects text in an assistant message and clicks the floating
  // Quote button, the formatted Markdown blockquote is inserted at the current
  // caret position in the chat input. If the input is empty, the blockquote is
  // pasted as-is; if there's existing draft, it's appended after a newline.
  const handleQuote = useCallback((text: string) => {
    inputRef.current?.insertText?.(text);
  }, []);

  // ─── Agent port (all agent/session logic via background) ───
  const {
    state,
    pendingTools,
    pendingPermissions,
    send,
    cancel,
    retry,
    editAndRerun,
    forkSession,
    subscribe: portSubscribe,
    unsubscribe: portUnsubscribe,
    clearSession,
    resolveTool,
    resolvePermission,
  } = useBackgroundAgent({
    onSessionCreated: useCallback((sessionId: string, title: string) => {
      onTitleChange?.(title);
      // Brand-new session from `prompt` — never a fork, so clear the badge.
      onForkedFromChange?.(null);
      navigate(`/chat/${sessionId}`, { replace: true });
    }, [navigate, onTitleChange, onForkedFromChange]),
    onSessionLoaded: useCallback((session: SessionRecord | null) => {
      if (!session) {
        onForkedFromChange?.(null);
        navigate('/chat/new', { replace: true });
        return;
      }
      // Push forked-from identity to App so Header can render the back-link
      // badge. Snapshot is in `session.forkedFrom` (set by forkSession in BG);
      // null/missing means brand-new / non-fork session — clear the badge.
      // `forkedAtIndex` only exists on the new (forked) session, paired with
      // `forkedFrom` — both come from the same fork write, so they travel
      // together. If `forkedFrom` is missing, drop both.
      if (session.forkedFrom) {
        onForkedFromChange?.({
          sessionId: session.forkedFrom.sessionId,
          title: session.forkedFrom.title,
          forkedAtIndex: session.forkedAtIndex ?? null,
        });
      } else {
        onForkedFromChange?.(null);
      }
      // 已有会话：本地草稿 seed 自会话行自己存的选择（而非全局）。模型 / provider
      // 为空（旧会话 / 旧备份）时置 null，让发送门禄拦下来提示用户重选。
      seedTurnFromSession(session.provider, session.model, session.thinkingLevel);

      // One-shot: if App staged a scroll intent (user clicked "Go to
      // original" on a fork badge), honour it here by parking the index in
      // a ref so the layout effect below can scroll to it. We do this AFTER
      // messages have been assigned to state via the hook's session_loaded
      // handler — the bubble DOM nodes exist on the next render. Clear the
      // intent synchronously so subsequent renders don't re-trigger.
      if (pendingScrollToIndex != null) {
        scrollToForkedRef.current = pendingScrollToIndex;
        onPendingScrollConsumed?.();
      }
    }, [navigate, seedTurnFromSession, onForkedFromChange, pendingScrollToIndex, onPendingScrollConsumed]),
    // 重新订阅一个仍有活 agent 的会话时，后台走 session_state（不带完整会话行），
    // 由它单独回传该会话的模型 / 思考档来 seed——与 onSessionLoaded 同样的逻辑。
    onSessionSettings: useCallback((provider: string, model: string, thinkingLevel: string) => {
      seedTurnFromSession(provider, model, thinkingLevel);
    }, [seedTurnFromSession]),
  });

  const { messages, isAgentRunning, isCompacting, sessionId: activeSessionId, sessionTitle, lastError } = state;

  // Mirror activeSessionId into a ref so the subscribe-effect can read the
  // latest value WITHOUT re-running when activeSessionId changes. Putting
  // activeSessionId in the effect's deps would cause an extra run between
  // session_created (which sets state.sessionId) and navigate (which sets
  // routeSessionId) — at that point isNewChat is still true, so the effect
  // would hit portUnsubscribe() and wipe the optimistic user message.
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  // One-shot scroll target for the "Go to original" flow. Set in
  // `onSessionLoaded` when App stages `pendingScrollToIndex` (the index of
  // the assistant bubble IN THE SOURCE that this fork branched from). Read
  // by a layout effect below that scrolls the matching bubble to the
  // viewport top instead of the default "scroll to bottom on session
  // switch". Declared here (vs. next to its only setter/useEffect) so the
  // `onSessionLoaded` callback closure can reference it without a TS
  // "used before declaration" hazard.
  const scrollToForkedRef = useRef<number | null>(null);

  // When an interactive tool (e.g. ask_user) OR a permission prompt is pending,
  // the agent is blocked waiting for user input — treat as "not running" so the
  // composer stays usable. For permissions this is deliberate: sending a message
  // while a prompt is pending is the implicit "dismiss" (non-grant) path, handled
  // by steer + bridge cancel in the background.
  const effectiveRunning = isAgentRunning && pendingTools.size === 0 && pendingPermissions.size === 0;

  // Subscribe to existing session or unsubscribe for new chat.
  //
  // Critical: the effect must NOT depend on `activeSessionId` — when user sends
  // the first message in a new chat, `activeSessionId` flips from null to the
  // new sessionId. If this effect re-ran, the `portUnsubscribe()` branch
  // (taken because `isNewChat` is still true) would reset hook state and
  // wipe the optimistic user bubble for 2-3 seconds. The hook is already
  // implicitly subscribed to the new sessionId via the 'prompt' handler's
  // sessionId-binding on the BG port; we just need to NOT touch it from
  // this effect.
  //
  // Subscription should only happen when the user explicitly navigates to
  // an *existing* session route. The original dep `activeSessionId` was a
  // bug — it caused a re-subscribe (or unsubscribe) on every session-id change,
  // racing with the in-flight prompt dispatch. Only react to `routeSessionId`
  // changes — the URL.
  useEffect(() => {
    if (isNewChat) {
      // New chat: don't touch the port subscription. The 'prompt' handler in
      // BG pins the subscription when the user sends. The hook's sessionIdRef
      // will be set to the new id on the next render.
      return;
    }
    if (routeSessionId && routeSessionId !== activeSessionIdRef.current) {
      portSubscribe(routeSessionId);
    }
  }, [routeSessionId, isNewChat, portSubscribe, portUnsubscribe]);

  // When the user clicks "New Chat" the same ChatPage component instance is
  // reused (React Router doesn't remount when navigating between two routes
  // that share a component). So we must explicitly clear hook state when the
  // route becomes `/chat/new`, otherwise the previous chat's messages
  // linger behind the welcome screen.
  useEffect(() => {
    if (isNewChat) {
      clearSession();
      // /chat/new has no session row, so no "forked from" badge. Without
      // this reset, navigating from a forked chat directly to /chat/new
      // (e.g. via the header's "New chat" button) would leave the previous
      // fork badge stuck on the empty welcome screen — the IPC callbacks
      // only fire on session_created/loaded, and neither runs on /chat/new.
      onForkedFromChange?.(null);
    }
  }, [routeSessionId, isNewChat, clearSession, onForkedFromChange]);

  // Sync session title to parent
  useEffect(() => {
    onTitleChange?.(sessionTitle);
  }, [sessionTitle, onTitleChange]);

  // Auto-scroll: Gemini-style prompt top-alignment.
  // When a new prompt is sent, `scrollToUserPrompt` aligns the user's question to the
  // top of the viewport and UNSTICKS from the bottom. Streaming output generates below
  // without yanking the scrollbar down, allowing the user to read from top to bottom.
  const { scrollRef, isAtBottom, scrollToBottom, scrollToUserPrompt, setSticky } = useStickToBottom();

  // Force-pin to bottom when switching sessions or opening a fresh chat.
  // NOTE: `effectiveRunning` is intentionally NOT in the dependency array.
  // When LLM finishes streaming, `effectiveRunning` flips from `true` to
  // `false` — if we re-ran this effect on that flip, we'd yank the viewport
  // back to the bottom of the chat, defeating the Gemini-style "prompt
  // pinned at top" UX. We only want to scroll-to-bottom when the user
  // explicitly switches sessions or opens a new chat.
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeSessionId === prevSessionIdRef.current) return;

    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = activeSessionId;

    // Skip scroll-to-bottom if we are just transitioning from a brand new chat (null)
    // to its newly created ID (activeSessionId). The optimistic user message is already
    // snapped to the top; forcing scroll to bottom here would push it off-screen
    // down to the spacer for ~2s while the LLM loads.
    if (!prev && activeSessionId) {
      return;
    }

    // Skip for fork-style transitions: switching to a session that has no
    // user message yet (e.g. a freshly forked session containing only an
    // assistant bubble). Force-scrolling to bottom would push the bubble
    // off-screen into empty space; the user will type their next prompt
    // and natural scroll-to-bottom (driven by the input + streaming) will
    // follow.
    if (lastUserMsgIndex === -1) {
      return;
    }

    // Skip when a "Go to original" scroll intent is pending: the layout
    // effect below will scroll to the forked bubble instead of the bottom.
    // The ref is cleared synchronously by the layout effect after it fires,
    // so this just gates the default scroll-to-bottom exactly once.
    if (scrollToForkedRef.current != null) {
      return;
    }

    scrollToBottom({ force: true });
  }, [activeSessionId, scrollToBottom]);

  // Index of the latest user message in the session
  const lastUserMsgIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  }, [messages]);

  // Token incremented each time the user sends a new prompt. Drives the
  // Gemini-style "snap to top on send" effect below. Using a counter (rather
  // than a boolean flag) makes the effect robust to rapid double-sends
  // (e.g. retry + enter) — each dispatch bumps the token, the effect fires
  // once per dispatch, and an in-flight snap doesn't get swallowed.
  const [pendingSnapToken, setPendingSnapToken] = useState(0);

  // Snap-to-top effect: when a new prompt is dispatched, run
  // `scrollToUserPrompt` synchronously via useLayoutEffect. This measures the
  // new DOM nodes (user bubble + bottom spacer) and adjusts the scroll position
  // before the browser paints the frame. This completely eliminates the visual
  // jump that occurs if we wait for requestAnimationFrame.
  useLayoutEffect(() => {
    if (pendingSnapToken === 0) return;
    scrollToUserPrompt();
  }, [pendingSnapToken, scrollToUserPrompt]);

  // "Go to original" effect: when the user clicks the fork badge's back link,
// App stages `pendingScrollToIndex` (the index in the source's messages
// array of the assistant bubble that was forked). `onSessionLoaded` parks
// it in `scrollToForkedRef`, then this layout effect runs after the source
// bubble DOM is committed, scrolls it to the viewport top with 16px of
// breathing room, and disarms auto-stick. The ref itself is NOT cleared
// here — see the follow-up useEffect below for the clear, sequenced AFTER
// the scroll-to-bottom effect so that effect can also see the intent and
// skip its default force-scroll.
//
// Why a layout effect (not a regular one): we want the scroll to happen
// BEFORE the browser paints the frame, so the user never sees the source
// land at the bottom. Mirrors why `pendingSnapToken` also uses layout.
useLayoutEffect(() => {
    const targetIdx = scrollToForkedRef.current;
    if (targetIdx == null) return;
    // The ScrollArea wraps its viewport in a div with data-slot="scroll-area-viewport"
    // — the actual scrolling element. `scrollRef` points at the wrapper.
    const viewport = scrollRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;
    if (!viewport) return;
    const el = viewport.querySelector(
      `[data-forked-source-idx="${targetIdx}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    // Disarm auto-stick so the upcoming assistant content (if any) doesn't
    // yank the viewport back to the bottom.
    setSticky(false);
    const viewportRect = viewport.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const desiredTopOffset = 16;
    const currentDiff = elRect.top - viewportRect.top;
    const targetScrollTop = viewport.scrollTop + (currentDiff - desiredTopOffset);
    const finalScrollTop = Math.max(0, targetScrollTop);
    viewport.scrollTop = finalScrollTop;
    debugLog.info('ui', 'fork:scroll-to-source',
      withSession({
        targetIdx,
        currentDiffPx: Math.round(currentDiff),
        targetScrollTopPx: Math.round(finalScrollTop),
        viewportHeightPx: Math.round(viewportRect.height),
      }, activeSessionId ?? ''));
  }, [messages, setSticky, activeSessionId]);

  // Clear the forked-scroll intent AFTER the scroll-to-bottom effect has
  // had its chance to skip. Both effects re-run on the same render commit
  // (scroll-to-bottom because `activeSessionId` changed; this one because
  // `messages` changed), so we need to sequence them by hook type — layout
  // effects run synchronously before regular effects. By the time this
  // useEffect fires, the scroll-to-bottom useEffect above has already
  // checked `scrollToForkedRef.current` and skipped, so it's safe to clear.
  useEffect(() => {
    if (scrollToForkedRef.current == null) return;
    // Schedule the clear for after this commit cycle so subsequent renders
    // don't accidentally re-read the intent. Setting it null synchronously
    // here is also fine since the scroll-to-bottom effect has already
    // fired (or skipped) by this point.
    scrollToForkedRef.current = null;
  }, [messages]);

  // Gemini-style send handler: bumps the snap token on successful dispatch.
  const handleSend = useCallback(
    async (text: string, attachments: Attachment[] | undefined, expectedSessionId: string | null, options?: { displayText?: string }) => {
      debugLog.info('ui', 'chat:handle_send',
        withSession({ sessionId: expectedSessionId ?? '', textLen: text.length }, expectedSessionId ?? ''));
      if (!isNewChat && routeSessionId !== activeSessionId) {
        return { status: 'notDispatched', reason: 'unavailable' } as const;
      }
      // CRITICAL: disarm auto-stick SYNCHRONOUSLY (BEFORE the await). The
      // ResizeObserver in useStickToBottom fires on the next React commit,
      // and with stickRef=true it would scroll to scrollHeight — yanking the
      // optimistic user bubble far off the bottom of the viewport. Setting
      // it false here (same tick as the user input) means the observer's
      // next tick is a no-op and the user bubble stays at the top.
      setSticky(false);
      const result = await send(text, attachments, expectedSessionId, {
        model: turnModel ?? undefined,
        thinkingLevel: turnThinking,
      }, options?.displayText);
      if (result.status === 'dispatched') {
        hasUserOverrideModelRef.current = false;
        hasUserOverrideThinkingRef.current = false;
        setPendingSnapToken((t) => t + 1);
      }
      return result;
    },
    [send, turnModel, turnThinking, isNewChat, routeSessionId, activeSessionId, setSticky],
  );

  // 重试同样携带本轮选中的模型 / 思考档，支持「换个模型再重试」。
  const handleRetry = useCallback(() => {
    debugLog.info('ui', 'send:retry',
      withSession({ sessionId: activeSessionId ?? '' }, activeSessionId ?? ''));
    hasUserOverrideModelRef.current = false;
    hasUserOverrideThinkingRef.current = false;
    retry({ model: turnModel ?? undefined, thinkingLevel: turnThinking });
    setSticky(false);
    setPendingSnapToken((t) => t + 1);
  }, [retry, turnModel, turnThinking, setSticky, activeSessionId]);

  // ─── Edit + rerun ───
  // Click the pencil on any user message → dialog opens with the extracted
  // user text pre-filled. Submit dispatches `editAndRerun` to the BG; BG
  // replaces the <user-request> at that index, drops everything after it,
  // and resumes the agent. Multi-window safe because the BG's broadcast
  // reconciles every subscriber.
  //
  // `editingIndex` doubles as "is dialog open"; we never display two dialogs
  // at once. While the agent is running, edits are blocked — the BG's phase
  // guard would silently no-op anyway, but hiding the UI is friendlier.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const editingMessage = editingIndex != null ? messages[editingIndex] : null;
  const editingText = editingMessage && editingMessage.role === 'user' ? extractUserText(editingMessage) : '';
  const [editDraft, setEditDraft] = useState('');

  const openEdit = useCallback((index: number) => {
    const m = messages[index];
    if (!m || m.role !== 'user') return;
    setEditDraft(extractUserText(m));
    setEditingIndex(index);
  }, [messages]);

  const closeEdit = useCallback(() => {
    setEditingIndex(null);
    setEditDraft('');
  }, []);

  const submitEdit = useCallback(() => {
    if (editingIndex == null) return;
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    debugLog.info('ui', 'send:edit_resubmit',
      withSession({ sessionId: activeSessionId ?? '', targetIdx: editingIndex }, activeSessionId ?? ''));
    editAndRerun(editingIndex, trimmed, {
      model: turnModel ?? undefined,
      thinkingLevel: turnThinking,
    });
    closeEdit();
    setSticky(false);
    setPendingSnapToken((t) => t + 1);
  }, [editingIndex, editDraft, editAndRerun, turnModel, turnThinking, closeEdit, setSticky, activeSessionId]);

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  // 压缩期间隐藏思考占位符，改由专门的压缩状态条提示，避免两个动效重叠。
  const showWaitingPlaceholder = effectiveRunning && !isCompacting && lastMsg && lastMsg.role === 'user';

  // History of user-typed prompts in this session, oldest first; consumed by
  // ChatInput's ↑/↓ navigation. Strips the <user-request> wrapper added by
  // composeUserMessage so what comes back is exactly what the user typed.
  const userHistory = useMemo(
    () => messages
      .filter((m): m is UserMessage => m.role === 'user')
      .map(extractUserText)
      .filter((s) => s.length > 0),
    [messages],
  );

  // Session loading state: any route/state mismatch means the current
  // message array belongs to a different chat and must not be rendered.
  const sessionLoading = !isNewChat && routeSessionId !== activeSessionId;

  return (
    <>
      <div className="flex-1 min-h-0 relative flex flex-col">
        <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
          <div role="chat-messages" className="flex min-h-full flex-col gap-3 px-4 py-3">
            {sessionLoading && (
              <div className="text-center text-sm text-muted-foreground py-12">
                {t('chat.session.loading')}
            </div>
          )}

          {!sessionLoading && messages.map((msg, idx) => {
            if (isCompactionSummary(msg)) {
              return (
                <CompactionDivider key={`compact-${idx}`} />
              );
            }

            if (isPermissionRequest(msg)) {
              // isLive = 后台有活 agent 正等这次授权（按 toolCallId 匹配）。
              // 查不到 → 失效态（如 SW 重启后），卡片置灰且按钮禁用。
              const isLive = pendingPermissions.has(msg.toolCallId);
              return (
                <PermissionRequestBlock
                  key={`perm-${msg.toolCallId}`}
                  title={msg.title}
                  permissions={msg.permissions}
                  decision={msg.decision}
                  isLive={isLive}
                  onResolve={isLive ? (decision) => resolvePermission(msg.toolCallId, decision) : undefined}
                />
              );
            }

            if (msg.role === 'user') {
              const isLastUser = idx === lastUserMsgIndex;
              return (
                <div
                  key={`user-wrap-${idx}`}
                  data-user-message={isLastUser ? 'last' : 'true'}
                  className={isLastUser ? 'pl-[1.5cm] pr-4' : undefined}
                >
                  <UserMessageBubble
                    key={`user-${idx}`}
                    msg={msg}
                    onEdit={effectiveRunning ? undefined : () => openEdit(idx)}
                  />
                </div>
              );
            }

            if (msg.role === 'assistant') {
              const assistantMsg = msg as AssistantMessage;
              const thinkingBlocks = getThinkingBlocks(assistantMsg);
              const text = getAssistantText(assistantMsg);
              const toolCalls = getToolCalls(assistantMsg);
              const isLast = idx === messages.length - 1;
              // 压缩期间 session_state 仍带 isRunning:true，但本轮还没真正开始流式输出，
              // 须插 !isCompacting 防止在已写完的上一条 assistant 末尾点亮流式光标。
              const isStreaming = isLast && effectiveRunning && !isCompacting;
              const isError = assistantMsg.stopReason === 'error';
              // Aborted: either user clicked stop while streaming (pi-agent-core
              // appends the marker naturally inside `handleRunFailure`), or
              // user clicked stop while a retry was preparing (the background's
              // `commitRetryCancel` appends the same shape manually). One
              // rendering rule covers both paths.
              const isAborted = assistantMsg.stopReason === 'aborted';

              // Show header only for the first assistant message in a consecutive group
              let showHeader = true;
              for (let i = idx - 1; i >= 0; i--) {
                const prev = messages[i];
                if (prev.role === 'toolResult') {
                  const tr = prev as ToolResultMessage;
                  const info = uiToolRegistry.get(tr.toolName);
                  if (info?.renderResultAsUserBubble && !tr.details?.cancelled) break;
                  continue;
                }
                // 权限卡片是这一轮中间插入的授权环节，对头折叠「透明」：穿透它
                // 继续往前看，避免把本来连续的 assistant 块劈成两轮、长出重复的头。
                if (isPermissionRequest(prev)) continue;
                if (prev.role === 'assistant') showHeader = false;
                break;
              }

              // Meta row: show only on the assistant message that *closes*
              // the turn (stopReason !== 'toolUse'), so multi-tool-round
              // turns get one consolidated meta at the very end instead of
              // one per intermediate model call. The closing message is
              // also the only one whose timing represents the whole turn.
              const turnEnded = !isLast || !isAgentRunning;
              const isTurnClosing =
                turnEnded && assistantMsg.stopReason !== 'toolUse';
              const plainText = getAssistantText(assistantMsg).trim();
              const copyText = isTurnClosing && plainText.length > 0 ? plainText : undefined;

              // Aggregate usage across all assistant messages of this turn
              // (walk back to the most recent user message). Each tool round
              // is its own LLM call with its own usage; users want the sum.
              let meta: Parameters<typeof AgentMessage>[0]['meta'];
              if (isTurnClosing) {
                let inputTokens = 0;
                let outputTokens = 0;
                let cacheReadTokens = 0;
                let cacheWriteTokens = 0;
                for (let i = idx; i >= 0; i--) {
                  const m = messages[i];
                  if (m.role === 'user') break;
                  if (m.role === 'assistant') {
                    const am = m as AssistantMessage;
                    inputTokens += am.usage?.input ?? 0;
                    outputTokens += am.usage?.output ?? 0;
                    cacheReadTokens += am.usage?.cacheRead ?? 0;
                    cacheWriteTokens += am.usage?.cacheWrite ?? 0;
                  }
                }
                meta = {
                  modelLabel: assistantMsg.model,
                  inputTokens: inputTokens || undefined,
                  outputTokens: outputTokens || undefined,
                  cacheReadTokens: cacheReadTokens || undefined,
                  cacheWriteTokens: cacheWriteTokens || undefined,
                };
              }

              // Retry button: only on the very last message in the timeline,
              // only when the turn has actually closed (no pending tool round),
              // and only when the agent is idle (no overlapping run).
              const canRetry = isLast && isTurnClosing && !isAgentRunning;
              const onRetry = canRetry ? handleRetry : undefined;

              // Fork button: any turn-closing assistant (not just the last),
              // so users can branch from any past response. The new session
              // contains ONLY this assistant bubble — no user bubble, no
              // prior turns. The BG walks back to find the trigger user
              // message for the title only.
              const canFork = isTurnClosing && !isAgentRunning;
              const onFork = canFork ? () => {
                // Log the click so we can correlate dispatch → BG IPC → DB
                // write. Without this we have no idea whether a missing
                // fork was caused by the click never firing, the IPC
                // dropping, or the BG rejecting the index.
                debugLog.info('ui', 'fork:button-click',
                  withSession({ atAssistantIndex: idx, isLast, isTurnClosing }, activeSessionId ?? ''));
                forkSession(idx);
              } : undefined;

              // The trailing assistant wrap must reserve at least one
              // viewport of height so the sticky last-user bubble above
              // always has scroll space to pin to top, even when the
              // response is short and there's nothing else to scroll
              // over. Without this min-height, short chats collapse the
              // sticky bubble back to its natural position (bottom of the
              // content), defeating the "user bubble pinned, response
              // streams below" UX. The 80px subtracts the header so a full
              // viewport of scroll is available above the bottom edge.
              return (
                <div
                  key={`asst-wrap-${idx}`}
                  // data-forked-source-idx lets the "Go to original" scroll
                  // effect (set up in `useStickToForked`) find this exact
                  // bubble in the source after the user clicks the back
                  // link on the fork's badge. Set on EVERY assistant bubble
                  // — index is unique within the messages array, the cost
                  // is a single attribute per bubble, and the source only
                  // ever needs to scroll to one of them.
                  data-forked-source-idx={idx}
                  className={isLast && isStreaming ? 'min-h-[calc(100vh-80px)]' : undefined}
                >
                  <AgentMessage
                    key={`asst-${idx}`}
                    isStreaming={isStreaming}
                    isThinking={isStreaming && thinkingBlocks.length > 0 && !text}
                    showHeader={showHeader}
                    meta={meta}
                    copyText={copyText}
                    onRetry={onRetry}
                    onFork={onFork}
                  >
                  {thinkingBlocks.map((block, i) => (
                    <ThinkingBlock key={`t-${idx}-${i}`} content={block.thinking} isLive={isStreaming} />
                  ))}
                  {text && <AgentTextBlock content={text} />}
                  {isError && (
                    <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 mt-2 whitespace-pre-wrap break-all">
                      {assistantMsg.errorMessage ?? t('chat.session.modelError')}
                    </div>
                  )}
                  {/* Generic tool rendering */}
                  {toolCalls.map((tc) => {
                    const uiInfo = uiToolRegistry.get(tc.name);

                    // Interactive tool — render via UI registry
                    if (uiInfo) {
                      const pending = pendingTools.get(tc.name);
                      const isPending = !!pending && pending.toolCallId === tc.id;
                      const toolResult = findToolResult(messages, tc.id);
                      return (
                        <uiInfo.Component
                          key={`tool-${tc.id}`}
                          toolCallId={tc.id}
                          args={tc.arguments}
                          isPending={isPending}
                          toolResult={toolResult}
                          onResolve={isPending ? (response: any) => resolveTool(tc.name, response) : undefined}
                        />
                      );
                    }

                    // Non-interactive tool — render as ToolCard
                    const toolResult = findToolResult(messages, tc.id);

                    // MCP App branch: if the tool result carries a UI
                    // resource reference (set by `createMCPAgentTool`
                    // when the original tool declared `_meta.ui.resourceUri`),
                    // swap to ToolCardWithUI for inline iframe render.
                    // While the result is still in-flight, fall through
                    // to ToolCard so the spinner shows — switching only
                    // once we have something to feed the iframe.
                    //
                    // Use a structural guard rather than a cast: `details`
                    // is `any` (per `ToolResultMessage<TDetails = any>`),
                    // so a truthy check would let a corrupted IDB row or
                    // an off-spec server's bogus payload reach the iframe
                    // and produce a vague fetch failure downstream.
                    if (toolResult?.details && isMcpAppResult(toolResult.details)) {
                      // Synthesise the SDK's `CallToolResult` wire shape
                      // from the existing message fields — we deliberately
                      // don't persist a second copy on `details.mcpApp`,
                      // see JSDoc on `MCPAppDetails` for the storage
                      // motivation.
                      const synthesizedToolResult: CallToolResult = {
                        content: toolResult.content as CallToolResult['content'],
                        ...(toolResult.details.structured !== undefined
                          ? { structuredContent: toolResult.details.structured as Record<string, unknown> }
                          : {}),
                        isError: toolResult.isError,
                      };
                      return (
                        <ToolCardWithUI
                          key={`tool-${tc.id}`}
                          label={getToolLabel(tc.name, tc.arguments)}
                          // Real MCP tool name (e.g. `create_diagram`), not
                          // the agent-runtime slug `mcp__drawio__create_diagram`.
                          // The slug is sanitized for provider name limits;
                          // the View receives this via `ui/notifications/tool-*`
                          // and SEP-1865 expects the real name so apps that
                          // dispatch on `tool` recognise it.
                          toolName={toolResult.details.tool}
                          serverId={toolResult.details.server.id}
                          mcpApp={toolResult.details.mcpApp}
                          toolResult={synthesizedToolResult}
                        />
                      );
                    }

                    const status = toolResult
                      ? (toolResult.isError ? 'error' : 'done')
                      : (isAborted ? 'cancelled' : 'running');
                    const label = getToolLabel(tc.name, tc.arguments);
                    const argsStr = JSON.stringify(tc.arguments, null, 2);
                    const resultText = toolResult
                      ? toolResult.content
                          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                          .map(b => b.text)
                          .join('\n') || undefined
                      : undefined;
                    const resultImages = toolResult
                      ? toolResult.content
                          .filter((b): b is { type: 'image'; data: string; mimeType: string } => b.type === 'image')
                      : undefined;
                    return (
                      <ToolCard
                        key={`tool-${tc.id}`}
                        label={label}
                        status={status}
                        args={argsStr}
                        result={resultText}
                        images={resultImages}
                      />
                    );
                  })}
                  {/* Cancelled marker sits after the tool cards, matching the text -> tool card -> cancelled timeline */}
                  {isAborted && (
                    <div className="text-xs text-muted-foreground/80 italic mt-2">
                      {t('chat.session.cancelled')}
                    </div>
                  )}
                </AgentMessage>
                </div>
              );
            }

            // Generic: render interactive tool results as user bubbles
            if (msg.role === 'toolResult') {
              const tr = msg as ToolResultMessage;
              const info = uiToolRegistry.get(tr.toolName);
              if (info?.renderResultAsUserBubble && !tr.details?.cancelled) {
                const text = tr.content
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map(b => b.text)
                  .join('');
                if (text) {
                  return (
                    <UserMessageBubble key={`tr-${idx}`}>
                      {text}
                    </UserMessageBubble>
                  );
                }
              }
              return null;
            }

            return null;
          })}

          {/* Waiting placeholder */}
          {showWaitingPlaceholder && (
            <div className="min-h-[calc(100vh-80px)]">
              <AgentMessage isStreaming />
            </div>
          )}

          {/* Compaction in-progress placeholder: normal Cebian Agent shell + grey italic status */}
          {isCompacting && <CompactionPlaceholder />}

          {/* Error display */}
          {lastError && !isAgentRunning && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              {lastError}
            </div>
          )}

          {!sessionLoading && messages.length === 0 && !isAgentRunning && (
            <WelcomeScreen
              hasModel={canStartChat}
              onPickExample={(prompt) => inputRef.current?.fill(prompt)}
              onOpenSettings={() => onOpenSettings?.()}
            />
          )}

          {/* Bottom scroll spacer.
              When generating, we need a large spacer so `scrollToUserPrompt` can snap
              the user bubble to the top, providing room for the AI text to stream below
              it without forcing the user to scroll.
              Once generation finishes, the spacer smoothly collapses to 0 so the user
              doesn't see a massive empty space at the bottom of the chat. */}
          {!sessionLoading && messages.length > 0 && (
            <div
              className="shrink-0 transition-[height] duration-500 ease-in-out"
              style={{ height: isAgentRunning ? '60vh' : '0px' }}
              aria-hidden
            />
          )}
        </div>
      </ScrollArea>

        {!isAtBottom && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label={t('chat.session.scrollToBottom')}
                onClick={() => scrollToBottom({ force: true })}
                className="absolute bottom-3 right-3 size-8 rounded-full shadow-md border border-border/60 bg-background/90 backdrop-blur hover:bg-background"
              >
                <ArrowDown className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('chat.session.scrollToBottom')}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <ChatInput
        ref={inputRef}
        onSend={handleSend}
        onCancel={cancel}
        isAgentRunning={effectiveRunning}
        onOpenSettings={onOpenSettings}
        onOpenStorage={onOpenStorage}
        userHistory={userHistory}
        sessionId={isNewChat ? activeSessionId : routeSessionId ?? null}
        model={turnModel}
        thinkingLevel={turnThinking}
        onModelChange={handleModelChange}
        onThinkingChange={handleThinkingChange}
      />

      <Dialog open={editingIndex != null} onOpenChange={(open) => { if (!open) closeEdit(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('chat.edit.title')}</DialogTitle>
            <DialogDescription>{t('chat.edit.description')}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            className="min-h-32"
            autoFocus
            onFocus={(e) => {
              // Caret mặc định ở đầu khi autoFocus; đẩy về cuối để user
              // có thể gõ tiếp mà không phải bấm End.
              const target = e.currentTarget;
              const len = target.value.length;
              target.setSelectionRange(len, len);
            }}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits, Escape cancels — same affordances
              // as the chat composer for muscle-memory continuity.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                submitEdit();
              }
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={closeEdit}>{t('common.cancel')}</Button>
            <Button
              onClick={submitEdit}
              disabled={editDraft.trim().length === 0 || editDraft === editingText}
            >
              {t('chat.edit.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Floating "Quote" button — appears whenever the user selects text
          inside a chat message. Clicking it inserts the formatted Markdown
          blockquote into the chat input via the `handleQuote` callback. */}
      <SelectionQuoteButton
        scopeSelector={CHAT_MESSAGES_SELECTOR}
        onQuote={handleQuote}
      />
    </>
  );
}
