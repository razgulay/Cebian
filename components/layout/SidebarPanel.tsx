import { useState, useEffect, useMemo, useRef } from 'react';
import { Trash2, MessageSquare, MoreVertical, Pin, PinOff, Pencil } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { CLIENT_PORT, type ClientMessage, type ServerMessage, type SessionMeta } from '@/lib/ipc/protocol';
import { showConfirm } from '@/lib/ui/dialog';
import { t } from '@/lib/i18n';
import { debugLog, withSession } from '@/lib/debug/log';
import { stripSystemTags } from '@/lib/agent/strip-system-tags';
import { CollectionsSection } from '@/components/sidebar/CollectionsSection';
import { MCPSection } from '@/components/sidebar/MCPSection';
import { WorkerTeamRoster } from '@/components/sidebar/WorkerTeamRoster';

interface SidebarPanelProps {
  open: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}

type RecencyBucket = 'pinned' | 'today' | 'week' | 'month' | 'older';

interface SessionGroup {
  bucket: RecencyBucket;
  sessions: SessionMeta[];
}

// 按 = the updatedAt 把已倒序的会话列表切成 4 段（今天 / 7 天内 / 30 天内 / 更早），并把
// 已 pin 的会话单独抽出来放到最上面的「Pinned」段。Pinned 不参与 recency 分桶——
// 即同一会话可以同时是 pinned AND 最近活跃的，会被放在 Pinned 而不是 Today。
// 这样筛选条件够干净，避免在两个段里出现同一行。
// 边界用本地自然日 0 点，空段直接跳过。输入需已按 updatedAt 倒序。
function groupSessionsByRecency(sessions: SessionMeta[], now: number): SessionGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  // 用日历日做边界，避免固定 24h 偏移在夏令时切换日落到非 0 点。
  // 「7 天内」含今天往前共 7 个自然日，故下界是今天 0 点往前 6 天。
  const weekStartDate = new Date(startOfToday);
  weekStartDate.setDate(weekStartDate.getDate() - 6);
  const monthStartDate = new Date(startOfToday);
  monthStartDate.setDate(monthStartDate.getDate() - 29);
  const todayStart = startOfToday.getTime();
  const weekStart = weekStartDate.getTime();
  const monthStart = monthStartDate.getTime();

  const pinned: SessionMeta[] = [];
  const buckets: Record<Exclude<RecencyBucket, 'pinned'>, SessionMeta[]> = {
    today: [],
    week: [],
    month: [],
    older: [],
  };

  for (const session of sessions) {
    if (session.isPinned) {
      pinned.push(session);
      continue;
    }
    if (session.updatedAt >= todayStart) buckets.today.push(session);
    else if (session.updatedAt >= weekStart) buckets.week.push(session);
    else if (session.updatedAt >= monthStart) buckets.month.push(session);
    else buckets.older.push(session);
  }

  const result: SessionGroup[] = [];
  // Pinned goes first regardless of recency — it's the user's curated
  // "always near the top" set, separate from the date-based list below.
  if (pinned.length > 0) {
    result.push({ bucket: 'pinned', sessions: pinned });
  }
  const order: Array<Exclude<RecencyBucket, 'pinned'>> = ['today', 'week', 'month', 'older'];
  for (const bucket of order) {
    if (buckets[bucket].length > 0) result.push({ bucket, sessions: buckets[bucket] });
  }
  return result;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t('common.time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('common.time.minutesAgo', [minutes]);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common.time.hoursAgo', [hours]);
  const days = Math.floor(hours / 24);
  if (days < 30) return t('common.time.daysAgo', [days]);
  const months = Math.floor(days / 30);
  if (months < 12) return t('common.time.monthsAgo', [months]);
  return t('common.time.yearsAgo', [Math.floor(months / 12)]);
}

// Session titles are derived from the user's first message (or LLM summary
// of it) and inherit the user's input casing — typically lowercase for
// chat-style input ("oh, người ăn tặng..."). The sidebar lists many titles
// at a glance, so we capitalize the first letter on display to give them a
// consistent heading-style appearance. `toUpperCase()` handles Unicode
// correctly (Vietnamese diacritics: `ơ` → `Ơ`, `ă` → `Ă`, etc.), and
// non-letter leading characters (digits, punctuation, ellipsis) are
// unaffected — they fall through unchanged.
function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Sanitize a stored title for display: strip system-only XML tags
 *  (<reminder-instructions>, <context>, ...) that some older sessions
 *  have leaking into their title. Defense in depth — the auto-title
 *  pipeline (lib/agent/title-generation.ts) now strips these before
 *  generating AND before persisting, but sessions whose title was
 *  saved before that fix landed still carry the literal tags. Strip at
 *  display time too so we don't have to migrate Dexie to fix the
 *  symptom (and so a re-display after a future regression doesn't
 *  bring the leak back). */
function displayTitle(title: string): string {
  return stripSystemTags(title);
}

/**
 * SidebarPanel — 抽屉式侧边栏，包含 4 个区域：
 *   1. Worker Team Roster — 4 个 worker role 的紧凑模型切换（顶部，跨 session 全局配置）
 *   2. MCP Servers — MCP 服务器列表 + 添加
 *   3. Collections — RAG collections 列表 + 新建/重命名/重新索引/删除
 *   4. History — 会话历史（按时间分组，pin 在顶部）
 *
 * 单列垂直滚动布局，不强制任何高度限制——各区域增多时整列自然变长，
 * 滚动条由 ScrollArea 提供。每个区域单独 `border-border` 包裹，区域间由 `space-y-3` 隔开；
 * 四个区域统一带 `mx-3 mt-3`，左右边缘对齐。
 *
 * 注意：记忆管理（Memory）不在侧边栏抽屉中——抽屉只列历史，记忆相关的总开关、整理配置、
 * 文件浏览 / 编辑请走 `/settings/memory` 设置页（见 `components/settings/sections/MemorySection`）。
 */
export function SidebarPanel({ open, onClose, onSelectSession, onDeleteSession }: SidebarPanelProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  // Local rename state — only one row can be in edit mode at a time.
  // Tracking the row id (not the whole row object) so toggling pin / scroll
  // doesn't reset the input. Refs the input element after mount so we can
  // autofocus + move the caret to the end on edit-mode entry.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const groups = useMemo(() => groupSessionsByRecency(sessions, Date.now()), [sessions]);

  // One-shot lifecycle log: fires once when the panel first mounts. The
  // mount + unmount pair brackets the entire open/close cycle for this
  // sidepanel session; combined with `history:select` / `history:delete*`
  // they give a complete picture of user activity inside the drawer.
  useEffect(() => {
    debugLog.info('ui', 'sidebar:open');
    return () => {
      debugLog.info('ui', 'sidebar:close');
    };
  }, []);

  const handleSelect = (sessionId: string) => {
    debugLog.info('ui', 'history:select', withSession({ sessionId }, sessionId));
    onSelectSession(sessionId);
  };

  // Load via the background port so we can include live `isRunning` state
  // for each session. The DB itself doesn't know which agents are mid-stream.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const port = chrome.runtime.connect({ name: CLIENT_PORT });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      setLoading(false);
      try { port.disconnect(); } catch { /* already disconnected */ }
    };
    const onMessage = (msg: ServerMessage) => {
      if (msg.type === 'session_list_result') {
        setSessions(msg.sessions);
        finish();
      } else if (msg.type === 'error') {
        console.warn('[sidebar] session_list error:', msg.error);
        finish();
      }
    };
    port.onMessage.addListener(onMessage);
    port.postMessage({ type: 'session_list' } satisfies ClientMessage);
    // Safety timeout in case the background doesn't respond.
    const timeout = setTimeout(() => {
      console.warn('[sidebar] session_list timed out');
      finish();
    }, 5000);
    return () => {
      clearTimeout(timeout);
      port.onMessage.removeListener(onMessage);
      try { port.disconnect(); } catch { /* already disconnected */ }
      setLoading(false);
    };
  }, [open]);

  // React to `session_changed` broadcasts (pin/rename). Patch the matching
  // row in place rather than re-fetching the whole list, which keeps the
  // typing feel snappy while renaming.
  useEffect(() => {
    if (!open) return;
    const port = chrome.runtime.connect({ name: CLIENT_PORT });
    const onMessage = (msg: ServerMessage) => {
      if (msg.type === 'session_changed') {
        const next = msg.session;
        setSessions((prev) => prev.map((s) => (s.id === next.id ? { ...s, ...next } : s)));
      }
    };
    port.onMessage.addListener(onMessage);
    return () => {
      port.onMessage.removeListener(onMessage);
      try { port.disconnect(); } catch { /* already disconnected */ }
    };
  }, [open]);

  // Inline confirm-then-delete. The Radix menu item click is the only
  // call site now (the always-visible trash icon is gone — the 3-dot menu
  // owns all per-row actions).
  const handleDelete = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    const ok = await showConfirm({
      title: t('common.session.deleteConfirmTitle'),
      description: t('common.session.deleteConfirmDescription', [displayTitle(session.title)]),
      destructive: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    debugLog.info('ui', 'history:delete:confirmed', withSession({ sessionId: id }, id));
    try {
      // Optimistic UI update
      setSessions(prev => prev.filter(s => s.id !== id));
      onDeleteSession?.(id);
      // Send delete to background (handles DB + agent cleanup)
      const port = chrome.runtime.connect({ name: CLIENT_PORT });
      const onMessage = (msg: ServerMessage) => {
        if (msg.type === 'session_deleted' && msg.sessionId === id) {
          port.onMessage.removeListener(onMessage);
          port.disconnect();
        }
      };
      port.onMessage.addListener(onMessage);
      port.postMessage({ type: 'session_delete', sessionId: id } satisfies ClientMessage);
      // Safety timeout: disconnect after 5s if no response
      setTimeout(() => {
        port.onMessage.removeListener(onMessage);
        try { port.disconnect(); } catch { /* already disconnected */ }
      }, 5000);
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  };

  // Toggle the pin state. Optimistic locally so the pin icon flips
  // immediately; the server broadcasts `session_changed` which reconciles
  // the canonical state across other sidepanels.
  const handleTogglePin = (id: string) => {
    debugLog.info('ui', 'history:pin:toggle', withSession({ sessionId: id }, id));
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, isPinned: !s.isPinned } : s)),
    );
    const port = chrome.runtime.connect({ name: CLIENT_PORT });
    // One-shot — disconnect as soon as the port is open since we don't
    // need a reply (the broadcast `session_changed` is what reconciles).
    setTimeout(() => {
      try { port.disconnect(); } catch { /* already disconnected */ }
    }, 0);
    port.postMessage({ type: 'session_pin', sessionId: id } satisfies ClientMessage);
  };

  // Enter rename mode for one row. The current title is captured into the
  // input as initial value; the input auto-focuses and places the caret
  // at the end (via the ref's `setSelectionRange` effect).
  const handleStartRename = (id: string) => {
    debugLog.info('ui', 'history:rename:start', withSession({ sessionId: id }, id));
    setRenamingId(id);
  };

  const handleCancelRename = () => {
    setRenamingId(null);
  };

  // Send the rename IPC and apply the new title optimistically. The
  // session_changed broadcast will reconcile the canonical row state.
  // The 200-char slice mirrors the server-side guard.
  const handleCommitRename = (id: string, newTitle: string) => {
    const trimmed = newTitle.trim().slice(0, 200);
    if (trimmed.length === 0) {
      // Empty after trim → bail out, keep the previous title. Don't close
      // rename mode so the user can fix it.
      return;
    }
    setRenamingId(null);
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: trimmed } : s)),
    );
    debugLog.info('ui', 'history:rename:commit', withSession({ titleLen: trimmed.length }, id));
    const port = chrome.runtime.connect({ name: CLIENT_PORT });
    setTimeout(() => {
      try { port.disconnect(); } catch { /* already disconnected */ }
    }, 0);
    port.postMessage({
      type: 'session_rename',
      sessionId: id,
      title: trimmed,
    } satisfies ClientMessage);
  };

  return (
    <>
      {/* Scrim: dims the chat behind the sidebar when open. Sits BELOW the
          sidebar (z-40 vs sidebar's z-50) and covers the full body area
          (the Header above is untouched). Click anywhere on the scrim to
          close — same UX as the close button. `pointer-events-none`
          when closed so the chat stays interactive. The opacity transition
          matches the sidebar's slide animation so the dimming fades in
          alongside the slide. */}
      <div
        className={`absolute inset-0 bg-black/40 z-40 transition-opacity duration-150 ease-out ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sidebar overlay — slides in from the left, ~60% of the sidepanel
          width (w-3/5). The chat area behind it is dimmed by the scrim
          (z-40) below — sidebar stays at full brightness (bg-background),
          chat is overlaid with 40% black for the modal-like focus effect.
          `shadow-xl` gives the right edge a soft drop shadow so the panel
          reads as floating above the dimmed chat. */}
      <div
        className={`absolute top-0 bottom-0 left-0 w-3/5 bg-background z-50 flex flex-col shadow-xl transition-transform duration-150 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
      {/* Brand header — the "Cebian" wordmark sits flush at the top-left of
          the panel. `pt-3 pb-3` (12px each side) is the tightest the brand
          can sit while still leaving visual breathing room above the body
          list. The bottom border is the same `--border` token used for the
          inter-group dividers further down, so the panel reads as one
          continuous stroke language. The in-panel close button was removed
          earlier — the page Header's PanelLeftOpen icon + the dimmed scrim
          are the only close affordances now. */}
      <div className="flex items-center px-8 pt-3 pb-3 border-b border-border">
        <span
          className="font-rounded font-bold text-2xl tracking-tight text-foreground"
          style={{ fontFamily: 'var(--font-rounded)' }}
        >
          Cebian
        </span>
      </div>

      {/* Body — single vertical scroll containing 4 regions (top → bottom):
          Worker Team Roster → MCP Servers → Collections → History.
          `space-y-3` gives regions a fixed gap. Each region adds its own
          `mx-3 mt-3`; combined with the wrapper's `pl-3` (left only) this
          places the four sections at 24 px from the left and 12 px from
          the right (asymmetric by design — preserving the original left
          inset while letting every region's own mx-3 govern the right
          edge). ScrollArea auto-shows a scrollbar when the regions exceed
          viewport height — adding MCP / RAG files grows the column without
          any fixed-height truncation. */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="pl-3 pr-0 py-1 space-y-3">
          {/* ─── Worker Team Roster (multi-agent model picker) ─── */}
          {/* Position: top of body, before MCP / Collections / History —
              worker team is a session-global config that should stay visible
              while users scroll through the rest of the sidebar. */}
          <WorkerTeamRoster />

          {/* ─── MCP Servers ─── */}
          <MCPSection />

          {/* ─── Collections (RAG) ─── */}
          {/* Position: after MCP Servers, before History. */}
          <CollectionsSection />

          {/* ─── History (cuối sidebar) ─── */}
          {/* Match Worker / MCP / Collections horizontal margins (mx-3 mt-3)
              so all four sections share the same left and right edges.
              History keeps no outer border (preserves the flat list look);
              the wrapper's pl-3 plus the section's own mx-3 double-stack
              gives the content its horizontal position. */}
          <section className="mx-3 mt-3">
            {loading && (
              <div className="text-center text-sm text-muted-foreground py-12">
                {t('common.loading')}
              </div>
            )}

            {!loading && groups.length > 0 && (
              <Accordion
                type="multiple"
                defaultValue={groups
                  .filter((g) => g.bucket === 'pinned' || g.bucket === 'today')
                  .map((g) => g.bucket)}
              >
                {groups.map((group, groupIdx) => (
                  <AccordionItem
                    key={group.bucket}
                    value={group.bucket}
                    className={`border-b-0 ${groupIdx > 0 ? 'border-t border-border' : ''}`}
                  >
                    <AccordionTrigger className="py-1 text-xs text-muted-foreground hover:no-underline">
                      {t(`common.historyGroup.${group.bucket}`)}
                    </AccordionTrigger>
                    <AccordionContent className="pb-1">
                      <div className="flex flex-col">
                        {group.sessions.map((session) => {
                          const isRenaming = renamingId === session.id;
                          return (
                            <div
                              key={session.id}
                              role="button"
                              tabIndex={0}
                              className={`relative w-full flex items-center gap-2 px-0 py-1 text-left hover:bg-muted/50 transition-colors group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isRenaming ? 'bg-muted/30 cursor-text' : ''}`}
                              onClick={() => {
                                if (isRenaming) return;
                                handleSelect(session.id);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  if (isRenaming) return;
                                  handleSelect(session.id);
                                }
                              }}
                            >
                              {!isRenaming && (
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {session.isRunning && (
                                    <span
                                      role="img"
                                      aria-label={t('common.session.running')}
                                      title={t('common.session.running')}
                                      className="size-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0"
                                    />
                                  )}
                                  {session.isPinned && (
                                    <span
                                      aria-label={t('common.session.pin')}
                                      title={t('common.session.pin')}
                                      className="inline-flex shrink-0 text-muted-foreground"
                                    >
                                      <Pin className="size-3.5" />
                                    </span>
                                  )}
                                </div>
                              )}

                              <div className="flex-1 min-w-0">
                                {isRenaming ? (
                                  <RenameInput
                                    initialTitle={displayTitle(session.title)}
                                    onCancel={handleCancelRename}
                                    onCommit={(value) => handleCommitRename(session.id, value)}
                                  />
                                ) : (
                                  <div className="text-sm truncate min-w-0 text-left">
                                    {capitalizeFirst(displayTitle(session.title).trim() || t('common.newChat'))}
                                  </div>
                                )}
                              </div>

                              {!isRenaming && (
                                <div className="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                  <DropdownMenu>
                                    <DropdownMenuTrigger
                                      aria-label={t('common.session.moreActions')}
                                      title={t('common.session.moreActions')}
                                      className="inline-flex items-center justify-center size-6 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                                    >
                                      <MoreVertical className="size-4" />
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" sideOffset={4}>
                                      <DropdownMenuItem
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          handleTogglePin(session.id);
                                        }}
                                      >
                                        {session.isPinned ? (
                                          <>
                                            <PinOff className="size-4" />
                                            {t('common.session.unpin')}
                                          </>
                                        ) : (
                                          <>
                                            <Pin className="size-4" />
                                            {t('common.session.pin')}
                                          </>
                                        )}
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          handleStartRename(session.id);
                                        }}
                                      >
                                        <Pencil className="size-4" />
                                        {t('common.session.rename')}
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          handleDelete(session.id);
                                        }}
                                      >
                                        <Trash2 className="size-4" />
                                        {t('common.delete')}
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            )}

            {/* Empty state — rendered inside the History section since
                it's now the last section in the sidebar. */}
            {!loading && sessions.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <MessageSquare className="size-6 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">{t('common.empty.history')}</p>
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
      </div>
    </>
  );
}

// ─── RenameInput ───

/**
 * Inline `<input>` rendered in place of a session row's title while the user
 * is editing it. Behavior matches the chat textarea's rename UX:
 *   - autofocus + caret placed at the end of the existing text (not the start),
 *     so the user can keep typing without losing position
 *   - Enter saves, Escape cancels, blur saves (so clicking away doesn't lose work)
 *   - clicks inside the input don't bubble to the row's "select session" handler
 *
 * Kept as a small standalone component so the parent row's JSX stays readable
 * and the autofocus/useEffect glue doesn't get tangled with the dropdown menu
 * wiring on the same row.
 */
function RenameInput({
  initialTitle,
  onCancel,
  onCommit,
}: {
  initialTitle: string;
  onCancel: () => void;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus once + move caret to end on mount. Running on every value change
  // would jump the caret when the user types in the middle; we deliberately
  // only run on mount via the empty deps array.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      // setSelectionRange can throw on edge input types; the focus itself
      // already gives the user a reasonable starting point.
    }
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      // Stop both click + keydown from bubbling to the row — otherwise
      // typing would also "select" the session and any Enter would navigate
      // away from the chat.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(value)}
      // Match the surrounding title's text style so the edit "morphs"
      // rather than jumping. The ring only shows while focused, hiding the
      // shadcn default outline on the unfocused state.
      className="flex-1 min-w-0 text-sm font-medium bg-transparent border border-input rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      // 200-char input limit mirrors the server-side guard in
      // updateSessionTitle — clientside mirror so users see a hard cap.
      maxLength={200}
      aria-label={t('common.session.rename')}
    />
  );
}