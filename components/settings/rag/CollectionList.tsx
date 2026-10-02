//
// CollectionList — 知识库列表本体，Settings 与 sidebar 共用。
//
// 只负责「一组行」与空态；标题、计数徽标、新建按钮由各自的**外壳**提供
// （`settings/sections/RagSection` 与 `sidebar/CollectionsSection`），
// 与 MCP 的 `MCPServerSortableList` 同构——外壳不同，列表相同。
//
// 行内呈现交给 `CollectionRow`。这里不做拖拽排序：知识库是按名字排的平铺列表，
// 没有顺序概念，引入排序就得往存储里加字段，不划算。
//

import { Accordion } from '@/components/ui/accordion';
import { t } from '@/lib/i18n';
import type { RagCollection, RagSettings } from '@/lib/rag';
import { CollectionRow } from './CollectionRow';

export interface CollectionListProps {
  collections: RagCollection[];
  /** 当前配置的嵌入模型，用于标记模型不符的 collection。 */
  currentModel: string;
  /** 重新索引对话框需要。 */
  settings: RagSettings;
  /** 索引完成后的回调——由外壳刷新列表。 */
  onIndexed: () => void;
  onDelete: (c: RagCollection) => void;
}

export function CollectionList({
  collections,
  currentModel,
  settings,
  onIndexed,
  onDelete,
}: CollectionListProps) {
  if (collections.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
        {t('settings.rag.noCollections')}
      </div>
    );
  }

  return (
    <Accordion type="multiple" className="divide-y divide-border/50">
      {collections.map((c) => (
        <CollectionRow
          key={c.name}
          collection={c}
          currentModel={currentModel}
          settings={settings}
          onIndexed={onIndexed}
          onDelete={onDelete}
        />
      ))}
    </Accordion>
  );
}
