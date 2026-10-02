//
// CollectionRow — 一个知识库在列表里的一行（Settings 与 sidebar 共用）。
//
// 结构照搬 `components/settings/mcp/MCPServerRow.tsx`：
//   • 折叠态：状态点 + 名称 + 展开箭头（一行）。
//   • 展开态：元信息、遗留源提示、只读来源清单，底部 Update / Delete 两个文字按钮。
//
// **源是只读的。** 磁盘上的文件夹才是事实来源，要改就改磁盘再从文件夹更新。
// 这里只把 `RagCollection.sources` 显示出来。
//
// 没有重命名入口：名字在创建时由文件夹名推导，改名会让名字与磁盘不再对应。
//
// `CollectionDialog` 必须渲染在 `AccordionItem` **外面**（同级，不是子节点）。
// Radix 的 `AccordionContent` 在折叠时会卸载子树，而 `CollectionDialog` 的卸载
// cleanup 会 `abort()` 正在跑的索引——放进 Content 里，用户一折叠行就把索引杀了。
// MCP 用同样的办法处理它的编辑表单。
//

import { useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { formatBytes } from '@/lib/utils';
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

export interface CollectionRowProps {
  collection: RagCollection;
  /** 用于判断模型是否与当前配置一致。 */
  currentModel: string;
  /** 更新对话框所需的配置。 */
  settings: RagSettings;
  /** 索引完成后的回调——由页面刷新列表。 */
  onIndexed: () => void;
  onDelete: (c: RagCollection) => void;
}

export function CollectionRow({
  collection: c,
  currentModel,
  settings,
  onIndexed,
  onDelete,
}: CollectionRowProps) {
  /** 重新索引对话框**挂在这一行上**，而不是页面级的一个 section。
   *  这样「对哪个库操作」在视觉上不言自明，也不需要页面用 ref 传
   *  「当前要重索引谁」这种 side-channel。 */
  const [reindexOpen, setReindexOpen] = useState(false);
  const state = rowState(c, currentModel);

  return (
    <>
      <AccordionItem value={c.name} className="border-0">
        <div className="flex items-center gap-2 min-w-0 text-sm py-1.5">
          <StatusDot tone={state.tone} label={state.label} />
          <span className="flex-1 min-w-0 text-foreground/80 truncate">{c.name}</span>
          <AccordionTrigger
            aria-label={t('settings.rag.collectionExpand', [c.name])}
            className="py-0 px-1 flex-none gap-0 hover:no-underline [&>svg]:size-3.5"
          />
        </div>

        <AccordionContent className="pb-2">
          <div className="rounded-md bg-muted/30 p-2 space-y-1.5">
            <div className="text-xs text-muted-foreground">
              {t('settings.rag.rowMeta', [
                String(c.chunkCount),
                c.embedModel,
                new Date(c.updatedAt).toLocaleDateString(),
              ])}
            </div>

            {/* Stale-source hint — the cost of add-only being the default.
                Deliberately NOT called "deleted": we cannot tell a removed
                file from one simply not picked last time. */}
            {(c.notInLastRun?.length ?? 0) > 0 && (
              <div className="text-xs text-amber-700 dark:text-amber-400">
                {t('settings.rag.notInLastRun', [String(c.notInLastRun!.length)])}
              </div>
            )}

            <div className="space-y-1">
              <p className="text-[0.7rem] text-muted-foreground">
                {t('settings.rag.sourcesReadOnlyHint')}
              </p>
              {c.sources.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('settings.rag.sourcesEmpty')}
                </p>
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
                        {t('settings.rag.sourceMeta', [
                          String(s.chunkCount),
                          formatBytes(s.size),
                        ])}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-end gap-1 pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => setReindexOpen(true)}
              >
                <RefreshCw className="size-3" />
                {t('settings.rag.updateAction')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
                onClick={() => onDelete(c)}
              >
                <Trash2 className="size-3" />
                {t('common.delete')}
              </Button>
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>

      {/* Sibling of AccordionItem, not a child — collapsing the row cannot
          unmount it, so an in-flight index is never aborted. */}
      <CollectionDialog
        open={reindexOpen}
        onOpenChange={setReindexOpen}
        settings={settings}
        mode={{ kind: 'update', collectionName: c.name }}
        onIndexed={onIndexed}
      />
    </>
  );
}
