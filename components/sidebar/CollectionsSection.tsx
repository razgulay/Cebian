// CollectionsSection — sidebar 抽屉内的知识库列表，与 MCPSection 视觉一致。
//
// 与 /settings/rag 共用同一个 `CollectionList`（进而共用 `CollectionRow`）和同一组
// storage（`ragCollections` / `ragSettings`）。两边写入即互相同步。
//
// 与 /settings/rag 的差异只有**外壳**：抽屉更窄，外壳采用 MCPSection / WorkerTeamRoster
// 同款的 rounded-lg border + mx-3 mt-3 overflow-hidden；header 是带 chevron 的按钮，
// 点击折叠整个 section，省纵向空间。
//
// 不做自动刷新：以前这里在 mount 时对每个 collection fan-out 一次 Neon 查询。
// 与 Settings 对齐后改为按需——数字可能停留在上次索引时的值，直到用户主动核对
// 或索引完成。理由见 `RagSection` 里 `checkCollections` 的说明。
//
// 没有重命名入口：名字在创建时由文件夹名推导，改名会让名字与磁盘不再对应。
import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { showConfirm } from '@/lib/ui/dialog';
import { toast } from 'sonner';
import { CollectionList } from '@/components/settings/rag/CollectionList';
import { CollectionDialog } from '@/components/settings/rag/CollectionDialog';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  DEFAULT_RAG_SETTINGS,
  deleteCollectionChunks,
  ragCollections,
  ragSettings,
  removeCollectionMeta,
  type RagCollection,
} from '@/lib/rag';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * CollectionsSection — 知识库列表 + 新建对话框。
 * 「New collection」按钮在未配置 Neon 连接串时禁用，与 /settings/rag 一致。
 */
export function CollectionsSection() {
  const [settings] = useStorageItem(ragSettings, DEFAULT_RAG_SETTINGS);
  const [collections, setCollections] = useStorageItem(ragCollections, [] as RagCollection[]);
  // 折叠状态为纯 UI 本地态，不持久化——与 MCPSection 对齐。
  const [collapsed, setCollapsed] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const handleDeleteCollection = async (c: RagCollection) => {
    const ok = await showConfirm({
      title: t('settings.rag.confirmDeleteTitle'),
      description: t('settings.rag.confirmDelete', [c.name, String(c.chunkCount)]),
      destructive: true,
    });
    if (!ok) return;
    try {
      if (settings.neonConnectionString) {
        await deleteCollectionChunks(settings.neonConnectionString, c.name);
      }
      const next = await removeCollectionMeta(c.name);
      setCollections(next);
      toast.success(t('settings.rag.deleteSuccess', [c.name]));
    } catch (err) {
      toast.error(`${t('settings.rag.deleteFailed')}: ${(err as Error).message}`);
    }
  };

  const refreshCollections = async () => {
    setCollections(await ragCollections.getValue());
  };

  const total = collections.length;

  return (
    <section className="rounded-lg border border-border mx-3 mt-3 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={!collapsed}
        aria-label={
          collapsed
            ? t('settings.rag.collectionsExpand')
            : t('settings.rag.collectionsCollapse')
        }
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="text-xs font-medium flex-1 truncate">
          {t('settings.rag.collections')}
        </span>
        <span className="text-[0.65rem] text-muted-foreground tabular-nums shrink-0">
          {t('settings.rag.collectionsCount', [String(total), String(total)])}
        </span>
      </button>

      {/* Hidden with CSS, NOT conditionally unmounted. Every row in
          `CollectionList` hosts a `CollectionDialog` whose unmount cleanup
          calls `abort()` on a running index — conditional rendering would let
          "collapse the whole section" kill an index as a side effect. MCP can
          get away with conditional rendering because its edit form has no
          such cleanup. */}
      <div
        className={cn(
          'px-3 pb-3 space-y-3 border-t border-border',
          collapsed && 'hidden',
        )}
      >
        <div className="pt-3">
          <CollectionList
            collections={collections}
            currentModel={settings.defaultEmbedModel}
            settings={settings}
            onIndexed={() => void refreshCollections()}
            onDelete={(c) => void handleDeleteCollection(c)}
          />
        </div>

        <div className="flex justify-center">
          <Button
            size="sm"
            disabled={!settings.neonConnectionString}
            onClick={() => setNewOpen(true)}
          >
            <Plus className="size-3.5" />
            {t('settings.rag.newCollection')}
          </Button>
        </div>
      </div>

      <CollectionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        settings={settings}
        existingNames={collections.map((c) => c.name)}
        mode={{ kind: 'create' }}
        onIndexed={() => void refreshCollections()}
      />
    </section>
  );
}
