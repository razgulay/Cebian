import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ImageContent,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { unescapeXml } from '@/lib/utils';

// ─── Parsed attachment metadata for UI display ───

export interface ParsedUserAttachments {
  images: { data: string; mimeType: string }[];
  elements: { selector: string }[];
  files: { name: string; type: string; pinned?: boolean }[];
  /** Prompt/skill directives we inlined into the user text via hybrid
   *  injection. Hybrid strips the envelope (so the LLM sees the body as
   *  user-typed instructions with full weight) but the UX layer still
   *  needs chips on the bubble — without them, the user loses the visual
   *  confirmation that they attached a prompt/skill to the message.
   *  `pinned` mirrors the same flag we already use for directory/file
   *  envelopes: pin chips skip the bubble badge (the composer strip is
   *  the source of truth for pins), mention chips render as confirmation. */
  inlineDirectives: { name: string; kind: 'prompt' | 'skill'; pinned: boolean }[];
  /** PDF attachments, surfaced separately so the bubble can render a
   *  "PDF · N pages" badge instead of a generic file chip. Extracted
   *  page count + truncation flag are the same values written by the
   *  offscreen extraction handler. */
  pdfs: { name: string; pageCount: number; extractedPageCount: number; truncated: boolean }[];
  recordings: { name: string; eventCount: number; durationMs: number; truncated: boolean; json: string }[];
  /** Mention chips — prompt, skill, directory references attached via the
   *  composer [+] popover. The XML envelope goes to the LLM verbatim; the
   *  parsed fields drive a chip-style badge in the chat bubble so the user
   *  can see what they attached. `path` is the VFS path the resolver read;
   *  `count` is only meaningful for `directory` (number of children listed).
   *  `pinned` mirrors the flag on the outgoing attachment: pin chips skip
   *  the bubble badge (the pin lives in the composer strip), mention chips
   *  render as confirmation. `pdfs` / `files` are always shown — those are
   *  not pin-able. */
  prompts: { name: string; path: string }[];
  skills: { name: string; path: string }[];
  directories: { path: string; label: string; count: number; pinned: boolean }[];
}

/** Extract plain text from an AssistantMessage's content blocks */
export function getAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Extract thinking blocks from an AssistantMessage (skips empty summaries) */
export function getThinkingBlocks(msg: AssistantMessage): ThinkingContent[] {
  return msg.content.filter(
    (b): b is ThinkingContent => b.type === 'thinking' && !!b.thinking?.trim(),
  );
}

/** Extract tool calls from an AssistantMessage */
export function getToolCalls(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((b): b is ToolCall => b.type === 'toolCall');
}

/** Find the ToolResultMessage for a given tool call id */
export function findToolResult(
  messages: AgentMessage[],
  toolCallId: string,
): ToolResultMessage | undefined {
  return messages.find(
    (m): m is ToolResultMessage =>
      m.role === 'toolResult' && m.toolCallId === toolCallId,
  );
}

const USER_REQUEST_OPEN = '<user-request>';
const USER_REQUEST_CLOSE = '</user-request>';

/** Snip out the content of the OUTERMOST `<user-request>...</user-request>`
 *  wrapper in `raw`. The BG's `prompt-composer.ts` wraps the user text in
 *  a `<user-request>` envelope, and that wrapper is always the outermost
 *  pair — its `<user-request>` is the FIRST one in the message and its
 *  `</user-request>` is the LAST one, even when a skill body inlined by
 *  hybrid injection contains its own `<user-request>` placeholder
 *  (later open tag, earlier close tag — strictly inside the BG pair).
 *  Matching the LAST `<user-request>` alone would skip past BG's open
 *  and pick up the skill's placeholder, so the bubble would render the
 *  skill body verbatim. Returns `raw` unchanged when no wrapper is
 *  found (old messages / non-BG-wrapped content). */
function extractLastUserRequest(raw: string): string {
  const firstOpen = raw.indexOf(USER_REQUEST_OPEN);
  if (firstOpen < 0) return raw;
  const lastClose = raw.lastIndexOf(USER_REQUEST_CLOSE);
  if (lastClose < firstOpen) return raw;
  return raw.slice(firstOpen + USER_REQUEST_OPEN.length, lastClose);
}

/** Replace the user-text segment inside the BG's OUTERMOST
 *  `<user-request>...</user-request>` wrapper with `newText`. The BG
 *  wraps the whole outgoing text (any directive chain plus the user's
 *  own words) in `<user-request>\n...\n</user-request>`. The directive
 *  chain lives at the front, separated from the user text by either
 *  `\n\n---\n\n` (multi-directive chain) or `\n\n` (single directive).
 *  Skill bodies injected as directives can themselves contain
 *  `<user-request>` placeholders (skill templates wrap their request
 *  in `<user-request>`), so we must NOT rewrite the wrapper content
 *  wholesale — that would wipe the directive body. Instead, locate the
 *  trailing user-text segment (after the LAST `[END DIRECTIVE]`
 *  separator inside the wrapper, or after `<user-request>\n` when no
 *  directives were attached) and rewrite only that segment. Same
 *  fallback as `replaceUserRequestInText` had: when no wrapper is
 *  present, return `newText` as-is (the surrounding context is dropped). */
function replaceLastUserRequest(raw: string, newText: string): string {
  const lastClose = raw.lastIndexOf(USER_REQUEST_CLOSE);
  if (lastClose < 0) return newText;

  // Find the trailing user-text segment inside BG's wrapper. The BG
  // inserts the user text after either:
  //   - `[END DIRECTIVE]\n\n---\n\n` (multi-directive chain)
  //   - `[END DIRECTIVE]\n\n` (single directive, no chain separator)
  //   - `<user-request>\n` (no directives, plain text)
  // Walk backwards from BG's close to find the last `[END DIRECTIVE]`;
  // if none, fall back to the wrapper open.
  let userTextStart: number;
  const lastEndDirective = raw.lastIndexOf('[END DIRECTIVE]', lastClose);
  if (lastEndDirective >= 0) {
    const afterLabel = lastEndDirective + '[END DIRECTIVE]'.length;
    // Consume the chain separator or the plain separator that follows.
    const chainStart = raw.indexOf('\n\n---\n\n', afterLabel);
    const plainStart = raw.indexOf('\n\n', afterLabel);
    let sepStart = -1;
    let sepLen = 0;
    if (chainStart >= 0 && chainStart < lastClose) {
      sepStart = chainStart;
      sepLen = '\n\n---\n\n'.length;
    } else if (plainStart >= 0 && plainStart < lastClose) {
      sepStart = plainStart;
      sepLen = '\n\n'.length;
    }
    if (sepStart < 0) {
      // Directive-only message — nothing to rewrite (the user-text
      // segment is empty; the bubble's displayText override handles
      // the "no user text" path).
      return raw;
    }
    userTextStart = sepStart + sepLen;
  } else {
    // No directives — user text starts right after `<user-request>\n`.
    const firstOpen = raw.indexOf(USER_REQUEST_OPEN);
    if (firstOpen < 0) return newText;
    userTextStart = firstOpen + USER_REQUEST_OPEN.length + 1; // +1 for the BG's `\n`
    if (userTextStart >= lastClose) return newText;
  }

  return (
    raw.slice(0, userTextStart) +
    newText +
    '\n' +
    raw.slice(lastClose)
  );
}

// Inline directive blocks emitted by ChatInput's hybrid injection — see the
// `inlineDirectiveParts` builder there. They wrap each pinned/mentioned
// prompt or skill body as `[DIRECTIVE — ATTACHED PROMPT/SKILL: "name"]\n\n<body>\n\n[END DIRECTIVE]`,
// then join them (and the user text) with `\n\n---\n\n`. The LLM sees them
// because they're in the user message; the bubble MUST NOT show them — the
// user finds the visible prompt body in their chat history jarring.
// `<user-request>` extraction above peels off the wrapping BG context; this
// helper peels off what we ourselves injected inside the user-request body.
// Pin directives also carry `pinned="true"` so the bubble can distinguish
// them from mention directives at parse time and skip their chip (the
// composer strip is the source of truth for pins).
const DIRECTIVE_BLOCK_RE = /\[DIRECTIVE\s+—\s+ATTACHED\s+(?:PROMPT|SKILL):\s+"[^"]*"(?:\s+pinned="true")?\][\s\S]*?\[END\s+DIRECTIVE\]/g;
const SEPARATOR_LINE_RE = /^\s*---\s*$/;

/** Parse `[DIRECTIVE — ATTACHED PROMPT/SKILL: "name"]` opening tags to
 *  recover the chips the user attached. Returns one entry per directive
 *  in the order they appear in the text. `pinned` is true when the
 *  directive carried `pinned="true"` (a pin chip — composer strip already
 *  shows it, the bubble should suppress the badge). The directive BLOCKS
 *  are still removed from the bubble text by `stripDirectives`; this only
 *  surfaces their names for chip rendering. */
export function extractInlineDirectives(text: string): { name: string; kind: 'prompt' | 'skill'; pinned: boolean }[] {
  const re = /\[DIRECTIVE\s+—\s+ATTACHED\s+(PROMPT|SKILL):\s+"([^"]*)"(\s+pinned="true")?\]/g;
  const out: { name: string; kind: 'prompt' | 'skill'; pinned: boolean }[] = [];
  for (const m of text.matchAll(re)) {
    out.push({
      name: m[2],
      kind: m[1].toLowerCase() as 'prompt' | 'skill',
      pinned: m[3] !== undefined,
    });
  }
  return out;
};

/** Strip `[DIRECTIVE — ...]...[END DIRECTIVE]` blocks and the `\n\n---\n\n`
 *  separators we used to delimit them. Only the directive blocks and the
 *  bare-separator lines we introduced go away — actual user text passes
 *  through unchanged. Used by the chat bubble so the visible text matches
 *  what the user typed, not what the LLM received. */
export function stripDirectives(text: string): string {
  const withoutBlocks = text.replace(DIRECTIVE_BLOCK_RE, '');
  return withoutBlocks
    .split('\n')
    .filter((line) => !SEPARATOR_LINE_RE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')  // collapse the now-empty lines we left behind
    .trim();
}

/** Extract the raw text string from a user message (handles string and block-array formats). */
function getRawUserText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: 'text'; text: string } => 'type' in b && b.type === 'text')
      .map(b => b.text)
      .join('');
  }
  return '';
}

/** Extract the user's actual input text from a structured user message.
 *  Reads the content of the <user-request> block and strips any directive
 *  blocks we inlined for the LLM — the bubble only shows what the user
 *  typed, never the directive bodies. */
export function extractUserText(msg: Message): string {
  if (msg.role !== 'user') return '';
  const raw = getRawUserText(msg);
  return stripDirectives(extractLastUserRequest(raw)).trim();
}

const ELEMENT_RE = /<selected-element\s+selector="([^"]*)"[^>]*>/g;
// `<attached-file>` carries three shapes: regular file (drag/drop), PDF
// (offscreen extraction), and mention-file (a VFS file the user pinned or
// @-mentioned). Mention-files add `path="..."` and may add `pinned="true"`.
// The trailing `([^>]*)` slurps any extra attributes (including `pinned`),
// which `parseAttachedFileAttrs` walks key-by-key.
const FILE_RE = /<attached-file\s+name="([^"]*)"\s+type="([^"]*)"([^>]*)>/g;
// Mention envelopes — keep names/paths out of the bubble's badge text;
// the UI just needs the `name` (prompt/skill) or `label` (directory) to
// show what was attached, and `path` for tooltip context. The optional
// `pinned="true"` prefix on `<attached-directory>` lets the bubble skip
// rendering a badge for pin chips (the pin is already visible in the
// composer strip); mention chips render as confirmation as before.
const PROMPT_RE = /<attached-prompt\s+name="([^"]*)"\s+path="([^"]*)"[^>]*>/g;
const SKILL_RE = /<attached-skill\s+name="([^"]*)"\s+path="([^"]*)"[^>]*>/g;
const DIR_RE = /<attached-directory(?:\s+pinned="true")?\s+path="([^"]*)"\s+label="([^"]*)"\s+count="(\d+)"[^>]*>/g;
// PDF attachments use the same `<attached-file>` envelope but carry extra
// attributes (`pages`, `truncated`). Re-extract from the same `<attached-file>`
// matches by walking the captures rather than a separate regex, so we can't
// miss a file just because it happens to share both shapes.
// ─── Per-file attribute scan ───
// Cheap inline attribute parser: splits on whitespace, then `name="value"`
// or `name=value`. Only used on the captured attribute blob (a few hundred
// chars max), so a real HTML parser would be overkill.
function parseAttachedFileAttrs(attrBlob: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrBlob)) !== null) {
    out[m[1]!] = m[2]!;
  }
  return out;
}
// Body is XML-escaped JSON. Recorded `<`/`>`/`&` chars are encoded as
// entities so they can't fake a `</recording>` or `</attachments>` close
// tag, keeping the non-greedy boundary unambiguous.
const RECORDING_RE = /<recording\s+name="([^"]*)"\s+mime="[^"]*"\s+event-count="(\d+)"\s+duration-ms="(\d+)"(\s+truncated="true")?>\n([\s\S]*?)\n<\/recording>/g;
const ATTACHMENTS_BLOCK_RE = /<attachments>([\s\S]*?)<\/attachments>/;

/** Extract attachment metadata from a user message for display in the chat bubble. */
export function extractUserAttachments(msg: Message): ParsedUserAttachments {
  const result: ParsedUserAttachments = {
    images: [], elements: [], files: [], pdfs: [], recordings: [],
    prompts: [], skills: [], directories: [], inlineDirectives: [],
  };
  if (msg.role !== 'user') return result;

  // Extract images from content blocks
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if ('type' in block && block.type === 'image') {
        const img = block as ImageContent;
        result.images.push({ data: img.data, mimeType: img.mimeType });
      }
    }
  }

  // Extract element/file metadata from the <attachments> block
  const raw = getRawUserText(msg);
  const attachBlock = raw.match(ATTACHMENTS_BLOCK_RE)?.[1] ?? '';

  for (const m of attachBlock.matchAll(ELEMENT_RE)) {
    result.elements.push({ selector: unescapeXml(m[1]) });
  }
  for (const m of attachBlock.matchAll(FILE_RE)) {
    const name = unescapeXml(m[1]!);
    const type = unescapeXml(m[2]!);
    const attrs = parseAttachedFileAttrs(m[3] ?? '');
    // `pinned="true"` only appears on mention-file envelopes (regular file
    // and PDF envelopes never carry it). The bubble uses it to hide pin
    // chips; mention-files and regular files render normally.
    const pinned = attrs.pinned === 'true';
    if (type === 'application/pdf') {
      // Pages count comes from the offscreen extractor. `truncated="true"`
      // means we hit the budget cap before reading the whole document;
      // `extractedPageCount` is approximated from the body length when
      // available, but we don't try to recover it precisely here — the UI
      // just needs the document total to render "PDF · 12 pages".
      const pageCount = Number(attrs.pages ?? '0');
      result.pdfs.push({
        name,
        pageCount,
        extractedPageCount: pageCount,
        truncated: attrs.truncated === 'true',
      });
    } else {
      result.files.push({ name, type, pinned });
    }
  }
  for (const m of attachBlock.matchAll(RECORDING_RE)) {
    result.recordings.push({
      name: unescapeXml(m[1]),
      eventCount: Number(m[2]),
      durationMs: Number(m[3]),
      truncated: !!m[4],
      json: unescapeXml(m[5]),
    });
  }
  for (const m of attachBlock.matchAll(PROMPT_RE)) {
    result.prompts.push({ name: unescapeXml(m[1]!), path: unescapeXml(m[2]!) });
  }
  for (const m of attachBlock.matchAll(SKILL_RE)) {
    result.skills.push({ name: unescapeXml(m[1]!), path: unescapeXml(m[2]!) });
  }
  for (const m of attachBlock.matchAll(DIR_RE)) {
    result.directories.push({
      path: unescapeXml(m[1]!),
      label: unescapeXml(m[2]!),
      count: Number(m[3]),
      // Optional `pinned="true"` prefix on the opening tag — pin chips skip
      // the bubble badge; mention chips render as confirmation.
      pinned: /pinned="true"/.test(m[0]),
    });
  }

  // Hybrid injection pulls prompt/skill mentions OUT of <attachments> and
  // inlines them as `[DIRECTIVE — ...]` text blocks. The LLM still gets the
  // data (it lives in the user text now), but for UX we re-extract the
  // names so the bubble can render confirmation chips. Scan the FULL raw
  // text — directives sit inside `<user-request>`, not the `<attachments>`
  // block, so the attachBlock scan above doesn't see them.
  result.inlineDirectives = extractInlineDirectives(raw);

  return result;
}

/**
 * Compute the transcript slice that "retry" should restart from: everything
 * up to and including the most recent user message. Drops the failed/unwanted
 * assistant turn plus any orphan toolUse / toolResult blocks that came after it.
 *
 * Returns `null` when no user message exists — callers should treat this as
 * "nothing to retry" (the UI normally prevents this, but defensive).
 *
 * Shared by the background `retry()` and the sidepanel's optimistic UI update
 * so both sides truncate identically — multi-window reconciliation never flickers.
 */
export function truncateForRetry<M extends { role: string }>(messages: M[]): M[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages.slice(0, i + 1);
    }
  }
  return null;
}

function replaceUserRequestInText(raw: string, newText: string): string {
  if (extractLastUserRequest(raw) !== raw) {
    return replaceLastUserRequest(raw, newText);
  }
  return newText;
}

/**
 * Compute the transcript slice for editing a previous user turn and rerunning
 * from that point. Only the visible user request text is replaced; structured
 * context / attachment XML and non-text blocks (images) on the edited message
 * are preserved, then everything after that user message is dropped.
 */
export function truncateForEditRerun<M extends { role: string }>(
  messages: M[],
  userMessageIndex: number,
  newText: string,
): M[] | null {
  const trimmed = newText.trim();
  if (!trimmed) return null;
  const target = messages[userMessageIndex];
  if (!target || target.role !== 'user') return null;

  const msg = target as unknown as Message;
  let edited: Message | null = null;

  if (typeof msg.content === 'string') {
    edited = { ...msg, content: replaceUserRequestInText(msg.content, trimmed) } as Message;
  } else if (Array.isArray(msg.content)) {
    let replaced = false;
    const nextContent = (msg.content as unknown[]).map((block) => {
      if (!block || typeof block !== 'object') return block;
      const b = block as Record<string, unknown>;
      if (b.type !== 'text' || typeof b.text !== 'string') return block;
      if (!replaced && extractLastUserRequest(b.text) !== b.text) {
        replaced = true;
        return { ...b, text: replaceUserRequestInText(b.text, trimmed) };
      }
      return block;
    });

    if (!replaced) {
      const firstTextIndex = nextContent.findIndex((block) => {
        if (!block || typeof block !== 'object') return false;
        const b = block as Record<string, unknown>;
        return b.type === 'text' && typeof b.text === 'string';
      });
      if (firstTextIndex < 0) return null;
      const block = nextContent[firstTextIndex] as Record<string, unknown>;
      nextContent[firstTextIndex] = { ...block, text: trimmed };
    }

    edited = { ...msg, content: nextContent as unknown as Message['content'] } as Message;
  } else {
    return null;
  }

  const out = messages.slice(0, userMessageIndex + 1);
  out[userMessageIndex] = edited as unknown as M;
  return out;
}

// ─── 消息形态规整（类型契约兜底）───

/** 把单个内容块里为 null / undefined 的字符串字段兜成空串；块无需矫正时原样返回同一引用 */
function sanitizeBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object') return block;
  const b = block as Record<string, unknown>;
  // text / thinking / name 在 pi 类型里都是 string；个别 provider 返回或旧数据可能落成
  // null，`== null` 同时覆盖 null 与 undefined
  if (b.type === 'text' && b.text == null) return { ...b, text: '' };
  if (b.type === 'thinking' && b.thinking == null) return { ...b, thinking: '' };
  if (b.type === 'toolCall' && b.name == null) return { ...b, name: '' };
  return block;
}

/** 矫正一个内容块数组；无改动时原样返回同一引用，只复制受影响的块 */
function sanitizeBlocks(blocks: unknown[]): unknown[] {
  let out: unknown[] | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const original = blocks[i];
    const fixed = sanitizeBlock(original);
    if (fixed !== original && out === null) out = blocks.slice(0, i);
    if (out !== null) out.push(fixed);
  }
  return out ?? blocks;
}

/** 矫正一条消息；无改动时原样返回同一引用 */
function sanitizeMessage(msg: AgentMessage): AgentMessage {
  // 仅标准 Message 角色带 content；compactionSummary 等自定义消息无 content 字段，跳过，
  // 避免给它们凭空塞一个 content
  if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'toolResult') {
    return msg;
  }
  const content: unknown = (msg as Message).content;
  // 顶层 content 缺失 → 空数组（对齐 pi transformMessages 的规整）
  if (content == null) {
    return { ...msg, content: [] } as AgentMessage;
  }
  // 字符串 content（常见于 user 消息）无嵌套块，原样返回
  if (!Array.isArray(content)) {
    return msg;
  }
  const fixed = sanitizeBlocks(content);
  return fixed === content ? msg : ({ ...msg, content: fixed } as AgentMessage);
}

/**
 * 把消息整形回 pi 的类型契约后再送入 pi。个别 provider 返回 / 旧会话数据可能让
 * assistant 内容块的 `text` / `thinking` / `name` 落成 `null`，而 pi 的 token 估算器
 * （`clampMaxTokensToContext` → `estimateMessageTokens`）对这些字段无保护地取 `.length`，
 * 一旦命中就整轮抛「Cannot read properties of null (reading 'length')」，把对话卡死
 * （issue #43）。上游把这类归为「调用方违反类型契约」不予修复（earendil-works/pi
 * #6568 等），故在此把 null / undefined 兜成空串，顶层缺失的 content 兜成空数组。
 *
 * copy-on-write：整条数组 / 消息 / 块在无需矫正时一律返回同一引用，仅在实际需要矫正时
 * 才复制受影响的那一层，因此热路径（每轮 convertToLlm）在常态下零分配、只做一次扫描。
 * 纯函数、不改动入参
 */
export function sanitizeAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  let out: AgentMessage[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const original = messages[i];
    const fixed = sanitizeMessage(original);
    if (fixed !== original && out === null) out = messages.slice(0, i);
    if (out !== null) out.push(fixed);
  }
  return out ?? messages;
}
