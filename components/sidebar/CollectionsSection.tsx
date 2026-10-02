// CollectionsSection — RAG Collections 列表 + New Collection 对话框。
// 从 components/settings/sections/RagSection.tsx 抽出，自包含状态（rename / reindex /
// new dialog），共享 ragCollections + ragSettings 两个 storage 项。/settings/rag 和
// SidebarPanel 都挂这一个组件，写入同一 storage，两处 UI 实时同步。
//
// Connection / Embedder / Chunking / Rerank 等「配置块」仍留在 /settings/rag，因为
// CollectionsSection 不渲染它们、也不依赖它们——sidebar 只关心 collections 本身。
import { useCallback, useEffect, useState } from 'react';
import {
  Database,
  Plus,
  Trash2,
  RefreshCw,
  Check,
  Pencil,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { showConfirm } from '@/lib/ui/dialog';
import { CollectionDialog, type CollectionDialogMode } from '@/components/settings/rag/CollectionDialog';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  countCollectionChunks,
  DEFAULT_RAG_SETTINGS,
  deleteCollectionChunks,
  normalizeCollectionName,
  ragCollections,
  ragSettings,
  removeCollectionMeta,
  renameCollectionChunks,
  renameCollectionMeta,
  type RagCollection,
} from '@/lib/rag';
import { t } from '@/lib/i18n';
import { debugLog } from '@/lib/debug/log';

/**
 * CollectionsSection — Collections 列表 + 新建 / 重命名 / 重新索引 / 删除。
 * 「New collection」按钮在未配置 Neon 连接串时禁用，与原 /settings/rag 一致。
 */
export function CollectionsSection() {
  const [settings] = useStorageItem(ragSettings, DEFAULT_RAG_SETTINGS);
  const [collections, setCollections] = useStorageItem(ragCollections, [] as RagCollection[]);

  // Rename-in-progress state. When `renamingName` is non-null, the
  // matching row in the collections list switches to an inline editor.
  // Only one rename at a time — keeps the UI focused and avoids two
  // inputs competing for the same row space.
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const startRename = useCallback((name: string) => {
    setRenamingName(name);
    setRenameDraft(name);
    setRenameError(null);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingName(null);
    setRenameDraft('');
    setRenameError(null);
  }, []);

  const commitRename = useCallback(async () => {
    if (!renamingName || renameBusy) return;
    const trimmed = renameDraft.trim();
    if (trimmed === renamingName) {
      // No-op rename — exit edit mode without touching storage.
      cancelRename();
      return;
    }
    const slugified = normalizeCollectionName(trimmed);
    if (!slugified) {
      setRenameError(t('settings.rag.nameInvalid'));
      return;
    }
    if (collections.some((c) => c.name === slugified)) {
      setRenameError(t('settings.rag.renameInUse', [slugified]));
      return;
    }
    setRenameBusy(true);
    try {
      if (settings.neonConnectionString) {
        await renameCollectionChunks(settings.neonConnectionString, renamingName, slugified);
      }
      const next = await renameCollectionMeta(renamingName, slugified);
      setCollections(next);
      toast.success(t('settings.rag.renameSuccess', [renamingName, slugified]));
      cancelRename();
    } catch (err) {
      setRenameError((err as Error).message);
    } finally {
      setRenameBusy(false);
    }
  }, [renamingName, renameDraft, renameBusy, collections, settings.neonConnectionString, setCollections, cancelRename]);

  // New-collection modal
  const [newOpen, setNewOpen] = useState(false);

  // Refresh collection chunk counts from Neon on mount + after indexing.
  // The local `chunkCount` field can drift if the user manually edits
  // the table; this keeps the UI honest. We re-read the canonical list
  // from storage before writing so the closure value doesn't go stale
  // when `setCollections` triggers a re-render that re-runs this effect.
  useEffect(() => {
    let cancelled = false;
    if (!settings.neonConnectionString) return;
    (async () => {
      const stored = await ragCollections.getValue();
      // Fan out all collection-count probes in parallel — the previous
      // `for...of` + `await` made each round trip sequential, so an N-collection
      // refresh cost N× RTT on the network. `Promise.allSettled` keeps partial
      // failures contained (one bad collection doesn't poison the others) and
      // collapses N updates into a single `setCollections` call.
      const settled = await Promise.allSettled(
        stored.map(async (c) => {
          const live = await countCollectionChunks(settings.neonConnectionString, c.name);
          return { name: c.name, live };
        }),
      );
      if (cancelled) return;
      const updates = new Map<string, number>();
      settled.forEach((r, i) => {
        const c = stored[i];
        if (!c) return;
        if (r.status === 'fulfilled') {
          if (r.value.live !== c.chunkCount) updates.set(c.name, r.value.live);
        } else {
          debugLog.warn('rag', 'count-chunks-failed', {
            collection: c.name,
            error: String(r.reason),
          });
        }
      });
      if (updates.size === 0) return;
      setCollections(
        stored.map((p) => (updates.has(p.name) ? { ...p, chunkCount: updates.get(p.name)! } : p)),
      );
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.neonConnectionString]);

  const handleDeleteCollection = useCallback(
    async (c: RagCollection) => {
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
    },
    [settings.neonConnectionString, setCollections],
  );

  const reindexCollection = useCallback(
    async (c: RagCollection) => {
      // 更新已有知识库。名字已固定，所以传进去而不是让对话框再问一次——
      // 从文件夹名重新推导会在用户选了别的文件夹时悄悄变成「新建」。
      setDialogMode({ kind: 'update', collectionName: c.name });
      setNewOpen(true);
    },
    [],
  );
  const [dialogMode, setDialogMode] = useState<CollectionDialogMode>({ kind: 'create' });

  return (
    <section className="space-y-3 rounded-lg border border-border mx-3 mt-3 p-4">
      {/* Title + description — stacked vertically so the long hint reads
          full-width instead of being squeezed next to the title. The
          "+ New collection" button is moved to the bottom of the section
          so all the action affordances line up at the end. */}
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t('settings.rag.collections')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.rag.collectionsHint')}</p>
      </div>

      {collections.length === 0 ? (
        <div className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
          {t('settings.rag.noCollections')}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {collections.map((c) => {
            const isRenaming = renamingName === c.name;
            return (
              <li key={c.name} className="flex items-center gap-3 px-3 py-2">
                <Database className="size-4 text-violet-400 shrink-0" />
                {isRenaming ? (
                  <div className="min-w-0 flex-1 space-y-1">
                    <Input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => {
                        setRenameDraft(e.target.value);
                        if (renameError) setRenameError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitRename();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      disabled={renameBusy}
                      placeholder={t('settings.rag.renamePlaceholder')}
                      className="h-7 text-xs"
                    />
                    {renameError && (
                      <p className="text-[0.7rem] text-destructive truncate">
                        {renameError}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {c.chunkCount} chunks · {c.embedModel} ·{' '}
                      {new Date(c.updatedAt).toLocaleDateString()}
                    </p>
                    {/* Orphan hint — the cost of add-only being the default.
                        Deliberately NOT called "orphaned": we cannot tell a
                        deleted file from one simply not picked last time. */}
                    {(c.notInLastRun?.length ?? 0) > 0 && (
                      <p className="text-[0.7rem] text-amber-700 dark:text-amber-400 truncate">
                        {t('settings.rag.notInLastRun', [String(c.notInLastRun!.length)])}
                      </p>
                    )}
                  </div>
                )}
                {isRenaming ? (
                  <>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void commitRename()}
                      disabled={renameBusy}
                      title={t('settings.rag.renameCollection')}
                    >
                      <Check className="size-3.5" />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={cancelRename}
                      disabled={renameBusy}
                      title={t('settings.rag.cancel')}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => startRename(c.name)}
                      title={t('settings.rag.renameCollection')}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void reindexCollection(c)}
                      title={t('settings.rag.reindex')}
                    >
                      <RefreshCw className="size-3.5" />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void handleDeleteCollection(c)}
                      title={t('settings.rag.deleteCollection')}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* "+ New collection" anchored at the bottom of the section so all
          action affordances stack together (the empty-state hint fills the
          middle when the list is empty). */}
      <div className="flex justify-center">
        <Button
          size="sm"
          disabled={!settings.neonConnectionString}
          onClick={() => {
            setDialogMode({ kind: 'create' });
            setNewOpen(true);
          }}
        >
          <Plus className="size-3.5" />
          {t('settings.rag.newCollection')}
        </Button>
      </div>

      <CollectionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        settings={settings}
        existingNames={collections.map((c) => c.name)}
        mode={dialogMode}
        onIndexed={(updated) => {
          // upsertCollection was already called inside the dialog; we
          // just refresh local state from storage to be safe.
          void (async () => {
            const next = await ragCollections.getValue();
            setCollections(next);
            void updated;
          })();
        }}
      />
    </section>
  );
}

