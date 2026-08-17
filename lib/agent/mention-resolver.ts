//
// Mention-chip resolver — converts a MentionChip (UI-only state) into a
// fully-resolved Attachment at send time. Reads the underlying prompt body
// / skill body / directory listing from the VFS and strips frontmatter so
// the LLM sees only the content it should follow.
//
import { CEBIAN_PROMPTS_DIR } from '@/lib/persistence/vfs-paths';
import { vfs } from '@/lib/persistence/vfs';
import { parseFrontmatter } from '@/lib/content/frontmatter';
import { ragSettings, buildEmbedder, buildReranker, retrieve } from '@/lib/rag';
import type {
  DirectoryMentionAttachment,
  FileMentionAttachment,
  PromptMentionAttachment,
  RagContextAttachment,
  SkillMentionAttachment,
} from '@/lib/agent/attachments';

/** Top-K chunks to retrieve per RAG mention. Tuned to keep a single
 *  mention's prompt contribution under ~4 KB of context (assuming
 *  average chunk size ≈ 800 chars). User can edit this if a collection
 *  has unusually short or long chunks. */
const RAG_TOP_K = 5;

/** How many consecutive failures before a pin auto-unpins. Picked at 3
 *  so transient VFS races (one write-during-read) don't auto-unpin a
 *  healthy pin, but a truly-deleted source triggers cleanup after a
 *  few sends rather than lingering forever. */
export const PIN_AUTO_UNPIN_THRESHOLD = 3;

/** Tiny one-attempt retry wrapper. lightning-fs occasionally throws on
 *  read-during-write races or while a workspace re-hydrates after
 *  restore; one short retry is enough to absorb that without papering
 *  over a real "file deleted" failure. Applied to file/folder I/O only,
 *  not to retrieval or chunk math. */
async function withRetry<T>(fn: () => Promise<T>, delayMs = 50): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await new Promise<void>((r) => setTimeout(r, delayMs));
    return await fn();
  }
}

export type MentionChip =
  | { kind: 'prompt'; id: string; name: string; fileName: string }
  | { kind: 'skill'; id: string; name: string; filePath: string; body: string; isBuiltIn: boolean }
  | { kind: 'vfs-dir'; id: string; path: string; label: string }
  | { kind: 'vfs-file'; id: string; path: string; label: string; size?: number }
  | { kind: 'rag-collection'; id: string; collection: string };

/** "Pin" an item for the lifetime of the current chat — its full content
 *  (prompt body, skill body, directory listing, or single file) rides along
 *  on every message until the chat ends or the user unpins it. Per-chat
 *  scope by design (state lives in the composer; a new session starts
 *  with an empty pin list). Defined as the same shape as `MentionChip`
 *  because the resolver path is identical — pin vs. mention is purely a
 *  UI lifetime concern (persistent across sends vs. dropped after send). */
export type PinnedMention = MentionChip;

export type ResolvedMentionAttachment =
  | PromptMentionAttachment
  | SkillMentionAttachment
  | DirectoryMentionAttachment
  | FileMentionAttachment
  | RagContextAttachment;

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
 *  silently drops the chip rather than blocking the send. `userQuery` is
 *  forwarded to RAG chips for embedding-based retrieval; other chip kinds
 *  ignore it.
 *
 *  `opts.minScore` is the relevance gate for RAG chips: when set >0 and
 *  the retriever's top hit falls below it, the resolver returns null
 *  (drops the attachment) so the LLM doesn't see a noisy envelope on
 *  off-topic questions.
 *
 *  `opts.pinned` opts the chip OUT of that silent-drop behavior. When
 *  the user has explicitly pinned a collection, we always emit the
 *  envelope (with `count="0"` + a `reason` attribute when nothing
 *  matched) so the LLM knows the collection was queried and can
 *  answer "no matches" or call `rag_inspect` instead of falling back
 *  to fs_* tools. Only matters for RAG chips; ignored for other kinds. */
export async function resolveMentionToAttachment(
  chip: MentionChip,
  userQuery?: string,
  opts?: { minScore?: number; pinned?: boolean },
): Promise<ResolvedMentionAttachment | null> {
  try {
    if (chip.kind === 'prompt') {
      const filePath = `${CEBIAN_PROMPTS_DIR}/${chip.fileName}`;
      const raw = await withRetry(() => readUtf8(filePath));
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
        : truncateBody(stripFrontmatter(await withRetry(() => readUtf8(chip.filePath))));
      return {
        type: 'mention-skill',
        name: chip.name,
        body,
        sourcePath: chip.filePath,
      };
    }

    if (chip.kind === 'vfs-dir') {
      const names = await withRetry(() => vfs.readdir(chip.path));
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
      const raw = await withRetry(() => readUtf8(chip.path));
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

    if (chip.kind === 'rag-collection') {
      // RAG retrieval: embed the user's outgoing text, fetch the top-K
      // chunks from the named collection in Neon. Skip cleanly when RAG
      // isn't configured (no connection string) or the user hasn't typed
      // anything yet — the chip still shows in the strip but produces no
      // attachment for this send. We resolve to null in either case so
      // the chip is silently dropped rather than failing the whole send.
      const settings = await ragSettings.getValue();
      if (!settings.neonConnectionString) return null;
      const queryText = userQuery?.trim() ?? '';
      if (!queryText) return null;
      const chunks = await retrieve({
        connectionString: settings.neonConnectionString,
        collection: chip.collection,
        query: queryText,
        embedder: buildEmbedder(settings),
        topK: RAG_TOP_K,
        // Lớp 2 rerank — when configured, the retriever re-orders the
        // top-K candidates via a cross-encoder-style model and returns
        // the top-N (smaller, more relevant). `buildReranker` returns
        // null when rerank is disabled, so the retriever falls back
        // to the raw cosine top-K.
        reranker: buildReranker(settings) ?? undefined,
        rerankTopN: settings.rerankTopN,
        // Relevance gate for PINNED RAG only. The retriever filters
        // out chunks below this cosine similarity at the vector stage,
        // so an empty result means "no relevant hit" — the resolver
        // either drops the attachment (one-shot mention) or emits an
        // empty envelope with a `reason` (pinned) so the LLM can
        // answer "no matches" without reaching for fs_* tools. We
        // re-check `chunks.length === 0` below because the gate could
        // have been satisfied by SOME low-score chunks that all got
        // filtered.
        minScore: opts?.minScore,
      });
      // Pinned path: always emit the envelope, even when chunks=0.
      // Without this, the LLM has no signal that the user pinned the
      // collection and ends up reaching for fs_list/fs_search to
      // answer "what files are in phaply?" — fs_* only sees VFS and
      // returns unrelated content. Set `reason` so the LLM knows
      // whether the collection is empty (`empty`) or just had no
      // relevant hits for this query (`no_match`).
      if (chunks.length === 0 && opts?.pinned) {
        // Cheap check: empty collection (zero rows) vs. no-match.
        // We only pay the extra count query when we already have 0
        // chunks — that's the case where the distinction matters.
        const { countCollectionChunks } = await import('@/lib/rag');
        let reason: 'no_match' | 'empty' = 'no_match';
        try {
          const total = await countCollectionChunks(settings.neonConnectionString, chip.collection);
          if (total === 0) reason = 'empty';
        } catch {
          // Stay with `no_match` — the gate already knows the LLM
          // got nothing; an exact reason is a nice-to-have.
        }
        return {
          type: 'rag-context',
          collection: chip.collection,
          query: queryText,
          chunks,
          reason,
        };
      }
      // One-shot mention with a configured relevance gate: drop
      // silently when nothing matched (existing behavior). Without
      // the gate we still emit the empty envelope so the LLM knows
      // the chip resolved to a query.
      if (chunks.length === 0 && opts?.minScore && opts.minScore > 0) {
        return null;
      }
      return {
        type: 'rag-context',
        collection: chip.collection,
        query: queryText,
        chunks,
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
 *  caller toasts once per failed chip). `userQuery` is forwarded to RAG
 *  chips for embedding-based retrieval; other kinds ignore it.
 *  `opts.minScore` is forwarded to each chip's resolver call so the
 *  PINNED RAG gate works in batch as well. `opts.pinned` is forwarded
 *  too — the resolver uses it to opt chips out of the silent-drop
 *  behavior on empty retrieval. */
export async function resolveMentions(
  chips: MentionChip[],
  userQuery?: string,
  opts?: { minScore?: number; pinned?: boolean },
): Promise<ResolvedMentionAttachment[]> {
  const results = await Promise.all(
    chips.map((chip) => resolveMentionToAttachment(chip, userQuery, opts)),
  );
  return results.filter((r): r is ResolvedMentionAttachment => r !== null);
}