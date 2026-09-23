import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, File as FileIcon, Folder } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { vfs, normalizePath } from '@/lib/persistence/vfs';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * VfsPathPickerDialog — 为备份的 vfsCustom 分类挑选 VFS 路径（目录或单文件）。
 *
 * 树形懒加载：readdir + stat 逐层展开，不做全量 walk（VFS 可能很大）。勾选语义
 * 与 sanitize / collect 的契约一致——勾目录 = 打包整个子树，勾文件 = 只打包该
 * 文件。根 `/` 不提供勾选（sanitize 会把它丢掉），仅作为树的展开起点。
 */

/** 树节点（readdir + stat 的产物）。 */
interface PickerNode {
  /** 规范化绝对路径。 */
  path: string;
  name: string;
  isDir: boolean;
}

interface VfsPathPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前已选路径（绝对、规范化）；确认时回传新的全量集合。 */
  selected: string[];
  onConfirm: (paths: string[]) => void;
}

/** 目录优先，名称 localeCompare 字典序。 */
function sortNodes(nodes: PickerNode[]): PickerNode[] {
  return [...nodes].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function VfsPathPickerDialog({ open, onOpenChange, selected, onConfirm }: VfsPathPickerDialogProps) {
  /** 已加载目录 → 子节点（懒加载缓存）。 */
  const [children, setChildren] = useState<Map<string, PickerNode[]>>(new Map());
  /** 展开中的目录集合。 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/',]));
  /** 勾选的路径集合——打开时以 props.selected 播种，确认时整体回传。 */
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /** 根目录首次加载中。 */
  const [loading, setLoading] = useState(false);
  /** readdir 失败的目录——渲染层用它区分「空文件夹」与「读取失败」。 */
  const [failedDirs, setFailedDirs] = useState<Set<string>>(new Set());

  const loadChildren = useCallback(async (dir: string): Promise<PickerNode[]> => {
    try {
      const names = await vfs.readdir(dir);
      const nodes = await Promise.all(
        names.map(async (name) => {
          const path = normalizePath(`${dir}/${name}`);
          try {
            const st = await vfs.stat(path);
            return { path, name, isDir: st.isDirectory() } satisfies PickerNode;
          } catch {
            // stat 失败（并发删除等）按文件渲染——勾选后 collect 侧同样会因
            // exists / readFile 失败而静默跳过，不会中断备份。
            return { path, name, isDir: false } satisfies PickerNode;
          }
        }),
      );
      // 成功加载即清除该目录的历史失败标记（重试语义）。
      setFailedDirs((prev) => {
        if (!prev.has(dir)) return prev;
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
      return sortNodes(nodes);
    } catch (err) {
      console.warn('[backup-picker] readdir failed:', err);
      setFailedDirs((prev) => new Set(prev).add(dir));
      toast.error(t('settings.backup.picker.loadFailed'));
      return [];
    }
  }, []);

  // 每次打开：重置树状态、以外部已选路径播种勾选、加载根目录子级。
  // （selected 刻意不入 deps——播种只发生在打开瞬间，之后勾选完全本地自治。）
  useEffect(() => {
    if (!open) return;
    setChecked(new Set(selected));
    setChildren(new Map());
    setFailedDirs(new Set());
    setExpanded(new Set(['/']));
    setLoading(true);
    void (async () => {
      const roots = await loadChildren('/');
      setChildren(new Map([['/', roots]]));
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loadChildren]);

  const toggleExpand = async (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!children.has(dir)) {
      const nodes = await loadChildren(dir);
      setChildren((prev) => new Map(prev).set(dir, nodes));
    }
  };

  const toggleChecked = (path: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  /** 递归渲染一层的树行。深度只驱动缩进，路径本身始终是绝对形态。 */
  const renderLevel = (dir: string, depth: number): ReactNode => {
    const nodes = children.get(dir);
    if (!nodes) return null;
    if (nodes.length === 0) {
      return (
        <p className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: depth * 16 + 40 }}>
          {failedDirs.has(dir)
            ? t('settings.backup.picker.loadFailed')
            : t('settings.backup.picker.empty')}
        </p>
      );
    }
    return nodes.map((node) => {
      const isOpen = expanded.has(node.path);
      return (
        <div key={node.path}>
          <div className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted/60" style={{ paddingLeft: depth * 16 }}>
            {node.isDir ? (
              <button
                type="button"
                onClick={() => void toggleExpand(node.path)}
                aria-expanded={isOpen}
                aria-label={node.name}
                className="shrink-0 rounded p-0.5 hover:bg-muted"
              >
                <ChevronRight
                  className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-90')}
                />
              </button>
            ) : (
              <span className="size-[18px] shrink-0" />
            )}
            <Checkbox
              checked={checked.has(node.path)}
              onCheckedChange={(v) => toggleChecked(node.path, v === true)}
              aria-label={node.name}
              className="shrink-0"
            />
            {node.isDir ? (
              <Folder className="size-3.5 shrink-0 text-amber-500" />
            ) : (
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate text-xs" title={node.path}>
              {node.name}
            </span>
          </div>
          {node.isDir && isOpen && renderLevel(node.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.backup.picker.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('settings.backup.picker.hint')}</p>
          <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border p-2">
            {/* Root row: expansion anchor only -- picking / is disabled (it is
                not a valid backup target). */}
            <div className="flex items-center gap-1 rounded px-1 py-0.5">
              <button
                type="button"
                onClick={() => void toggleExpand('/')}
                aria-expanded={expanded.has('/')}
                aria-label="/"
                className="shrink-0 rounded p-0.5 hover:bg-muted"
              >
                <ChevronRight
                  className={cn('size-3.5 text-muted-foreground transition-transform', expanded.has('/') && 'rotate-90')}
                />
              </button>
              <Checkbox disabled className="shrink-0" aria-label="/" />
              <Folder className="size-3.5 shrink-0 text-amber-500" />
              <span className="truncate text-xs">/</span>
            </div>
            {expanded.has('/') &&
              (loading ? (
                <p className="py-1 pl-4 text-xs text-muted-foreground">…</p>
              ) : (
                renderLevel('/', 1)
              ))}
          </div>
        </div>

        <DialogFooter>
          <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">
            {t('settings.backup.picker.selectedCount', [String(checked.size)])}
          </p>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => onConfirm([...checked])}>{t('common.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
