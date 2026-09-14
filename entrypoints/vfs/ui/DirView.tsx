import { ArrowUp, Check, CheckSquare, ChevronRight, Folder, MoreVertical } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/lib/i18n';
import type { SessionLabelRow } from '@/lib/persistence/db';
import { formatBytes } from '@/lib/utils';
import { fileExtension, navigateTo, parentOf, pickFileIcon } from '../lib/path-utils';
import { formatWorkspaceEntry, formatWorkspaceBanner } from '../lib/session-labels';
import type { DirEntry } from '../types';

/** Single-row action menu item. Actions fire through `onAction` with the row's
 *  full path + name; the row itself stays passive (no vfs.* import here).
 *  Subtask 2 / 3 will fill in real handlers; Subtask 1 only ships the menu shell. */
export interface DirRowAction {
  /** Stable id for `key` + filtering. */
  id: string;
  /** Translation key under `vfs.*` (rendered via `t`). */
  labelKey: string;
  /** `destructive` items get the destructive text color in the menu. */
  variant?: 'default' | 'destructive';
  /** Hidden when this returns false (e.g. disabled for current entry). */
  enabled?: (entry: DirEntry) => boolean;
}

const ROW_ACTIONS: readonly DirRowAction[] = [
  { id: 'copyName', labelKey: 'vfs.action.copyName' },
  { id: 'copyPath', labelKey: 'vfs.action.copyPath' },
  { id: 'copy', labelKey: 'vfs.action.copy' },
  { id: 'cut', labelKey: 'vfs.action.cut' },
  { id: 'download', labelKey: 'common.download' },
  { id: 'edit', labelKey: 'common.edit' },
  { id: 'rename', labelKey: 'common.rename' },
  { id: 'delete', labelKey: 'common.delete', variant: 'destructive' },
];

export function DirView({
  path,
  entries,
  workspaceLabels,
  workspaceRow,
  selectedNames,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onBatchDelete,
  onRowAction,
}: {
  path: string;
  entries: DirEntry[];
  workspaceLabels?: Map<string, SessionLabelRow>;
  workspaceRow?: SessionLabelRow;
  /** Names selected in this dir. Lives in the parent so multi-action and
   *  cross-render coordination work; DirView treats it as read-only. */
  selectedNames: ReadonlySet<string>;
  onToggleSelect: (name: string) => void;
  /** Set to enable "Select all" banner button. Omit to hide it. */
  onSelectAll?: () => void;
  setExists?: boolean;
  onClearSelection?: () => void;
  /** 批量删除选中条目（Subtask 4: 用户主要诉求）。Omit 时不渲染。 */
  onBatchDelete?: (names: string[]) => void;
  /** Single-row action (kebab menu). Receives the chosen action id + entry
   *  + its full path; the parent owns the actual `vfs.*` calls. */
  onRowAction?: (actionId: string, entry: DirEntry, fullPath: string) => void;
}) {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
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
  // 多选模式：只要有 selection 就在每行显示 checkbox + kebab；否则只显示 kebab。
  // 「Select all」按钮在 selection 为空且 onSelectAll 存在时仍可见，让用户主动进入多选。
  const selectMode = selectedNames.size > 0;

  if (sorted.length === 0 && !showUpNav) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <Folder size={48} strokeWidth={1} className="opacity-30" />
        <span className="text-sm">{t('common.empty.folder')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Always show the select toolbar when `onSelectAll` is provided, so the user
       *  has an explicit affordance to enter multi-select mode without first
       *  clicking a per-row checkbox. Once any row is selected, the same slot
       *  flips to the “N selected + Cancel” banner with a destructive Delete. */}
      {onSelectAll && !selectMode && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-muted/40 text-xs">
          <button
            type="button"
            onClick={onSelectAll}
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <CheckSquare className="size-3.5" />
            <span>{t('vfs.selectAll')}</span>
          </button>
        </div>
      )}
      {selectMode && onClearSelection && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-primary/30 bg-primary/5 text-xs">
          <Check className="size-3.5 text-primary" />
          <span className="text-foreground">
            {t('common.session.selectedCount', selectedNames.size)}
          </span>
          {onBatchDelete && (
            <button
              type="button"
              onClick={() => onBatchDelete(Array.from(selectedNames))}
              className="inline-flex items-center gap-1 text-destructive hover:underline"
            >
              {t('common.delete')}
            </button>
          )}
          <button
            type="button"
            onClick={onClearSelection}
            className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}
      {banner && (
        <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-accent/30 px-4 py-3">
          <span className="text-sm font-medium text-foreground truncate">{banner.title}</span>
          <span className="text-xs text-muted-foreground">{banner.createdLabel}</span>
        </div>
      )}
      <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
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
          const wsLabel = workspaceLabels && entry.isDir
            ? formatWorkspaceEntry(entry.name, workspaceLabels.get(entry.name))
            : null;
          const displayName = wsLabel ? wsLabel.title : entry.name;
          const isSelected = selectedNames.has(entry.name);
          return (
            <div
              key={entry.name}
              role="row"
              aria-selected={isSelected}
              className={
                'group relative flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left ' +
                (isSelected ? 'bg-primary/5' : '')
              }
            >
              {onToggleSelect && (
                <label
                  className="shrink-0 flex items-center cursor-pointer p-1 -m-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    aria-label={t('common.session.select')}
                    checked={isSelected}
                    onChange={() => onToggleSelect(entry.name)}
                    className="size-4 accent-primary"
                  />
                </label>
              )}
              <button
                onClick={() => navigateTo(fullPath)}
                className="flex-1 min-w-0 flex items-center gap-3 text-left"
              >
                {entry.isDir ? (
                  <Folder size={18} strokeWidth={1.5} className="shrink-0 text-primary/80 group-hover:text-primary transition-colors" />
                ) : (
                  <FileGlyph size={18} strokeWidth={1.5} className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
                )}
                <span className="flex-1 min-w-0 flex flex-col">
                  <span
                    title={displayName}
                    className="text-sm truncate text-foreground/90 group-hover:text-foreground transition-colors"
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
                    {formatBytes(entry.size)}
                  </span>
                )}
                {entry.isDir && (
                  <ChevronRight size={14} className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
                )}
              </button>
              {onRowAction && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('common.moreActions')}
                      title={t('common.moreActions')}
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 size-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                    >
                      <MoreVertical size={14} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {ROW_ACTIONS.filter((a) => !a.enabled || a.enabled(entry)).map((a) => (
                      <DropdownMenuItem
                        key={a.id}
                        variant={a.variant}
                        onSelect={() => onRowAction(a.id, entry, fullPath)}
                      >
                        {t(a.labelKey as Parameters<typeof t>[0])}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        })}
      </div>
      {selectMode && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClearSelection}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
