import type { ImageContent } from '@earendil-works/pi-ai';
import { escapeXml, formatBytes } from '@/lib/utils';
import { RECORDING_SCHEMA_COMMENT } from '@/lib/recorder/schema-doc';

// ─── Attachment types ───

export interface ImageAttachment {
  type: 'image';
  /** How the image was produced.
   *  - 'screenshot'    — full viewport via the chat toolbar Camera button
   *  - 'upload'        — file picked from disk
   *  - 'paste'         — pasted from clipboard
   *  - 'region-select' — drag-to-crop rectangle from the region picker */
  source: 'screenshot' | 'upload' | 'paste' | 'region-select';
  data: string;          // base64 without data: prefix
  mimeType: string;
  name?: string;
}

export interface TextFileAttachment {
  type: 'file';
  content: string;
  name: string;
  mimeType: string;
  size: number;          // original bytes
}

/** Text extracted from a PDF the user attached. Renders into the same
 *  `<attached-file>` block as a plain text file (the LLM doesn't need to
 *  know it was originally a PDF), but the UI surfaces a "PDF · N pages"
 *  badge so the user can tell at a glance. `pageCount` is the full
 *  document size — `extractedPageCount` is how many pages made it into
 *  `content` after the budget cap. */
export interface PdfTextAttachment {
  type: 'pdf';
  content: string;
  name: string;
  /** "application/pdf" — preserved for the XML envelope so downstream
   *  tools / parsers see the original MIME. */
  mimeType: string;
  size: number;
  pageCount: number;
  extractedPageCount: number;
  truncated: boolean;
}

export interface ElementAttachment {
  type: 'element';
  selector: string;
  tagName: string;
  path: string;          // full path from html root
  attributes: Record<string, string>;
  textContent?: string;  // first 200 chars of innerText
  rect?: { x: number; y: number; width: number; height: number };
  tabId?: number;
  tabUrl?: string;
  windowId?: number;
  frameId?: number;      // 0 or undefined = top frame
  frameUrl?: string;
}

/**
 * A captured user-interaction recording, stored as a JSON string. The agent
 * receives the raw JSON wrapped in a `<recording>` block; the UI shows a
 * download chip. `truncatedAttachment` is set when `events` had to be cut
 * from the end to fit `MAX_RECORDING_SIZE`.
 */
export interface RecordingAttachment {
  type: 'recording';
  /** Display + download filename, e.g. `recording-20260422-1503.json`. */
  name: string;
  /** UTF-8 byte length of `json`. */
  sizeBytes: number;
  eventCount: number;
  durationMs: number;
  /** Serialized RecordedSession. May reflect a truncated session. */
  json: string;
  /** True when events were dropped from the end to fit the size limit. */
  truncatedAttachment?: boolean;
}

/** Mention of a user-defined prompt file (`~/.cebian/prompts/<name>.md`).
 *  The full body is shipped to the LLM inside `<attached-prompt>`, so the
 *  model sees the prompt as if the user had typed it in (minus any
 *  `{{template}}` placeholders, which are NOT expanded here — the user
 *  controls the chip, the chip is the source of truth). */
export interface PromptMentionAttachment {
  type: 'mention-prompt';
  name: string;
  body: string;
  sourcePath: string;
}

/** Mention of a user skill (`~/.cebian/skills/<name>/SKILL.md`) or a
 *  built-in starter skill shipped via locales. The full body is shipped
 *  to the LLM inside `<attached-skill>` — the agent already has the skill
 *  index in its system prompt, so the inline body simply confirms which
 *  skill was selected and pins down its rules for this turn. */
export interface SkillMentionAttachment {
  type: 'mention-skill';
  name: string;
  body: string;
  sourcePath: string;
}

/** Mention of a VFS directory. The LLM receives a one-level-deep listing
 *  of children (file name + size; directory name + `/`) inside
 *  `<attached-directory>`. The agent can `fs_read_file` any of the listed
 *  files later if it needs the content — the listing is just a hint that
 *  this folder is in scope for the request.
 *
 *  `pinned` is set when this chip came from the persistent pin list rather
 *  than a one-shot mention. The bubble uses the flag to suppress the
 *  visual chip (the pin is already visible in the composer strip), while
 *  the envelope itself still reaches the LLM so the data persists across
 *  every send of the chat. */
export interface DirectoryMentionAttachment {
  type: 'mention-directory';
  path: string;
  label: string;
  entries: { name: string; kind: 'file' | 'dir'; size?: number }[];
  pinned?: boolean;
}

/** Mention of a single VFS file. Resolved at send-time by reading the file
 *  via `vfs.readFile`. The LLM receives the file's text content inside
 *  `<attached-file>` (the same envelope used by regular file attachments),
 *  so the agent can `fs_read_file` it again later if needed.
 *
 *  Body 截断按 `MAX_INLINE_BODY`（100 KB）走，比 composer attachment 的
 *  `MAX_TEXT_FILE_SIZE`（1 MB）紧——mention chip 在 pin 时每条 send 都跟着走，
 *  预算敏感；超大文件应作为普通 attachment 拖入（上限 1 MB），而不是用 mention chip
 *  引用。`truncated="true"` 会在 envelope 上挂出来，LLM 看到就知道内容被截了。
 *
 *  `pinned` mirrors the same flag on DirectoryMentionAttachment — pin
 *  chips skip the bubble badge but still ship their data to the LLM. */
export interface FileMentionAttachment {
  type: 'mention-file';
  name: string;
  content: string;
  sourcePath: string;
  mimeType: string;
  truncated: boolean;
  pinned?: boolean;
}

/** Top-K chunks retrieved from a RAG collection at send-time. The LLM
 *  receives them inside `<attached-rag-context>` as `<chunk>` blocks —
 *  one per retrieved chunk, each carrying the source path + chunk
 *  index (no numeric score — order conveys the ranking). The agent
 *  sees only what the retriever picked, not the whole collection,
 *  keeping prompt budget bounded.
 *
 *  When `chunks` is empty, `reason` explains why so the LLM can
 *  decide between answering "no matches" (LLM should NOT fall back
 *  to fs_* for the same collection — see system prompt RAG Workflow)
 *  or asking the user to clarify. Only meaningful when chunks=0.
 *
 *  `pinned` mirrors the directory/file flag — pin chips skip the
 *  bubble badge (RAG currently doesn't render one anyway) while the
 *  envelope still ships to the LLM. Kept on the type for consistency
 *  with the other mention kinds. */
export interface RagContextAttachment {
  type: 'rag-context';
  collection: string;
  /** User text that triggered the retrieval (or empty for explicit
   *  pinned-without-query). Stored for the agent's awareness and for
   *  debugging — not rendered as a separate field in the XML. */
  query: string;
  chunks: {
    sourcePath: string;
    chunkIndex: number;
    content: string;
  }[];
  /** Why `chunks` is empty. `no_match` = retriever ran but minScore
   *  filtered everything out (or the collection had no relevant hits);
   *  `empty` = the collection has zero indexed chunks. Undefined when
   *  chunks.length > 0 (omitted from the XML).
   *  `model_mismatch` = collection 是用另一个 embedder 索引的（读取守卫拦下，
   *  未执行检索）——envelope 提示 LLM 让用户 re-index 或把 embedder 换回去。 */
  reason?: 'no_match' | 'empty' | 'model_mismatch';
  pinned?: boolean;
}

// ─── Pinned-RAG unlock evidence（rag_search 自动启用的证据）───────────────
//
// 会话 ghim 了 RAG collection 时，rag_search 工具对该会话解锁（即使全局开关
// 关闭）。证据有两形态、走同一判定：
//   • structured——send 路径：attachment 数组里有 `pinned="true"` 的
//     rag-context（后台 send handler 直接读 ClientMessage.attachments）；
//   • text——retry/edit 路径：原 user message 的文本里带 `<attached-rag-context
//     … pinned="true" …>` envelope（回卷路径手里只有树上的消息文本）。
// 正则锚定在我们的 wire contract 上（system prompt 教过、bubble parser 也按
// 这个形状走文本），`<attached-… pinned="true">` 的其它种类（directory/file）
// 不会误命中——tag 名不同。
//
// 债务（记录在案）：上面两个函数是同一判定的两个入口（结构化遍历 vs 文本
// regex），存在漂移面——envelope 形状改了而 regex 没跟上时，retry 路径会静默
// 失去证据。统一做法：structured 侧也走 `buildTextPrefix` 序列化后过同一
// regex（单一事实源）。本轮不做。

/** send 路径：attachment 数组里是否有 pinned 的 RAG context。 */
export function hasPinnedRagContext(
  attachments: readonly Attachment[] | undefined,
): boolean {
  return attachments?.some((a) => a.type === 'rag-context' && a.pinned === true) ?? false;
}

/** retry/edit 路径：user message 文本里是否带 pinned 的 rag-context envelope。 */
export function textHasPinnedRagContext(text: string): boolean {
  return /<attached-rag-context\b[^>]*\bpinned="true"/.test(text);
}

export type Attachment =
  | ImageAttachment
  | TextFileAttachment
  | PdfTextAttachment
  | ElementAttachment
  | RecordingAttachment
  | PromptMentionAttachment
  | SkillMentionAttachment
  | DirectoryMentionAttachment
  | FileMentionAttachment
  | RagContextAttachment;

/** MIME type for serialized recording JSON. Used for both the agent-prompt
 *  envelope and browser downloads of recording attachments. */
export const RECORDING_MIME = 'application/x-cebian-recording+json';

// ─── Size / type limits ───

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;      // 5 MB
// Composer text-file attachment 上限：提到 1 MB 后，绝大多数代码文件、长 log、
// 中等 markdown 文档都能整篇附上。注意这个值只给「拖入 composer 的一次性 attachment」用；
// mention chip（mention-file / mention-prompt / mention-skill）走 `MAX_INLINE_BODY`
// (100 KB)，worker skill body 同上，pin 时每次 send 都跟着走，预算比一次性 attachment 紧。
export const MAX_TEXT_FILE_SIZE = 1024 * 1024;        // 1 MB
/** Cap recording JSON to keep prompt budget reasonable (~80k tokens worst case). */
export const MAX_RECORDING_SIZE = 256 * 1024;         // 256 KB
/** Hard cap on PDF attachment file size — the offscreen PDF.js pipeline
 *  holds the full ArrayBuffer plus decoded structures in memory, so a
 *  50 MB cap matches the `fs_save_url` ceiling and keeps the SW from
 *  OOMing on multi-hundred-page manuals picked straight from disk. */
export const MAX_PDF_SIZE = 50 * 1024 * 1024;         // 50 MB
export const MAX_ATTACHMENT_COUNT = 10;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.log',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.go', '.rs', '.rb', '.php', '.sh', '.bash',
  '.sql', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.json', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.env', '.gitignore', '.editorconfig',
]);

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
]);

export function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(getFileExtension(name));
}

export function isImageFile(file: File): boolean {
  return IMAGE_MIME_TYPES.has(file.type);
}

/** PDF detection. Browsers are inconsistent about MIME for dropped files:
 *  Chrome usually reports `application/pdf` for `.pdf` files but a drag
 *  from a sandboxed iframe / a paste from a non-file source may leave
 *  `file.type` empty, and some sandboxes report `application/octet-stream`
 *  as a generic catch-all. We accept any of those when the extension is
 *  `.pdf`, but require a real PDF MIME when the extension says otherwise —
 *  a misconfigured server returning a PNG with a `.pdf` URL should not
 *  sneak through. */
export function isPdfFile(file: File): boolean {
  const ext = getFileExtension(file.name);
  const isPdfMime = file.type === 'application/pdf';
  // Trust the extension when MIME is empty or generic octet-stream.
  // Refuse non-PDF MIMEs (e.g. image/png with .pdf name) — MIME wins.
  if (ext === '.pdf') {
    if (file.type === '' || file.type === 'application/octet-stream' || isPdfMime) {
      return true;
    }
    return false;
  }
  return isPdfMime;
}

// ─── File intake rules ───

export type FileIntakeKind = 'image' | 'text';

export type FileIntakeRejection =
  | { file: File; reason: 'no-image-model' }
  | { file: File; reason: 'too-large'; maxSize: number }
  | { file: File; reason: 'unsupported' };

export interface FileIntakePlan {
  /** 通过校验、且占到了名额的文件，保持传入顺序。 */
  accepted: Array<{ file: File; kind: FileIntakeKind }>;
  /** 类型 / 大小 / 模型能力不合格的文件（不占名额）。 */
  rejected: FileIntakeRejection[];
  /** 本身合格、但名额已满而没有加入的文件数。 */
  skipped: number;
}

/**
 * 判定一批文件（点击上传 / 粘贴 / 拖放共用）能加入哪些附件。纯规则，不读文件内容。
 * 按传入顺序逐个判定，只有合格的文件占名额——前面一个不支持的文件不会挤掉后面合格的。
 */
export function planFileIntake(
  files: readonly File[],
  { remaining, supportsImage }: { remaining: number; supportsImage: boolean },
): FileIntakePlan {
  const plan: FileIntakePlan = { accepted: [], rejected: [], skipped: 0 };
  for (const file of files) {
    let kind: FileIntakeKind;
    if (isImageFile(file)) {
      if (!supportsImage) {
        plan.rejected.push({ file, reason: 'no-image-model' });
        continue;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        plan.rejected.push({ file, reason: 'too-large', maxSize: MAX_IMAGE_SIZE });
        continue;
      }
      kind = 'image';
    } else if (isTextFile(file.name)) {
      if (file.size > MAX_TEXT_FILE_SIZE) {
        plan.rejected.push({ file, reason: 'too-large', maxSize: MAX_TEXT_FILE_SIZE });
        continue;
      }
      kind = 'text';
    } else {
      plan.rejected.push({ file, reason: 'unsupported' });
      continue;
    }
    if (plan.accepted.length < remaining) plan.accepted.push({ file, kind });
    else plan.skipped++;
  }
  return plan;
}

// ─── Build LLM-ready content from attachments ───

/**
 * Build XML text from element and file attachments, wrapped in <attachments>.
 * Returns empty string if there are no element/file attachments.
 */
export function buildTextPrefix(attachments: Attachment[]): string {
  const blocks: string[] = [];

  for (const a of attachments) {
    if (a.type === 'element') {
      const attrs = Object.entries(a.attributes)
        .map(([k, v]) => `${k}="${escapeXml(v, { forAttribute: true })}"`)
        .join(' ');

      const lines = [
        `<selected-element selector="${escapeXml(a.selector, { forAttribute: true })}"${a.frameId ? ` frame-id="${a.frameId}" frame-url="${escapeXml(a.frameUrl ?? '', { forAttribute: true })}"` : ''}>`,
        `  path: ${a.path}`,
        `  tag: ${a.tagName}`,
        `  attributes: ${attrs || '(none)'}`,
      ];
      if (a.textContent) lines.push(`  text: ${a.textContent}`);
      if (a.rect) lines.push(`  rect: ${a.rect.x},${a.rect.y} ${a.rect.width}×${a.rect.height}`);
      lines.push('</selected-element>');
      blocks.push(lines.join('\n'));
    }

    if (a.type === 'file') {
      blocks.push(
        `<attached-file name="${escapeXml(a.name, { forAttribute: true })}" type="${escapeXml(a.mimeType, { forAttribute: true })}">\n${a.content}\n</attached-file>`,
      );
    }

    if (a.type === 'pdf') {
      // Same `<attached-file>` envelope as plain text — the LLM doesn't
      // care whether it was originally a PDF, only about the extracted
      // text. Preserving `mimeType="application/pdf"` keeps the type
      // discoverable for any downstream tool that wants to know.
      const truncNote = a.truncated
        ? ` (text truncated to first ${a.extractedPageCount} of ${a.pageCount} pages)`
        : '';
      blocks.push(
        `<attached-file name="${escapeXml(a.name, { forAttribute: true })}" type="application/pdf" pages="${a.pageCount}"${a.truncated ? ' truncated="true"' : ''}${truncNote ? ` note="${escapeXml(truncNote, { forAttribute: true })}"` : ''}>\n${a.content}\n</attached-file>`,
      );
    }

    if (a.type === 'recording') {
      const truncAttr = a.truncatedAttachment ? ' truncated="true"' : '';
      // Element-text-escape the JSON body so arbitrary recorded text
      // (containing `<`, `>`, or `&`) can't break the surrounding XML or
      // the non-greedy <attachments>...</attachments> regex used for
      // parsing. Body is plain readable JSON for the agent (no base64).
      blocks.push(
        `<recording name="${escapeXml(a.name, { forAttribute: true })}" mime="${RECORDING_MIME}" event-count="${a.eventCount}" duration-ms="${a.durationMs}"${truncAttr}>\n${escapeXml(a.json)}\n</recording>`,
      );
    }

    if (a.type === 'mention-prompt') {
      // Body is escaped wholesale — prompt bodies can contain `<`, `>`, `&`,
      // and arbitrary markdown the LLM must see verbatim.
      blocks.push(
        `<attached-prompt name="${escapeXml(a.name, { forAttribute: true })}" path="${escapeXml(a.sourcePath, { forAttribute: true })}">\n${escapeXml(a.body)}\n</attached-prompt>`,
      );
    }

    if (a.type === 'mention-skill') {
      blocks.push(
        `<attached-skill name="${escapeXml(a.name, { forAttribute: true })}" path="${escapeXml(a.sourcePath, { forAttribute: true })}">\n${escapeXml(a.body)}\n</attached-skill>`,
      );
    }

    if (a.type === 'mention-directory') {
      // One-level listing: each child rendered on its own line with kind and
      // optional size. Kept compact so a large directory doesn't blow the
      // prompt budget — the agent can `fs_list` deeper if it needs to.
      // `pinned="true"` flags pin chips so the bubble can hide the badge
      // (the pin is already visible in the composer strip) while the data
      // still rides along to the LLM.
      const lines = a.entries.map((e) => {
        if (e.kind === 'dir') return `  - ${e.name}/`;
        const size = typeof e.size === 'number' ? ` (${formatBytes(e.size)})` : '';
        return `  - ${e.name}${size}`;
      });
      const pinnedAttr = a.pinned ? ' pinned="true"' : '';
      blocks.push(
        `<attached-directory${pinnedAttr} path="${escapeXml(a.path, { forAttribute: true })}" label="${escapeXml(a.label, { forAttribute: true })}" count="${a.entries.length}">\n${lines.join('\n')}\n</attached-directory>`,
      );
    }

    if (a.type === 'mention-file') {
      // Same envelope as regular file attachments so the agent can treat it
      // identically. `truncated` flag tells the agent the body was cut off.
      // `pinned="true"` mirrors the directory flag — pin chips skip the
      // bubble badge; the content still ships to the LLM.
      const truncAttr = a.truncated ? ' truncated="true"' : '';
      const pinnedAttr = a.pinned ? ' pinned="true"' : '';
      blocks.push(
        `<attached-file${pinnedAttr} name="${escapeXml(a.name, { forAttribute: true })}" type="${escapeXml(a.mimeType, { forAttribute: true })}" path="${escapeXml(a.sourcePath, { forAttribute: true })}"${truncAttr}>\n${escapeXml(a.content)}\n</attached-file>`,
      );
    }

    if (a.type === 'rag-context') {
      // 每个 chunk 渲染成 <attached-rag-context> 的一个 <chunk> 子元素。
      // envelope 不带数值分数：hybrid（默认）模式下它是几乎无意义的 RRF 常数，
      // 给 LLM 一个数字只会诱导跨调用比较或自行设阈值（pinMinScore 的教训）——
      // 顺序本身就是排名信号。空结果也要发 envelope，让 agent 知道 collection
      // 被查过（而不是被静默丢弃）。`reason` 存在时作为属性 + 一句内联提示，
      // 让 agent 不用猜就能区分「没有命中」与「collection 为空」；提示里点名
      // `rag_inspect`，给 agent 一条不经过 fs_* 的兜底路径。
      const chunkBlocks = a.chunks.map((c) => {
        return (
          `  <chunk path="${escapeXml(c.sourcePath, { forAttribute: true })}" index="${c.chunkIndex}">\n` +
          `${escapeXml(c.content)}\n` +
          `  </chunk>`
        );
      });
      // `pinned="true"` is included on pin collections for symmetry with
      // the other mention envelopes (and so any future RAG bubble badge
      // could skip them). RAG doesn't currently render a bubble chip,
      // so this is purely a marker for now.
      const pinnedAttr = a.pinned ? ' pinned="true"' : '';
      if (a.chunks.length > 0) {
        blocks.push(
          `<attached-rag-context${pinnedAttr} collection="${escapeXml(a.collection, { forAttribute: true })}" count="${a.chunks.length}">\n${chunkBlocks.join('\n')}\n</attached-rag-context>`,
        );
      } else {
        const reason = a.reason ?? 'no_match';
        const hint =
          reason === 'empty'
            ? 'This collection has no indexed chunks yet. Use rag_inspect to confirm, or ask the user to pick files and re-index.'
            : reason === 'model_mismatch'
              ? 'This collection was indexed with a different embedding model than the one currently configured, so it cannot be searched reliably. Do NOT retry the query — instead tell the user to re-index the collection with the current embedder, or to switch the embedder back in Settings → Knowledge.'
              : 'No chunks matched the user\'s outgoing text above the relevance threshold. Use rag_inspect to see what files are in this collection, or ask the user to refine the question.';
        blocks.push(
          `<attached-rag-context${pinnedAttr} collection="${escapeXml(a.collection, { forAttribute: true })}" count="0" reason="${reason}">\n${escapeXml(hint)}\n</attached-rag-context>`,
        );
      }
    }
  }

  if (blocks.length === 0) return '';

  // When the message carries at least one <recording>, prepend a schema
  // comment so the agent can interpret the JSON body without guessing
  // field meanings. Only inject when relevant to avoid spending tokens
  // on messages that don't need it.
  const hasRecording = attachments.some((a) => a.type === 'recording');
  const body = hasRecording
    ? `${RECORDING_SCHEMA_COMMENT}\n${blocks.join('\n\n')}`
    : blocks.join('\n\n');
  return `<attachments>\n${body}\n</attachments>`;
}

/**
 * Extract ImageContent array from attachments for multi-modal prompt.
 */
export function extractImages(attachments: Attachment[]): ImageContent[] {
  return attachments
    .filter((a): a is ImageAttachment => a.type === 'image')
    .map(a => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }));
}


