//
// CollectionDialog — 知识库的**新建**与**更新**共用对话框。
//
// 两种模式（`mode`）：
//   • create — 新建。显示名字输入框（由文件夹名推导，可改），不显示同步开关。
//   • update — 用磁盘上的文件夹刷新已有知识库。**不显示名字输入框**：名字在
//              创建时已固定，改名会让它与磁盘上的文件夹不再对应。显示同步开关
//              （默认关闭）与删除预览。
//
// 为什么两种模式都要重新选一次文件夹：`<input webkitdirectory>` 只回传相对
// 路径字符串，**拿不到 `FileSystemDirectoryHandle`**，所以浏览器不保留用户上次
// 选的是哪个目录，我们无法在下次打开时自动重读。将来若改用
// `showDirectoryPicker()`（能拿到并持久化 handle），就能省掉这一步，届时
// "Reindex" 这个叫法才真正准确。在那之前，UI 用「从文件夹更新」描述实际发生的事。
//
// 源是只读的：对话框只负责挑选本地文件并写入索引，不提供增删改源的入口。
//

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, FileText, Folder, FolderOpen, Database } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

/** 文件清单一次最多显示多少行；超出部分折叠成一行「还有 N 个」。
 *  两个用处（截断与计数）必须用同一个值，所以提成常量。 */
const FILE_LIST_CAP = 50;

/** Decide if a picked file can be ingested. Used to filter FileList
 *  before we even attempt to read it. Unknown extensions are skipped
 *  silently — the user gets a toast count after the picker closes. */
function isIngestable(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(PDF_EXT)) return true;
  return SUPPORTED_TEXT_EXT.some((ext) => name.endsWith(ext));
}

/** 对话框的两种用途。`update` 必须带上目标知识库的名字——它已固定，不可改。 */
export type CollectionDialogMode =
  | { kind: 'create' }
  | { kind: 'update'; collectionName: string };

export interface CollectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: RagSettings;
  /** 现有知识库名，用于新建时拦截重名。只有 create 模式需要——update 的名字
   *  已固定，不会撞名。 */
  existingNames?: string[];
  mode: CollectionDialogMode;
  onIndexed: (c: RagCollection) => void;
}

export function CollectionDialog({
  open,
  onOpenChange,
  settings,
  existingNames = [],
  mode,
  onIndexed,
}: CollectionDialogProps) {
  const isUpdate = mode.kind === 'update';

  const [files, setFiles] = useState<File[]>([]);
  /** 新建时由文件夹名推导的名字；用户在输入框里改过的值也落在这里。
   *  更新模式下不使用。 */
  const [nameDraft, setNameDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 更新模式：是否让知识库与本次选择一致（删除未选中的源）。默认关闭——
   *  新增文件绝不能顺手删掉其它源。 */
  const [syncMode, setSyncMode] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset on open so a re-open starts fresh.
  useEffect(() => {
    if (open) {
      setFiles([]);
      setNameDraft('');
      setProgress(null);
      setError(null);
      setSyncMode(false);
    } else {
      // Cancel any in-flight index when the dialog closes.
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [open]);

  // 卸载时也要中止。这个对话框**挂在每一行上**，比页面级版本更容易在索引进行中
  // 被卸载——列表刷新导致行重挂，或用户中途离开设置页。只靠上面的
  // `open === false` 分支覆盖不到这些路径，结果就是索引继续跑、并在已卸载的
  // 组件上 setState。
  //
  // 只在**确实有索引在跑**时提示（`abortRef.current` 非空才非 idle）：平时卸载
  // 一个关着的对话框是常态（列表刷新、折叠 section），不该弹 toast 打扰用户。
  // 用户主动 Cancel 走的是上面的 `open === false` 分支，不经过这里。
  useEffect(() => () => {
    if (abortRef.current) {
      abortRef.current.abort();
      toast.info(t('settings.rag.indexCancelled'));
    }
    abortRef.current = null;
  }, []);

  const ingestable = useMemo(() => files.filter(isIngestable), [files]);
  const skipped = files.length - ingestable.length;

  /** 目标知识库名。更新模式用固定名；新建模式用输入框的值。
   *
   *  新建时名字由文件夹推导后**预填**进输入框，所以这里只需读 `nameDraft`——
   *  不需要再去碰文件夹名，也就不会出现「一改名字按钮就变灰」那类问题。 */
  const targetName = isUpdate ? mode.collectionName : nameDraft;
  const slug = normalizeCollectionName(targetName);
  const nameValid = slug !== null;
  /** 新建时撞上已有名字。**必须拦下**，不能只提示——放行的话
   *  `indexCollection` 会 add-only 合并进那个已有知识库，并把它记录的 `sources`
   *  替换成本次的文件清单。要往已有知识库加文件，正路是它自己的「从文件夹更新」。 */
  const nameTaken = !isUpdate && nameValid && existingNames.includes(slug!);

  const totalBytes = useMemo(
    () => ingestable.reduce((s, f) => s + f.size, 0),
    [ingestable],
  );

  /** Extract the top-level folder name from a `webkitdirectory` pick.
   *  Files in a folder pick carry a `webkitRelativePath` like
   *  `myfolder/sub/file.txt` — we want `myfolder`. */
  const pickFolderName = useCallback((picked: FileList | File[] | null): string | null => {
    if (!picked) return null;
    for (let i = 0; i < picked.length; i++) {
      const rel = picked[i]?.webkitRelativePath;
      if (rel && rel.includes('/')) {
        return rel.split('/')[0] ?? null;
      }
    }
    return null;
  }, []);

  /** 唯一的选源入口。新建模式下顺带把文件夹名填进名字框（作为**结果**，
   *  用户随后可改）；更新模式只用它取文件。 */
  const onPickFolder = useCallback((picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    if (!isUpdate) {
      const folderName = pickFolderName(picked);
      if (folderName) setNameDraft(folderName);
    }
    setFiles(Array.from(picked));
  }, [isUpdate, pickFolderName]);

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
        // Contextual Retrieval — opt-in, only ships the LLM endpoint config
        // when the master toggle is on so we don't leak the key to the
        // indexer when CR is off.
        contextualEnabled: settings.contextualRetrievalEnabled,
        contextualLlmBaseUrl: settings.contextualLlmBaseUrl,
        contextualLlmApiKey: settings.contextualLlmApiKey,
        contextualLlmModel: settings.contextualLlmModel,
        // Add-only by default: sources already in the collection that are not
        // re-picked this run are left untouched. Deleting them is opt-in via
        // the sync toggle, gated behind a confirm that lists every filename.
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
      // 永远查不到东西的空 collection。新建时拒绝它；已有的 collection 更新到 0
      // chunk 则照常（那可能是 sync 模式刚把内容删空，metadata 必须跟上）。
      if (result.chunkCount === 0 && !isUpdate) {
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
  }, [slug, nameValid, ingestable, settings, syncMode, isUpdate, onIndexed, onOpenChange]);

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

  const folderName = pickFolderName(files);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isUpdate ? t('settings.rag.updateTitle') : t('settings.rag.addFolder')}
          </DialogTitle>
          <DialogDescription>
            {isUpdate
              ? t('settings.rag.updateHint', [mode.collectionName])
              : t('settings.rag.addFolderHint')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* The only source-picking entry point. It is step one and the
              source of the name, so it is never disabled — it used to be
              gated on `!folder`, which required a name before you could
              pick files, inverting the real dependency. */}
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
            <input
              ref={folderInputRef}
              type="file"
              multiple
              // @ts-expect-error webkitdirectory is non-standard but supported
              // in all Chromium-based browsers we ship to.
              webkitdirectory=""
              className="hidden"
              onChange={(e) => {
                onPickFolder(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {/* The name input only exists when creating — on update it is
              fixed, and renaming would break its correspondence with the
              folder on disk. When creating it is pre-filled from the folder
              and stays editable, but that is an adjustment, not a
              precondition. */}
          {!isUpdate && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('settings.rag.collectionName')}</Label>
              <Input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={t('settings.rag.collectionNamePlaceholder')}
                disabled={running}
              />
              <p className="text-[0.7rem] text-muted-foreground">
                {t('settings.rag.nameDerivedHint')}
              </p>
              {nameDraft.length > 0 && !nameValid && (
                <p className="text-[0.7rem] text-destructive">
                  {t('settings.rag.nameInvalid')}
                </p>
              )}
              {nameTaken && (
                <p className="text-[0.7rem] text-destructive">
                  {t('settings.rag.nameExists')}
                </p>
              )}
            </div>
          )}

          {/* The sync toggle only appears on update: it governs deleting
              sources this run did not pick, and a brand-new collection has no
              old sources to delete. Off by default. */}
          {isUpdate && (
            <label className="flex items-start gap-2.5 rounded-md border border-border p-2.5 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 accent-destructive"
                checked={syncMode}
                onChange={(e) => setSyncMode(e.target.checked)}
                disabled={running}
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

          {/* Contextual Retrieval cost hint — shown only when the master
              toggle is on, so the cost (one LLM call per chunk) is visible
              before clicking. Both modes show it; the sidebar copy used to
              be missing it. */}
          {settings.contextualRetrievalEnabled && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {t('settings.rag.contextualHint')}
            </div>
          )}

          {/* Picked files — read-only. */}
          {files.length === 0 ? (
            <div className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
              {t('settings.rag.filesInsideFolder')}
            </div>
          ) : (
            <div className="rounded-md border border-border overflow-hidden">
              <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs">
                <Folder className="size-3.5 text-violet-400 shrink-0" />
                <span className="font-mono truncate">{folderName ?? '—'}</span>
                <span className="ml-auto text-muted-foreground">
                  {t('settings.rag.pickedCount', [
                    String(ingestable.length),
                    formatBytes(totalBytes),
                  ])}
                </span>
              </div>
              <ul className="max-h-40 overflow-y-auto py-1 text-xs">
                {files.slice(0, FILE_LIST_CAP).map((f) => (
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
                {files.length > FILE_LIST_CAP && (
                  <li className="px-3 py-0.5 text-muted-foreground/70">
                    {t('chat.composer.loadMore', [String(files.length - FILE_LIST_CAP)])}
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

          {progress && (
            <div className="rounded-md border border-border p-2 space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <Loader2 className="size-3.5 animate-spin" />
                <span className="flex-1 truncate">{progressLabel}</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{
                    width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!slug || !nameValid || nameTaken || ingestable.length === 0 || running}
            onClick={() => void handleIndex()}
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Database className="size-3.5" />
            )}
            {isUpdate ? t('settings.rag.updateAction') : t('settings.rag.index')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
