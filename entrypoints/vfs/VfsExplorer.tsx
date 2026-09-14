import { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { vfs, isProtectedVfsRoot } from '@/lib/persistence/vfs';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/persistence/storage';
import { downloadFile } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Spinner } from '@/components/ui/spinner';
import { t } from '@/lib/i18n';
import { applyTheme, resolveTheme } from './lib/theme';
import { dualViewTypeOf, getHashPath, navigateTo, sessionUuidOf, workspaceUuidOf } from './lib/path-utils';
import { copyText } from '@/lib/ui/clipboard';
import { rmRecursive } from './lib/rm-recursive';
import { cpRecursive, getClipboardBuffer, setClipboardBuffer, clearClipboardBuffer } from './lib/clipboard-buffer';
import { zipDirectory, zipNameFor } from './lib/download';
import type { DirEntry } from './types';
import { buildCrumbs } from './lib/breadcrumb';
import { loadView, releaseView } from './lib/load-view';
import { Breadcrumbs } from './ui/Breadcrumbs';
import { DirView } from './ui/DirView';
import { FileView } from './ui/FileView';
import { Toolbar } from './ui/Toolbar';
import type { DualViewType, ViewMode, ViewState } from './types';

const BRAND_ICON = browser.runtime.getURL('/icon/32.png' as never);

export default function App() {
  const [theme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: 'loading', path: getHashPath() });
  // 下载忙碌标志放在 `view` 之外：在 `/prompts` 上发起的打包即使用户中途导航走了也
  // 必须继续（显式下载不打断）。handler 在点击时从闭包捕获目标路径，与后续 view 无关。
  const [isDownloading, setIsDownloading] = useState(false);
  // 预览 / 源码切换按文件类型各自记忆：连续浏览多个 .md 时保持用户选的视图，
  // 切到别的双视图类型互不影响。内存态，不持久化。
  const [viewModes, setViewModes] = useState<Partial<Record<DualViewType, ViewMode>>>({});
  // 当前目录的多选状态。Set 用 name 当 key 而非 path——`/workspaces/<uuid>` path 会随
  // hash 变化但 name 稳定，dir 重载时 selection 自动延续到新 view。切目录时清空。
  const [selectedNames, setSelectedNames] = useState<Set<string>>(() => new Set());

  // ── 主题同步 ──
  useEffect(() => {
    themePreference.getValue().then((val) => {
      applyTheme(resolveTheme(val ?? 'system'));
      setThemeReady(true);
    });
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    applyTheme(resolveTheme(theme));
  }, [theme, themeReady]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // ── 按 hash 加载路径 ──
  //
  // 两份跨调用状态放在 ref 里：
  //   1. `loadIdRef`：每次 loadPath 进入时取一个递增 id，await 之后重新核对；连续多次
  //      hashchange（或上一次尚未完成时又来一次）不会让过期结果覆盖新结果。
  //   2. `heldRef`：当前持有外部资源（blob URL / pdf.js 文档）的视图，换视图前 / 卸载时
  //      经 `releaseView` 释放，内存有界。
  const loadIdRef = useRef(0);
  const heldRef = useRef<ViewState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 切目录时清空多选：跨目录保留会让旧 name 在新目录里出现误选。Ref 用来在 effect 内
  // 读取当前 path 而不把 effect 拆成 path 依赖（避免 path 变化时双重 setSelected）。
  const lastDirPathRef = useRef<string | null>(null);
  useEffect(() => {
    const currentDirPath = view.kind === 'dir' ? view.path : null;
    if (currentDirPath !== lastDirPathRef.current) {
      lastDirPathRef.current = currentDirPath;
      setSelectedNames((prev) => (prev.size === 0 ? prev : new Set()));
    }
  }, [view]);

  // Ctrl+A 在 dir view 中 select-all entries。当前 Ctrl+A 焦点条件：仅 dir 视图且未在
  // input/textarea 中（让 textarea 自身的 select-all 不被吞掉）。
  useEffect(() => {
    if (view.kind !== 'dir') return;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        if (view.kind !== 'dir') return;
        setSelectedNames(new Set(view.entries.map((entry) => entry.name)));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  useEffect(() => {
    if (!themeReady) return;

    function releaseHeld() {
      if (heldRef.current) {
        releaseView(heldRef.current);
        heldRef.current = null;
      }
    }

    async function loadPath() {
      const myId = ++loadIdRef.current;
      // 作废上一次仍在飞的加载：结果会被 loadIdRef 丢弃，abort 让它别再做重活。
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const path = getHashPath();
      // 加载态继承上一视图的会话标签（仍在同一会话内时），面包屑不会闪成「未知会话」。
      setView((prev) => ({
        kind: 'loading',
        path,
        session: prev.session?.id === sessionUuidOf(path) ? prev.session : undefined,
      }));
      const next = await loadView(path, controller.signal);
      if (myId !== loadIdRef.current) {
        // 已被更新的导航作废：把这次加载创建的资源直接释放。
        releaseView(next);
        return;
      }
      releaseHeld();
      heldRef.current = next;
      setView(next);
    }

    loadPath();
    window.addEventListener('hashchange', loadPath);
    return () => {
      loadIdRef.current++;
      abortRef.current?.abort();
      releaseHeld();
      window.removeEventListener('hashchange', loadPath);
    };
  }, [themeReady]);

  // ── 下载（文件或打包的文件夹）──
  //
  // 第一个 await 之前把 `view` 快照成常量，避免并发 hashchange 把下载导向别的路径。
  // 有意不在导航时中止——见 `isDownloading` 的声明注释。
  async function handleDownload() {
    if (isDownloading) return;
    const snapshot = view;
    if (snapshot.kind !== 'file' && snapshot.kind !== 'dir') return;

    setIsDownloading(true);
    try {
      if (snapshot.kind === 'file') {
        const data = (await vfs.readFile(snapshot.path)) as unknown as Uint8Array;
        const name = snapshot.path.split('/').pop() || 'file';
        // 包成 Blob——`downloadFile` 接受 ArrayBuffer/Blob/string 而不直接接受 Uint8Array。
        // `as BlobPart` 见 load-view.ts 同处注释。通用 octet-stream 防止浏览器改写扩展名
        // （如 .md → .txt）。
        downloadFile(name, new Blob([data as BlobPart], { type: 'application/octet-stream' }), 'application/octet-stream');
      } else {
        const data = await zipDirectory(snapshot.path);
        downloadFile(zipNameFor(snapshot.path), new Blob([data as BlobPart], { type: 'application/zip' }), 'application/zip');
      }
    } catch (err) {
      console.error('[vfs.download]', err);
      toast.error(t('common.downloadFailed'));
    } finally {
      setIsDownloading(false);
    }
  }

  // ── 单行 row action handlers (Subtask 2) ──
  async function handleRowDownload(fullPath: string) {
    if (isDownloading) return;
    try {
      const data = (await vfs.readFile(fullPath)) as unknown as Uint8Array;
      const name = fullPath.split('/').pop() || 'file';
      downloadFile(name, new Blob([data as BlobPart], { type: 'application/octet-stream' }), 'application/octet-stream');
    } catch (err) {
      console.error('[vfs.download]', err);
      toast.error(t('common.downloadFailed'));
    }
  }

  // 重命名：弹 dialog 输入新名，校验后调 vfs.rename，触发 loadPath 刷新。
  async function handleRowRename(fullPath: string, currentName: string) {
    const parentDir = fullPath.slice(0, fullPath.length - currentName.length - 1) || '/';
    const newName = window.prompt(t('vfs.prompt.rename', [currentName]), currentName);
    if (!newName || newName === currentName) return;
    if (newName.includes('/') || newName.includes('..') || !newName.trim()) {
      toast.error(t('vfs.error.invalidName'));
      return;
    }
    try {
      await vfs.rename(fullPath, `${parentDir}/${newName}`);
    } catch (err) {
      console.error('[vfs.rename]', err);
      toast.error(t('vfs.toast.renameFailed', [newName, String(err)]));
    }
  }

  // 删除：受保护根（/、/workspaces、~/.cebian/skills、~/.cebian/prompts）禁止删；
  // 否则用 window.confirm 二次确认。删除目录时 vfs.rm 默认不递归；用 readdir + rm 递归清空。
  async function handleRowDelete(fullPath: string, name: string, isDir: boolean) {
    if (isProtectedVfsRoot(fullPath)) {
      toast.error(t('vfs.error.cannotDeleteProtected'));
      return;
    }
    const label = isDir ? t('vfs.confirm.deleteFolder', [name]) : t('vfs.confirm.deleteFile', [name]);
    if (!window.confirm(label)) return;
    try {
      if (isDir) {
        await rmRecursive(fullPath);
      } else {
        await vfs.rm(fullPath);
      }
      // Force the dir view to re-read entries — vfs state changed but
      // hash didn't, so navigateTo triggers the hashchange → loadPath().
      if (view.kind === 'dir') navigateTo(view.path);
    } catch (err) {
      console.error('[vfs.delete]', err);
      toast.error(t('vfs.toast.deleteFailed', [name, String(err)]));
    }
  }

  // 批量删除：按名查 entry，过滤受保护路径，统一 confirm 一次后并发执行。
  async function handleBatchDelete(names: string[]) {
    if (names.length === 0) return;
    if (view.kind !== 'dir') return;
    const byName = new Map(view.entries.map((e) => [e.name, e] as const));
    const targets: { fullPath: string; entry: DirEntry }[] = [];
    for (const name of names) {
      const entry = byName.get(name);
      if (!entry) continue;
      const fullPath = view.path === '/' ? `/${entry.name}` : `${view.path}/${entry.name}`;
      if (isProtectedVfsRoot(fullPath)) {
        toast.error(t('vfs.error.cannotDeleteProtected'));
        return;
      }
      targets.push({ fullPath, entry });
    }
    if (targets.length === 0) return;
    const summary = `${targets.length} item${targets.length === 1 ? '' : 's'}`;
    if (!window.confirm(`${t('common.session.deleteManyConfirmTitle', targets.length)}\n${summary}`)) return;
    try {
      await Promise.all(
        targets.map(async ({ fullPath, entry }) => {
          if (entry.isDir) {
            await rmRecursive(fullPath);
          } else {
            await vfs.rm(fullPath);
          }
        }),
      );
      setSelectedNames(new Set());
      // Force the dir view to re-read entries — `view.entries` only refreshes
      // when hash changes, and hash hasn't changed here. navigateTo triggers
      // the hashchange listener that re-runs loadPath().
      navigateTo(view.path);
    } catch (err) {
      console.error('[vfs.deleteBatch]', err);
      toast.error(t('vfs.toast.deleteFailed', [summary, String(err)]));
    }
  }

  // Edit：跳到该文件的 source view（已支持 CodeView 高亮 + CopyButton）。后续若加全屏编辑器
  // 把这里换成 navigateTo + `?edit=1` 之类 query。当前最小可用方案。
  function handleRowEdit(fullPath: string) {
    // 切到 source 模式需要 setViewModes（ViewMode 状态在父级）。此处通过 navigateTo 直接打开
    // 文件；FileView 默认走 preview（html/svg）或 text/markdown 等简单类型，text/markdown/code
    // 自然走 CodeView，html 我们强制切到 source 让用户至少看到原始标签。
    navigateTo(fullPath);
  }

  // ── Subtask 3: New File / New Folder / Cut+Paste handlers ──

  // 新建条目：在 dir 下弹 dialog 输入名（按 entry type 区分 placeholder），空名校验 + /
  // / .. 拒绝。成功后无需手动 reload —— vfs 的 'write' | 'mkdir' mutation event 已通过
  // listener 链路把新条目接进 next loadPath（但当前 DirView 直接消费 props.entries，
  // 所以这里触发一次 hash 变化或调用 `navigateTo(path)` 让 loadPath 重新拉取）。
  function handleNewFile(dir: string) {
    const name = window.prompt(t('vfs.prompt.newName', [t('vfs.action.newFile')]), '');
    if (!name) return;
    if (name.includes('/') || name.includes('..') || !name.trim()) {
      toast.error(t('vfs.error.invalidName'));
      return;
    }
    void vfs.writeFile(`${dir === '/' ? '' : dir}/${name}`, '' as Parameters<typeof vfs.writeFile>[1])
      .catch((err) => {
        console.error('[vfs.writeFile]', err);
        toast.error(t('vfs.toast.createFailed', [name, String(err)]));
      })
      .then(() => navigateTo(dir));
  }

  function handleNewFolder(dir: string) {
    const name = window.prompt(t('vfs.prompt.newName', [t('vfs.action.newFolder')]), '');
    if (!name) return;
    if (name.includes('/') || name.includes('..') || !name.trim()) {
      toast.error(t('vfs.error.invalidName'));
      return;
    }
    void vfs
      .mkdir(`${dir === '/' ? '' : dir}/${name}`)
      .catch((err) => {
        console.error('[vfs.mkdir]', err);
        toast.error(t('vfs.toast.createFailed', [name, String(err)]));
      })
      .then(() => navigateTo(dir));
  }

  // 粘贴：从 module buffer 读 paths，复制或移动到当前 dir。
  function handlePaste(dir: string) {
    const buf = getClipboardBuffer();
    if (buf.paths.length === 0) return;
    const isPasteIntoSelf = (src: string) =>
      src === dir || src.startsWith((dir === '/' ? '' : dir) + '/');
    const allConflict = buf.paths.every(isPasteIntoSelf);
    if (allConflict) {
      toast.error(t('vfs.toast.pasteSelf', [buf.paths[0]]));
      return;
    }
    const tasks = buf.paths.map(async (src) => {
      if (isPasteIntoSelf(src)) return null;
      const name = src.split('/').pop() ?? src;
      const dest = `${dir === '/' ? '' : dir}/${name}`;
      if (buf.verb === 'cut') {
        await vfs.rename(src, dest);
      } else {
        await cpRecursive(src, dest);
      }
      return name;
    });
    Promise.all(tasks)
      .catch((err) => {
        console.error('[vfs.paste]', err);
        toast.error(t('vfs.toast.pasteFailed', [buf.paths[0] ?? '', String(err)]));
      })
      .then(() => {
        if (buf.verb === 'cut') clearClipboardBuffer();
        navigateTo(dir);
      });
  }

  // 当 dir view 渲染时把 pasteHint 透传到 Toolbar；buffer 为空时不渲染 Paste 按钮。
  const pasteBuffer = view.kind === 'dir' ? getClipboardBuffer() : { verb: 'copy' as const, paths: [] };
  const pasteHint =
    view.kind === 'dir' && pasteBuffer.paths.length > 0
      ? t('vfs.action.pasteHint', [
          pasteBuffer.verb === 'cut' ? t('vfs.action.cut') : t('vfs.action.copy'),
          String(pasteBuffer.paths.length),
        ])
      : undefined;

  // ── 渲染 ──

  // 加载态且没有继承到会话标签时，会话段只显示短 ID（标签还没查回来，不是会话已删）。
  const crumbs = useMemo(
    () =>
      buildCrumbs(
        view.path,
        view.kind === 'dir' ? true : view.kind === 'file' ? false : undefined,
        view.kind === 'loading' && !view.session ? 'pending' : view.session,
      ),
    [view],
  );
  const dualType: DualViewType | null = view.kind === 'file' ? dualViewTypeOf(view.media) : null;
  const mode: ViewMode = (dualType ? viewModes[dualType] : undefined) ?? 'preview';

  if (!themeReady) return null;

  // 主区域是滚动容器；填满型视图（媒体 / 占位 / HTML 预览）用 absolute inset-0 铺满它，
  // PDF 视图为了做 IntersectionObserver 的 root 自带一层滚动容器。
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen bg-background text-foreground">
        <header className="flex items-center gap-3 pl-3 pr-3.5 h-[46px] border-b border-border shrink-0">
          <img src={BRAND_ICON} alt="Cebian" title="Cebian" className="size-6 rounded-md shrink-0" />
          <div className="h-4 w-px bg-border shrink-0" />
          <div className="flex-1 min-w-0">
            <Breadcrumbs crumbs={crumbs} />
          </div>
          <Toolbar
            view={view}
            mode={dualType ? mode : undefined}
            onModeChange={(next) => dualType && setViewModes((prev) => ({ ...prev, [dualType]: next }))}
            isDownloading={isDownloading}
            onDownload={handleDownload}
            onNewFile={view.kind === 'dir' ? handleNewFile : undefined}
            onNewFolder={view.kind === 'dir' ? handleNewFolder : undefined}
            onPaste={view.kind === 'dir' ? handlePaste : undefined}
            {...(pasteHint !== undefined ? { pasteHint } : {})}
          />
        </header>

        <main className="flex-1 min-h-0 overflow-auto relative">
          {view.kind === 'loading' && (
            <div className="flex items-center justify-center py-20">
              <Spinner className="size-5 text-primary" aria-label={t('common.loading')} />
            </div>
          )}

          {view.kind === 'dir' && (
            <div className="max-w-3xl mx-auto px-5 py-5">
              <DirView
                path={view.path}
                entries={view.entries}
                workspaceLabels={view.workspaceLabels}
                workspaceRow={workspaceUuidOf(view.path) ? view.session : undefined}
                selectedNames={selectedNames}
                onToggleSelect={(name) => setSelectedNames((prev) => {
                  const next = new Set(prev);
                  if (next.has(name)) next.delete(name);
                  else next.add(name);
                  return next;
                })}
                onSelectAll={() => setSelectedNames(new Set(view.entries.map((e) => e.name)))}
                onClearSelection={() => setSelectedNames(new Set())}
                onBatchDelete={view.kind === 'dir' ? handleBatchDelete : undefined}
                onRowAction={async (actionId, entry, fullPath) => {
                  if (actionId === 'copyPath') {
                    const ok = await copyText(fullPath, { silent: true });
                    toast[ok ? 'success' : 'error'](ok ? t('vfs.pathCopied') : t('common.copyFailed'));
                  } else if (actionId === 'copyName') {
                    const ok = await copyText(entry.name, { silent: true });
                    toast[ok ? 'success' : 'error'](ok ? t('common.copied') : t('common.copyFailed'));
                  } else if (actionId === 'copy') {
                    setClipboardBuffer({ verb: 'copy', paths: [fullPath] });
                    toast.success(t('common.copied'));
                  } else if (actionId === 'cut') {
                    setClipboardBuffer({ verb: 'cut', paths: [fullPath] });
                    toast.success(t('vfs.action.cut'));
                  } else if (actionId === 'download') {
                    void handleRowDownload(fullPath);
                  } else if (actionId === 'edit') {
                    handleRowEdit(fullPath);
                  } else if (actionId === 'rename') {
                    void handleRowRename(fullPath, entry.name);
                  } else if (actionId === 'delete') {
                    void handleRowDelete(fullPath, entry.name, entry.isDir);
                  }
                }}
              />
            </div>
          )}

          {view.kind === 'file' && <FileView path={view.path} media={view.media} mode={mode} />}

          {view.kind === 'error' && (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
                <span className="text-destructive text-lg">!</span>
              </div>
              <p className="text-sm text-muted-foreground">{view.message}</p>
              <button
                onClick={() => navigateTo('/')}
                className="mt-2 text-xs text-primary hover:underline"
              >
                {t('vfs.backToRoot')}
              </button>
            </div>
          )}
        </main>
        <Toaster theme={resolveTheme(theme)} />
      </div>
    </TooltipProvider>
  );
}
