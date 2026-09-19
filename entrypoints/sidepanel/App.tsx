import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { browser } from 'wxt/browser';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { DialogOutlet } from '@/components/dialogs/outlet';
import { ConfirmOutlet } from '@/components/dialogs/confirm-outlet';
import { UpdateNoticeOutlet } from '@/components/dialogs/update-notice-outlet';
import { Header } from '@/components/layout/Header';
import { SidebarPanel } from '@/components/layout/SidebarPanel';
import { CanvasPane } from '@/components/canvas/CanvasPane';
import { useStorageItem } from '@/hooks/useStorageItem';
import { useApplyThemePreference, resolveTheme } from '@/hooks/useApplyThemePreference';
import { useChangelogOnUpdate } from '@/hooks/useChangelogOnUpdate';
import { useChatFontSize } from '@/hooks/useChatFontSize';
import { canvasPanelOpen, lastOpenSessionId } from '@/lib/persistence/storage';
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

function App() {
  const [theme, themeReady, setTheme] = useApplyThemePreference();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatTitle, setChatTitle] = useState('');
  // Canvas pane 开关状态——持久化到 session: 存储（侧边栏关闭再开会恢复）。
  // `exclude` 分类不进备份（panel-open 是设备本地 UI 状态，不是用户配置）。
  const [canvasOpen, setCanvasOpen] = useStorageItem(canvasPanelOpen, false);

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
    navigate('/chat/new');
  }, [location.pathname, navigate]);

  const handleSelectSession = useCallback((sessionId: string) => {
    debugLog.info('ui', 'app:select_session', withSession({ sessionId }, sessionId));
    setSidebarOpen(false);
    // If we're already viewing this session, do nothing — clearing chatTitle
    // and navigate-to-same-path would wipe the header without triggering a
    // resubscribe/IPC roundtrip to repopulate it.
    if (location.pathname === `/chat/${sessionId}`) return;
    setChatTitle('');
    navigate(`/chat/${sessionId}`);
  }, [location.pathname, navigate]);

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

  const handleToggleCanvas = useCallback(() => {
    const next = !canvasOpen;
    debugLog.info('ui', 'app:canvas:toggle', { from: canvasOpen, to: next });
    // setCanvasOpen 是 useStorageItem 的乐观 setter：先同步 setValueState 让
    // Eye/EyeOff 立即切，再异步落 chrome.storage.session。直接调
    // canvasPanelOpen.setValue 会绕开乐观更新，导致图标切换延迟到 storage
    // 写完 + watch 回调一圈才生效（与 useStorageItem 调用点的统一约定违背）。
    void setCanvasOpen(next);
  }, [canvasOpen, setCanvasOpen]);

  if (!themeReady || !restored) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen overflow-hidden relative">
        {/* Hide Chrome's Header on routes that bring their own header:
            - /settings/*  → SettingsLayout (top bar + back button) */}
        {!location.pathname.startsWith('/settings') && (
          <Header
            title={chatTitle}
            isNewChat={location.pathname === '/chat/new'}
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => navigate('/settings')}
            onNewChat={handleNewChat}
            onOpenSidebar={() => setSidebarOpen(true)}
            canvasOpen={canvasOpen}
            onToggleCanvas={handleToggleCanvas}
          />
        )}

        <Routes>
          <Route
            path="/chat/:sessionId?"
            element={
              canvasOpen && !location.pathname.startsWith('/settings') ? (
                <div className="flex-1 min-h-0 flex">
                  <Group
                    orientation="horizontal"
                    id="cebian-canvas-split"
                    style={{ flex: 1 }}
                  >
                    {/*
                     * Canvas 在左，chat 在右。Panel id 仅作布局标识——
                     * 无持久化布局，DOM 顺序即渲染顺序。
                     */}
                    <Panel
                      id="cebian-canvas-panel"
                      defaultSize="50"
                      minSize="20"
                    >
                      <CanvasPane onClose={handleToggleCanvas} />
                    </Panel>
                    <Separator
                      id="cebian-canvas-resize"
                      className="w-1 hover:bg-primary/30 active:bg-primary/50 transition-colors"
                    />
                    <Panel
                      id="cebian-chat-panel"
                      defaultSize="50"
                      minSize="25"
                      className="flex flex-col"
                    >
                      {/*
                       * Panel 的 inner wrapper 默认是 block——chat 内容短时整片收缩、
                       * 输入框跟着漂。转成 flex column 让消息区 flex-1 吃满高度、
                       * ChatInput 恒定钉在底部。
                       */}
                      <ChatPage
                        onOpenSettings={() => navigate('/settings')}
                        onOpenStorage={handleOpenStorage}
                        onTitleChange={setChatTitle}
                      />
                    </Panel>
                  </Group>
                </div>
              ) : (
                <ChatPage
                  onOpenSettings={() => navigate('/settings')}
                  onOpenStorage={handleOpenStorage}
                  onTitleChange={setChatTitle}
                />
              )
            }
          />
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

        <SidebarPanel
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
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
