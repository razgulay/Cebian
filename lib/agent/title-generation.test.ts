import { describe, it, expect } from 'vitest';
import { cleanTitle, cleanTitleInputs, fallbackTitle, TITLE_MAX_LENGTH } from '@/lib/agent/title-generation';

/**
 * `cleanTitle` is the boundary between messy LLM output and a usable
 * session title — the only place the title actually surfaces to the
 * user. Tests cover the failure modes the LLM most commonly produces:
 *
 *   - Surrounding quotes (LLM ignores "no quotes" instruction)
 *   - Leading bullet / numbered list prefix (LLM echoes its own formatting)
 *   - Trailing period (LLM ignores "no period" instruction)
 *   - Over-length output truncated at word boundary
 *   - Empty / whitespace-only returns empty string (caller falls back)
 *
 * `fallbackTitle` covers the deterministic best-effort path used when
 * LLM call fails — must be byte-identical to the pre-feature code so
 * session-store migrations stay consistent.
 */

describe('cleanTitle', () => {
  it('returns plain text unchanged', () => {
    expect(cleanTitle('Giá vàng hôm nay')).toBe('Giá vàng hôm nay');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanTitle('  Bitcoin price  ')).toBe('Bitcoin price');
  });

  it('strips straight double quotes', () => {
    expect(cleanTitle('"Bitcoin price"')).toBe('Bitcoin price');
  });

  it('strips straight single quotes', () => {
    expect(cleanTitle("'Bitcoin price'")).toBe('Bitcoin price');
  });

  it('strips curly double quotes', () => {
    expect(cleanTitle('“Bitcoin price”')).toBe('Bitcoin price');
  });

  it('strips French guillemets', () => {
    expect(cleanTitle('«Bitcoin price»')).toBe('Bitcoin price');
  });

  it('strips leading dash bullet', () => {
    expect(cleanTitle('- Bitcoin price update')).toBe('Bitcoin price update');
  });

  it('strips leading asterisk bullet', () => {
    expect(cleanTitle('* Bitcoin price update')).toBe('Bitcoin price update');
  });

  it('strips leading numbered list prefix', () => {
    expect(cleanTitle('1. Bitcoin price update')).toBe('Bitcoin price update');
  });

  it('strips leading "Title:" echo', () => {
    expect(cleanTitle('Title: Bitcoin price update')).toBe('Bitcoin price update');
    expect(cleanTitle('title: Bitcoin price update')).toBe('Bitcoin price update');
  });

  it('strips trailing period', () => {
    expect(cleanTitle('Bitcoin price update.')).toBe('Bitcoin price update');
  });

  it('strips trailing period + whitespace', () => {
    expect(cleanTitle('Bitcoin price update.   ')).toBe('Bitcoin price update');
  });

  it('caps length at TITLE_MAX_LENGTH, cutting at word boundary', () => {
    const long = 'This is a very long title that should definitely exceed the maximum allowed character limit';
    const result = cleanTitle(long);
    expect(result.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    // Should cut at a space, not mid-word.
    expect(result.endsWith(' ')).toBe(false);
  });

  it('hard-cuts when no word boundary in the look-back window', () => {
    // 50-char string with no spaces — must hard-cut at TITLE_MAX_LENGTH.
    const noSpaces = 'a'.repeat(50);
    const result = cleanTitle(noSpaces);
    expect(result.length).toBe(TITLE_MAX_LENGTH);
  });

  it('returns empty string for empty input', () => {
    expect(cleanTitle('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(cleanTitle('   \n\t  ')).toBe('');
  });

  it('preserves internal dashes (does not strip mid-sentence " - ")', () => {
    expect(cleanTitle('Hello - World update')).toBe('Hello - World update');
  });

  it('strips quotes AND trailing period combined', () => {
    expect(cleanTitle('"Bitcoin price update."')).toBe('Bitcoin price update');
  });

  it('rejects titles that describe the user (meta-commentary)', () => {
    // LLM hay echo reasoning thay vì tóm tắt topic — system prompt có
    // anti-pattern nhưng defense in depth: cleanTitle cũng phải reject.
    // Caller sẽ fallback sang fallbackTitle nếu trả ''.
    expect(cleanTitle('The user asked about Bitcoin')).toBe('');
    expect(cleanTitle('The user wants a concise conversation')).toBe('');
    expect(cleanTitle('The user is asking in Vietnamese')).toBe('');
    expect(cleanTitle('User wants to know the weather')).toBe('');
    expect(cleanTitle('A user is asking for help')).toBe('');
    expect(cleanTitle('The user asked: Bitcoin price')).toBe('');
    expect(cleanTitle('Assistant explains Bitcoin')).toBe('');
    expect(cleanTitle('AI assistant responds about weather')).toBe('');
  });

  it('keeps titles where "user" appears mid-sentence (not as opener)', () => {
    // "user" ở giữa câu là từ nội dung, không phải meta-prefix.
    expect(cleanTitle('Apple user guide')).toBe('Apple user guide');
    expect(cleanTitle('Linux user permissions')).toBe('Linux user permissions');
  });

  it('keeps topic-first titles even when they contain meta words', () => {
    expect(cleanTitle('Bitcoin price today')).toBe('Bitcoin price today');
    expect(cleanTitle('Weather forecast in HCMC')).toBe('Weather forecast in HCMC');
  });

  it('rejects think-tag leaks that survived upstream stripping', () => {
    // Defense in depth — stripThinkTags xử lý ở generateSessionTitle
    // trước khi build prompt, nhưng nếu LLM vẫn lặp lại literal
    // `<think>…</think>` (M3 đôi khi xảy ra), cleanTitle phải
    // reject thay vì pass qua. Build tag strings via concatenation
    // để harness/toolchain không interpret angle-bracket là HTML.
    const THINK_OPEN = '<' + 'think' + '>';
    const THINK_CLOSE = '<' + '/think' + '>';
    // Paired tag với reasoning content → reject (LLM đang echo reasoning
    // thay vì tóm tắt topic; không nên giữ bất kỳ phần nào).
    expect(cleanTitle(THINK_OPEN + 'The user wants X' + THINK_CLOSE + 'Bitcoin price')).toBe('');
    // Orphan close tag (no body) → strip, giữ phần text thật. Orphan
    // không mang reasoning nên text còn lại vẫn đáng tin.
    const ORPHAN = '<' + '/think' + '>';
    expect(cleanTitle(ORPHAN + 'Bitcoin price')).toBe('Bitcoin price');
  });
});

describe('fallbackTitle', () => {
  it('returns user message verbatim when under 50 chars', () => {
    expect(fallbackTitle('giá vàng hôm nay')).toBe('giá vàng hôm nay');
  });

  it('truncates at 50 chars with ellipsis when over', () => {
    const long = 'a'.repeat(60);
    expect(fallbackTitle(long)).toBe('a'.repeat(50) + '...');
  });

  it('exactly 50 chars does not add ellipsis', () => {
    const exact = 'a'.repeat(50);
    expect(fallbackTitle(exact)).toBe(exact);
  });

  it('trims whitespace before measuring', () => {
    expect(fallbackTitle('  hi  ')).toBe('hi');
  });

  it('returns empty for empty input (placeholder stays)', () => {
    // fallbackTitle on empty would yield '' — caller must gate
    // separately. Documenting the edge case so any future change
    // doesn't silently break it.
    expect(fallbackTitle('')).toBe('');
    expect(fallbackTitle('   ')).toBe('');
  });
});

describe('cleanTitleInputs', () => {
  // cleanTitleInputs is the strip pipeline run on user+assistant text
  // BEFORE the title LLM sees them. If it leaks a directive block, the
  // LLM can echo the literal prefix back into the title (the original
  // regression). Tests cover each strip stage + their combinations.
  //
  // We test this helper directly rather than mocking `complete()` from
  // pi-ai — it's a pure function, and the integration with the LLM
  // mock would mostly retest the helper anyway.

  it('passes plain text through unchanged', () => {
    expect(cleanTitleInputs('hello', 'world')).toEqual({ cleanedUser: 'hello', cleanedAssistant: 'world' });
  });

  it('strips inline DIRECTIVE blocks from user input (slash command body)', () => {
    // Slash command injects a long directive body. cleanTitleInputs should
    // peel it so the LLM sees only the words the user actually typed.
    const userText = '[DIRECTIVE — ATTACHED COMMAND: "english"]\n\nAlways respond in English.\n\n[END DIRECTIVE]\n\n---\n\ntell me a joke';
    const result = cleanTitleInputs(userText, 'Sure! Why did the chicken cross the road?');
    expect(result).not.toBeNull();
    expect(result!.cleanedUser).toBe('tell me a joke');
    expect(result!.cleanedUser).not.toContain('[DIRECTIVE');
    expect(result!.cleanedUser).not.toContain('Always respond');
  });

  it('strips pinned directive blocks (pinned="true" attr)', () => {
    const userText = '[DIRECTIVE — ATTACHED PROMPT: "eng" pinned="true"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nhi';
    const result = cleanTitleInputs(userText, 'response');
    expect(result!.cleanedUser).toBe('hi');
  });

  it('strips multiple stacked directive blocks, preserving only user text', () => {
    const userText = [
      '[DIRECTIVE — ATTACHED PROMPT: "a"]\n\nbody A\n\n[END DIRECTIVE]',
      '[DIRECTIVE — ATTACHED SKILL: "b"]\n\nbody B\n\n[END DIRECTIVE]',
      '[DIRECTIVE — ATTACHED COMMAND: "c"]\n\nbody C\n\n[END DIRECTIVE]',
      '---',
      'final user words',
    ].join('\n\n');
    const result = cleanTitleInputs(userText, 'reply');
    expect(result!.cleanedUser).toBe('final user words');
  });

  it('returns null when user side is only directive body (no user words)', () => {
    // /english alone — only directive, no extra user text. Strip yields
    // empty string → caller should NOT fire LLM (would 400 on empty).
    const userText = '[DIRECTIVE — ATTACHED COMMAND: "english"]\n\nAlways respond in English.\n\n[END DIRECTIVE]';
    expect(cleanTitleInputs(userText, 'ok')).toBeNull();
  });

  it('returns null when assistant side is empty after stripping', () => {
    expect(cleanTitleInputs('hi', '')).toBeNull();
    expect(cleanTitleInputs('hi', '<think>reasoning</think>')).toBeNull();
  });

  it('strips inline directive blocks from assistant input too (defensive)', () => {
    // Assistant normally shouldn't contain directive blocks, but if a
    // future bug causes it, we strip rather than leak.
    const assistantText = '[DIRECTIVE — ATTACHED COMMAND: "x"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nactual reply';
    expect(cleanTitleInputs('hi', assistantText)).toEqual({ cleanedUser: 'hi', cleanedAssistant: 'actual reply' });
  });

  it('strips system tags after directive strip (compound)', () => {
    // directive strip first, then system-tag strip — the latter operates on
    // what's left. Verify order is correct.
    const userText = '[DIRECTIVE — ATTACHED COMMAND: "x"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\n<context>secret context</context> actual question';
    const result = cleanTitleInputs(userText, 'reply');
    expect(result!.cleanedUser).toBe('actual question');
    expect(result!.cleanedUser).not.toContain('<context>');
  });

  it('strips think-tag content from assistant before passing on', () => {
    // MiniMax M3 hay emit `<think>The user is asking...</think>` inline;
    // strip phải peel phần reasoning để LLM không tóm tắt luôn reasoning.
    const THINK_OPEN = '<' + 'think' + '>';
    const THINK_CLOSE = '<' + '/think' + '>';
    const assistantText = THINK_OPEN + 'The user wants X' + THINK_CLOSE + 'Bitcoin price today';
    const result = cleanTitleInputs('what is bitcoin', assistantText);
    expect(result!.cleanedAssistant).toBe('Bitcoin price today');
    expect(result!.cleanedAssistant).not.toContain('The user wants');
  });

  it('strips nested XML tags inside directive body (directive-first ordering)', () => {
    // Locks in the pipeline ordering: directive envelope goes first, so
    // inner `<context>` / `<reminder-instructions>` that some prompts
    // intentionally inject don't get partially peeled by `stripSystemTags`.
    // Build tag strings via concatenation so harness/toolchain doesn't
    // interpret angle-brackets as HTML.
    const CTX_OPEN = '<' + 'context' + '>';
    const CTX_CLOSE = '<' + '/context' + '>';
    const userText =
      `[DIRECTIVE — ATTACHED COMMAND: "x"]\n\n` +
      `before ${CTX_OPEN}secret${CTX_CLOSE} after\n\n` +
      `[END DIRECTIVE]\n\n---\n\nreal question`;
    const result = cleanTitleInputs(userText, 'reply');
    expect(result!.cleanedUser).toBe('real question');
    expect(result!.cleanedUser).not.toContain('secret');
  });

  it('is idempotent: cleaning already-cleaned input produces the same result', () => {
    const userText = '[DIRECTIVE — ATTACHED COMMAND: "x"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nreal q';
    const asstText = 'Bitcoin price today';
    const once = cleanTitleInputs(userText, asstText);
    expect(once).not.toBeNull();
    const twice = cleanTitleInputs(once!.cleanedUser, once!.cleanedAssistant);
    expect(twice).toEqual(once);
  });

  it('strips multiple think-tag pairs from assistant (stripThinkTags handles N pairs)', () => {
    const THINK_OPEN = '<' + 'think' + '>';
    const THINK_CLOSE = '<' + '/think' + '>';
    const assistantText =
      THINK_OPEN + 'first reasoning' + THINK_CLOSE + ' middle ' +
      THINK_OPEN + 'second reasoning' + THINK_CLOSE + 'final answer';
    const result = cleanTitleInputs('q', assistantText);
    expect(result!.cleanedAssistant).toBe('middle final answer');
    expect(result!.cleanedAssistant).not.toContain('reasoning');
  });

  it('delegates pinned-attr behavior to stripDirectives (only pinned="true" triggers strip)', () => {
    // `INLINE_DIRECTIVE_BLOCK_RE` requires the literal string
    // `pinned="true"` to recognize the optional attribute group — any
    // other value (`pinned="false"`, `pinned="yes"`, missing attr, …)
    // makes the regex not match the open line and the block is left
    // intact. That's the behavior of the underlying helper; this
    // surface just delegates. Lock it in here so a future `stripDirectives`
    // change is caught by the unit tests for that helper, not here.
    const pinnedTrue =
      '[DIRECTIVE — ATTACHED PROMPT: "p" pinned="true"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nstripped';
    expect(cleanTitleInputs(pinnedTrue, 'reply')!.cleanedUser).toBe('stripped');

    const pinnedFalse =
      '[DIRECTIVE — ATTACHED PROMPT: "p" pinned="false"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nleft alone';
    // `pinned="false"` makes the regex skip (only `pinned="true"`
    // matches), so the directive body passes through. `stripDirectives`
    // does still collapse the `---` separator unconditionally (it's not
    // gated on having found a directive), so the post-call output drops
    // only that separator — the OPEN header + body + close + leftover
    // text flow through.
    const r = cleanTitleInputs(pinnedFalse, 'reply');
    expect(r).not.toBeNull();
    expect(r!.cleanedUser).not.toContain('---');
    expect(r!.cleanedUser).toContain('left alone');
    expect(r!.cleanedUser).toContain('[DIRECTIVE');
  });

  it('returns null for fully empty input (post-guard contract)', () => {
    // The early-return guard in `generateSessionTitle` (line 118) catches
    // this before reaching the LLM, but `cleanTitleInputs` is exported and
    // future callers may bypass the guard. Document the contract here.
    expect(cleanTitleInputs('', '')).toBeNull();
    expect(cleanTitleInputs('   ', '   ')).toBeNull();
    expect(cleanTitleInputs('hi', '   ')).toBeNull();
    expect(cleanTitleInputs('   ', 'hi')).toBeNull();
  });
});