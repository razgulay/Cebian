// Session auto-title generation: dùng LLM sinh title ngắn (≤40 chars) từ
// user + assistant message đầu tiên. Pattern reuse từ `lib/agent/compaction.ts`
// nhưng đơn giản hơn nhiều — title chỉ cần 1 LLM call nhỏ, không có state
// rolling-merge, không phải UPDATE-style summary.

import type { Api, Model } from '@earendil-works/pi-ai';
import { complete } from '@earendil-works/pi-ai/compat';
import { debugLog, withSession } from '@/lib/debug/log';
import { stripThinkTags } from '@/lib/agent/think-tags';
import { stripSystemTags } from '@/lib/agent/strip-system-tags';

/**
 * Hard cap cho title. Đủ dài để mô tả nhưng đủ ngắn để hiển thị trong
 * sidepanel list. Trim whitespace trước khi đo; nếu sau trim vẫn > 40
 * thì cắt ở word boundary gần nhất + ellipsis. 40 chars là cùng ngưỡng
 * ChatGPT dùng.
 */
export const TITLE_MAX_LENGTH = 40;

/** System prompt ép LLM chỉ output title thuần. Anti-patterns rất rõ
 *  vì LLM hay echo reasoning ("The user wants a concise conversation
 *  about...") thay vì tóm tắt topic — đó là lỗi phổ biến nhất của
 *  auto-title ở nhiều LLM (M3, GPT-4, Claude đều từng dính). */
const SYSTEM_PROMPT =
  'Generate a short conversation title (2-6 words, maximum ' + TITLE_MAX_LENGTH + ' characters). ' +
  'Output ONLY the title — no quotes, no prefix, no explanation, no period at the end. ' +
  '\n\n' +
  'CRITICAL: the title must describe the TOPIC of the conversation, not describe what the user is doing. ' +
  'Phrase it as if naming the subject matter for a chapter heading.\n' +
  '  GOOD: "Bitcoin price today" — names the topic.\n' +
  '  GOOD: "Weather forecast in HCMC" — names the topic.\n' +
  '  GOOD: "How to cook pasta" — names the topic.\n' +
  '  BAD:  "The user asked about Bitcoin" — describes the user, not the topic.\n' +
  '  BAD:  "User wants to know weather" — describes the user, not the topic.\n' +
  '  BAD:  "A user is asking for help" — describes the user, not the topic.\n' +
  '\n' +
  'Match the language of the user\'s message. Keep it under ' + TITLE_MAX_LENGTH + ' characters.';

/**
 * Sinh title từ user + assistant message đầu tiên.
 *
 * Returns:
 *   - Non-empty string: title ready to persist (đã trim, strip quotes, cap length)
 *   - `null`: LLM fail / abort / output invalid → caller dùng fallback heuristic
 *
 * LLM call qua `complete` (pi-ai/compat) — same path ProviderApiKeyItem dùng
 * cho "verify key". Một call duy nhất, maxTokens=60 đủ cho title ngắn
 * (đề phòng LLM phun giải thích dài).
 *
 * Trả `null` thay vì throw để caller không phải try/catch — chỉ cần check
 * truthy. Background errors vẫn được log qua debugLog để debug sau.
 */
export async function generateSessionTitle(params: {
  userMessage: string;
  assistantMessage: string;
  model: Model<Api>;
  apiKey?: string;
  signal?: AbortSignal;
  sessionId?: string;
}): Promise<string | null> {
  const { userMessage, assistantMessage, model, apiKey, signal, sessionId } = params;

  // Defensive: input rỗng → caller đã bug. Trả null thay vì fire LLM với
  // empty content (một số provider sẽ 400 trên empty user message).
  if (!userMessage.trim() || !assistantMessage.trim()) return null;

  // Strip system-only XML tags (<reminder-instructions>, <context>, ...)
  // từ CẢ user + assistant trước khi đưa cho title LLM. Nếu không, LLM
  // sẽ thấy literal tag trong input và dễ echo lại nó vào title output
  // (regression user report: "<reminder-instructions>" leak thành tên
  // session). Strip xong mới tính trim/empty check — tag-only content
  // coi như rỗng để caller fallback heuristic.
  const cleanedUser = stripSystemTags(userMessage);
  const strippedAssistant = stripSystemTags(assistantMessage);

  // Strip think-tag content ra khỏi assistant message TRƯỚC khi đưa
  // cho LLM. MiniMax M3 hay emit `<think>The user is asking...</think>`
  // inline; nếu pass nguyên xi cho title generator, LLM sẽ bị "lừa"
  // tóm tắt luôn reasoning thay vì topic. `stripThinkTags` đã có sẵn
  // orphan-close handling, idempotent trên plain prose.
  const thinkStripped = stripThinkTags(strippedAssistant);
  const cleanedAssistant = thinkStripped.text;

  if (!cleanedUser || !cleanedAssistant) {
    // Either side was empty after stripping system tags / think tags.
    // Returning null lets the caller fall back to its own heuristic
    // (e.g. slice user message). Avoids firing the LLM with empty
    // content (some providers 400 on empty user message) AND avoids
    // returning a literal "..." — which is what callers fall back to
    // when the function returns null.
    return null;
  }

  const userPrompt =
    `User: ${cleanedUser.trim()}\n` +
    `Assistant: ${cleanedAssistant}\n` +
    `Title:`;

  const startedAt = Date.now();
  debugLog.info('llm', 'autoTitle:start', withSession({
    model: `${model.provider}/${model.id}`,
    userLen: userMessage.length,
    assistantLen: assistantMessage.length,
  }, sessionId ?? ''));

  let result;
  try {
    result = await complete(
      model,
      {
        // `Context.messages` is `Message[]` = user | assistant | toolResult
        // only — system instructions go in `Context.systemPrompt`, not
        // as a `{role: 'system'}` message in the array (per pi-ai's
        // typed Context).
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: userPrompt, timestamp: Date.now() },
        ],
      },
      // apiKey: undefined OK — pi-ai tự resolve từ env / provider registry
      // cho builtin. Custom provider thì caller phải truyền (resolve từ
      // resolveProviderApiKey trước khi gọi).
      { ...(apiKey ? { apiKey } : {}), maxTokens: 60, ...(signal ? { signal } : {}) },
    );
  } catch (err) {
    debugLog.warn('llm', 'autoTitle:done', withSession({
      ok: false,
      reason: 'thrown',
      err: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    }, sessionId ?? ''));
    return null;
  }

  // complete() resolves (not rejects) với Error khi provider fail.
  if (result instanceof Error) {
    debugLog.warn('llm', 'autoTitle:done', withSession({
      ok: false,
      reason: 'complete-returned-error',
      err: result.message,
      durationMs: Date.now() - startedAt,
    }, sessionId ?? ''));
    return null;
  }

  // Abort: signal có thể fired giữa call. complete() trả content rỗng
  // hoặc partial — caller không phân biệt được, nhưng vì maxTokens=60
  // partial sẽ rất ngắn và bị loại bởi length cap. Coi như fail.
  if (signal?.aborted) {
    debugLog.info('llm', 'autoTitle:done', withSession({
      ok: false,
      cancelled: true,
      durationMs: Date.now() - startedAt,
    }, sessionId ?? ''));
    return null;
  }

  // Extract text content. Anthropic-style content blocks có thể có
  // {type: 'text', text} — flatten. Skip non-text (tool_use, image, ...).
  const text = result.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const cleaned = cleanTitle(text);
  if (!cleaned) {
    debugLog.warn('llm', 'autoTitle:done', withSession({
      ok: false,
      reason: 'empty-after-clean',
      rawLen: text.length,
      durationMs: Date.now() - startedAt,
    }, sessionId ?? ''));
    return null;
  }

  debugLog.info('llm', 'autoTitle:done', withSession({
    ok: true,
    titleLen: cleaned.length,
    durationMs: Date.now() - startedAt,
  }, sessionId ?? ''));
  return cleaned;
}

/**
 * Patterns that signal the LLM echoed its own reasoning instead of
 * naming the topic. If the cleaned title starts with one of these,
 * reject it and let the caller fall back to `fallbackTitle`. Defense
 * in depth — system prompt has explicit anti-patterns, but M3/others
 * still slip occasionally and we don't want those titles in the
 * session list.
 *
 * Matched at the start (case-insensitive), tolerating a leading "A"
 * article. Word boundary `\b` prevents false matches like "Universe"
 * for `\buser\b`; we explicitly avoid that risk by matching whole
 * opening phrases instead of single words where possible.
 */
const META_PREFIXES_RE = /^(?:a\s+)?(?:user|the\s+user|users?|i\b|assistant|the\s+assistant|ai\b|the\s+ai)(?:\s+(?:is\s+|are\s+|was\s+|were\s+|has\s+|have\s+|had\s+|asked|asks|asking|wants?|wanted|wanted\s+to|needs?|wanted\s+to\s+know|requested?|is\s+requesting|inquired|inquiring|seeking|seeks|would\s+like|is\s+looking|is\s+interested|asked\s+about|asked\s+for|asked\s+to))?\s*(?:[:.,-]|\s+(?:about|for|to|in|whether|if|how|what|when|where|why|which|that|who)\b)?\s*/i;

/**
 * Làm sạch LLM output:
 *   - Trim whitespace
 *   - Strip surrounding quotes (", ', ", ", « »)
 *   - Strip leading bullet/number prefix (`- title`, `1. title`)
 *   - Strip trailing period (LLM hay thêm dù đã bảo không)
 *   - Strip leading "Title:" echo
 *   - Reject meta-commentary ("The user asked…") → returns ''
 *   - Cap � TITLE_MAX_LENGTH (word-boundary khi có thể)
 *
 * Trả `''` nếu sau khi clean không còn gì hoặc title thuộc dạng
 * meta-commentary — caller sẽ fallback sang `fallbackTitle`.
 *
 * Export để test trực tiếp mà không phải mock LLM.
 */
export function cleanTitle(raw: string): string {
  let s = raw.trim();

  // Strip system tags FIRST so any leaked <reminder-instructions> /
  // <context> / etc. from the LLM output is removed before we even try
  // to interpret the rest. Mirrors the pre-LLM strip in generateSessionTitle
  // — defense in depth: model echoes are still our problem to fix.
  s = stripSystemTags(s);

  // Strip surrounding quotes. LLM hay wrap output trong "" / '' / « »
  // dù system prompt cấm — robust hơn là giả định nó tuân lệnh.
  // ASCII straight quotes first (same char for open + close); then
  // curly/smart quotes which have distinct open/close code points.
  const SAME_CHAR_QUOTES = ['"', '\''];
  for (const q of SAME_CHAR_QUOTES) {
    if (s.length >= 2 && s.startsWith(q) && s.endsWith(q)) {
      s = s.slice(1, -1).trim();
      break;
    }
  }
  if (s.length > 0) {
    const PAIRED_QUOTES: Array<[string, string]> = [
      ['“', '”'], // " "
      ['‘', '’'], // ' '
      ['«', '»'], // « »
      ['「', '」'], // 「 」
    ];
    for (const [open, close] of PAIRED_QUOTES) {
      if (s.startsWith(open) && s.endsWith(close) && s.length >= 2) {
        s = s.slice(1, -1).trim();
        break;
      }
    }
  }

  // Defense in depth: nếu LLM lặp lại literal `<think>…</think>` trong
  // output (M3 đôi khi làm điều này dù upstream đã strip), toàn bộ
  // output bị nghi ngờ — không nên giữ lại bất k� phần nào vì LLM có
  // thể đang echo reasoning mà không phải topic. Reject để caller
  // fallback sang heuristic title. Orphan close tag (no body) thì
  // vô hại — chỉ cần dùng phần text đã strip.
  const stripped = stripThinkTags(s);
  if (stripped.reasoning.length > 0) return '';
  s = stripped.text;

  // Strip leading bullet / number prefix: "- Title", "* Title", "1. Title"
  // Ch� strip khi match đúng định dạng (dash + space + chữ đầu viết hoa
  // hoặc số + dấu chấm + space). Không strip "Hello - World" giữa câu.
  s = s.replace(/^[-*•·]\s+/, '');
  s = s.replace(/^\d+\.\s+/, '');

  // Strip leading "Title:" nếu LLM echo lại schema.
  s = s.replace(/^title:\s*/i, '');

  // Reject meta-commentary prefixes. M3 / GPT-4 hay bắt đầu bằng
  // "The user asked about…", "User wants to know…", "A user is
  // asking…", "I need to…". Những cái này tóm tắt user chứ không
  // phải topic. Nếu match → return '' để caller fallback.
  // Test "is at least the start of the title is meta" — không loại
  // nếu meta phrase nằm giữa (ví dụ "Apple user guide" — "user" ở
  // giữa, không phải opening).
  if (META_PREFIXES_RE.test(s)) return '';

  // Strip trailing period. Đôi khi LLM thêm dù system prompt bảo không.
  // Chỉ strip 1 dấu chấm ở cuối (giữ dấu chấm giữa câu nếu có).
  s = s.replace(/[.。]\s*$/, '');

  // Reject meta-commentary AGAIN (in case the prefix regex left a
  // short residual after stripping). Cheap double-check.
  if (META_PREFIXES_RE.test(s)) return '';

  // Cap ở TITLE_MAX_LENGTH, cố gắng cắt ở word boundary.
  if (s.length > TITLE_MAX_LENGTH) {
    s = truncateAtBoundary(s, TITLE_MAX_LENGTH);
  }

  // Final meta-check after truncation (truncation might leave a
  // fragment that's no longer meta-prefixed, but rare).
  if (META_PREFIXES_RE.test(s)) return '';

  return s;
}

/**
 * Cắt string ở word boundary gần nhất TRƯỚC maxLength. Nếu không tìm
 * được space hợp lý (vd toàn tiếng Việt không space), cứng tay cắt
 * đúng maxLength. Không thêm ellipsis — caller quyết.
 */
function truncateAtBoundary(s: string, maxLen: number): string {
  // Look back từ maxLen tìm space. Khoảng cách tối đa 8 chars (chống
  // greedy: cắt sát quá thì mất nhiều nội dung).
  const LOOK_BACK = 8;
  const limit = Math.max(1, maxLen - LOOK_BACK);
  for (let i = maxLen; i > limit; i--) {
    if (s[i] === ' ' || s[i] === '\t') {
      return s.slice(0, i).trim();
    }
  }
  // Không có word boundary → cứng tay cắt
  return s.slice(0, maxLen).trim();
}

/**
 * Fallback title khi LLM fail: slice 50 chars đầu của user message.
 * Giữ behavior cũ (pre-auto-title feature) như best-effort —
 * vẫn có title để header / history list hiển thị được.
 *
 * Cùng logic với code cũ ở session-manager.ts trước khi feature này
 * được add — backward-compat cho session row pre-feature.
 */
export function fallbackTitle(userMessage: string): string {
  const trimmed = userMessage.trim();
  const slice = trimmed.slice(0, 50);
  return slice + (trimmed.length > 50 ? '...' : '');
}