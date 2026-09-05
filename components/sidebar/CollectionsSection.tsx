// CollectionsSection — RAG Collections 列表 + New Collection 对话框。
// 从 components/settings/sections/RagSection.tsx 抽出，自包含状态（rename / reindex /
// new dialog），共享 ragCollections + ragSettings 两个 storage 项。/settings/rag 和
// SidebarPanel 都挂这一个组件，写入同一 storage，两处 UI 实时同步。
//
// Connection / Embedder / Chunking / Rerank 等「配置块」仍留在 /settings/rag，因为
// CollectionsSection 不渲染它们、也不依赖它们——sidebar 只关心 collections 本身。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Database,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  FileText,
  Folder,
  FolderPlus,
  ChevronDown,
  Check,
  FolderOpen,
  Pencil,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { showConfirm } from '@/lib/ui/dialog';
import { formatBytes, cn } from '@/lib/utils';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  buildEmbedder,
  countCollectionChunks,
  deleteCollectionChunks,
  indexCollection,
  IndexCancelledError,
  normalizeCollectionName,
  ragCollections,
  ragSettings,
  removeCollectionMeta,
  renameCollectionChunks,
  renameCollectionMeta,
  upsertCollection,
  type IndexProgress,
  type RagCollection,
  type RagSettings,
} from '@/lib/rag';
import { t } from '@/lib/i18n';
import { debugLog } from '@/lib/debug/log';

const SUPPORTED_TEXT_EXT = ['.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.csv', '.tsv', '.log', '.xml', '.html', '.htm', '.tex'];
const PDF_EXT = '.pdf';

/** Decide if a picked file can be ingested. Used to filter FileList
 *  before we even attempt to read it. Unknown extensions are skipped
 *  silently — the user gets a toast count after the picker closes. */
function isIngestable(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(PDF_EXT)) return true;
  return SUPPORTED_TEXT_EXT.some((ext) => name.endsWith(ext));
}

const DEFAULT_RAG_SETTINGS: RagSettings = {
  neonConnectionString: '',
  embedderBaseUrl: 'http://localhost:8317/v1',
  embedderApiKey: '',
  defaultEmbedModel: 'text-embedding-3-small',
  embedderDim: 1536,
  chunkSize: 800,
  chunkOverlap: 100,
  rerankEnabled: false,
  rerankBaseUrl: 'http://localhost:8317/v1',
  rerankApiKey: '',
  rerankModel: 'rerank-english-v3.0',
  rerankTopN: 3,
  pinMinScore: 0,
};

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
      // Re-indexing requires the user to re-pick files — we don't store
      // the originals (they live on the user's disk). Open the New
      // Collection dialog pre-filled with the same name + a banner
      // explaining the re-pick. For v1 we keep it simple: the re-index
      // button just opens the New dialog pre-named.
      setNewOpen(true);
      // The dialog reads its own state; we stash a hint via a side-channel.
      pendingReindexRef.current = c.name;
    },
    [],
  );
  const pendingReindexRef = useRef<string | null>(null);

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
            pendingReindexRef.current = null;
            setNewOpen(true);
          }}
        >
          <Plus className="size-3.5" />
          {t('settings.rag.newCollection')}
        </Button>
      </div>

      <NewCollectionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        settings={settings}
        existingNames={collections.map((c) => c.name)}
        initialName={pendingReindexRef.current}
        onCreated={(created) => {
          // upsertCollection was already called inside the dialog; we
          // just refresh local state from storage to be safe.
          void (async () => {
            const next = await ragCollections.getValue();
            setCollections(next);
            void created;
          })();
        }}
      />
    </section>
  );
}

// ─── New-collection dialog ─────────────────────────────────────────

interface NewCollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: RagSettings;
  existingNames: string[];
  /** When set, the dialog opens pre-named for a re-index of the named
   *  collection. The user must still re-pick files (we don't keep the
   *  originals on disk). */
  initialName: string | null;
  onCreated: (created: RagCollection) => void;
}

function NewCollectionDialog({
  open,
  onOpenChange,
  settings,
  existingNames,
  initialName,
  onCreated,
}: NewCollectionDialogProps) {
  // The folder this dialog operates on. `null` means "no folder chosen
  // yet — user must pick or create one". When non-null, `files` belong
  // to that folder (visually nested + indexed under that name).
  const [folder, setFolder] = useState<string | null>(null);
  // When the user picks "New folder…" from the dropdown, we switch to an
  // inline text input bound to this state instead of selecting an
  // existing name.
  const [draftNew, setDraftNew] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Whether `folder` names an existing collection (re-index flow) or a
  // brand-new one (create flow). Used to gate the reindex banner.
  const isExisting = folder !== null && existingNames.includes(folder);

  // Reset on open so a re-open starts fresh.
  useEffect(() => {
    if (open) {
      setFolder(initialName ?? null);
      setDraftNew('');
      setFiles([]);
      setProgress(null);
      setError(null);
    } else {
      // Cancel any in-flight index when the dialog closes.
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open, initialName]);

  const ingestable = useMemo(() => files.filter(isIngestable), [files]);
  const skipped = files.length - ingestable.length;
  const slug = normalizeCollectionName(folder ?? '');
  const nameValid = slug !== null;

  const totalBytes = useMemo(
    () => ingestable.reduce((s, f) => s + f.size, 0),
    [ingestable],
  );

  /** Extract the top-level folder name from a `webkitdirectory` pick.
   *  Files in a folder pick carry a `webkitRelativePath` like
   *  `myfolder/sub/file.txt` — we want `myfolder`. Files picked via the
   *  multi-file picker (no webkitdirectory) don't have a folder, so we
   *  return null. */
  const pickFolderName = useCallback((picked: FileList | null): string | null => {
    if (!picked) return null;
    for (let i = 0; i < picked.length; i++) {
      const rel = picked[i]?.webkitRelativePath;
      if (rel && rel.includes('/')) {
        return rel.split('/')[0] ?? null;
      }
    }
    return null;
  }, []);

  const onPickFiles = useCallback((picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    setFiles(Array.from(picked));
  }, []);

  const onPickFolder = useCallback((picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const folderName = pickFolderName(picked);
    if (folderName) {
      // Auto-sync the selected folder to the picked folder name.
      const slugified = normalizeCollectionName(folderName);
      if (slugified) setFolder(slugified);
      setDraftNew('');
    }
    setFiles(Array.from(picked));
  }, [pickFolderName]);

  const chooseExisting = useCallback((name: string) => {
    setFolder(name);
    setDraftNew('');
    setFolderPickerOpen(false);
  }, []);

  const startNewFolder = useCallback(() => {
    setFolder(null);
    setDraftNew('');
    setFolderPickerOpen(false);
  }, []);

  const commitDraft = useCallback(() => {
    const slugified = normalizeCollectionName(draftNew);
    if (slugified) {
      setFolder(slugified);
      setDraftNew('');
    }
  }, [draftNew]);

  const handleIndex = useCallback(async () => {
    if (!slug || !nameValid || ingestable.length === 0) return;
    setRunning(true);
    setError(null);
    setProgress({ phase: 'reading', done: 0, total: ingestable.length });
    abortRef.current = new AbortController();
    try {
      const embedder = buildEmbedder(settings);
      const result = await indexCollection({
        connectionString: settings.neonConnectionString,
        collection: slug,
        embedder,
        files: ingestable,
        chunkSize: settings.chunkSize,
        chunkOverlap: settings.chunkOverlap,
        onProgress: setProgress,
        signal: abortRef.current.signal,
      });
      const now = Date.now();
      const collection: RagCollection = {
        name: slug,
        embedModel: settings.defaultEmbedModel,
        embedDim: settings.embedderDim,
        createdAt: now,
        updatedAt: now,
        chunkCount: result.chunkCount,
        sources: result.files.map((f) => ({
          path: f.path,
          size: f.size,
          chunkCount: f.chunks,
        })),
      };
      const next = await upsertCollection(collection);
      toast.success(t('settings.rag.indexDone', [String(result.chunkCount)]));
      onCreated(collection);
      // Notify parent of updated list (parent also reads from storage).
      void next;
      onOpenChange(false);
    } catch (err) {
      if (err instanceof IndexCancelledError) {
        // Silent — user closed the dialog.
      } else {
        const msg = (err as Error).message ?? String(err);
        setError(msg);
        toast.error(`${t('settings.rag.indexFailed')}: ${msg}`);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [slug, nameValid, ingestable, settings, onCreated, onOpenChange]);

  const progressLabel = (() => {
    if (!progress) return null;
    const { phase, done, total, currentFile } = progress;
    switch (phase) {
      case 'reading':
        return t('settings.rag.progressReading', [
          String(done),
          String(total),
          currentFile ?? '',
        ]);
      case 'chunking':
        return t('settings.rag.progressChunking', [String(total)]);
      case 'embedding':
        return t('settings.rag.progressEmbedding', [String(done), String(total)]);
      case 'inserting':
        return t('settings.rag.progressInserting', [String(done), String(total)]);
    }
  })();

  // Render the folder picker button. Shows the active folder name (or
  // the in-progress draft), a folder icon, and a chevron. Clicking
  // opens a popover listing existing folders + "New folder…" option.
  // When `folder` is null (user picked "New folder…"), we surface the
  // current draft so the user has visual feedback that what they type
  // in the inline input is being captured.
  const folderTrigger = (
    <Button
      type="button"
      variant="outline"
      role="combobox"
      aria-expanded={folderPickerOpen}
      disabled={running}
      className={cn(
        'w-full justify-between font-normal',
        !folder && !(draftNew.length > 0) && 'text-muted-foreground',
      )}
    >
      <span className="flex items-center gap-2 truncate">
        {folder ? (
          <Folder className="size-3.5 shrink-0" />
        ) : (
          <FolderPlus className="size-3.5 shrink-0" />
        )}
        <span className="truncate">
          {folder ?? (draftNew || t('settings.rag.folderPlaceholder'))}
        </span>
      </span>
      <ChevronDown className="size-3.5 shrink-0 opacity-50" />
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.rag.newCollection')}</DialogTitle>
          <DialogDescription>{t('settings.rag.newCollectionHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* ─── Folder picker ─── */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.rag.folderLabel')}</Label>
            <Popover open={folderPickerOpen} onOpenChange={setFolderPickerOpen}>
              <PopoverTrigger asChild>{folderTrigger}</PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput
                    placeholder={t('settings.rag.folderNewPlaceholder')}
                    value={draftNew}
                    onValueChange={setDraftNew}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitDraft();
                        setFolderPickerOpen(false);
                      }
                    }}
                  />
                  <CommandList>
                    <CommandEmpty>
                      {existingNames.length === 0
                        ? t('settings.rag.folderNoFolders')
                        : null}
                    </CommandEmpty>
                    {existingNames.length > 0 && (
                      <CommandGroup>
                        {existingNames.map((name) => (
                          <CommandItem
                            key={name}
                            value={name}
                            keywords={[name]}
                            onSelect={() => chooseExisting(name)}
                          >
                            <FolderOpen className="size-3.5 text-violet-400" />
                            <span className="truncate">{name}</span>
                            <Check
                              className={cn(
                                'ml-auto',
                                folder === name ? 'opacity-100' : 'opacity-0',
                              )}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    <CommandGroup>
                      <CommandItem
                        value="__new__"
                        keywords={['new', 'create', t('settings.rag.folderNewOption')]}
                        onSelect={startNewFolder}
                      >
                        <FolderPlus className="size-3.5" />
                        <span>{t('settings.rag.folderNewOption')}</span>
                      </CommandItem>
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {/* Inline new-folder input — shows whenever the user has
                picked "New folder…" (folder is null) regardless of
                whether they've typed anything yet. The previous
                condition gated on `draftNew.length > 0`, which left
                the user staring at a closed popover with no visible
                affordance to type. autoFocus so the cursor lands
                here immediately after picking "New folder…". Enter
                commits, blur also commits (so clicking outside the
                dialog still saves the name). Persists alongside the
                dropdown so the user can switch back to an existing
                folder without losing their draft. */}
            {folder === null && (
              <Input
                autoFocus
                value={draftNew}
                onChange={(e) => setDraftNew(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitDraft();
                  }
                }}
                onBlur={() => commitDraft()}
                placeholder={t('settings.rag.folderNewPlaceholder')}
                disabled={running}
              />
            )}
            {folder === null && draftNew.length > 0 && !nameValid && (
              <p className="text-[0.7rem] text-destructive">
                {t('settings.rag.nameInvalid')}
              </p>
            )}
            {folder && !nameValid && (
              <p className="text-[0.7rem] text-destructive">
                {t('settings.rag.nameInvalid')}
              </p>
            )}
          </div>

          {/* Re-index banner — only when an existing folder is active. */}
          {isExisting && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {t('settings.rag.reindexBanner', [folder])}
            </div>
          )}

          {/* ─── Files inside the chosen folder ─── */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">
                {folder
                  ? `${t('settings.rag.folderLabel')} / ${folder}`
                  : t('settings.rag.filesInsideFolder')}
              </Label>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={running || !folder}
                  onClick={() => fileInputRef.current?.click()}
                  title={t('settings.rag.pickFiles')}
                >
                  <FileText className="size-3" />
                  {t('settings.rag.pickFiles')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={running || !folder}
                  onClick={() => folderInputRef.current?.click()}
                  title={t('settings.rag.pickFolder')}
                >
                  <FolderOpen className="size-3" />
                  {t('settings.rag.pickFolder')}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={[...SUPPORTED_TEXT_EXT, PDF_EXT].join(',')}
                  className="hidden"
                  onChange={(e) => {
                    onPickFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  // @ts-expect-error webkitdirectory is non-standard but
                  // supported in all Chromium-based browsers we ship to.
                  webkitdirectory=""
                  className="hidden"
                  onChange={(e) => {
                    onPickFolder(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>

            {/* Nested file list — visually inside the folder. Empty state
                nudges the user to pick files; the buttons above are
                disabled until a folder is selected. */}
            {files.length === 0 ? (
              <div className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                {folder
                  ? t('settings.rag.filesInsideFolder')
                  : t('settings.rag.folderPlaceholder')}
              </div>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                {/* Folder header row */}
                <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
                  <Folder className="size-3.5 text-violet-400 shrink-0" />
                  <span className="font-mono truncate">{folder ?? '—'}</span>
                  <span className="ml-auto text-muted-foreground">
                    {t('settings.rag.pickedCount', [
                      String(ingestable.length),
                      formatBytes(totalBytes),
                    ])}
                  </span>
                </div>
                {/* File list, indented to look nested */}
                <ul className="max-h-40 overflow-y-auto py-1 text-xs">
                  {files.slice(0, 50).map((f) => (
                    <li
                      key={f.name + f.size}
                      className="flex items-center gap-2 px-3 py-0.5 font-mono text-[0.7rem]"
                    >
                      <FileText
                        className={cn(
                          'size-3 shrink-0',
                          isIngestable(f) ? 'text-foreground/70' : 'text-amber-500',
                        )}
                      />
                      <span className="truncate">{f.name}</span>
                      <span className="ml-auto text-muted-foreground shrink-0">
                        {formatBytes(f.size)}
                      </span>
                    </li>
                  ))}
                  {files.length > 50 && (
                    <li className="px-3 py-0.5 text-muted-foreground/70">
                      …{files.length - 50} more
                    </li>
                  )}
                </ul>
                {skipped > 0 && (
                  <div className="border-t border-border bg-amber-500/5 px-3 py-1 text-[0.7rem] text-amber-600 dark:text-amber-400">
                    {t('settings.rag.pickedSkipped', [String(skipped)])}
                  </div>
                )}
              </div>
            )}
          </div>

          {progress && (
            <div className="rounded-md border border-border p-2 space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <Loader2 className="size-3.5 animate-spin" />
                <span className="flex-1 truncate">{progressLabel}</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{
                    width: `${
                      progress.total > 0
                        ? Math.round((progress.done / progress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            {t('settings.rag.cancel')}
          </Button>
          <Button
            disabled={!slug || !nameValid || ingestable.length === 0 || running}
            onClick={() => void handleIndex()}
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Database className="size-3.5" />
            )}
            {t('settings.rag.index')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}