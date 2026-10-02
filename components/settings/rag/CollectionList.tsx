//
// CollectionList — Collections 卡片：空态 / 列表 / 新建入口。
//
// 行的呈现交给 `CollectionRow`；这里只负责列表容器与「最大值」的计算
// （占比条需要一个基准）。
//

import { Folder, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import type { RagCollection, RagSettings } from '@/lib/rag';
import { CollectionRow } from './CollectionRow';

export interface CollectionListProps {
  collections: RagCollection[];
  /** 当前配置的嵌入模型，用于标记模型不符的 collection。 */
  currentModel: string;
  /** 连接串为空时不能新建——没有目标可写。 */
  canCreate: boolean;
  /** 重新索引对话框需要：配置 + 已存在的名字（预填与冲突校验）。 */
  settings: RagSettings;
  onCreate: () => void;
  onIndexed: () => void;
  onDelete: (c: RagCollection) => void;
}

export function CollectionList({
  collections,
  currentModel,
  canCreate,
  settings,
  onCreate,
  onIndexed,
  onDelete,
}: CollectionListProps) {
  // 占比条的基准。空列表时不会用到。
  const maxChunkCount = collections.reduce((m, c) => Math.max(m, c.chunkCount), 0);

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-flex size-9 items-center justify-center rounded-md bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400 shrink-0"
          >
            <Folder className="size-4" />
          </span>
          <div>
            <h3 className="text-sm font-medium">{t('settings.rag.collections')}</h3>
            {/* Two lines, both load-bearing: the first says how to USE a
                collection in chat, the second says where the data actually
                comes from (and that editing happens on disk, not here). */}
            <p className="text-xs text-muted-foreground">{t('settings.rag.collectionsHint')}</p>
            <p className="text-xs text-muted-foreground">
              {t('settings.rag.collectionsSourceHint')}
            </p>
          </div>
        </div>
        <Button size="sm" disabled={!canCreate} onClick={onCreate}>
          <Plus className="size-3.5" />
          {t('settings.rag.newCollection')}
        </Button>
      </div>

      {collections.length === 0 ? (
        <div className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
          {t('settings.rag.noCollections')}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {collections.map((c) => (
            <CollectionRow
              key={c.name}
              collection={c}
              currentModel={currentModel}
              maxChunkCount={maxChunkCount}
              settings={settings}
              onIndexed={onIndexed}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
