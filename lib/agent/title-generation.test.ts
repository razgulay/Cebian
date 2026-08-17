import { describe, it, expect } from 'vitest';
import { cleanTitle, fallbackTitle, TITLE_MAX_LENGTH } from '@/lib/agent/title-generation';

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