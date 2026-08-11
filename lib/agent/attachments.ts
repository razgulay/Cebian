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
 *  this folder is in scope for the request. */
export interface DirectoryMentionAttachment {
  type: 'mention-directory';
  path: string;
  label: string;
  entries: { name: string; kind: 'file' | 'dir'; size?: number }[];
}

/** Mention of a single VFS file. Resolved at send-time by reading the file
 *  via `vfs.readFile`. The LLM receives the file's text content inside
 *  `<attached-file>` (the same envelope used by regular file attachments),
 *  so the agent can `fs_read_file` it again later if needed. Sized the
 *  same as a regular text-file attachment — large files (over
 *  `MAX_TEXT_FILE_SIZE`) get truncated to keep prompt budget in check. */
export interface FileMentionAttachment {
  type: 'mention-file';
  name: string;
  content: string;
  sourcePath: string;
  mimeType: string;
  truncated: boolean;
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
  | FileMentionAttachment;

/** MIME type for serialized recording JSON. Used for both the agent-prompt
 *  envelope and browser downloads of recording attachments. */
export const RECORDING_MIME = 'application/x-cebian-recording+json';

// ─── Size / type limits ───

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;      // 5 MB
export const MAX_TEXT_FILE_SIZE = 100 * 1024;         // 100 KB
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
      const lines = a.entries.map((e) => {
        if (e.kind === 'dir') return `  - ${e.name}/`;
        const size = typeof e.size === 'number' ? ` (${formatBytes(e.size)})` : '';
        return `  - ${e.name}${size}`;
      });
      blocks.push(
        `<attached-directory path="${escapeXml(a.path, { forAttribute: true })}" label="${escapeXml(a.label, { forAttribute: true })}" count="${a.entries.length}">\n${lines.join('\n')}\n</attached-directory>`,
      );
    }

    if (a.type === 'mention-file') {
      // Same envelope as regular file attachments so the agent can treat it
      // identically. `truncated` flag tells the agent the body was cut off.
      const truncAttr = a.truncated ? ' truncated="true"' : '';
      blocks.push(
        `<attached-file name="${escapeXml(a.name, { forAttribute: true })}" type="${escapeXml(a.mimeType, { forAttribute: true })}" path="${escapeXml(a.sourcePath, { forAttribute: true })}"${truncAttr}>\n${escapeXml(a.content)}\n</attached-file>`,
      );
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


