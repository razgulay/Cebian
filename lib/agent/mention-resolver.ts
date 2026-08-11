//
// Mention-chip resolver — converts a MentionChip (UI-only state) into a
// fully-resolved Attachment at send time. Reads the underlying prompt body
// / skill body / directory listing from the VFS and strips frontmatter so
// the LLM sees only the content it should follow.
//
import { CEBIAN_PROMPTS_DIR } from '@/lib/persistence/vfs-paths';
import { vfs } from '@/lib/persistence/vfs';
import { parseFrontmatter } from '@/lib/content/frontmatter';
import type {
  DirectoryMentionAttachment,
  FileMentionAttachment,
  PromptMentionAttachment,
  SkillMentionAttachment,
} from '@/lib/agent/attachments';

export type MentionChip =
  | { kind: 'prompt'; id: string; name: string; fileName: string }
  | { kind: 'skill'; id: string; name: string; filePath: string; body: string; isBuiltIn: boolean }
  | { kind: 'vfs-dir'; id: string; path: string; label: string }
  | { kind: 'vfs-file'; id: string; path: string; label: string; size?: number };

export type ResolvedMentionAttachment =
  | PromptMentionAttachment
  | SkillMentionAttachment
  | DirectoryMentionAttachment
  | FileMentionAttachment;

/** Read a UTF-8 VFS file as a string. lightning-fs returns either string
 *  (utf8) or Uint8Array depending on the encoding flag; normalize both. */
async function readUtf8(path: string): Promise<string> {
  const raw = await vfs.readFile(path, 'utf8');
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
}

/** Strip YAML frontmatter (`---\n...\n---\n`) from a markdown body. If no
 *  frontmatter is present, return the body unchanged. Errors during parsing
 *  fall back to the raw body so a malformed frontmatter never drops the file
 *  silently. */
function stripFrontmatter(content: string): string {
  try {
    const { body } = parseFrontmatter(content);
    return body.trim();
  } catch {
    return content.trim();
  }
}

/** Cap inline body length to keep prompt budget reasonable. A 100 KB cap
 *  matches MAX_TEXT_FILE_SIZE — large files should be selected as a regular
 *  attachment instead. The cap is applied AFTER frontmatter stripping so the
 *  budget reflects content the LLM will actually see. */
const MAX_INLINE_BODY = 100 * 1024;
function truncateBody(body: string, cap = MAX_INLINE_BODY): string {
  if (body.length <= cap) return body;
  return body.slice(0, cap) + '\n…[truncated]';
}

/** Tiny extension → MIME map for the few kinds we actually send through
 *  mention-file. Falls back to `text/plain` so the LLM still sees the
 *  content even when the extension is unfamiliar — better than dropping
 *  the file silently. */
function guessMimeType(path: string): string {
  const ext = path.toLowerCase().match(/\.([^./\\]+)$/)?.[1] ?? '';
  switch (ext) {
    case 'md':    return 'text/markdown';
    case 'txt':   return 'text/plain';
    case 'json':  return 'application/json';
    case 'xml':   return 'application/xml';
    case 'html':
    case 'htm':   return 'text/html';
    case 'css':   return 'text/css';
    case 'js':
    case 'mjs':
    case 'cjs':   return 'application/javascript';
    case 'ts':
    case 'tsx':
    case 'jsx':   return 'text/plain'; // not a real MIME — TSX isn't standard
    case 'py':    return 'text/x-python';
    case 'yaml':
    case 'yml':   return 'application/yaml';
    case 'csv':   return 'text/csv';
    case 'log':   return 'text/plain';
    case 'sh':
    case 'bash':  return 'text/x-shellscript';
    default:      return 'text/plain';
  }
}

/** Resolve a single mention chip to an attachment. Returns null when the
 *  source file is missing or unreadable — the caller surfaces a toast and
 *  silently drops the chip rather than blocking the send. */
export async function resolveMentionToAttachment(
  chip: MentionChip,
): Promise<ResolvedMentionAttachment | null> {
  try {
    if (chip.kind === 'prompt') {
      const filePath = `${CEBIAN_PROMPTS_DIR}/${chip.fileName}`;
      const raw = await readUtf8(filePath);
      const body = truncateBody(stripFrontmatter(raw));
      return {
        type: 'mention-prompt',
        name: chip.name,
        body,
        sourcePath: filePath,
      };
    }

    if (chip.kind === 'skill') {
      // Built-in skills ship with their body already in the chip (loaded
      // from locales); no VFS read needed. User skills read from the SKILL.md
      // path captured when the chip was created.
      const body = chip.isBuiltIn
        ? truncateBody(chip.body)
        : truncateBody(stripFrontmatter(await readUtf8(chip.filePath)));
      return {
        type: 'mention-skill',
        name: chip.name,
        body,
        sourcePath: chip.filePath,
      };
    }

    if (chip.kind === 'vfs-dir') {
      const names = await vfs.readdir(chip.path);
      const entries: DirectoryMentionAttachment['entries'] = [];
      for (const name of names) {
        if (name === '.' || name === '..') continue;
        const childPath = chip.path === '/' ? `/${name}` : `${chip.path}/${name}`;
        try {
          const st = await vfs.stat(childPath);
          if (st.isDirectory()) {
            entries.push({ name, kind: 'dir' });
          } else if (st.isFile()) {
            entries.push({ name, kind: 'file', size: Number(st.size ?? 0) });
          }
        } catch {
          // Skip unreadable entries; the listing still works for the rest.
        }
      }
      // Sort: directories first, then files; alphabetical within each.
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return {
        type: 'mention-directory',
        path: chip.path,
        label: chip.label,
        entries,
      };
    }

    if (chip.kind === 'vfs-file') {
      const raw = await readUtf8(chip.path);
      // Heuristic: strip frontmatter if the file looks like markdown
      // (starts with `---\n`). Frontmatter is YAML metadata, not content —
      // sending it would confuse the LLM.
      const looksMarkdown = raw.startsWith('---\n') || raw.startsWith('---\r\n');
      const body = looksMarkdown
        ? stripFrontmatter(raw)
        : raw.trim();
      const truncated = body.length > MAX_INLINE_BODY;
      const content = truncated ? truncateBody(body) : body;
      return {
        type: 'mention-file',
        name: chip.label.split('/').pop() ?? chip.label,
        content,
        sourcePath: chip.path,
        mimeType: guessMimeType(chip.path),
        truncated,
      };
    }
  } catch (err) {
    // Caller (ChatInput) decides whether to surface the error. We just
    // hand back null so the chip is dropped from the outgoing message.
    console.warn('[Mention Resolver] failed to resolve', chip, err);
    return null;
  }
  return null;
}

/** Resolve all chips in parallel. Returns the attachments that resolved
 *  successfully — chips whose resolution failed are silently dropped (the
 *  caller toasts once per failed chip). */
export async function resolveMentions(
  chips: MentionChip[],
): Promise<ResolvedMentionAttachment[]> {
  const results = await Promise.all(chips.map(resolveMentionToAttachment));
  return results.filter((r): r is ResolvedMentionAttachment => r !== null);
}