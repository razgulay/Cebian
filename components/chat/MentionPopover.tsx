//
// MentionPopover — the + button's dropdown that lets the user attach
// prompt/skill/VFS-directory references as chips in the composer.
//
// Built on Radix Popover (positioning + a11y) and cmdk (search + groups).
// Three live sections (Skills, Prompts, Folders) and one placeholder section
// (Add tabs). Each section lazy-loads on first open via Promise.all in the
// effect; we cache the result locally to keep re-opens instant.
//
// Built-in skills ship from locales (no VFS round-trip). Their bodies are
// loaded at module-evaluation time via t() and shipped through MentionChip
// with `isBuiltIn: true` — the resolver reads the body straight off the chip.
//
import { useEffect, useMemo, useState } from 'react';
import { Plus, FileText, Sparkles, Folder, Layers, Pin, ChevronRight, File as FileIcon, Database } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { scanPrompts, scanSkillIndex, type PromptMeta, type SkillMeta } from '@/lib/ai-config/scanner';
import { vfs, normalizePath } from '@/lib/persistence/vfs';
import { CEBIAN_HOME, WORKSPACES_ROOT } from '@/lib/persistence/vfs-paths';
import { ragCollections, type RagCollection } from '@/lib/rag';
import { formatBytes } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { MentionChip, PinnedMention } from '@/lib/agent/mention-resolver';

interface MentionPopoverProps {
  disabled?: boolean;
  onSelect: (chip: MentionChip) => void;
  /** Currently pinned items — drives the "Pinned" section at the top of
   *  the popover and the filled/outline state of each per-item toggle. */
  pinned?: PinnedMention[];
  /** Lookup so each CommandItem can render the right Pin icon state. */
  isPinned?: (id: string) => boolean;
  /** Add / remove a pin — called from the per-item Pin toggle button. */
  onTogglePin?: (item: PinnedMention) => void;
}

interface FolderListing {
  path: string;
  label: string;
}

/** Entry at the current folder-browse position. Mix of files and
 *  sub-directories; the user can pick a file (→ mention-file chip) or
 *  drill into a sub-directory by clicking it. */
interface FolderEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size?: number;
}

/** Hardcoded map of locale-driven built-in skills. The id is the locale key
 *  namespace (`chat.mention.builtinSkill.<id>Name` / `…Body`); the chip's
 *  body is loaded at render time, NOT at module-evaluation time, so locale
 *  switching still picks up the right translation. */
const BUILTIN_SKILL_IDS = ['funFacts', 'hypeItUp', 'explainInCharacter'] as const;
type BuiltinSkillId = typeof BUILTIN_SKILL_IDS[number];

function loadBuiltinSkills(): { id: BuiltinSkillId; name: string; body: string }[] {
  return BUILTIN_SKILL_IDS.map((id) => ({
    id,
    name: t(`chat.mention.builtinSkill.${id}Name`),
    body: t(`chat.mention.builtinSkill.${id}Body`),
  }));
}

/** Inline alias for `formatBytes` — file rows in the picker stay short with
 *  a single suffix like "4.2 KB" or "1.5 MB". */
const formatBytesShort = formatBytes;

export function MentionPopover({ disabled, onSelect, pinned = [], isPinned, onTogglePin }: MentionPopoverProps) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<PromptMeta[] | null>(null);
  const [skills, setSkills] = useState<SkillMeta[] | null>(null);
  const [folderRoots, setFolderRoots] = useState<FolderListing[] | null>(null);
  // RAG collections — read from `chrome.storage.local`. Re-read on every
  // open so collections created in Settings mid-session appear immediately.
  const [ragList, setRagList] = useState<RagCollection[] | null>(null);
  // Recursive folder-browse state. `folderPath = null` shows the root
  // listing (the configured roots: ~/.cebian, /workspaces); a string value
  // means the user has drilled into that absolute VFS path. Navigation is
  // purely click-based — the user can drill down by clicking a directory
  // entry or jump back via the breadcrumb at the top of the section.
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<FolderEntry[] | null>(null);

  // Lazy-load sections on first open. Re-uses cached data for re-opens so the
  // popover appears instantly. Skill cache in scanner.ts is TTL-bounded and
  // vfs.onChange-invalidated; prompts are re-scanned every time, which is
  // cheap (single readdir + a handful of small file reads).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [p, s, collections] = await Promise.all([
        scanPrompts().catch(() => [] as PromptMeta[]),
        scanSkillIndex().catch(() => [] as SkillMeta[]),
        ragCollections.getValue().catch(() => [] as RagCollection[]),
      ]);
      if (cancelled) return;
      setPrompts(p);
      setSkills(s);
      setRagList(collections);

      // Root-level folder listing: show ONLY the configured roots. We
      // intentionally do NOT pre-list their direct children here — that's
      // what the VFS file browser's own root view does (it shows whatever
      // lives at `/`, e.g. `home`, `tmp`, `workspaces`), and pre-listing
      // `.cebian/skills`, `.cebian/prompts`, `.cebian/memories`, etc.
      // here was confusing because the same path "root level" rendered
      // very different contents in the two surfaces. Now both surfaces
      // agree: this popover surfaces curated entry points (the configured
      // roots), and clicking one drills into it to reveal its children.
      const roots = [CEBIAN_HOME, WORKSPACES_ROOT];
      const listings: FolderListing[] = roots.map((r) => ({
        path: normalizePath(r),
        label: normalizePath(r),
      }));
      if (!cancelled) setFolderRoots(listings);
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Read the children of `folderPath` whenever the user navigates. Keeps
  // the section reactive to vfs mutations via the same onChange listener
  // the scanner uses — the next folder-browse re-reads from disk.
  useEffect(() => {
    // folderPath === null shows the root listings (folderRoots), not a
    // vfs.readdir result.
    if (folderPath === null) {
      setFolderEntries(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const names = await vfs.readdir(folderPath);
        const entries: FolderEntry[] = [];
        for (const name of names) {
          if (name === '.' || name === '..') continue;
          const childPath = folderPath === '/' ? `/${name}` : `${folderPath}/${name}`;
          try {
            const st = await vfs.stat(childPath);
            if (st.isDirectory()) {
              entries.push({ name, path: childPath, kind: 'dir' });
            } else if (st.isFile()) {
              entries.push({
                name,
                path: childPath,
                kind: 'file',
                size: Number(st.size ?? 0),
              });
            }
          } catch {
            // skip unreadable entries
          }
        }
        // Sort: directories first, then files; alphabetical within each.
        entries.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        if (!cancelled) setFolderEntries(entries);
      } catch {
        if (!cancelled) setFolderEntries([]);
      }
    })();
    return () => { cancelled = true; };
  }, [folderPath]);

  // Reset drill-down state when the popover closes so the next open starts
  // fresh at the root listing.
  useEffect(() => {
    if (!open) setFolderPath(null);
  }, [open]);

  // Built-in skills are loaded fresh on every render so locale changes
  // propagate without re-opening the popover.
  const builtinSkills = useMemo(loadBuiltinSkills, []);

  const handleSelect = (chip: MentionChip) => {
    onSelect(chip);
    // Popover stays open so the user can pick multiple chips in a row.
  };

  /** Tiny inline button — click toggles the pin for this item. We
   *  stopPropagation on the click event so the surrounding CommandItem's
   *  `onSelect` (which would add a per-message mention chip) does not
   *  also fire. We intentionally do NOT stopPropagation on `pointerdown`:
   *  Radix's DismissableLayer relies on a bubble-phase `pointerdown`
   *  listener on `document` to reset its `isPointerInsideReactTreeRef`
   *  flag — if we block that listener, the flag stays stuck at `true`
   *  after a Pin click, and the next outside-click is incorrectly
   *  classified as "inside" (the popover stays open), requiring a
   *  second outside-click to actually close. cmdk's CommandItem listens
   *  to `onClick` / `onPointerMove` only, never `onPointerDown`, so the
   *  click-side `stopPropagation` alone is enough to suppress item
   *  selection. */
  const PinToggleButton = ({ item }: { item: PinnedMention }) => {
    const active = isPinned?.(item.id) ?? false;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onTogglePin?.(item);
        }}
        title={active ? t('chat.composer.unpin') : t('chat.composer.togglePin')}
        aria-label={active ? t('chat.composer.unpin') : t('chat.composer.togglePin')}
        className="shrink-0 -mr-1 p-1 rounded hover:bg-foreground/10 transition-colors"
      >
        <Pin
          className={
            'size-3.5 transition-colors ' +
            (active
              ? 'text-amber-500 fill-amber-500/40'
              : 'text-muted-foreground/60')
          }
        />
      </button>
    );
  };

  const hasPrompts = (prompts?.length ?? 0) > 0;
  const hasUserSkills = (skills?.length ?? 0) > 0;
  const hasRootFolders = (folderRoots?.length ?? 0) > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          title={t('chat.composer.mentionAdd')}
          disabled={disabled}
          data-state={open ? 'open' : 'closed'}
          className="size-7 data-[state=open]:bg-accent"
        >
          <Plus className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="w-80 p-0"
        onOpenAutoFocus={(e) => {
          // Prevent auto-focus stealing — the textarea should keep focus so
          // typing continues to land there. cmdk handles its own selection
          // state from the search input.
          e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          // Without this, Radix restores focus to the trigger ([+] button)
          // on close — which means clicking outside the popover (e.g. on
          // the textarea) closes the popover but bounces focus back to the
          // trigger, requiring the user to click again to actually focus
          // the textarea. Prevents that bounce so one outside-click closes
          // AND focuses what the user clicked. Combined with the Pin
          // toggle's pointerdown handling inside the popover, this restores
          // the expected "one click to close" UX.
          e.preventDefault();
        }}
      >
        <Command shouldFilter>
          <CommandInput placeholder={t('chat.composer.mentionAdd')} />
          <CommandList>
            <CommandEmpty>{t('chat.composer.noMatch')}</CommandEmpty>

            {/* Pinned section — top of the popover so the user always sees
                what's currently auto-included in the chat. Clicking the
                row unpins (mirrors the [X] on composer chips). Items are
                shown even if their source content changed, since the row
                keeps the `name` for display only; resolution re-reads the
                latest content at send time. Per-kind icon makes it
                obvious whether a prompt, skill, folder listing, or single
                file is riding along — the filled Pin glyph stays amber so
                "pinned" has a consistent visual cue regardless of kind. */}
            {pinned.length > 0 && (
              <CommandGroup heading={t('chat.composer.sectionPinned')}>
                {pinned.map((p) => {
                  const label =
                    p.kind === 'prompt' ? `/${p.name}` :
                    p.kind === 'vfs-dir' ? p.label :
                    p.kind === 'vfs-file' ? p.label :
                    p.kind === 'rag-collection' ? p.collection :
                    p.name;
                  const KindIcon =
                    p.kind === 'prompt' ? FileText :
                    p.kind === 'skill' ? Sparkles :
                    p.kind === 'vfs-dir' ? Folder :
                    p.kind === 'rag-collection' ? Database :
                    FileIcon;
                  return (
                    <CommandItem
                      key={`pinned-${p.id}`}
                      value={`pinned ${label}`}
                      onSelect={() => onTogglePin?.(p)}
                      className="opacity-90"
                    >
                      <KindIcon className="size-3.5 text-amber-500/80" />
                      <span className="flex-1 truncate">{label}</span>
                      <span className="text-[0.6rem] text-muted-foreground uppercase tracking-wider">
                        {t('chat.composer.pinnedAutoHint')}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}

            <CommandGroup heading={t('chat.composer.sectionPrompts')}>
              {hasPrompts
                ? prompts!.map((p) => {
                    const item: PinnedMention = {
                      kind: 'prompt',
                      id: `prompt-${p.fileName}`,
                      name: p.name,
                      fileName: p.fileName,
                    };
                    return (
                      <CommandItem
                        key={p.fileName}
                        value={`${p.name} ${p.description}`}
                        onSelect={() =>
                          handleSelect({
                            kind: 'prompt',
                            id: `${item.id}-${Date.now().toString(36)}`,
                            name: p.name,
                            fileName: p.fileName,
                          })
                        }
                      >
                        <FileText className="size-3.5 text-blue-400" />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate">/{p.name}</span>
                          {p.description && (
                            <span className="block text-[0.66rem] text-muted-foreground truncate">
                              {p.description}
                            </span>
                          )}
                        </span>
                        <PinToggleButton item={item} />
                      </CommandItem>
                    );
                  })
                : (
                  <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                    {t('chat.composer.noPromptsMention')}
                  </div>
                )}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('chat.composer.sectionSkills')}>
              {builtinSkills.map((s) => {
                const item: PinnedMention = {
                  kind: 'skill',
                  id: `builtin-${s.id}`,
                  name: s.name,
                  filePath: `chat.mention.builtinSkill.${s.id}`,
                  body: s.body,
                  isBuiltIn: true,
                };
                return (
                  <CommandItem
                    key={`builtin-${s.id}`}
                    value={`${s.name} ${s.body}`}
                    onSelect={() =>
                      handleSelect({
                        kind: 'skill',
                        id: `${item.id}-${Date.now().toString(36)}`,
                        name: s.name,
                        filePath: item.filePath,
                        body: s.body,
                        isBuiltIn: true,
                      })
                    }
                  >
                    <Sparkles className="size-3.5 text-amber-400" />
                    <span className="flex-1 truncate">{s.name}</span>
                    <PinToggleButton item={item} />
                  </CommandItem>
                );
              })}
              {hasUserSkills
                ? skills!.map((sk) => {
                    const item: PinnedMention = {
                      kind: 'skill',
                      id: `skill-${sk.filePath}`,
                      name: sk.name,
                      filePath: sk.filePath,
                      body: '',
                      isBuiltIn: false,
                    };
                    return (
                      <CommandItem
                        key={sk.filePath}
                        value={`${sk.name} ${sk.description}`}
                        onSelect={() =>
                          handleSelect({
                            kind: 'skill',
                            id: `${item.id}-${Date.now().toString(36)}`,
                            name: sk.name,
                            filePath: sk.filePath,
                            body: '',
                            isBuiltIn: false,
                          })
                        }
                      >
                        <Sparkles className="size-3.5 text-amber-400" />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate">{sk.name}</span>
                          {sk.description && (
                            <span className="block text-[0.66rem] text-muted-foreground truncate">
                              {sk.description}
                            </span>
                          )}
                        </span>
                        <PinToggleButton item={item} />
                      </CommandItem>
                    );
                  })
                : null}
              {!hasUserSkills && (
                <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                  {t('chat.composer.noSkills')}
                </div>
              )}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('chat.composer.sectionFolders')}>
              {/* Breadcrumb / nav header when the user has drilled past the
                  root listing. Shows a back-to-parent affordance. Per-row
                  Pin toggles on each folder/file handle "pin this folder"
                  / "pin this file" so we no longer need a duplicate inline
                  CommandItem just for that action. cmdk's search input keeps
                  filtering both the back affordance and the children rows. */}
              {folderPath !== null && (
                <CommandItem
                  value={`__back ${folderPath}`}
                  onSelect={() => {
                    const parent = folderPath.split('/').slice(0, -1).join('/') || '/';
                    // Snap back to the root listing if the parent is one of
                    // the configured roots; otherwise keep drilling up.
                    const isRoot = folderRoots?.some((r) => r.path === parent);
                    setFolderPath(isRoot ? null : parent);
                  }}
                >
                  <Folder className="size-3.5 text-muted-foreground" />
                  <span className="flex-1 truncate text-muted-foreground text-[0.72rem]">
                    ← {t('chat.composer.folderBack')}
                  </span>
                </CommandItem>
              )}

              {folderPath === null
                ? (
                    hasRootFolders
                      ? folderRoots!.map((f) => {
                          // Stable id keyed on the root path — the same
                          // root keeps the same id across popover re-opens
                          // so the toggle stays "filled" while pinned.
                          const pinItem: PinnedMention = {
                            kind: 'vfs-dir',
                            id: `dir-pin-${f.path}`,
                            path: f.path,
                            label: f.label,
                          };
                          return (
                            <CommandItem
                              key={f.path}
                              value={f.label}
                              onSelect={() => setFolderPath(f.path)}
                            >
                              <Folder className="size-3.5 text-emerald-400" />
                              <span className="flex-1 truncate font-mono text-[0.72rem]">
                                {f.label}
                              </span>
                              <PinToggleButton item={pinItem} />
                              <ChevronRight className="size-3 text-muted-foreground/60" />
                            </CommandItem>
                          );
                        })
                      : (
                          <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                            {t('chat.composer.noFolders')}
                          </div>
                        )
                  )
                : folderEntries === null
                  ? (
                      <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                        {t('chat.composer.loading')}
                      </div>
                    )
                  : folderEntries.length === 0
                    ? (
                        <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                          {t('chat.composer.folderEmpty')}
                        </div>
                      )
                    : folderEntries.map((entry) =>
                        entry.kind === 'dir'
                          ? (() => {
                              const pinItem: PinnedMention = {
                                kind: 'vfs-dir',
                                id: `dir-pin-${entry.path}`,
                                path: entry.path,
                                label: entry.name,
                              };
                              return (
                                <CommandItem
                                  key={entry.path}
                                  value={entry.path}
                                  onSelect={() => setFolderPath(entry.path)}
                                >
                                  <Folder className="size-3.5 text-emerald-400" />
                                  <span className="flex-1 truncate font-mono text-[0.72rem]">
                                    {entry.name}/
                                  </span>
                                  <PinToggleButton item={pinItem} />
                                  <ChevronRight className="size-3 text-muted-foreground/60" />
                                </CommandItem>
                              );
                            })()
                          : (() => {
                              const pinItem: PinnedMention = {
                                kind: 'vfs-file',
                                id: `file-pin-${entry.path}`,
                                path: entry.path,
                                label: entry.name,
                                size: entry.size,
                              };
                              return (
                                <CommandItem
                                  key={entry.path}
                                  value={entry.path}
                                  onSelect={() =>
                                    handleSelect({
                                      kind: 'vfs-file',
                                      id: `file-${entry.path}-${Date.now().toString(36)}`,
                                      path: entry.path,
                                      label: entry.name,
                                      size: entry.size,
                                    })
                                  }
                                >
                                  <FileIcon className="size-3.5 text-blue-400" />
                                  <span className="flex-1 truncate font-mono text-[0.72rem]">
                                    {entry.name}
                                  </span>
                                  {typeof entry.size === 'number' && (
                                    <span className="text-[0.62rem] text-muted-foreground">
                                      {formatBytesShort(entry.size)}
                                    </span>
                                  )}
                                  <PinToggleButton item={pinItem} />
                                </CommandItem>
                              );
                            })(),
                      )}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('chat.composer.sectionKnowledge')}>
              {ragList === null
                ? (
                    <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                      {t('chat.composer.loading')}
                    </div>
                  )
                : ragList.length === 0
                  ? (
                      <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                        {t('chat.composer.noCollections')}
                      </div>
                    )
                  : ragList.map((c) => {
                      const item: PinnedMention = {
                        kind: 'rag-collection',
                        id: `rag-${c.name}`,
                        collection: c.name,
                      };
                      const sub = `${c.chunkCount} chunks · ${c.embedModel}`;
                      return (
                        <CommandItem
                          key={c.name}
                          value={`${c.name} ${sub}`}
                          onSelect={() =>
                            handleSelect({
                              kind: 'rag-collection',
                              id: `${item.id}-${Date.now().toString(36)}`,
                              collection: c.name,
                            })
                          }
                        >
                          <Database className="size-3.5 text-violet-400" />
                          <span className="flex-1 min-w-0">
                            <span className="block truncate">{c.name}</span>
                            <span className="block text-[0.66rem] text-muted-foreground truncate">
                              {sub}
                            </span>
                          </span>
                          <PinToggleButton item={item} />
                        </CommandItem>
                      );
                    })}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('chat.composer.sectionTabs')}>
              <CommandItem
                disabled
                value={t('chat.composer.sectionTabs')}
                onSelect={() => {
                  // Placeholder for the future tab-mention flow — disabled in v1.
                  // Intentionally not calling onSelect; the disabled flag already
                  // prevents selection. Kept as a visual placeholder so the
                  // layout matches the spec screenshot.
                  setOpen(false);
                }}
              >
                <Layers className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate text-muted-foreground">
                  {t('chat.composer.tabsNotReady')}
                </span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}