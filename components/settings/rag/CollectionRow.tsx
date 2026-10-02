//
// CollectionRow — 一个知识库在列表里的一行。
//
// 三行布局（由密到疏）：
//   1. dot + 名称 + chunk 占比条 + `⋮` 菜单
//   2. 元信息：chunk 数 · 嵌入模型 · 索引时间
//   3. 遗留源提示（仅当有源不在上次索引里时出现）
//
// **源是只读的。** 点行体（不是 `⋮`）展开该 collection 的来源清单，清单里没有
// 任何改名 / 删除 / 新增按钮——磁盘上的文件夹才是事实来源，要改就改磁盘再
// Reindex。这里只把 `RagCollection.sources` 显示出来（此前它只写不读）。
//
// `⋮` 菜单刻意只有两项：Reindex…、Delete collection。改名已从 UI 移除：名字在
// 创建时由文件夹名推导（`CollectionDialog.tsx` 里的 `pickFolderName` /
// `onPickFolder`），改名会让名字与磁盘不再对应。
//

import { useState } from 'react';
import { ChevronRight, Ellipsis, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/lib/i18n';
import { cn, formatBytes } from '@/lib/utils';
import type { RagCollection, RagSettings } from '@/lib/rag';
import { CollectionDialog } from './CollectionDialog';
import { StatusDot, type StatusTone } from './StatusDot';

/** 行的健康态：颜色与文案一次算出。
 *
 *  刻意**不**拆成 `rowTone()` + `rowToneLabel()` 两个函数——那样两边都要各自
 *  判断「空 vs 模型不符」，改了一处忘了另一处就会显示错误的原因。
 *
 *  判据全部来自 `RagCollection` 已有的字段，不需要额外查询。 */
function rowState(
  c: RagCollection,
  currentModel: string,
): { tone: StatusTone; label: string } {
  // 空 collection：查不到任何东西，且通常是索引失败留下的。
  if (c.chunkCount === 0) {
    return { tone: 'error', label: t('settings.rag.rowStateEmpty') };
  }
  // 模型与当前配置不符：这个 collection 的向量不在当前模型的空间里。
  if (c.embedModel !== currentModel) {
    return {
      tone: 'error',
      label: t('settings.rag.rowStateModelMismatch', [c.embedModel, currentModel]),
    };
  }
  // 有源不在上次索引里——可能只是这次没选，也可能是磁盘上删了。
  if ((c.notInLastRun?.length ?? 0) > 0) {
    return { tone: 'warn', label: t('settings.rag.rowStateStale') };
  }
  return { tone: 'ok', label: t('settings.rag.rowStateOk') };
}

/** chunk 占比条：把这个 collection 的 chunk 数与最大的那个比。
 *  只表示相对大小，不是配额——纯粹让「哪个库大」一眼可见。 */
function ProportionBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="hidden sm:block h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
      <span
        className="block h-full rounded-full bg-violet-400"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

export interface CollectionRowProps {
  collection: RagCollection;
  /** 用于判断模型是否与当前配置一致。 */
  currentModel: string;
  /** 列表里最大的 chunkCount，用于占比条。 */
  maxChunkCount: number;
  /** 更新对话框所需的配置。 */
  settings: RagSettings;
  /** 索引完成后的回调——由页面刷新列表。 */
  onIndexed: () => void;
  onDelete: (c: RagCollection) => void;
}

export function CollectionRow({
  collection: c,
  currentModel,
  maxChunkCount,
  settings,
  onIndexed,
  onDelete,
}: CollectionRowProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  /** 重新索引对话框**挂在这一行上**，而不是页面级的一个 section。
   *  这样「对哪个库操作」在视觉上不言自明，也不需要页面用 ref 传
   *  「当前要重索引谁」这种 side-channel。 */
  const [reindexOpen, setReindexOpen] = useState(false);
  const state = rowState(c, currentModel);

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        {/* The row body is the button that opens the source list; the
            `⋮` menu sits outside it so the two never collide. */}
        <button
          type="button"
          onClick={() => setSourcesOpen((v) => !v)}
          aria-expanded={sourcesOpen}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left hover:bg-accent/40 -mx-1 px-1 py-0.5"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              sourcesOpen && 'rotate-90',
            )}
          />
          <StatusDot tone={state.tone} label={state.label} />
          <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
          <ProportionBar value={c.chunkCount} max={maxChunkCount} />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('settings.rag.collectionActions', [c.name])}
            >
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44 max-w-[calc(100vw-1rem)]">
            <DropdownMenuItem onSelect={() => setReindexOpen(true)}>
              <RefreshCw className="size-3.5" />
              {t('settings.rag.updateFromFolder')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(c)}>
              <Trash2 className="size-3.5" />
              {t('settings.rag.deleteCollection')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Line 2: meta. */}
      <p className="mt-0.5 pl-6 text-xs text-muted-foreground truncate">
        {t('settings.rag.rowMeta', [
          String(c.chunkCount),
          c.embedModel,
          new Date(c.updatedAt).toLocaleDateString(),
        ])}
      </p>

      {/* Line 3: stale-source hint. Deliberately not called "deleted" — we
          cannot tell a removed file from one simply not picked last time. */}
      {(c.notInLastRun?.length ?? 0) > 0 && (
        <p className="mt-0.5 pl-6 text-[0.7rem] text-amber-700 dark:text-amber-400 truncate">
          {t('settings.rag.notInLastRun', [String(c.notInLastRun!.length)])}
        </p>
      )}

      {/* Source list — read-only. */}
      {sourcesOpen && (
        <div className="mt-1.5 ml-6 rounded-md border border-border/60 p-2">
          <p className="mb-1 text-[0.7rem] text-muted-foreground">
            {t('settings.rag.sourcesReadOnlyHint')}
          </p>
          {c.sources.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('settings.rag.sourcesEmpty')}</p>
          ) : (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {c.sources.map((s) => (
                <li
                  key={s.path}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate font-mono" title={s.path}>
                    {s.path}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {t('settings.rag.sourceMeta', [String(s.chunkCount), formatBytes(s.size)])}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <CollectionDialog
        open={reindexOpen}
        onOpenChange={setReindexOpen}
        settings={settings}
        mode={{ kind: 'update', collectionName: c.name }}
        onIndexed={onIndexed}
      />
    </li>
  );
}
