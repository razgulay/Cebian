import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp, ChevronRight, ClipboardPaste, File, FilePlus, Folder, FolderPlus, MoreVertical,
} from 'lucide-react';
import { t } from '@/lib/i18n';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { SessionLabelRow } from '@/lib/persistence/db';
import { fileExtension, formatSize, navigateTo, parentOf, pickFileIcon } from '../lib/path-utils';
import { formatWorkspaceEntry, formatWorkspaceBanner } from '../lib/session-labels';
import type { DirEntry } from '../types';

type CreateKind = 'file' | 'folder';

/**
 * Toolbar + row-list view for a VFS directory.
 *
 * Action affordances:
 *   - Top toolbar: New File / New Folder / Paste (paste visible only when
 *     `canPaste` is true; clipboardSummary provides the queue label).
 *   - Per-row kebab: Rename / Copy / Cut / Delete.
 *   - Inline `<input>` row at the top of the list for "new file / new folder"
 *     (keyboard: Enter submits, Escape cancels, blur with empty value cancels).
 *   - Inline `<input>` over the entry's display name when renaming (same key
 *     handling).
 *
 * The component is purely presentational + emits intent via callbacks. The
 * parent (`VfsExplorer`) owns the clipboard buffer, confirm dialogs, and the
 * actual `vfs.*` calls so error/loading state can be kept above the row
 * layer.
 */
export function DirView({
  path,
  entries,
  workspaceLabels,
  workspaceRow,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
  onCopy,
  onCut,
  onPaste,
  canPaste,
  clipboardSummary,
}: {
  path: string;
  entries: DirEntry[];
  /** 当 `path` 为 `/workspaces` 时存在：把 UUID 子目录翻译成会话标签并按最后活动倒序。 */
  workspaceLabels?: Map<string, SessionLabelRow>;
  /** 当 `path` 为某个会话工作区目录且会话仍存在时存在：据此渲染顶部信息条。 */
  workspaceRow?: SessionLabelRow;
  /** Toolbar / kebab callbacks — when undefined, the toolbar and per-row
   *  kebabs are hidden. VfsExplorer always sets these; standalone use cases
   *  (tests, future read-only embeds) can pass a list-only variant by
   *  omitting them. */
  onCreateFile?: (name: string) => Promise<void> | void;
  onCreateFolder?: (name: string) => Promise<void> | void;
  onRename?: (oldName: string, newName: string, isDir: boolean) => Promise<void> | void;
  onDelete?: (name: string, isDir: boolean) => Promise<void> | void;
  onCopy?: (name: string) => void;
  onCut?: (name: string) => void;
  onPaste?: () => Promise<void> | void;
  /** Show the Paste button in the toolbar. */
  canPaste?: boolean;
  /** Optional second-line label on the Paste button — e.g. "Copy → README.md". */
  clipboardSummary?: string | null;
}) {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  // 工作区根：按会话最后活动倒序（无标签的孤儿目录排末尾）；其余路径按名称升序。
  if (workspaceLabels) {
    dirs.sort((a, b) => {
      const ua = workspaceLabels.get(a.name)?.updatedAt ?? -1;
      const ub = workspaceLabels.get(b.name)?.updatedAt ?? -1;
      return ub - ua;
    });
  } else {
    dirs.sort((a, b) => a.name.localeCompare(b.name));
  }
  const sorted = [...dirs, ...files];
  const showUpNav = path !== '/';
  const banner = formatWorkspaceBanner(workspaceRow);
  const showToolbar = !!(onCreateFile || onCreateFolder || onPaste);

  // Inline-create form: shown at the top of the list while the user types a
  // name. `null` when no form is open. Auto-focuses on mount.
  const [creating, setCreating] = useState<CreateKind | null>(null);
  // Which entry name is currently being renamed. Replaces the entry's display
  // name with an `<input>` while non-null.
  const [renaming, setRenaming] = useState<string | null>(null);

  // Open forms are mutually exclusive — opening one closes the other. Avoids
  // a stack of stale inputs the user has to dismiss before the next action.
  function startCreating(kind: CreateKind): void {
    setRenaming(null);
    setCreating(kind);
  }
  function startRenaming(name: string): void {
    setCreating(null);
    setRenaming(name);
  }

  return (
    <div className="flex flex-col gap-3">
      {banner && (
        <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-accent/30 px-4 py-3">
          <span className="text-sm font-medium text-foreground truncate">{banner.title}</span>
          <span className="text-xs text-muted-foreground">{banner.createdLabel}</span>
        </div>
      )}

      {showToolbar && (
        <Toolbar
          canPaste={!!canPaste}
          clipboardSummary={clipboardSummary ?? null}
          onCreateFile={onCreateFile ? () => startCreating('file') : undefined}
          onCreateFolder={onCreateFolder ? () => startCreating('folder') : undefined}
          onPaste={onPaste ? () => { void onPaste(); } : undefined}
        />
      )}

      {(sorted.length > 0 || showUpNav || creating) && (
        <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
          {creating && (
            <CreateRow
              kind={creating}
              onCancel={() => setCreating(null)}
              onSubmit={(value) => {
                const trimmed = value.trim();
                setCreating(null);
                if (!trimmed) return;
                if (creating === 'file') void onCreateFile?.(trimmed);
                else void onCreateFolder?.(trimmed);
              }}
            />
          )}
          {showUpNav && (
            <button
              onClick={() => navigateTo(parentOf(path))}
              className="group w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
            >
              <ArrowUp size={16} className="text-muted-foreground group-hover:text-primary transition-colors" />
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">..</span>
            </button>
          )}
          {sorted.map((entry) => {
            const fullPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
            const ext = fileExtension(entry.name);
            const FileGlyph = pickFileIcon(ext);
            // 工作区根下的目录用会话标签替代裸 UUID 显示。
            const wsLabel = workspaceLabels && entry.isDir
              ? formatWorkspaceEntry(entry.name, workspaceLabels.get(entry.name))
              : null;
            const displayName = wsLabel ? wsLabel.title : entry.name;
            const isRenaming = renaming === entry.name;
            return (
              <DirRow
                key={entry.name}
                entry={entry}
                fullPath={fullPath}
                displayName={displayName}
                FileGlyph={FileGlyph}
                wsLabel={wsLabel}
                isRenaming={isRenaming}
                onStartRename={startRenaming}
                onRenameSubmit={(newName) => {
                  const trimmed = newName.trim();
                  setRenaming(null);
                  if (!trimmed || trimmed === entry.name) return;
                  void onRename?.(entry.name, trimmed, entry.isDir);
                }}
                onRenameCancel={() => setRenaming(null)}
                onCopy={onCopy ? () => onCopy(entry.name) : undefined}
                onCut={onCut ? () => onCut(entry.name) : undefined}
                onDelete={onDelete ? () => { void onDelete(entry.name, entry.isDir); } : undefined}
              />
            );
          })}
        </div>
      )}

      {sorted.length === 0 && !showUpNav && !creating && (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3 border border-border rounded-lg">
          <Folder size={48} strokeWidth={1} className="opacity-30" />
          <span className="text-sm">{t('common.empty.folder')}</span>
          {showToolbar && (
            <div className="flex gap-2 mt-1">
              {onCreateFile && <EmptyStateAction icon={FilePlus} label={t('vfs.action.newFile')} onClick={() => startCreating('file')} />}
              {onCreateFolder && <EmptyStateAction icon={FolderPlus} label={t('vfs.action.newFolder')} onClick={() => startCreating('folder')} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────

function Toolbar({
  canPaste,
  clipboardSummary,
  onCreateFile,
  onCreateFolder,
  onPaste,
}: {
  canPaste: boolean;
  clipboardSummary: string | null;
  onCreateFile?: () => void;
  onCreateFolder?: () => void;
  onPaste?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {onCreateFile && (
        <ToolbarButton icon={FilePlus} label={t('vfs.action.newFile')} onClick={onCreateFile} dataAttr="vfs-toolbar-trigger" />
      )}
      {onCreateFolder && (
        <ToolbarButton icon={FolderPlus} label={t('vfs.action.newFolder')} onClick={onCreateFolder} dataAttr="vfs-toolbar-trigger" />
      )}
      {onPaste && canPaste && (
        <button
          type="button"
          onClick={onPaste}
          title={clipboardSummary ?? t('vfs.action.paste')}
          aria-label={clipboardSummary ?? t('vfs.action.paste')}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border bg-background text-xs text-foreground hover:bg-accent transition-colors"
        >
          <ClipboardPaste className="size-3.5" />
          <span className="font-medium">{t('vfs.action.paste')}</span>
          {clipboardSummary && (
            <span className="hidden sm:inline text-muted-foreground truncate max-w-40">{clipboardSummary}</span>
          )}
        </button>
      )}
    </div>
  );
}

function ToolbarButton({ icon: Icon, label, onClick, dataAttr }: { icon: typeof File; label: string; onClick: () => void; dataAttr?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-vfs-toolbar-trigger={dataAttr}
      title={label}
      aria-label={label}
      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border bg-background text-xs text-foreground hover:bg-accent transition-colors"
    >
      <Icon className="size-3.5" />
      <span className="font-medium">{label}</span>
    </button>
  );
}

function EmptyStateAction({ icon: Icon, label, onClick }: { icon: typeof File; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-vfs-toolbar-trigger="vfs-toolbar-trigger"
      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

// ─── Inline create row (new file / new folder) ────────────────────────────

function CreateRow({
  kind,
  onSubmit,
  onCancel,
}: {
  kind: CreateKind;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-focus + select so the user can start typing immediately.
    inputRef.current?.focus();
  }, []);

  function commit() {
    onSubmit(value);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  // Blur submits a non-empty value but is suppressed when focus moves to
  // another toolbar button — otherwise clicking "New Folder" while the
  // "New File" input still has text would commit the file AND open the
  // folder form. `data-vfs-toolbar-trigger` marks the toolbar buttons that
  // should steal focus from a sibling create form.
  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const next = e.relatedTarget as HTMLElement | null;
    if (next?.closest('[data-vfs-toolbar-trigger]')) {
      onCancel();
      return;
    }
    if (!value.trim()) onCancel();
    else commit();
  }

  const Icon = kind === 'file' ? FilePlus : FolderPlus;
  const placeholder = t('vfs.prompt.newName', [t(kind === 'file' ? 'vfs.action.newFile' : 'vfs.action.newFolder').toLowerCase()]);

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-accent/30">
      <Icon size={18} className="shrink-0 text-primary" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        aria-label={placeholder}
        className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
}

// ─── Directory row ────────────────────────────────────────────────────────

function DirRow({
  entry,
  fullPath,
  displayName,
  FileGlyph,
  wsLabel,
  isRenaming,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  onCopy,
  onCut,
  onDelete,
}: {
  entry: DirEntry;
  fullPath: string;
  displayName: string;
  FileGlyph: typeof File;
  wsLabel: ReturnType<typeof formatWorkspaceEntry> | null;
  isRenaming: boolean;
  onStartRename: (name: string) => void;
  onRenameSubmit: (newName: string) => void;
  onRenameCancel: () => void;
  onCopy?: () => void;
  onCut?: () => void;
  onDelete?: () => void;
}) {
  // Sibling flex row: the navigate button (icon + name + meta) on the left
  // takes up flex-1, the kebab lives at the right. Two sibling buttons are
  // valid HTML — nested buttons would be the actual problem.
  const showActions = !!(onCopy || onCut || onDelete || onStartRename);
  // Orphan workspace rows: tooltip explains "this is a leftover from a
  // deleted session, safe to delete". `title` is the cheapest accessible
  // affordance; we don't pull in Tooltip just for this one row case.
  const titleTooltip = wsLabel?.isOrphan ? t('vfs.unknownSessionTooltip') : displayName;
  return (
    <div className="flex items-stretch group">
      {isRenaming ? (
        <RenameRow
          displayName={displayName}
          onSubmit={onRenameSubmit}
          onCancel={onRenameCancel}
        />
      ) : (
        <button
          onClick={() => navigateTo(fullPath)}
          className="flex-1 min-w-0 flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
        >
          {entry.isDir ? (
            <Folder size={18} strokeWidth={1.5} className="shrink-0 text-primary/80 group-hover:text-primary transition-colors" />
          ) : (
            <FileGlyph size={18} strokeWidth={1.5} className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
          )}
          <span className="flex-1 min-w-0 flex flex-col">
            <span
              title={titleTooltip}
              className={
                wsLabel?.isOrphan
                  ? 'text-sm truncate text-muted-foreground group-hover:text-foreground transition-colors'
                  : 'text-sm truncate text-foreground/90 group-hover:text-foreground transition-colors'
              }
            >
              {displayName}
            </span>
            {wsLabel?.uuid && (
              <span
                title={wsLabel.uuid}
                className="text-xs text-muted-foreground/50 truncate tabular-nums"
              >
                {wsLabel.uuid}
              </span>
            )}
          </span>
          {wsLabel?.dateLabel && (
            <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
              {wsLabel.dateLabel}
            </span>
          )}
          {!entry.isDir && (
            <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
              {formatSize(entry.size)}
            </span>
          )}
          {entry.isDir && (
            <ChevronRight size={14} className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
          )}
        </button>
      )}
      {showActions && !isRenaming && (
        <RowActions
          onRename={onStartRename ? () => onStartRename(entry.name) : undefined}
          onCopy={onCopy}
          onCut={onCut}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function RenameRow({
  displayName,
  onSubmit,
  onCancel,
}: {
  displayName: string;
  onSubmit: (newName: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(displayName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Pre-select the name (minus extension for files would be nicer but
    // there's no clean way to detect "this is a file" inside RenameRow —
    // select-all is the standard file-manager behaviour for ambiguous cases).
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function commit() {
    onSubmit(value);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="flex-1 min-w-0 flex items-center gap-3 px-4 py-2 bg-accent/30">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (!value.trim()) onCancel(); else commit(); }}
        aria-label={t('common.rename')}
        className="flex-1 min-w-0 bg-transparent text-sm outline-none"
      />
    </div>
  );
}

// ─── Per-row kebab popover ────────────────────────────────────────────────

function RowActions({
  onRename,
  onCopy,
  onCut,
  onDelete,
}: {
  onRename?: () => void;
  onCopy?: () => void;
  onCut?: () => void;
  onDelete?: () => void;
}) {
  // Open state mirrors Radix so the popover closes immediately after a click.
  // The trigger button does NOT have a navigate handler so closing the menu
  // is the only effect needed.
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          // stopPropagation so opening the menu doesn't fire any future
          // ancestor click handlers (today there are none, but cheap to be
          // defensive).
          onClick={(e) => e.stopPropagation()}
          title={t('common.moreActions')}
          aria-label={t('common.moreActions')}
          aria-haspopup="menu"
          className="shrink-0 self-stretch px-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors border-l border-transparent"
        >
          <MoreVertical className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-44 p-1">
        {onRename && (
          <KebabMenuItem label={t('common.rename')} onSelect={() => { setOpen(false); onRename(); }} />
        )}
        {onCopy && (
          <KebabMenuItem label={t('common.copy')} onSelect={() => { setOpen(false); onCopy(); }} />
        )}
        {onCut && (
          <KebabMenuItem label={t('common.cut')} onSelect={() => { setOpen(false); onCut(); }} />
        )}
        {onDelete && (
          <KebabMenuItem
            label={t('common.delete')}
            destructive
            onSelect={() => { setOpen(false); onDelete(); }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function KebabMenuItem({
  label,
  destructive,
  onSelect,
}: {
  label: string;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={
        'w-full text-left px-2.5 py-1.5 rounded text-sm transition-colors ' +
        (destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-foreground hover:bg-accent')
      }
    >
      {label}
    </button>
  );
}