// MemorySection — SidebarPanel 内的 Memory 总开关 + Organize 配置 + Search 跳转 +
// 原地新建并编辑一条 memory。
//
// 设计取舍：
// - 文件 workspace（浏览/编辑具体 memory 文件）只放在 /settings/memory，sidebar 不
//   渲染 workspace tree——workspace 体积太大不适合抽屉。
// - 但单击 sidebar 里的「+ New memory」可以直接在 sidebar 内联展开一个极简编辑器
//   （textarea + 文件名输入 + 状态 + 关闭），不跳转到 /settings/memory。这样一来
//   「随手记一条」的工作流不出 sidebar；想要完整 workspace 再走搜索跳转。
// - Textarea 而非 CodeMirror：CM6 完整 bundle 太重，会污染 sidepanel 初始包。Textarea
//   配 500ms 防抖落盘已经够「随手记」用，与 InstructionsSection.tsx 的小文本编辑模式
//   同构。
//
// Search 输入本身不做过滤：聚焦或回车跳到 /settings/memory（带 q= 查询参数），由那边的
// FileWorkspace 接管实际搜索。这么写是权衡：sidebar 没法同时塞下文件列表 + 搜索结果，
// 直接跳走比让搜索栏「看似可用实际空转」更安全。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, FilePlus, FileText, Loader2, X, Pencil, Trash2 } from 'lucide-react';
import { showConfirm } from '@/lib/ui/dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { toast } from 'sonner';
import { MemoryOrganizeControls } from '@/components/sidebar/MemoryOrganizeControls';
import { memorySettings } from '@/lib/persistence/storage';
import { useStorageItem } from '@/hooks/useStorageItem';
import { vfs, normalizePath } from '@/lib/persistence/vfs';
import { CEBIAN_MEMORIES_DIR } from '@/lib/persistence/vfs-paths';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

// Mirrors the template used by /settings/memory (the only place in the
// app that creates memory files today). Keep the two in sync — if you
// change the frontmatter shape here, also update MemorySection in
// components/settings/sections/MemorySection.tsx. Extracted into a thunk
// so i18n resolves at call-time (not at module-load), matching how the
// settings page does it.
const MEMORY_TEMPLATE = () => `---
name: new-memory
description: ""
type: user
---

${t('settings.memory.newBody')}
`;

// Sidebar-only helper: same `uniqueName` logic FileTree uses to pick
// `untitled.md`, `untitled-1.md`, `untitled-2.md`, ... Lives here rather
// than importing from FileTree to avoid pulling react-arborist into the
// sidebar bundle.
async function uniqueMemoryName(dir: string, base: string, ext: string): Promise<string> {
  const full = `${base}${ext}`;
  if (!(await vfs.exists(`${dir}/${full}`))) return full;
  let n = 1;
  while (true) {
    const candidate = `${base}-${n}${ext}`;
    if (!(await vfs.exists(`${dir}/${candidate}`))) return candidate;
    n++;
  }
}

// Sidebar-only inline editor. The full workspace uses CodeMirror — too
// heavy for the sidepanel initial bundle. Pattern lifted from
// components/settings/sections/EditorPanel.tsx (debounced auto-save at
// 500ms, flush on Cmd/Ctrl+S / visibilitychange / unmount) but stripped
// of the breadcrumb / status shell / language detection. The VFS path
// is the same path the workspace uses, so once the user closes the
// sidebar editor and later opens /settings/memory, the same file shows
// up in the file tree pre-loaded with the user's content.
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const AUTOSAVE_DEBOUNCE_MS = 500;

function InlineMemoryEditor({
  relativePath,
  onClose,
  onRenamed,
}: {
  /** Path relative to CEBIAN_MEMORIES_DIR (e.g. `untitled.md`). */
  relativePath: string;
  onClose: () => void;
  /** Called after a successful rename so the parent can update its
   *  `editingPath` state. New name is the full relative path including
   *  the `.md` extension. */
  onRenamed: (newRelativePath: string) => void;
}) {
  const fullPath = `${CEBIAN_MEMORIES_DIR}/${relativePath}`;

  const [body, setBody] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [loading, setLoading] = useState(true);
  const [filename, setFilename] = useState(relativePath);

  // Refs the latest values so the debounce setTimeout / Cmd+S handler /
  // visibilitychange flush can read them without re-binding on every
  // keystroke. Mirrors editor/EditorPanel.tsx pattern.
  const bodyRef = useRef(body);
  const savedRef = useRef(savedContent);
  const fullPathRef = useRef(fullPath);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Path whose content is currently loaded into `body` / `savedContent`.
  // Set after a successful read; the auto-save effect refuses to write
  // until this matches the current `fullPathRef`, which prevents the
  // previous rename's body from being written to the new path while the
  // freshly-loaded read is still in flight.
  const loadedPathRef = useRef<string | null>(null);
  bodyRef.current = body;
  savedRef.current = savedContent;
  fullPathRef.current = fullPath;

  // ─── Flush: write the in-memory body to VFS. ───
  const flush = useCallback(async (): Promise<void> => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const path = fullPathRef.current;
    if (!path) return;
    if (path !== loadedPathRef.current) return;
    const content = bodyRef.current;
    if (content === savedRef.current) return;
    setStatus('saving');
    try {
      await vfs.writeFile(path, content);
      if (path === fullPathRef.current) {
        setSavedContent(content);
        setStatus('saved');
      }
    } catch (err) {
      console.error('[memory-inline] autosave failed', err);
      setStatus('error');
      toast.error(t('settings.editor.saveFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // ─── Load file on mount / path change. ───
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatus('idle');
    setFilename(relativePath);
    loadedPathRef.current = null;
    (async () => {
      try {
        const raw = await vfs.readFile(fullPath, 'utf8');
        const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
        if (cancelled || fullPath !== fullPathRef.current) return;
        setSavedContent(content);
        setBody(content);
        loadedPathRef.current = fullPath;
      } catch {
        if (cancelled) return;
        setBody('');
        setSavedContent('');
        loadedPathRef.current = fullPath;
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fullPath, relativePath]);

  // ─── Debounced auto-save on body change. ───
  useEffect(() => {
    if (!loadedPathRef.current) return;
    if (body === savedContent) return;
    setStatus('idle');
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void flush();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [body, savedContent, flush]);

  // ─── Cmd/Ctrl+S → immediate flush. ───
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void flush();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [flush]);

  // ─── Flush on visibility change / beforeunload. ───
  useEffect(() => {
    const maybeFlush = () => {
      if (bodyRef.current !== savedRef.current && fullPathRef.current && loadedPathRef.current) {
        void flush();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') maybeFlush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', maybeFlush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', maybeFlush);
    };
  }, [flush]);

  // ─── On unmount, flush pending changes. ───
  useEffect(() => {
    return () => {
      if (bodyRef.current !== savedRef.current && fullPathRef.current && loadedPathRef.current) {
        void flush();
      }
    };
  }, [flush]);

  // ─── Auto-fade "Saved" → "idle" after 2s for a calm footer. ───
  useEffect(() => {
    if (status !== 'saved') return;
    const id = setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(id);
  }, [status]);

  // ─── Close handler: flush, then onClose. ───
  const handleClose = useCallback(async () => {
    await flush();
    onClose();
  }, [flush, onClose]);

  // ─── Rename: flush current content to old path, then vfs.rename. ───
  // Refuse on collision — easier than auto-suffixing, and the user is
  // driving the rename explicitly so they can pick a unique name.
  const handleRename = useCallback(async () => {
    const newName = filename.trim();
    if (!newName || newName === relativePath) {
      setFilename(relativePath);
      return;
    }
    // Require .md extension to keep the file tree consistent.
    const finalName = newName.endsWith('.md') ? newName : `${newName}.md`;
    const newFullPath = `${CEBIAN_MEMORIES_DIR}/${finalName}`;
    if (newFullPath === fullPath) {
      setFilename(finalName);
      return;
    }
    if (await vfs.exists(newFullPath)) {
      toast.error(t('settings.memory.inlineEditor.renameConflict'));
      setFilename(relativePath);
      return;
    }
    try {
      await flush();
      await vfs.rename(fullPath, newFullPath);
      // Update refs synchronously so the next autosave writes to the new
      // path. `relativePath` prop will change in the parent once we
      // propagate, but until then we update the ref directly to avoid a
      // stale write.
      loadedPathRef.current = newFullPath;
      fullPathRef.current = newFullPath;
      onRenamed(finalName);
    } catch (err) {
      console.error('[memory-inline] rename failed', err);
      toast.error(t('settings.editor.saveFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
      setFilename(relativePath);
    }
  }, [filename, relativePath, fullPath, flush, onRenamed]);

  const dirty = body !== savedContent;
  const statusLabel =
    status === 'saving' ? t('settings.editor.saving')
    : status === 'error' ? t('settings.editor.saveFailed')
    : dirty ? t('settings.editor.unsaved')
    : status === 'saved' ? t('settings.editor.saved')
    : '';
  const statusClass =
    status === 'error' ? 'text-destructive'
    : 'text-muted-foreground/70';

  return (
    <div className="rounded border border-border bg-muted/30 p-2 space-y-2">
      {/* Header row: filename input on the left, status + close on the right.
          The filename input doubles as the rename widget — blur commits the
          rename (Enter / Esc also work). Keeping it small to fit the sidebar's
          narrow column. */}
      <div className="flex items-center gap-1">
        <Input
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          onBlur={() => { void handleRename(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setFilename(relativePath);
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label={t('settings.memory.inlineEditor.renameFile')}
          className="h-7 text-xs flex-1 min-w-0"
          spellCheck={false}
        />
        {statusLabel && (
          <span className={cn('shrink-0 text-[10px] transition-opacity', statusClass)}>
            {statusLabel}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => { void handleClose(); }}
          aria-label={t('settings.memory.inlineEditor.close')}
          title={t('settings.memory.inlineEditor.close')}
          disabled={loading}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground py-2 flex items-center gap-2">
          <Loader2 className="size-3 animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t('settings.memory.inlineEditor.placeholder')}
          rows={6}
          spellCheck={false}
          className="text-xs font-mono min-h-32 resize-y"
        />
      )}
    </div>
  );
}

// Sidebar-only file list. Always visible below the search bar so the
// user can see what memory files exist + click any one to open it in
// the inline editor (or jump to /settings/memory if no editor is
// open). The full workspace tree still lives in /settings/memory —
// this is a coarse flat list, not a directory tree, scoped to the
// memories root. Sorted alphabetically; the user's most-recent file
// is whatever they last clicked (or just-created).
//
// Right-click on any row opens a context menu with Rename and Delete
// — matches the affordance /settings/memory FileTree exposes. Delete
// goes through the same `showConfirm` dialog used elsewhere; rename
// uses native `window.prompt` (kept simple; a custom Dialog would be
// a richer UX but isn't worth the inline-editor-surfacing complexity
// for a list-row rename).
//
// Subscribes to vfs.onChange so writes/deletes/renames from
// /settings/memory (or anywhere else) reflect here without a manual
// refresh. The listener only refetches when the change path is
// inside CEBIAN_MEMORIES_DIR — other VFS activity doesn't bother us.
function MemoryFileList({
  selectedPath,
  onSelect,
  onRename,
  onDelete,
}: {
  selectedPath: string | null;
  onSelect: (relativePath: string) => void;
  onRename: (relativePath: string) => void;
  onDelete: (relativePath: string) => void;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const entries = await vfs.readdir(CEBIAN_MEMORIES_DIR);
      // Filter to .md-only and strip directory entries. entries are
      // names; we don't recurse — memories is a flat namespace
      // (lib/persistence/vfs-paths.ts: CEBIAN_MEMORIES_DIR is a single
      // directory, not a tree).
      const mdFiles = entries
        .filter((name) => name.toLowerCase().endsWith('.md'))
        .sort();
      setFiles(mdFiles);
    } catch (err) {
      console.warn('[memory] readdir failed:', err);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + subscribe to VFS changes inside the memory dir.
  useEffect(() => {
    void refresh();
    // `vfs.emitted` paths are normalized (e.g.
    // `/home/user/.cebian/memories/untitled.md`) — `CEBIAN_MEMORIES_DIR`
    // is the tilde form (`~/.cebian/memories`), so a raw `+ '/'` prefix
    // would never match. Normalize once here and compare against that.
    const MEMORIES_PREFIX = normalizePath(CEBIAN_MEMORIES_DIR) + '/';
    const unsubscribe = vfs.onChange((event) => {
      const path = event.path;
      if (!path.startsWith(MEMORIES_PREFIX)) return;
      // Refetch on any mutation — cheap (single readdir) and avoids
      // trying to reconstruct the list from the event payload (rename
      // would need to know which file was removed from the old name).
      void refresh();
    });
    return unsubscribe;
  }, [refresh]);

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground py-1 flex items-center gap-1.5">
        <Loader2 className="size-3 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-1">
        {t('settings.memory.emptyList')}
      </div>
    );
  }

  return (
    <ul className="-mx-1 max-h-32 overflow-y-auto">
      {files.map((name) => {
        const isSelected = name === selectedPath;
        return (
          <li key={name}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect(name)}
                  className={cn(
                    'w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-xs text-left truncate',
                    'hover:bg-muted/50 transition-colors',
                    isSelected && 'bg-muted/70 text-foreground font-medium',
                  )}
                  title={name}
                >
                  <FileText className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{name}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-44">
                <ContextMenuItem onSelect={() => onRename(name)}>
                  <Pencil className="size-3.5" />
                  {t('common.rename')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => onDelete(name)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                  {t('common.delete')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </li>
        );
      })}
    </ul>
  );
}

export function MemorySection() {
  const [settings, setSettings] = useStorageItem(memorySettings, { enabled: false });
  const [creating, setCreating] = useState(false);
  // The relative path of the file currently being edited in the inline
  // editor. null = no editor open. Stored as relative path (not full VFS
  // path) so it survives the encode/decode round-trip with the same
  // string the user types in the filename input.
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const navigate = useNavigate();

  // Enter on search → jump to /settings/memory?q=<query>。FileWorkspace 暂不读 q，
  // 但用户已经到达正确位置，可以重新输入查询。这是「sidebar 不重复文件 workspace」的代价。
  const handleSearchSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      const q = String(data.get('q') ?? '').trim();
      navigate(`/settings/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    },
    [navigate],
  );

  // Inline-create flow: write the file with the memory template, then
  // open the inline editor with the new file path. No `navigate()` —
  // the whole point of this button is to keep the user inside the
  // sidebar.
  const handleCreateMemory = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const fileName = await uniqueMemoryName(CEBIAN_MEMORIES_DIR, 'untitled', '.md');
      const fullPath = `${CEBIAN_MEMORIES_DIR}/${fileName}`;
      await vfs.writeFile(fullPath, MEMORY_TEMPLATE());
      setEditingPath(fileName);
    } catch (err) {
      console.error('[memory] failed to create memory file:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [creating]);

  // Rename a file from the sidebar list. Native `window.prompt` is
  // fine here — the data is a short filename, validation is just
  // ".md extension", and the affordance is the same one Chrome uses
  // for "save page as". If the editor is currently open with this
  // file, propagate the rename so the editor's selectedPath updates
  // in lockstep (editor's own rename logic would refuse, since two
  // rename sources race; we let the editor pick up the rename via
  // its key-based remount instead).
  //
  // Tolerates ENOENT on the source — if the file was just removed
  // elsewhere (or the rename race lost), silently refresh and let
  // the listener update the list. Same pattern as the delete path.
  const handleRenameFileFromList = useCallback(async (relativePath: string) => {
    const input = window.prompt(t('settings.memory.inlineEditor.renameFile'), relativePath);
    if (input === null) return; // user cancelled
    const trimmed = input.trim();
    if (!trimmed || trimmed === relativePath) return;
    const finalName = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    const oldPath = `${CEBIAN_MEMORIES_DIR}/${relativePath}`;
    const newPath = `${CEBIAN_MEMORIES_DIR}/${finalName}`;
    if (await vfs.exists(newPath)) {
      toast.error(t('settings.memory.inlineEditor.renameConflict'));
      return;
    }
    try {
      if (!(await vfs.exists(oldPath))) {
        // Source already gone — let the listener refresh.
        return;
      }
      await vfs.rename(oldPath, newPath);
      if (editingPath === relativePath) {
        setEditingPath(finalName);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT|no such file/i.test(msg)) {
        if (editingPath === relativePath) setEditingPath(null);
        return;
      }
      console.error('[memory] rename failed:', err);
      toast.error(msg);
    }
  }, [editingPath]);

  // Delete a file from the sidebar list. Uses the same `showConfirm`
  // dialog as MCPServerCard for visual consistency. If the editor is
  // currently open with this file, close it (the file will be gone
  // after the delete); the vfs.onChange listener will refresh the
  // list naturally.
  //
  // Tolerates ENOENT — if the file was already removed (a concurrent
  // delete from /settings/memory, or a refresh that hadn't fired yet),
  // we silently swallow the error and let the onChange listener update
  // the list. Without this guard, deleting a file that the workspace
  // just removed surfaces a confusing "ENOENT" toast to the user.
  const handleDeleteFileFromList = useCallback(async (relativePath: string) => {
    const ok = await showConfirm({
      title: t('settings.memory.deleteConfirmTitle'),
      description: t('settings.memory.deleteConfirmDescription'),
      destructive: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    const fullPath = `${CEBIAN_MEMORIES_DIR}/${relativePath}`;
    try {
      if (await vfs.exists(fullPath)) {
        await vfs.unlink(fullPath);
      } else {
        // Already gone — close editor if it was open, listener will
        // refresh the list. No toast.
      }
      if (editingPath === relativePath) {
        setEditingPath(null);
      }
    } catch (err) {
      // ENOENT is the same as "already gone" — vfs.unlink races with
      // /settings/memory delete; one of them wins. Don't surface to
      // the user; the listener will refresh the list.
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT|no such file/i.test(msg)) {
        if (editingPath === relativePath) setEditingPath(null);
        return;
      }
      console.error('[memory] delete failed:', err);
      toast.error(msg);
    }
  }, [editingPath]);

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      {/* Title + toggle on the top row (toggle sits at the right so the
          switch is the most "primary" affordance of the section). The
          description goes full-width on its own line below — pulled out
          of the squeezed header so it reads cleanly in the narrow sidebar. */}
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium">{t('settings.memory.title')}</h3>
        <div className="flex items-center gap-2 shrink-0">
          <Label htmlFor="memory-enabled-sidebar" className="text-xs text-muted-foreground">
            {t('settings.memory.enable')}
          </Label>
          <Switch
            id="memory-enabled-sidebar"
            checked={settings.enabled}
            onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.memory.hint')}</p>

      {/* Organize controls sit above the search / editor so the
          configuration is the first thing the user sees after the
          memory toggle. Search + new file stay close to the user
          actions; the inline editor ends up at the very bottom of
          the section — a "working scratchpad" that doesn't crowd
          the controls above. The order is: title → description →
          organize → search → editor. */}
      {settings.enabled && (
        <MemoryOrganizeControls
          settings={settings}
          setSettings={setSettings}
          onOrganized={() => {
            // /settings/memory 里 FileWorkspace 拿到自己的 ref 调 refresh。
            // sidebar 这里没有 file list，无视回调即可。
          }}
        />
      )}

      {/* Search + New file share one row so the section stays compact.
          A full-width "+ New memory" button above this row would push
          the search bar (and the empty-history placeholder below the
          sidebar) further down the page — the user pushed back on
          that. The New file button is icon-only (`size="icon"`) and
          sits to the right of the search input, mirroring the chat
          icon at the very bottom of the sidebar. type="button" is
          load-bearing: without it, submitting the form (Enter in the
          search field) would also fire the new-file click. */}
      <form onSubmit={handleSearchSubmit} className="flex items-center gap-1">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            name="q"
            placeholder={t('common.searchPlaceholder')}
            className="pl-8 h-8 text-xs"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          disabled={creating}
          onClick={handleCreateMemory}
          title={t('common.newFile')}
          aria-label={t('common.newFile')}
        >
          {creating ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FilePlus className="size-3.5" />
          )}
        </Button>
      </form>

      {/* File list — always visible below the search bar. Shows every
          .md file in the memories directory, clickable to open in the
          inline editor. Lives outside the editor's conditional render so
          you can browse + open another file while one's already open —
          the click handler just updates `editingPath`, which triggers
          the editor's key-based remount. The list listens to VFS
          mutations and refetches automatically, so /settings/memory
          edits (rename/delete) reflect here too. */}
      <MemoryFileList
        selectedPath={editingPath}
        onSelect={(name) => setEditingPath(name)}
        onRename={handleRenameFileFromList}
        onDelete={handleDeleteFileFromList}
      />

      {/* Inline editor — renders LAST in the section so it sits below
          the search row. The parent's editingPath doubles as the
          source of truth for the open file, so the editor can be
          closed by clearing it. `key={editingPath}` so a rename tears
          down and remounts the editor cleanly with the new
          relativePath prop, avoiding stale ref / state crosstalk. */}
      {editingPath && (
        <InlineMemoryEditor
          key={editingPath}
          relativePath={editingPath}
          onClose={() => setEditingPath(null)}
          onRenamed={(newName) => setEditingPath(newName)}
        />
      )}
    </section>
  );
}
