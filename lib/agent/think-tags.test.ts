import { describe, it, expect } from 'vitest';
import { stripThinkTags } from './think-tags';

/**
 * `stripThinkTags` is the boundary between LLM-emitted reasoning wrapped in
 * raw tags and a usable chat bubble. Tag format is deterministic (LLM emits
 * the exact same tag shape every time), so the tests cover format variants
 * and edge cases — not heuristic matching.
 *
 *   - Standard tag — must collect reasoning + strip tags from text
 *   - Multiple tags in same text — must strip ALL, collect each reasoning
 *   - Whitespace inside tag — must strip
 *   - Case-insensitive tag — must strip
 *   - Empty reasoning inside tag — must drop empty entry from reasoning array
 *   - Only tags (no answer) — must return empty text + reasoning array
 *   - No tag at all — must return text unchanged + empty reasoning
 *   - Tag literal inside answer text (after first strip) — must not be matched
 *
 * Helper: build tag strings via concatenation so the harness/toolchain
 * doesn't interpret angle-bracket content as HTML.
 */
const THINK_OPEN = '<' + 'mm:think' + '>';
const THINK_CLOSE = '<' + '/' + 'mm:think' + '>';
// Same tag without `mm:` prefix — LLM has emitted both forms depending
// on session/prompt. Parser must handle either shape.
const PLAIN_THINK_OPEN = '<' + 'think' + '>';
const PLAIN_THINK_CLOSE = '<' + '/think' + '>';

describe('stripThinkTags', () => {
  describe('positive cases', () => {
    it('strips standard think tag and collects reasoning', () => {
      const text = THINK_OPEN + 'Let me think about this.' + THINK_CLOSE + '\n\nThe answer is 42.';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['Let me think about this.']);
      expect(result.text).toBe('The answer is 42.');
    });

    it('preserves multi-paragraph reasoning inside tag', () => {
      const reasoning = 'First paragraph.\n\nSecond paragraph with **bold**.\n\n- bullet 1\n- bullet 2';
      const text = THINK_OPEN + reasoning + THINK_CLOSE + '\nFinal answer.';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual([reasoning]);
      expect(result.text).toBe('Final answer.');
    });

    it('strips tag with whitespace inside (defensive)', () => {
      const open = '<' + 'mm:think ' + '>';
      const close = '<' + '/ mm:think>';
      const text = open + 'reasoning here' + close + 'answer';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['reasoning here']);
      expect(result.text).toBe('answer');
    });

    it('handles case-insensitive tag (MM:THINK)', () => {
      const open = '<' + 'MM:THINK>';
      const close = '<' + '/MM:THINK>';
      const text = open + 'reasoning' + close + 'answer';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['reasoning']);
      expect(result.text).toBe('answer');
    });

    it('handles plain `think` tag (no `mm:` prefix)', () => {
      // LLM has been observed to emit BOTH `<think>...</think>`
      // and `<think>...</think>`. Parser must accept either.
      const text = PLAIN_THINK_OPEN + 'reasoning' + PLAIN_THINK_CLOSE + 'answer';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['reasoning']);
      expect(result.text).toBe('answer');
    });

    it('handles mixed mm:think and think tags in same text', () => {
      const text =
        THINK_OPEN + 'first reasoning' + THINK_CLOSE +
        'middle' +
        PLAIN_THINK_OPEN + 'second reasoning' + PLAIN_THINK_CLOSE;
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['first reasoning', 'second reasoning']);
      expect(result.text).toBe('middle');
    });

    it('strips leading whitespace + newlines from cleaned text', () => {
      const text = THINK_OPEN + 'reasoning' + THINK_CLOSE + '\n\n\n   \nReal answer.';
      const result = stripThinkTags(text);
      expect(result.text).toBe('Real answer.');
    });

    it('handles MULTIPLE tags in same text — strips all, collects each', () => {
      // Real-world shape: LLM emits reasoning before tool call, then again
      // after tool result. Both should become separate ThinkingBlocks, and
      // the middle "content between" stays in body.
      const text =
        THINK_OPEN + 'reasoning 1' + THINK_CLOSE +
        '\n\nsearch result here\n\n' +
        THINK_OPEN + 'reasoning 2' + THINK_CLOSE +
        '\n\nfinal answer';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['reasoning 1', 'reasoning 2']);
      expect(result.text).toBe('search result here\n\nfinal answer');
    });

    it('returns empty text when text only contains tag (no answer)', () => {
      const text = THINK_OPEN + 'just reasoning, no reply' + THINK_CLOSE;
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['just reasoning, no reply']);
      expect(result.text).toBe('');
    });

    it('drops empty / whitespace-only reasoning entries from array', () => {
      // Two tags: first has content, second is whitespace-only. Reasoning
      // array drops the empty entry; cleaned text concatenates the
      // fragments between tags (whitespace inside the empty tag is also
      // stripped, so 'middle' and 'tail' run together).
      const text =
        THINK_OPEN + 'reasoning 1' + THINK_CLOSE +
        'middle' +
        THINK_OPEN + '   ' + THINK_CLOSE +
        'tail';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['reasoning 1']);
      expect(result.text).toBe('middletail');
    });
  });

  describe('negative cases (no tags present)', () => {
    it('returns text unchanged when no tag present', () => {
      const text = 'Just a normal answer with no tags.';
      const result = stripThinkTags(text);
      expect(result.text).toBe(text);
      expect(result.reasoning).toEqual([]);
    });

    it('returns text unchanged for empty input', () => {
      const result = stripThinkTags('');
      expect(result.text).toBe('');
      expect(result.reasoning).toEqual([]);
    });

    it('returns text unchanged for whitespace-only input', () => {
      const text = '   \n\n  ';
      const result = stripThinkTags(text);
      expect(result.text).toBe(text);
      expect(result.reasoning).toEqual([]);
    });

    it('handles only opening tag (no closing) — streaming mid-flight', () => {
      // Behavior changed with regex update: previously this returned text
      // unchanged, but that left raw `<think>` in the body during streaming.
      // Now we extract whatever body has been streamed so far into reasoning
      // and drop the open tag, so the bubble never shows a raw tag literal.
      const text = THINK_OPEN + 'partial reasoning without close yet';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['partial reasoning without close yet']);
      expect(result.text).toBe('');
    });

    it('STRIPS unclosed open tag during streaming — body goes to reasoning, open tag removed from text', () => {
      // Real streaming scenario: LLM has emitted open tag + partial body
      // but no close yet. Previous behavior left raw `<think>` + body in
      // the bubble text; now the open tag + body are extracted into
      // reasoning, and `text` is whatever came before the open tag.
      const text = THINK_OPEN + 'partial reasoning streaming in';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['partial reasoning streaming in']);
      expect(result.text).toBe('');
    });

    it('preserves text before unclosed open tag', () => {
      const text = 'Some preamble. ' + THINK_OPEN + 'reasoning still streaming';
      const result = stripThinkTags(text);
      expect(result.reasoning).toEqual(['reasoning still streaming']);
      expect(result.text).toBe('Some preamble.');
    });

    it('returns empty reasoning when tag is empty (no reasoning content)', () => {
      const text = THINK_OPEN + THINK_CLOSE + 'answer';
      const result = stripThinkTags(text);
      // Empty tag stripped, but reasoning array stays empty (caller won't
      // render an empty ThinkingBlock).
      expect(result.reasoning).toEqual([]);
      expect(result.text).toBe('answer');
    });
  });

  describe('idempotency', () => {
    it('does not double-strip — running on cleaned text returns same', () => {
      const first = stripThinkTags(THINK_OPEN + 'thinking' + THINK_CLOSE + 'answer');
      expect(first.text).toBe('answer');
      expect(first.reasoning).toEqual(['thinking']);
      const second = stripThinkTags(first.text);
      expect(second.text).toBe('answer');
      expect(second.reasoning).toEqual([]);
    });
  });

  describe('orphan closing tags', () => {
    // LLM đôi khi emit close tag đứng một mình như dấu kết thúc segment
    // — regex chính đòi open tag nên không bắt, secondary pass phải dọn
    // để literal không lọt vào body. Build close strings via
    // concatenation để harness/toolchain không interpret `<...>`.
    const ORPHAN_CLOSE = '<' + '/think>';

    it('strips orphan close tag literal with no preceding open tag', () => {
      const text = 'preamble' + ORPHAN_CLOSE + 'rest of answer';
      const result = stripThinkTags(text);
      expect(result.text).toBe('preamblerest of answer');
      expect(result.reasoning).toEqual([]);
    });

    it('strips orphan `[/mm:think]` literal', () => {
      const text = THINK_CLOSE + 'answer';
      const result = stripThinkTags(text);
      expect(result.text).toBe('answer');
      expect(result.reasoning).toEqual([]);
    });

    it('strips orphan close tagged with whitespace + case-insensitive', () => {
      const variants = [
        '<' + '  /  think  >answer',
        '<' + ' /Think >answer',
        '<' + ' /MM:THINK >answer',
      ];
      for (const close of variants) {
        const result = stripThinkTags(close);
        expect(result.text).toBe('answer');
        expect(result.reasoning).toEqual([]);
      }
    });

    it('strips orphan close after stripping a matched pair', () => {
      // LLM có thể emit cặp tag đầy đủ + một orphan close thừa ở cuối.
      // Cả hai phải được dọn sạch.
      const text = THINK_OPEN + 'reasoning' + THINK_CLOSE + 'answer' + THINK_CLOSE;
      const result = stripThinkTags(text);
      expect(result.text).toBe('answer');
      expect(result.reasoning).toEqual(['reasoning']);
    });

    it('strips orphan close between paired tags (does not affect paired collection)', () => {
      const text =
        THINK_OPEN + 'r1' + THINK_CLOSE +
        'middle' + ORPHAN_CLOSE +
        THINK_OPEN + 'r2' + THINK_CLOSE;
      const result = stripThinkTags(text);
      expect(result.text).toBe('middle');
      expect(result.reasoning).toEqual(['r1', 'r2']);
    });
  });
});