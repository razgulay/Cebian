import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { browser } from 'wxt/browser';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { DialogOutlet } from '@/components/dialogs/outlet';
import { ConfirmOutlet } from '@/components/dialogs/confirm-outlet';
import { UpdateNoticeOutlet } from '@/components/dialogs/update-notice-outlet';
import { Header } from '@/components/layout/Header';
import { HistoryPanel } from '@/components/layout/HistoryPanel';
import { useStorageItem } from '@/hooks/useStorageItem';
import { useChangelogOnUpdate } from '@/hooks/useChangelogOnUpdate';
import { useChatFontSize } from '@/hooks/useChatFontSize';
import { themePreference, lastOpenSessionId } from '@/lib/persistence/storage';
import { debugLog, withSession } from '@/lib/debug/log';
import { ChatPage } from './pages/chat';
import { useSidePanelToggle } from './useSidePanelToggle';
import { useSidePanelHandoff } from './useSidePanelHandoff';

// Lazy-load Settings: pulls in CodeMirror, react-arborist, lightning-fs,
// all provider/MCP forms, etc. — a large chunk that's only needed once
// the user opens /settings. Keeping it out of the sidepanel's initial
// bundle is the single biggest first-paint win.
const SettingsRoutes = lazy(() =>
  import('./pages/settings').then(m => ({ default: m.SettingsRoutes })),
);

/** Resolve 'system' to the actual theme based on OS preference (defaults to 'light'). */
function resolveTheme(pref: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', resolved);
}

function App() {
  const [theme, setTheme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatTitle, setChatTitle] = useState('');
  // Source identity snapshot for the currently-viewed chat. Drives the
  // Header's "Forked from: <title>" badge + back link. Null = brand-new or
  // non-fork session (no badge). Reset to null on /chat/new by ChatPage's
  // session_loaded callback when no session resolves, mirroring how
  // `chatTitle` is cleared on the same path.
  //
  // `forkedAtIndex` is the index of the assistant bubble IN THE SOURCE that
  // this fork branched from. Carried alongside `forkedFrom` so that when the
  // user clicks the back link, we can scroll the source back to that exact
  // message — otherwise re-entering the source drops the user at the bottom
  // of the chat, hiding the very message they just forked.
  const [chatForkedFrom, setChatForkedFrom] = useState<{
    sessionId: string;
    title: string;
    forkedAtIndex: number | null;
  } | null>(null);

  // One-shot scroll intent for ChatPage: when the user clicks "Go to
  // original" on a fork, we want ChatPage to scroll the source's forked
  // assistant bubble to the viewport top instead of its default "snap to
  // bottom on session switch". Set right before navigate, consumed once
  // by ChatPage in `onSessionLoaded`, then cleared so subsequent navigations
  // don't accidentally re-trigger it.
  const [pendingScrollToIndex, setPendingScrollToIndex] = useState<number | null>(null);

  const navigate = useNavigate();
  const location = useLocation();

  // 参与悬浮球的 open/close toggle：上报开启态 + 订阅「自关」指令。
  useSidePanelToggle();

  // Apply user-controlled chat font size (writes `--chat-font-size` to the
  // document root, consumed by text-[length:var(--chat-font-size)] in Message,
  // MarkdownRenderer, ChatInput). No-op render-wise: just side-effects on the
  // document root via useEffect.
  useChatFontSize();

  // 「在侧边栏继续」交接：仅当 handoff 的 windowId 命中本窗口时跳转（多窗口不误跳）。
  const goToSession = useCallback(
    (sessionId: string) => navigate(`/chat/${sessionId}`),
    [navigate],
  );

  // NOTE: deliberately NOT clearing `chatForkedFrom` on every route change.
  // A "synchronous set to null" effect here races the async `onSessionLoaded`
  // callback (BG roundtrip can be <100ms) — session_loaded commits first and
  // the route-change effect then clobbers it back to null. Symptom: badge
  // missing on freshly-opened fork chat. The badge is cleared correctly in:
  //   - `handleNewChat` (sync, no async race)
  //   - `handleSelectSession` (sync, same)
  //   - `onSessionCreated` callback (when BG creates a brand-new session)
  //   - `onSessionLoaded` callback (when the loaded session has no
  //     forkedFrom — covers "navigated from a fork to a non-fork session").
  useSidePanelHandoff(goToSession);

  // 记住最近访问过的聊天路由（/chat/new 或 /chat/:sessionId），供退出设置时回到原处。
  // 缺省 /chat/new 兜底首次进设置的情况。
  const lastChatPathRef = useRef('/chat/new');
  useEffect(() => {
    if (location.pathname.startsWith('/chat/')) {
      lastChatPathRef.current = location.pathname;
    }
  }, [location.pathname]);

  // 跨侧边栏窗口的生命周期记忆：用户点浮动球关闭 sidepanel 时，Chrome 会销毁整个
  // sidepanel window；再次点开是全新窗口 + 空 React 树（route 兜底到 /chat/new），
  // 视觉上像是「重置成了新对话」。我们让「上次停留的聊天路由」持久化在 WXT storage：
  // - /chat/:sessionId → 写入 id，给下次打开用
  // - /chat/new        → 主动清除（用户在新窗口里点「New Chat」就不该复活旧会话）
  // - 其它路由（/settings/*）→ 不动，给下次打开用「之前的聊天」兜底
  //
  // 关键时序：mount 时 location.pathname === '/chat/new'（来自 MemoryRouter 兜底），
  // 如果让这个 effect 在 restore 完成前就 fire，会把刚读到的「上次会话 id」覆盖成 null，
  // restore effect 跟着读到的就是空，整个机制被自己吞掉。`skipPersistRef` 标记 restore
  // 完成前的 pathname 是「初始兜底」而非「用户主动 New Chat」，故不写。
  const skipPersistRef = useRef(true);
  useEffect(() => {
    const m = location.pathname.match(/^\/chat\/([^/]+)$/);
    if (!m) return;
    if (skipPersistRef.current) return;
    const id = m[1];
    if (id === 'new') {
      void lastOpenSessionId.setValue(null).catch(() => {});
    } else {
      void lastOpenSessionId.setValue(id).catch(() => {});
    }
  }, [location.pathname]);

  // 侧边栏（重新）挂载时：读出上次记录的会话 id，若有则立即 navigate 过去。
  // MemoryRouter 用 initialEntries=['/chat/new'] 兜底，所以这里是「先到 new、再跳到
  // 真实路由」——为了不闪 WelcomeScreen，用 `restored` flag 在读完前整体不渲染。
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    lastOpenSessionId.getValue().then((id) => {
      if (cancelled) return;
      if (id && location.pathname !== `/chat/${id}`) {
        navigate(`/chat/${id}`, { replace: true });
      }
      // 不论有没有跳，restore 一结束就放开 persist 闸门——之后 location.pathname 的
      // 变化才是「用户行为」触发的。
      skipPersistRef.current = false;
      setRestored(true);
    }).catch(() => {
      skipPersistRef.current = false;
      setRestored(true);
    });
    return () => { cancelled = true; };
  }, []);

  // 侧边栏打开后，若后台在升级时留了「待展示更新日志」标记，则打开更新日志页。
  useChangelogOnUpdate();

  // Load theme from storage before first render
  useEffect(() => {
    themePreference.getValue().then((val) => {
      applyTheme(resolveTheme(val ?? 'system'));
      setThemeReady(true);
    });
  }, []);

  // Sync theme changes after initial load
  useEffect(() => {
    if (!themeReady) return;
    applyTheme(resolveTheme(theme));
  }, [theme, themeReady]);

  // Listen for OS theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    debugLog.info('ui', 'app:toggle_theme', { next });
    setTheme(next);
  };

  const handleNewChat = useCallback(() => {
    debugLog.info('ui', 'app:new_chat', { fromPath: location.pathname });
    // If already on /chat/new, do nothing
    if (location.pathname === '/chat/new') return;
    setChatTitle('');
    // No session row for /chat/new → no fork badge. Clear here too so the
    // Header doesn't flash a stale badge for the brief render between
    // navigate() and ChatPage's own useEffect that also clears it.
    setChatForkedFrom(null);
    navigate('/chat/new');
  }, [location.pathname, navigate]);

  const handleSelectSession = useCallback((sessionId: string) => {
    debugLog.info('ui', 'app:select_session', withSession({ sessionId }, sessionId));
    setHistoryOpen(false);
    // If we're already viewing this session, do nothing — clearing chatTitle
    // and navigate-to-same-path would wipe the header without triggering a
    // resubscribe/IPC roundtrip to repopulate it.
    if (location.pathname === `/chat/${sessionId}`) return;
    setChatTitle('');
    // Clear fork badge immediately — the next session_loaded callback will
    // re-set it if the target itself is a fork, but until that async
    // roundtrip completes the previous fork's badge would otherwise linger
    // on the new route.
    setChatForkedFrom(null);
    navigate(`/chat/${sessionId}`);
  }, [location.pathname, navigate]);

  // Back-link target inside the fork badge. Synchronously clears the badge
  // BEFORE navigating so the badge disappears the instant the user clicks,
  // instead of lingering on the source chat for the duration of the async
  // session_loaded roundtrip (which would otherwise need to fire and set
  // forkedFrom to null on the source — source has no forkedFrom, so the
  // badge would briefly render on the main chat).
  //
  // Also stages a one-shot scroll intent: ChatPage's default behaviour on
  // session switch is to force-scroll the viewport to the bottom (so the
  // latest message is visible). On the source the latest message is usually
  // nowhere near the forked bubble, so without this override the user would
  // land at the bottom and have to scroll up to find what they just forked.
  // We remember `forkedAtIndex` here and pass it down; ChatPage consumes it
  // once in `onSessionLoaded` and clears it.
  const handleBackToOriginal = useCallback((sourceSessionId: string) => {
    if (location.pathname === `/chat/${sourceSessionId}`) return;
    const forkedAtIndex = chatForkedFrom?.forkedAtIndex ?? null;
    debugLog.info('ui', 'fork:back-to-original:click',
      withSession({
        sourceSessionId,
        forkedAtIndex,
        fromPath: location.pathname,
      }, sourceSessionId));
    setChatTitle('');
    setChatForkedFrom(null);
    // Stage the scroll target. Setting it BEFORE navigate means it's ready
    // by the time ChatPage's `onSessionLoaded` callback fires (which is the
    // sync moment it reads the intent).
    if (forkedAtIndex != null) {
      setPendingScrollToIndex(forkedAtIndex);
    }
    navigate(`/chat/${sourceSessionId}`);
  }, [location.pathname, navigate, chatForkedFrom]);

  const clearPendingScrollToIndex = useCallback(() => {
    setPendingScrollToIndex(null);
  }, []);

  const handleDeleteSession = useCallback((deletedId: string) => {
    debugLog.info('ui', 'app:delete_session', withSession({ sessionId: deletedId }, deletedId));
    // If the deleted session is the one currently open, redirect to new chat
    if (location.pathname === `/chat/${deletedId}`) {
      navigate('/chat/new', { replace: true });
    }
  }, [location.pathname, navigate]);

  // 退出设置：回到进设置前的聊天路由（记不到则 /chat/new 兜底）。
  const handleExitSettings = useCallback(() => {
    debugLog.info('ui', 'app:exit_settings', { fromPath: location.pathname, toPath: lastChatPathRef.current });
    navigate(lastChatPathRef.current, { replace: true });
  }, [navigate, location.pathname]);

  // Chat 工具栏「文件系统」快捷入口 — 始终在新的浏览器标签页里打开
  // 独立的 vfs.html 视图，不内嵌进 sidepanel（用户偏好「VFS 与 sidepanel
  // 分离」的布局，所以撤销了上一版 /vfs 路由内嵌的方案）。
  const handleOpenStorage = useCallback(() => {
    debugLog.info('ui', 'app:open_storage', { fromPath: location.pathname });
    void browser.tabs.create({ url: browser.runtime.getURL('/vfs.html') + '#/workspaces' });
  }, [location.pathname]);

  if (!themeReady || !restored) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen overflow-hidden relative">
        {/* Hide Chrome's Header on routes that bring their own header:
            - /settings/*  → SettingsLayout (top bar + back button) */}
        {!location.pathname.startsWith('/settings') && (
          <Header
            title={chatTitle}
            forkedFrom={chatForkedFrom}
            isNewChat={location.pathname === '/chat/new'}
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => navigate('/settings')}
            onNewChat={handleNewChat}
            onOpenHistory={() => setHistoryOpen(true)}
            onBackToOriginal={handleBackToOriginal}
          />
        )}

        <Routes>
          <Route path="/chat/:sessionId?" element={<ChatPage onOpenSettings={() => navigate('/settings')} onOpenStorage={handleOpenStorage} onTitleChange={setChatTitle} onForkedFromChange={setChatForkedFrom} pendingScrollToIndex={pendingScrollToIndex} onPendingScrollConsumed={clearPendingScrollToIndex} />} />
          <Route
            path="/settings/*"
            element={
              <Suspense fallback={null}>
                <SettingsRoutes basePath="/settings" showBackButton showOpenInTab onBack={handleExitSettings} />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/chat/new" replace />} />
        </Routes>

        <HistoryPanel
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
        />

        <Toaster theme={resolveTheme(theme)} />
        <DialogOutlet />
        <ConfirmOutlet />
        <UpdateNoticeOutlet />
      </div>
    </TooltipProvider>
  );
}

export default App;
