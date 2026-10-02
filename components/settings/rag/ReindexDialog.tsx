//
// ReindexDialog — 「新建 / 重新索引知识库」对话框。
//
// 一个 collection 的两种入口共用它：新建（`initialName` 为 null）与重新索引
// （`initialName` 为已有名字，打开时预填、并显示提示横幅）。
//
// 文件偏长（~590 行）是刻意的：这是一条**顺序流程**——选文件 → 配置 → 跑 →
// 报进度，拆成两半会得到两个都不能独立成立的部分。可复用的片段（文件选择器、
// 进度条）已在本文件内提取为小组件。
//
// 源是只读的：对话框只负责挑选本地文件并写入索引，不提供增删改源的入口。
//

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, FileText, Folder, FolderPlus, ChevronDown, Check, FolderOpen, Database } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { showConfirm } from '@/lib/ui/dialog';
import { formatBytes, cn } from '@/lib/utils';
import {
  buildEmbedder, indexCollection, IndexCancelledError, MixedModelError,
  normalizeCollectionName, upsertCollection,
  type IndexProgress, type RagCollection, type RagSettings,
} from '@/lib/rag';
import { t } from '@/lib/i18n';

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

export interface ReindexDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: RagSettings;
  existingNames: string[];
  /** When set, the dialog opens pre-named for a re-index of the named
   *  collection. The user must still re-pick files (we don't keep the
   *  originals on disk). */
  initialName: string | null;
  onIndexed: (updated: RagCollection) => void;
}

export function ReindexDialog({
  open,
  onOpenChange,
  settings,
  existingNames,
  initialName,
  onIndexed,
}: ReindexDialogProps) {
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
  /** Opt-in: delete collection sources that are not part of this run.
   *  Off by default — adding a file must never silently drop the others. */
  const [syncMode, setSyncMode] = useState(false);
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
      setSyncMode(false);
    } else {
      // Cancel any in-flight index when the dialog closes.
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open, initialName]);

  // 卸载时也要中止。这个对话框现在**挂在每一行上**（重新索引流程），因此比
  // 以前的页面级版本更容易在索引进行中被卸载——例如列表刷新导致该行重挂，
  // 或用户中途离开设置页。只靠上面的 `open === false` 分支覆盖不到这些路径，
  // 结果就是索引继续跑、并在已卸载的组件上 setState。
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const ingestable = useMemo(() => files.filter(isIngestable), [files]);
  const skipped = files.length - ingestable.length;

  /** 当前生效的名字。两个来源：`folder`（选完文件夹自动推导）或 `draftNew`
   *  （用户手改 / 走「挑文件」时手输）。**必须同时看两者**——用户一动手改，
   *  `onChange` 就把 `folder` 置空，只看 `folder` 会让名字瞬间变空、Index 按钮
   *  立刻变灰。 */
  const nameInput = draftNew || folder || '';
  const slug = normalizeCollectionName(nameInput);
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
        // Contextual Retrieval (Subtask 3) — opt-in, only ships the
        // LLM endpoint config when the master toggle is on so we
        // don't leak the key to the indexer when CR is off.
        contextualEnabled: settings.contextualRetrievalEnabled,
        contextualLlmBaseUrl: settings.contextualLlmBaseUrl,
        contextualLlmApiKey: settings.contextualLlmApiKey,
        contextualLlmModel: settings.contextualLlmModel,
        // Default is add-only: files already in the collection that are not
        // re-picked this run are left untouched. Deleting them is opt-in via
        // the sync toggle, and gated behind a confirm that lists every
        // affected filename.
        syncMode,
        confirmPrune: async (removed) => {
          return showConfirm({
            title: t('settings.rag.syncConfirmTitle'),
            description: t('settings.rag.syncConfirmBody'),
            // One row per file — `description` renders in a single <p> where
            // newlines collapse, and the user must be able to scan exactly
            // what is about to be deleted.
            detailLines: removed.map(
              (r) => `${r.path} — ${t('settings.rag.syncConfirmChunks', [String(r.chunks)])}`,
            ),
            destructive: true,
          });
        },
      });
      // 不为「新建」写入 0 chunk 的 collection。
      //
      // `indexCollection` 在**没有任何文件产出 chunk 时仍返回成功**（`chunkCount: 0`）
      // ——典型场景是扫描版 PDF 没有文字层。以前这里照样 upsert，于是列表里留下一个
      // 永远查不到东西的空 collection。新建时拒绝它；已存在的 collection 重索引到 0
      // chunk 则照常更新（那可能是 sync 模式刚把内容删空，metadata 必须跟上）。
      if (result.chunkCount === 0 && !isExisting) {
        setProgress(null);
        setError(t('settings.rag.emptyIndexError'));
        return;
      }
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
        notInLastRun: result.notInLastRun,
      };
      const next = await upsertCollection(collection);
      toast.success(
        result.prunedCount > 0
          ? t('settings.rag.indexDonePruned', [
              String(result.chunkCount),
              String(result.prunedCount),
            ])
          : t('settings.rag.indexDone', [String(result.chunkCount)]),
      );
      onIndexed(collection);
      // Notify parent of updated list (parent also reads from storage).
      void next;
      onOpenChange(false);
    } catch (err) {
      if (err instanceof MixedModelError) {
        // A different embedding model already owns part of this collection and
        // those rows would survive this run. Two real ways out, both offered
        // here — an "override" flag would only produce the mixed state we are
        // refusing.
        setProgress(null);
        setError(t('settings.rag.mixedModelError'));
      } else if (err instanceof IndexCancelledError) {
        // Two sources: the user closed the dialog (abort), or they declined
        // the sync-delete confirm. In the latter the dialog is still open, so
        // clear the progress card — otherwise it spins forever with no
        // explanation.
        setProgress(null);
      } else {
        const msg = (err as Error).message ?? String(err);
        setError(msg);
        toast.error(`${t('settings.rag.indexFailed')}: ${msg}`);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [slug, nameValid, ingestable, settings, syncMode, onIndexed, onOpenChange]);

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
          <DialogTitle>
            {isExisting ? t('settings.rag.reindexTitle') : t('settings.rag.addFolder')}
          </DialogTitle>
          <DialogDescription>
            {isExisting
              ? t('settings.rag.reindexHint')
              : t('settings.rag.addFolderHint')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Primary action: pick a folder. This is step one and the source
              of the name, so it is never disabled — it used to be gated on
              `!folder`, which required a name before you could pick files,
              inverting the real dependency. */}
          <div className="space-y-1.5">
            <Button
              type="button"
              variant="outline"
              disabled={running}
              className="w-full justify-start font-normal"
              onClick={() => folderInputRef.current?.click()}
            >
              <FolderOpen className="size-3.5 shrink-0" />
              {t('settings.rag.chooseFolder')}
            </Button>
            <p className="text-[0.7rem] text-muted-foreground">
              {t('settings.rag.chooseFolderHint')}
            </p>
          </div>

          {/* The name is an OUTCOME, not a prerequisite: it appears after a
              folder is picked, pre-filled with the folder's slug. Still
              editable — wanting a different name is legitimate, but that is
              an adjustment, not a precondition. On the "pick files" path
              (no folder name) this input is the only way to name it, so it
              cannot be gated on `folder` alone. */}
          {(folder !== null || draftNew.length > 0 || files.length > 0) && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('settings.rag.collectionName')}</Label>
              <Input
                value={nameInput}
                onChange={(e) => {
                  setDraftNew(e.target.value);
                  setFolder(null);
                }}
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
              <p className="text-[0.7rem] text-muted-foreground">
                {t('settings.rag.nameDerivedHint')}
              </p>
              {!nameValid && (
                <p className="text-[0.7rem] text-destructive">
                  {t('settings.rag.nameInvalid')}
                </p>
              )}
            </div>
          )}

          {/* Only re-indexing needs "switch to a different existing
              collection" — the create flow has no such concept. The two
              flows used to share this dropdown, which conflated "pick a
              target" with "invent a name". */}
          {isExisting && (
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
            </div>
          )}

          {/* Re-index banner — only when an existing folder is active. */}
          {isExisting && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {t('settings.rag.reindexBanner', [folder])}
            </div>
          )}

          {/* Sync toggle — only meaningful when re-indexing an existing
              collection. Off (the default) means add-only: files already in
              the collection are kept even if not re-picked here. */}
          {isExisting && (
            <label className="flex items-start gap-2.5 rounded-md border border-border p-2.5 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 accent-destructive"
                checked={syncMode}
                onChange={(e) => setSyncMode(e.target.checked)}
              />
              <span className="space-y-0.5">
                <span className="block text-xs font-medium">
                  {t('settings.rag.syncToggle')}
                </span>
                <span className="block text-[0.7rem] text-muted-foreground">
                  {t('settings.rag.syncToggleHint')}
                </span>
              </span>
            </label>
          )}

          {/* Contextual Retrieval cost hint — only when the master toggle
              is on, so the user knows they're about to spend 1 LLM call
              per chunk before clicking Index. Same amber styling as the
              re-index banner so visually consistent with the "heads-up"
              pattern. */}
          {settings.contextualRetrievalEnabled && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {t('settings.rag.contextualHint')}
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
                {/* "Pick files" is the fallback path (multi-file, no
                    webkitdirectory). It sits after folder selection but is
                    not blocked by it — both buttons used to carry a `!folder`
                    guard, forcing you to name before you could pick. */}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={running}
                  onClick={() => fileInputRef.current?.click()}
                  title={t('settings.rag.pickFiles')}
                >
                  <FileText className="size-3" />
                  {t('settings.rag.pickFiles')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={running}
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
                nudges the user to pick files; folder selection is optional
                on the pick-files path. */}
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
