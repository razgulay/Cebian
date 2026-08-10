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
  files: { name: string; type: string }[];
  /** PDF attachments, surfaced separately so the bubble can render a
   *  "PDF · N pages" badge instead of a generic file chip. Extracted
   *  page count + truncation flag are the same values written by the
   *  offscreen extraction handler. */
  pdfs: { name: string; pageCount: number; extractedPageCount: number; truncated: boolean }[];
  recordings: { name: string; eventCount: number; durationMs: number; truncated: boolean; json: string }[];
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

const USER_REQUEST_RE = /<user-request>\s*([\s\S]*?)\s*<\/user-request>/;

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
 *  Reads the content of the <user-request> block. */
export function extractUserText(msg: Message): string {
  if (msg.role !== 'user') return '';
  const raw = getRawUserText(msg);
  const match = raw.match(USER_REQUEST_RE);
  return match ? match[1].trim() : raw.trim();
}

const ELEMENT_RE = /<selected-element\s+selector="([^"]*)"[^>]*>/g;
const FILE_RE = /<attached-file\s+name="([^"]*)"\s+type="([^"]*)"([^>]*)>/g;
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
  const result: ParsedUserAttachments = { images: [], elements: [], files: [], pdfs: [], recordings: [] };
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
      result.files.push({ name, type });
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
  if (USER_REQUEST_RE.test(raw)) {
    return raw.replace(USER_REQUEST_RE, `<user-request>\n${newText}\n</user-request>`);
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
      if (!replaced && USER_REQUEST_RE.test(b.text)) {
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
