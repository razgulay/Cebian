// [DIAG:edit-btn] 渲染时 user-msg 入口诊断：与 hook/BG 的 [DIAG:edit-btn] 配对，
// 确认 render 阶段看到的是 broadcast（带 entryId）还是 prev（被乐观消息顶掉）。
// Bug 修完后删除并改 false。
const __DIAG_EDIT_BTN__ = true;

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
  getLeakedThinking,
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
import { useContextUsage } from '@/components/chat/context/useContextUsage';
import { ContextUsageBadge } from '@/components/chat/context/ContextUsageBadge';
import { useCompactionToasts } from '@/hooks/useCompactionToasts';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import { useStorageItem } from '@/hooks/useStorageItem';
import { lastSelectedModel, lastSelectedThinkingLevel as thinkingLevelStorage, providerCredentials, customProviders, type ModelIdentity, type ThinkingLevel } from '@/lib/persistence/storage';
import { hasUsableModel } from '@/lib/providers/usable-models';
import type { Attachment } from '@/lib/agent/attachments';
import type { SessionSnapshot } from '@/lib/ipc/protocol';
import { debugLog, withSession } from '@/lib/debug/log';
import { startTrace } from '@/lib/debug/trace';
import { t } from '@/lib/i18n';

// ─── ChatPage ───

export function ChatPage({
  onOpenSettings,
  onOpenStorage,
  onTitleChange,
}: {
  onOpenSettings?: () => void;
  onOpenStorage?: () => void;
  onTitleChange?: (title: string) => void;
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

  // 临时诊断：本轮 send→reply 的 trace 句柄。`handleSend` 在派发 tick 捕
  // 获 `t0` 并 ship 给 BG；hook 端按 t0 重建自己的 trace handle（让
  // `source` 与各端 `debugLog` 写入约定对齐——hook 端写 `'hook'`、BG 端写
  // `'bg'`、UI 端写 `'ui'`），BG 端在 session-manager 里也按 t0 起自己
  // 的 handle（避免 renderer 与 SW 的 `performance.now()` 起点不同导致
  // Δt 失真）。`null` = 当前轮没有派发（冷态 / 上一次已完成）。本 ref
  // 仅供本组件生命周期内的同步读取，不持有资源。
  const pendingTraceRef = useRef<ReturnType<typeof startTrace> | null>(null);

  // When the user selects text in an assistant message and clicks the floating
  // Quote button, the formatted `quote <text> quote` blockquote is inserted at
  // the current caret position in the chat input AND surfaced as a small
  // preview chip above the textarea so the user sees the excerpt in a
  // smaller font than the main draft (a plain <textarea> can't render mixed
  // font sizes — the chip is the workaround).
  const handleQuote = useCallback((text: string) => {
    const handle = inputRef.current;
    if (!handle) return;
    if (handle.insertQuote) {
      handle.insertQuote(text);
    } else {
      handle.insertText?.(text);
    }
  }, []);

  // ─── Agent port (all agent/session logic via background) ───
  const agent = useBackgroundAgent({
    onSessionCreated: useCallback((sessionId: string, title: string) => {
      onTitleChange?.(title);
      navigate(`/chat/${sessionId}`, { replace: true });
    }, [navigate, onTitleChange]),
    onSessionLoaded: useCallback((session: SessionSnapshot | null) => {
      if (!session) {
        navigate('/chat/new', { replace: true });
        return;
      }
      // 已有会话：本地草稿 seed 自会话行自己存的选择（而非全局）。模型 / provider
      // 为空（旧会话 / 旧备份）时置 null，让发送门禄拦下来提示用户重选。
      seedTurnFromSession(session.provider, session.model, session.thinkingLevel);
    }, [navigate, seedTurnFromSession]),
    // 重新订阅一个仍有活 agent 的会话时，后台走 session_state（不带完整会话行），
    // 由它单独回传该会话的模型 / 思考档来 seed——与 onSessionLoaded 同样的逻辑。
    onSessionSettings: useCallback((provider: string, model: string, thinkingLevel: string) => {
      seedTurnFromSession(provider, model, thinkingLevel);
    }, [seedTurnFromSession]),
  });

  const {
    state,
    pendingTools,
    pendingPermissions,
    send,
    cancel,
    retry,
    editMessage,
    switchBranch,
    subscribe: portSubscribe,
    unsubscribe: portUnsubscribe,
    clearSession,
    resolveTool,
    resolvePermission,
    sendContextOverflowResponse,
    compactNow,
  } = agent;

  const { messages, branchInfo, isAgentRunning, isCompacting, sessionId: activeSessionId, sessionTitle, lastError } = state;

  // Context-usage 共享视图数据——ChatInput 通过 `usage` prop 消费；调用一次，
  // 整个组件树共享同一份 severity / headroom / compactNow 入口。turnModel 为
  // null 时（用户尚未选模型）→ unknown = true，pill 自然隐藏。
  const usage = useContextUsage(agent, turnModel);

  // Mirror activeSessionId into a ref so the subscribe-effect can read the
  // latest value WITHOUT re-running when activeSessionId changes. Putting
  // activeSessionId in the effect's deps would cause an extra run between
  // session_created (which sets state.sessionId) and navigate (which sets
  // routeSessionId) — at that point isNewChat is still true, so the effect
  // would hit portUnsubscribe() and wipe the optimistic user message.
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

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
    }
  }, [routeSessionId, isNewChat, clearSession]);

  // Sync session title to parent
  useEffect(() => {
    onTitleChange?.(sessionTitle);
  }, [sessionTitle, onTitleChange]);

  // Subtask 5：BG 主动压缩找不到切点时弹 toast 的订阅挂在 chat 表面（与 chat
  // 同生命周期即可），installed flag 守单例，重渲染安全。
  useCompactionToasts();

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

  // Gemini-style send handler: bumps the snap token on successful dispatch.
  const handleSend = useCallback(
    async (text: string, attachments: Attachment[] | undefined, expectedSessionId: string | null, options?: { displayText?: string }) => {
      // 临时诊断：捕获 send→reply 流水线的 `t0` 锚点。锚点通过 IPC 透传给
      // background（让 BG 算出可比 Δt），本地也立刻打 `chat:t0` 作为边界
      // 标记。锚点分配在本 tick（user click → dispatch 之前），反映从用
      // 户点按到第一次派发的真实耗时，而非先 await 再算。`expectedSessionId`
      // 此时可能为 null（新会话），用 `activeSessionId` 或占位 `'new'`——
      // BG 端会按端口绑定后的真实 sessionId 写日志，二者由 sessionId 字
      // 段关联。
      const trace = startTrace('ui', expectedSessionId ?? activeSessionId ?? 'new');
      trace.mark('chat:t0', { textLen: text.length, hasAttach: !!attachments?.length });
      pendingTraceRef.current = trace;
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
      // 把 trace.t0 ship 给 hook：BG 端按 t0 起 bg trace handle，hook 端按
      // t0 重建 hook trace handle；二者源头一致，Δt 在 renderer ↔ BG ↔ hook
      // 三处可对比。trace 句柄本身不需要过 IPC——锚点只是一个 number。
      const result = await send(text, attachments, expectedSessionId, {
        model: turnModel ?? undefined,
        thinkingLevel: turnThinking,
      }, options?.displayText, pendingTraceRef.current?.t0);
      if (result.status === 'dispatched') {
        hasUserOverrideModelRef.current = false;
        hasUserOverrideThinkingRef.current = false;
        setPendingSnapToken((t) => t + 1);
      }
      return result;
    },
    [send, turnModel, turnThinking, isNewChat, routeSessionId, activeSessionId, setSticky],
  );

  // 重试同样携带本轮选中的模型 / 思考档，支持「换个模型再重试」。`entryId` 指定
  // 要重试的那一轮的 user 消息（历史任意轮）；缺省 = 最后一轮。
  const handleRetry = useCallback((entryId?: string) => {
    retry({ model: turnModel ?? undefined, thinkingLevel: turnThinking }, entryId);
  }, [retry, turnModel, turnThinking]);

  // 分支切换：目标是分支点上的兄弟 entry（由消息操作区传入）。
  const handleSwitchBranch = useCallback((targetEntryId: string) => {
    switchBranch(targetEntryId);
  }, [switchBranch]);

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  // 压缩期间隐藏思考占位符，改由专门的压缩状态条提示，避免两个动效重叠。
  const showWaitingPlaceholder = effectiveRunning && !isCompacting && lastMsg && lastMsg.role === 'user';

  // History of user-typed prompts in this session, oldest first; consumed by
  // ChatInput's ↑/↓ navigation. `extractUserText` strips both the
  // `<user-request>` wrapper (added by composeUserMessage) and any inline
  // directive blocks (mention chips / slash commands) so what comes back is
  // exactly what the user typed — never the expanded directive body.
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
              // `msg` is CompactionSummaryMessage：summary 字段是 LLM 输出的
              // Markdown 摘要，tokensBefore 是压缩前估算。把它们传给
              // CompactionDivider，让它能在展开时显示摘要原文 + 节省量徽章。
              return (
                <CompactionDivider
                  key={`compact-${idx}`}
                  summary={{ summary: msg.summary, tokensBefore: msg.tokensBefore }}
                />
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
              // 编辑入口：消息已落树（有 entryId）且 agent 空闲时才提供——
              // 未落树的乐观消息无处可回卷，运行中编辑会与在途轮冲突。
              // UserMessageBubble manages its own inline edit state internally;
              // we just need to wire onEdit to call editMessage(entryId, text).
              const entryId = msg.entryId;
              const canEdit = entryId !== undefined && !isAgentRunning;
              const branch = entryId ? branchInfo[entryId] : undefined;
              return (
                <UserMessageBubble
                  key={`user-${entryId ?? idx}`}
                  msg={msg}
                  isLast={idx === lastUserMsgIndex}
                  onEdit={canEdit && entryId
                    ? (text) => editMessage(entryId, text, {
                        model: turnModel ?? undefined,
                        thinkingLevel: turnThinking,
                      })
                    : undefined}
                  branch={branch
                    ? {
                      index: branch.index,
                      count: branch.count,
                      disabled: isAgentRunning,
                      onPrev: branch.index > 0
                        ? () => handleSwitchBranch(branch.siblings[branch.index - 1])
                        : undefined,
                      onNext: branch.index < branch.count - 1
                        ? () => handleSwitchBranch(branch.siblings[branch.index + 1])
                        : undefined,
                    }
                    : undefined}
                />
              );
            }

            if (msg.role === 'assistant') {
              const assistantMsg = msg as AssistantMessage;
              const thinkingBlocks = getThinkingBlocks(assistantMsg);
              const leakedThinking = getLeakedThinking(assistantMsg);
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

              // Retry：任意已闭合的轮次都可重试（树化后旧回复保留为分支，不再
              // 破坏性截断）。最后一轮沿用旧语义（后台自寻最后一条 user）；历史
              // 轮次需要定位该轮起点的 user 消息 entryId——向前找最近的 user，
              // 找不到（该轮由交互式工具结果驱动等）则不提供入口。
              let turnUserEntryId: string | undefined;
              for (let i = idx - 1; i >= 0; i--) {
                const m = messages[i];
                if (m.role === 'user') {
                  turnUserEntryId = m.entryId;
                  break;
                }
                if (
                  m.role === 'toolResult' &&
                  uiToolRegistry.get((m as ToolResultMessage).toolName)?.renderResultAsUserBubble &&
                  !(m as ToolResultMessage).details?.cancelled
                ) {
                  // 该轮由交互式工具结果开启，无对应 user 消息（被取消的结果对轮
                  // 边界「透明」，与 showHeader 的扫描口径一致）
                  break;
                }
              }
              const canRetry =
                isTurnClosing && !isAgentRunning && (isLast || turnUserEntryId !== undefined);
              const onRetry = canRetry
                ? () => handleRetry(isLast ? undefined : turnUserEntryId)
                : undefined;
              const branch = msg.entryId ? branchInfo[msg.entryId] : undefined;

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
                  key={`asst-wrap-${msg.entryId ?? idx}`}
                  className={isLast && isStreaming ? 'min-h-[calc(100vh-80px)]' : undefined}
                >
                  <AgentMessage
                    key={`asst-${msg.entryId ?? idx}`}
                    isStreaming={isStreaming}
                    showHeader={showHeader}
                    meta={meta}
                    copyText={copyText}
                    onRetry={onRetry}
                    branch={branch
                      ? {
                        index: branch.index,
                        count: branch.count,
                        disabled: isAgentRunning,
                        onPrev: branch.index > 0
                          ? () => handleSwitchBranch(branch.siblings[branch.index - 1])
                          : undefined,
                        onNext: branch.index < branch.count - 1
                          ? () => handleSwitchBranch(branch.siblings[branch.index + 1])
                          : undefined,
                      }
                      : undefined}
                  >
                  {thinkingBlocks.map((block, i) => (
                    <ThinkingBlock key={`t-${idx}-${i}`} content={block.thinking} isLive={isStreaming} />
                  ))}
                  {/* Some providers emit reasoning inline as `<think>...</think>`
                     inside the text content block (instead of a structured
                     `{type: 'thinking'}` block). `getLeakedThinking` extracts
                     those bodies so we render them as collapsible blocks too —
                     otherwise the raw tag would leak into the chat bubble. */}
                  {leakedThinking.map((reasoning, i) => (
                    <ThinkingBlock key={`tl-${idx}-${i}`} content={reasoning} isLive={isStreaming} />
                  ))}
                  {text && <AgentTextBlock content={text} streaming={isStreaming} />}
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

        {/* Floating context-usage badge — anchored absolute bottom-right of
            * the chat scroll container. Lifted out of ChatInput so it sits
            * with the message content (where the eye is already moving)
            * instead of competing with the composer toolbar for horizontal
            * room. `usage` is computed once at the page level via
            * `useContextUsage(agent, turnModel)`; `onCompact` proxies to
            * `agent.compactNow`. The badge owns its own popover open state
            * and compact-button ref — no prop drilling. */}
        <ContextUsageBadge usage={usage} onCompact={() => { compactNow(); }} />

        {!isAtBottom && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Anchored to the LEFT edge so it never overlaps the
                  * context-usage badge (which lives at bottom-right). Both
                  * surfaces are independently positioned so each stays
                  * reachable in its own zone. */}
              <Button
                variant="secondary"
                size="icon"
                aria-label={t('chat.session.scrollToBottom')}
                onClick={() => scrollToBottom({ force: true })}
                className="absolute bottom-3 left-3 size-8 rounded-full shadow-md border border-border/60 bg-background/90 backdrop-blur hover:bg-background"
              >
                <ArrowDown className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('chat.session.scrollToBottom')}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/*
          Inline edit happens inside UserMessageBubble now (upstream's design):
          the bubble toggles its own textarea. ChatInput is purely the
          compose surface for new messages — no edit-mode switching needed.
        */}
        {state.contextOverflow && (
          <div className="mx-2 mb-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2">
            <div className="text-sm font-medium text-destructive">
              {t('chat.session.contextOverflow.title')}
            </div>
            <div className="mt-1 text-xs text-muted-foreground break-all line-clamp-2">
              {state.contextOverflow.lastError}
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() => sendContextOverflowResponse('retry')}
              >
                {t('chat.session.contextOverflow.retry')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => sendContextOverflowResponse('stop')}
              >
                {t('chat.session.contextOverflow.stop')}
              </Button>
            </div>
          </div>
        )}
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
