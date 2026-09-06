/**
 * FileTree — VFS file tree powered by react-arborist.
 *
 * Features: drag & drop, inline rename/create (VFS-first, VS Code style),
 * keyboard navigation, virtualized rendering, file-type icons, right-click context menu.
 *
 * Create flow: VFS placeholder → scan → auto-enter edit mode → rename confirms / cancel deletes.
 */
import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { Tree, type NodeRendererProps, type NodeApi, type TreeApi } from 'react-arborist';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode, FileType, Trash2, FilePlus, FolderPlus, Pencil } from 'lucide-react';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { vfs } from '@/lib/persistence/vfs';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

// ─── Top-level entry palette ───
//
// Immediate children of the workspace root (each skill / prompt folder) get a
// small colored monogram badge so the user can scan a long list at a glance
// instead of reading every name. Color is deterministic per-name (FNV-1a hash
// → palette index) so the same skill keeps the same color across reloads.
//
// Palette mirrors the Settings-card scheme (blue / purple / emerald / indigo
// / orange / pink / cyan / amber) for visual continuity with the rest of the
// polished UI.

interface PaletteEntry {
  bg: string;        // light-mode badge background
  fg: string;        // light-mode badge text/icon
  bgDark: string;    // dark-mode badge background
  fgDark: string;    // dark-mode badge text/icon
}

const TOP_LEVEL_PALETTE: PaletteEntry[] = [
  { bg: 'bg-blue-50',      fg: 'text-blue-600',      bgDark: 'dark:bg-blue-950/40',      fgDark: 'dark:text-blue-400' },
  { bg: 'bg-purple-50',    fg: 'text-purple-600',    bgDark: 'dark:bg-purple-950/40',    fgDark: 'dark:text-purple-400' },
  { bg: 'bg-emerald-50',   fg: 'text-emerald-600',   bgDark: 'dark:bg-emerald-950/40',   fgDark: 'dark:text-emerald-400' },
  { bg: 'bg-indigo-50',    fg: 'text-indigo-600',    bgDark: 'dark:bg-indigo-950/40',    fgDark: 'dark:text-indigo-400' },
  { bg: 'bg-orange-50',    fg: 'text-orange-600',    bgDark: 'dark:bg-orange-950/40',    fgDark: 'dark:text-orange-400' },
  { bg: 'bg-pink-50',      fg: 'text-pink-600',      bgDark: 'dark:bg-pink-950/40',      fgDark: 'dark:text-pink-400' },
  { bg: 'bg-cyan-50',      fg: 'text-cyan-600',      bgDark: 'dark:bg-cyan-950/40',      fgDark: 'dark:text-cyan-400' },
  { bg: 'bg-amber-50',     fg: 'text-amber-700',     bgDark: 'dark:bg-amber-950/40',     fgDark: 'dark:text-amber-400' },
];

/** 32-bit FNV-1a hash → deterministic non-negative integer. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Up to two leading Unicode letters/digits of a name, uppercased — gives
 *  the badge enough entropy to separate same-initial entries (FE for
 *  feynman-explainer vs FR for frontend-deploy) while still fitting a 20 px
 *  badge at 10 px font. Falls back to '?' for purely symbolic / whitespace
 *  names so we never render an empty box. */
function monogramFor(name: string): string {
  const match = name.trim().match(/^[\p{L}\p{N}]{1,2}/u);
  return match ? match[0].toUpperCase() : '?';
}

interface TopLevelBadgeProps {
  name: string;
}

/** Colored monogram badge rendered in place of the default folder/file icon
 *  for the immediate children of the workspace root (skills / prompts). */
function TopLevelBadge({ name }: TopLevelBadgeProps) {
  const entry = TOP_LEVEL_PALETTE[fnv1a(name) % TOP_LEVEL_PALETTE.length]!;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-5 items-center justify-center rounded text-[10px] font-semibold shrink-0 overflow-hidden',
        entry.bg, entry.fg, entry.bgDark, entry.fgDark,
      )}
    >
      {monogramFor(name)}
    </span>
  );
}

// ─── Types ───

interface TreeNodeData {
  id: string;       // full VFS path
  name: string;
  children?: TreeNodeData[];
}

export interface FileTreeHandle {
  /** Create a new empty file. Optional `initialContent` populates the file on disk. */
  createFile: (parentId?: string, initialContent?: string) => void;
  /** Create a new folder (placeholder → inline rename). */
  createFolder: (parentId?: string) => void;
  /** Re-scan the VFS and redraw the tree. */
  refresh: () => void;
}

interface FileTreeProps {
  /** VFS root directory to display. */
  root: string;
  /** Currently selected file path. */
  selectedFile: string | null;
  /** Called when a file is selected. */
  onSelect: (filePath: string) => void;
  /** Incremented to trigger re-scan. */
  refreshKey?: number;
  /** Filter tree nodes by name. */
  searchTerm?: string;
  /** Allow creating subfolders. false = flat file list. */
  allowNewFolder?: boolean;
}

// ─── VFS → tree data builder ───

async function buildTreeData(dirPath: string): Promise<TreeNodeData[]> {
  const nodes: TreeNodeData[] = [];
  let entries: string[];
  try { entries = await vfs.readdir(dirPath); } catch { return nodes; }

  for (const name of entries.sort()) {
    const fullPath = `${dirPath}/${name}`;
    try {
      const stat = await vfs.stat(fullPath);
      if (stat.isDirectory()) {
        const children = await buildTreeData(fullPath);
        nodes.push({ id: fullPath, name, children });
      } else {
        nodes.push({ id: fullPath, name });
      }
    } catch { /* skip unreadable entries */ }
  }
  return nodes;
}

// ─── Unique name helper ───

async function uniqueName(dir: string, base: string, ext?: string): Promise<string> {
  const full = ext ? `${base}${ext}` : base;
  if (!(await vfs.exists(`${dir}/${full}`))) return full;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = ext ? `${base}-${n}${ext}` : `${base}-${n}`;
    if (!(await vfs.exists(`${dir}/${candidate}`))) return candidate;
    n++;
  }
}

// ─── File icon by extension ───

function FileIcon({ name, className }: { name: string; className?: string }) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx') {
    return <FileCode className={className} />;
  }
  if (ext === 'md') {
    return <FileType className={className} />;
  }
  return <FileText className={className} />;
}

// ─── Custom node renderer ───

function NodeRenderer({ node, style, dragHandle, tree }: NodeRendererProps<TreeNodeData>) {
  const allowNewFolder = (tree.props as any).allowNewFolder ?? true;
  const editStartRef = useRef<number>(0);

  const runMenuAction = (action: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    action();
  };

  const handleClick = (e: React.MouseEvent) => {
    if (node.isEditing) return; // Don't activate/toggle while inline-renaming
    if (node.isInternal) {
      node.toggle();
    }
    node.handleClick(e);
    e.stopPropagation();
  };

  const content = (
    <div
      ref={dragHandle}
      style={style}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-sm text-[13px] cursor-pointer select-none group',
        node.isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        node.willReceiveDrop && 'bg-primary/10 ring-1 ring-primary/30',
        node.isDragging && 'opacity-40',
      )}
      onClick={handleClick}
      tabIndex={-1}
    >
      {/* Expand/collapse arrow for folders */}
      {node.isInternal ? (
        <span className="shrink-0 size-4 flex items-center justify-center">
          {node.isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      ) : (
        <span className="shrink-0 size-4" />
      )}

      {/* Icon: top-level entries (immediate children of the workspace root)
          get a colored monogram badge so the user can scan a long skill /
          prompt list at a glance. All nested entries keep the default icons. */}
      {node.level === 0 ? (
        <TopLevelBadge name={node.data.name} />
      ) : node.isInternal ? (
        node.isOpen
          ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          : <Folder className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon name={node.data.name} className="size-4 shrink-0 text-muted-foreground" />
      )}

      {/* Name or rename input */}
      {node.isEditing ? (
        <input
          type="text"
          defaultValue={node.data.name}
          className="flex-1 min-w-0 h-5.5 text-[13px] px-1 py-0 border rounded bg-background outline-none focus:ring-1 focus:ring-primary/40"
          autoFocus
          // Prevent pointer/click from bubbling to the drag-handle div.
          // Without this, pointerdown starts a DnD drag (can't select text)
          // and click triggers handleClick → activate → navigates away.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => {
            editStartRef.current = Date.now();
            const val = e.target.value;
            const dotIdx = val.lastIndexOf('.');
            e.target.setSelectionRange(0, dotIdx > 0 ? dotIdx : val.length);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') node.submit((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') {
              e.stopPropagation();
              e.preventDefault(); // prevent Radix Dialog from closing
              node.reset();
            }
          }}
          onBlur={(e) => {
            // Context menu close steals focus — re-grab it
            if (Date.now() - editStartRef.current < 150) {
              e.target.focus();
              return;
            }
            const val = e.target.value.trim();
            if (val) node.submit(val);
            else node.reset();
          }}
        />
      ) : (
        <span className="truncate flex-1">{node.data.name}</span>
      )}

    </div>
  );

  // Context menu items based on node type and allowNewFolder
  let menuItems: React.ReactNode;
  if (node.isInternal) {
    menuItems = (
      <>
        <ContextMenuItem onClick={runMenuAction(() => (tree.props as any).onCreateFile?.(node.id))}>
          <FilePlus className="size-3.5 mr-2" /> {t('common.newFile')}
        </ContextMenuItem>
        {allowNewFolder && (
          <ContextMenuItem onClick={runMenuAction(() => (tree.props as any).onCreateFolder?.(node.id))}>
            <FolderPlus className="size-3.5 mr-2" /> {t('common.newFolder')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={runMenuAction(() => node.edit())}>
          <Pencil className="size-3.5 mr-2" /> {t('common.rename')}
        </ContextMenuItem>
        <ContextMenuItem onClick={runMenuAction(() => tree.delete(node.id))} className="text-destructive focus:text-destructive">
          <Trash2 className="size-3.5 mr-2" /> {t('common.delete')}
        </ContextMenuItem>
      </>
    );
  } else {
    menuItems = (
      <>
        <ContextMenuItem onClick={runMenuAction(() => node.edit())}>
          <Pencil className="size-3.5 mr-2" /> {t('common.rename')}
        </ContextMenuItem>
        <ContextMenuItem onClick={runMenuAction(() => tree.delete(node.id))} className="text-destructive focus:text-destructive">
          <Trash2 className="size-3.5 mr-2" /> {t('common.delete')}
        </ContextMenuItem>
      </>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div onContextMenu={(e) => e.stopPropagation()}>
          {content}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuItems}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Main component ───

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(
  function FileTree({ root, selectedFile, onSelect, refreshKey, searchTerm, allowNewFolder = true }, ref) {
  const [data, setData] = useState<TreeNodeData[]>([]);
  const treeRef = useRef<TreeApi<TreeNodeData>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 200, height: 400 });

  // Pending edit: after creating a placeholder in VFS and rescanning, auto-enter edit mode
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  // Track placeholders so empty-name reset → delete in VFS
  const placeholdersRef = useRef<Set<string>>(new Set());

  // Native ResizeObserver for dynamic sizing
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setDims({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scan = useCallback(async () => {
    setData(await buildTreeData(root));
  }, [root]);

  useEffect(() => { scan(); }, [scan, refreshKey]);

  // After data updates, check if there's a pending edit node to activate
  useEffect(() => {
    if (!pendingEditId || !treeRef.current) return;
    // Small delay to let react-arborist finish rendering the new data
    const timer = setTimeout(() => {
      const node = treeRef.current?.get(pendingEditId);
      if (node) {
        node.edit();
        setPendingEditId(null);
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [data, pendingEditId]);

  // ─── Resolve parent for create based on current selection ───

  const resolveCreateParent = useCallback((explicitParent?: string): string => {
    if (explicitParent) return explicitParent;
    // Use react-arborist's focused node (tracks clicks on both files and folders)
    const focused = treeRef.current?.focusedNode;
    if (focused?.isInternal) return focused.id; // folder → create inside
    if (focused?.isLeaf) {
      // file → create in same directory (parent)
      const lastSlash = focused.id.lastIndexOf('/');
      return lastSlash > 0 ? focused.id.substring(0, lastSlash) : root;
    }
    return root;
  }, [root]);

  // ─── VFS-first create helpers ───

  // Expand the parent folder (unless it's root) so the newly created node is visible.
  const revealParent = useCallback((parent: string) => {
    if (parent === root) return;
    // Defer: scan() has just queued a data update; open after the tree renders it.
    setTimeout(() => treeRef.current?.open(parent), 50);
  }, [root]);

  const doCreateFile = useCallback(async (parentId?: string, initialContent: string = '') => {
    if (treeRef.current?.isEditing) return;
    const parent = resolveCreateParent(parentId);
    const name = await uniqueName(parent, 'untitled', '.md');
    const fullPath = `${parent}/${name}`;
    try {
      await vfs.writeFile(fullPath, initialContent);
      placeholdersRef.current.add(fullPath);
      await scan();
      revealParent(parent);
      setPendingEditId(fullPath);
    } catch { /* ignore */ }
  }, [resolveCreateParent, scan, revealParent]);

  const doCreateFolder = useCallback(async (parentId?: string) => {
    if (treeRef.current?.isEditing) return;
    const parent = resolveCreateParent(parentId);
    const name = await uniqueName(parent, 'new-folder');
    const fullPath = `${parent}/${name}`;
    try {
      await vfs.mkdir(fullPath, { recursive: true });
      placeholdersRef.current.add(fullPath);
      await scan();
      revealParent(parent);
      setPendingEditId(fullPath);
    } catch { /* ignore */ }
  }, [resolveCreateParent, scan, revealParent]);

  // Expose imperative methods
  useImperativeHandle(ref, () => ({
    createFile: doCreateFile,
    createFolder: doCreateFolder,
    refresh: scan,
  }), [doCreateFile, doCreateFolder, scan]);

  // ─── Data handlers (controlled mode) ───

  const onRename = async ({ id, name }: { id: string; name: string }) => {
    const trimmed = name.trim();
    const isPlaceholder = placeholdersRef.current.has(id);

    // Empty name → cancel. If placeholder, delete it from VFS.
    if (!trimmed) {
      if (isPlaceholder) {
        placeholdersRef.current.delete(id);
        try {
          const stat = await vfs.stat(id);
          if (stat.isDirectory()) await vfs.rm(id, { recursive: true, force: true });
          else await vfs.unlink(id);
        } catch { /* ignore */ }
        await scan();
      }
      return;
    }

    // Clean up placeholder tracking
    if (isPlaceholder) placeholdersRef.current.delete(id);

    const parentDir = id.substring(0, id.lastIndexOf('/'));
    const newPath = `${parentDir}/${trimmed}`;

    // Same name → keep as-is (placeholder stays with its auto-generated name)
    if (newPath === id) {
      if (isPlaceholder) {
        const node = treeRef.current?.get(id);
        if (node?.isLeaf) onSelect(id);
      }
      return;
    }

    // Rename in VFS
    try {
      await vfs.rename(id, newPath);
      await scan();
      if (selectedFile === id) onSelect(newPath);
      else if (selectedFile?.startsWith(id + '/')) onSelect(selectedFile.replace(id, newPath));
      else if (isPlaceholder) {
        // Newly created file — select it after rename
        const stat = await vfs.stat(newPath).catch(() => null);
        if (stat && !stat.isDirectory()) onSelect(newPath);
      }
    } catch { /* ignore rename errors */ }
  };

  const onMove = async ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null; index: number }) => {
    const target = parentId ?? root;
    for (const srcPath of dragIds) {
      const name = srcPath.substring(srcPath.lastIndexOf('/') + 1);
      const destPath = `${target}/${name}`;
      if (destPath === srcPath) continue;
      try {
        await vfs.rename(srcPath, destPath);
        if (selectedFile === srcPath) onSelect(destPath);
        else if (selectedFile?.startsWith(srcPath + '/')) onSelect(selectedFile.replace(srcPath, destPath));
      } catch { /* ignore */ }
    }
    await scan();
  };

  const onDelete = async ({ ids }: { ids: string[] }) => {
    for (const path of ids) {
      placeholdersRef.current.delete(path);
      try {
        const stat = await vfs.stat(path);
        if (stat.isDirectory()) await vfs.rm(path, { recursive: true, force: true });
        else await vfs.unlink(path);
      } catch { /* ignore */ }
    }
    await scan();
    if (selectedFile && ids.some((id) => selectedFile === id || selectedFile.startsWith(id + '/'))) {
      onSelect('');
    }
  };

  const onActivate = (node: NodeApi<TreeNodeData>) => {
    if (node.isEditing) return; // Don't navigate while inline-renaming
    if (node.isLeaf) onSelect(node.id);
  };

  const showEmptyOverlay = data.length === 0 && !pendingEditId;

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative"
      onKeyDown={(e) => {
        if (e.key === 'Delete') {
          const tree = treeRef.current;
          if (!tree || tree.isEditing) return;
          const ids = Array.from(tree.selectedIds);
          if (ids.length > 0) {
            e.preventDefault();
            tree.delete(ids);
          }
        }
      }}
    >
      <Tree<TreeNodeData>
        ref={treeRef}
        data={data}
        onRename={onRename}
        onMove={onMove}
        onDelete={onDelete}
        onActivate={onActivate}
        selection={selectedFile ?? undefined}
        openByDefault={true}
        disableMultiSelection
        searchTerm={searchTerm}
        searchMatch={(node, term) => node.data.name.toLowerCase().includes(term.toLowerCase())}
        width={dims.width}
        height={dims.height}
        indent={16}
        rowHeight={30}
        paddingTop={6}
        paddingBottom={6}
        // Pass through custom props for NodeRenderer to read
        {...{ allowNewFolder, onCreateFile: doCreateFile, onCreateFolder: doCreateFolder } as any}
      >
        {NodeRenderer}
      </Tree>
      {showEmptyOverlay && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground pointer-events-none">
          {t('common.empty.folder')}
        </div>
      )}
    </div>
  );
});