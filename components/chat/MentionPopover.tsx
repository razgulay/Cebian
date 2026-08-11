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
import { Plus, FileText, Sparkles, Folder, Layers, Pin } from 'lucide-react';
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
import { t } from '@/lib/i18n';
import type { MentionChip } from '@/lib/agent/mention-resolver';

interface MentionPopoverProps {
  disabled?: boolean;
  onSelect: (chip: MentionChip) => void;
}

interface FolderListing {
  path: string;
  label: string;
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

export function MentionPopover({ disabled, onSelect }: MentionPopoverProps) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<PromptMeta[] | null>(null);
  const [skills, setSkills] = useState<SkillMeta[] | null>(null);
  const [folders, setFolders] = useState<FolderListing[] | null>(null);

  // Lazy-load sections on first open. Re-uses cached data for re-opens so the
  // popover appears instantly. Skill cache in scanner.ts is TTL-bounded and
  // vfs.onChange-invalidated; prompts are re-scanned every time, which is
  // cheap (single readdir + a handful of small file reads).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [p, s] = await Promise.all([
        scanPrompts().catch(() => [] as PromptMeta[]),
        scanSkillIndex().catch(() => [] as SkillMeta[]),
      ]);
      if (cancelled) return;
      setPrompts(p);
      setSkills(s);

      // Folder picker: enumerate a fixed set of "interesting" root
      // directories and their direct children. v1 is intentionally shallow —
      // a full tree picker would dwarf the popover's intent (quick add).
      const folderRoots = [CEBIAN_HOME, WORKSPACES_ROOT];
      const listings: FolderListing[] = [];
      for (const root of folderRoots) {
        try {
          const norm = normalizePath(root);
          const children = await vfs.readdir(norm);
          for (const name of children) {
            if (name === '.' || name === '..') continue;
            const childPath = norm === '/' ? `/${name}` : `${norm}/${name}`;
            try {
              const st = await vfs.stat(childPath);
              if (st.isDirectory()) {
                listings.push({
                  path: childPath,
                  label: `${norm === '/' ? '' : norm}/${name}`,
                });
              }
            } catch {
              // skip unreadable entries
            }
          }
        } catch {
          // skip missing roots
        }
      }
      // Always offer the parent dirs themselves so the user can pick a
      // top-level folder even if it's empty.
      for (const root of folderRoots) {
        listings.unshift({ path: normalizePath(root), label: normalizePath(root) });
      }
      if (!cancelled) setFolders(listings);
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Built-in skills are loaded fresh on every render so locale changes
  // propagate without re-opening the popover.
  const builtinSkills = useMemo(loadBuiltinSkills, []);

  const handleSelect = (chip: MentionChip) => {
    onSelect(chip);
    // Popover stays open so the user can pick multiple chips in a row.
  };

  const hasPrompts = (prompts?.length ?? 0) > 0;
  const hasUserSkills = (skills?.length ?? 0) > 0;
  const hasFolders = (folders?.length ?? 0) > 0;

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
      >
        <Command shouldFilter>
          <CommandInput placeholder={t('chat.composer.mentionAdd')} />
          <CommandList>
            <CommandEmpty>{t('chat.composer.noMatch')}</CommandEmpty>

            <CommandGroup heading={t('chat.composer.sectionSkills')}>
              {builtinSkills.map((s) => (
                <CommandItem
                  key={`builtin-${s.id}`}
                  value={`${s.name} ${s.body}`}
                  onSelect={() =>
                    handleSelect({
                      kind: 'skill',
                      id: `builtin-${s.id}-${Date.now().toString(36)}`,
                      name: s.name,
                      filePath: `chat.mention.builtinSkill.${s.id}`,
                      body: s.body,
                      isBuiltIn: true,
                    })
                  }
                >
                  <Sparkles className="size-3.5 text-amber-400" />
                  <span className="flex-1 truncate">{s.name}</span>
                  <Pin className="size-3 text-muted-foreground/60" />
                </CommandItem>
              ))}
              {hasUserSkills
                ? skills!.map((sk) => (
                    <CommandItem
                      key={sk.filePath}
                      value={`${sk.name} ${sk.description}`}
                      onSelect={() =>
                        handleSelect({
                          kind: 'skill',
                          id: `skill-${sk.filePath}-${Date.now().toString(36)}`,
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
                    </CommandItem>
                  ))
                : null}
              {!hasUserSkills && (
                <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                  {t('chat.composer.noSkills')}
                </div>
              )}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('chat.composer.sectionPrompts')}>
              {hasPrompts
                ? prompts!.map((p) => (
                    <CommandItem
                      key={p.fileName}
                      value={`${p.name} ${p.description}`}
                      onSelect={() =>
                        handleSelect({
                          kind: 'prompt',
                          id: `prompt-${p.fileName}-${Date.now().toString(36)}`,
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
                    </CommandItem>
                  ))
                : (
                  <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                    {t('chat.composer.noPromptsMention')}
                  </div>
                )}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading={t('chat.composer.sectionFolders')}>
              {hasFolders
                ? folders!.map((f) => (
                    <CommandItem
                      key={f.path}
                      value={f.label}
                      onSelect={() =>
                        handleSelect({
                          kind: 'vfs-dir',
                          id: `dir-${f.path}-${Date.now().toString(36)}`,
                          path: f.path,
                          label: f.label,
                        })
                      }
                    >
                      <Folder className="size-3.5 text-emerald-400" />
                      <span className="flex-1 truncate font-mono text-[0.72rem]">
                        {f.label}
                      </span>
                    </CommandItem>
                  ))
                : (
                  <div className="px-2 py-1.5 text-[0.7rem] text-muted-foreground">
                    {t('chat.composer.noFolders')}
                  </div>
                )}
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