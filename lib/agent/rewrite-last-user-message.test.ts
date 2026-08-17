import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { rewriteLastUserMessage } from './rewrite-last-user-message';

// Lightweight test-only message type: covers the role discriminator and a
// permissive `content` array. The helper under test does not depend on
// per-message-type metadata (api/provider/usage/...), and copying the full
// pi-agent-core shape here would force every assertion to fabricate model
// credentials. The test asserts observable behavior, not message validity.
type TestMessage =
  | { role: 'user' | 'assistant'; content: unknown[]; timestamp?: number }
  | AgentMessage;

function asAgentMessages(messages: TestMessage[]): AgentMessage[] {
  return messages as unknown as AgentMessage[];
}

// These tests cover the helper extracted from `hooks/useBackgroundAgent.ts`.
// The hook used to ship a local copy of this function in its own test file,
// which meant production changes could silently diverge from the assertions.
// Pinning the behavior here keeps the rewrite guarantees a single source of
// truth. Mirroring the regression suite that previously lived next to the
// hook — the live-bubble regression on the inner-skill-body case is the most
// important of them (see the closing-tag preservation test below).

describe('rewriteLastUserMessage', () => {
  it('keeps the prompt directive prefix and only replaces the user-typed suffix', () => {
    const text =
      '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nAlways respond in English.\n\n[END DIRECTIVE]\n\n---\n\nxin chào\n</user-request>';
    const messages = asAgentMessages([
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ]);
    const out = rewriteLastUserMessage(messages, 'xin chào');
    const newText = (out[0] as any).content[0].text;
    // Directive prefix preserved verbatim so the bubble parser can find it.
    expect(newText).toContain('[DIRECTIVE — ATTACHED PROMPT: "english"]');
    expect(newText).toContain('[END DIRECTIVE]');
    expect(newText).toContain('---');
    // BG wrapper's `\n</user-request>` close is preserved — without it
    // `extractLastUserRequest` latches onto the wrong close tag.
    expect(newText).toContain('</user-request>');
    // User-typed segment was rewritten.
    expect(newText).toContain('xin chào');
    expect(newText).not.toContain('old xin chào');
    // Suffix after the rewrite position contains the rewritten user text
    // followed by the close.
    expect(newText).toMatch(/xin chào\s*<\/user-request>$/);
  });

  it('handles multiple stacked directives (prompt + skill) — only the last user portion is replaced', () => {
    const text =
      '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nbody1\n\n[END DIRECTIVE]\n\n---\n\n' +
      '[DIRECTIVE — ATTACHED SKILL: "search" pinned="true"]\n\nbody2\n\n[END DIRECTIVE]\n\n---\n\n' +
      'xin chào\n</user-request>';
    const messages = asAgentMessages([
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ]);
    const out = rewriteLastUserMessage(messages, 'xin chào');
    const newText = (out[0] as any).content[0].text;
    // Both directives survive.
    expect(newText).toContain('[DIRECTIVE — ATTACHED PROMPT: "english"]');
    expect(newText).toContain('[DIRECTIVE — ATTACHED SKILL: "search" pinned="true"]');
    // Close preserved.
    expect(newText).toContain('</user-request>');
    expect(newText).toMatch(/xin chào\s*<\/user-request>$/);
  });

  it('falls back to the original whole-text replacement when there is no directive (slash command path)', () => {
    // Slash command `/english xin chào` resolves to the expanded prompt body
    // in `text`, with `displayText = "/english xin chào"`. No directive —
    // replace the whole text the way the function always did.
    const text = 'Please respond in English. User input: xin chào';
    const messages = asAgentMessages([
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ]);
    const out = rewriteLastUserMessage(messages, '/english xin chào');
    expect((out[0] as any).content[0].text).toBe('/english xin chào');
  });

  it('handles a directive-only message (no user text, no separator) — keeps the directive unchanged', () => {
    // User sent only a chip (no typed text). The text in the BG is just the
    // directive prefix; displayText is empty. The rewrite must NOT wipe the
    // directive — the bubble still wants to render the chip from the persisted
    // text.
    const text = '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nbody\n\n[END DIRECTIVE]';
    const messages = asAgentMessages([
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ]);
    const out = rewriteLastUserMessage(messages, '');
    const newText = (out[0] as any).content[0].text;
    expect(newText).toContain('[DIRECTIVE — ATTACHED PROMPT: "english"]');
    expect(newText).toContain('[END DIRECTIVE]');
    // Same text block returned unchanged (no allocation churn).
    expect((out[0] as any).content[0]).toBe((messages[0] as any).content[0]);
  });

  it('preserves </user-request> close when the BG wrapper carries an inner skill-body placeholder (regression)', () => {
    // Repro of the live-bubble regression. The BG wrapper contains a skill
    // body that itself uses `<user-request>...</user-request>` as a
    // placeholder. Without the close-preservation fix, the rewrite drops
    // the BG wrapper's trailing `\n</user-request>`, and the bubble's
    // `extractLastUserRequest` (FIRST `<user-request>` matched against
    // LAST `</user-request>`) ends up returning the skill body instead of
    // the rewritten user text — leaking `<reminder-instructions>`,
    // `<context>`, `<user-request>` template tags into the live bubble.
    // After the fix the rewrite keeps the close and the bubble shows just
    // the slash command (and `stripDirectives` strips the directive block).
    const skillBody =
      '<reminder-instructions>\n- Review your todos\n</reminder-instructions>\n\n' +
      '<context>\n[page context]\n</context>\n\n' +
      '<user-request>\n[placeholder from skill template]\n</user-request>';
    const directive = `[DIRECTIVE — ATTACHED SKILL: "reminder-instructions"]\n\n${skillBody}\n\n[END DIRECTIVE]`;
    const text =
      '<user-request>\n' + directive + '\n\n---\n\nxin chào\n</user-request>';
    const messages = asAgentMessages([
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ]);
    const out = rewriteLastUserMessage(messages, '/reminder-instructions');
    const newText = (out[0] as any).content[0].text;
    // The BG wrapper's close must still be present after the rewrite — this
    // is the structural guarantee the fix provides.
    expect(newText.endsWith('</user-request>')).toBe(true);
    // User-text segment was rewritten.
    expect(newText).toContain('/reminder-instructions');
    // Skill body still in the text (the directive is kept verbatim so the
    // chip parser can find it) — but the BG close is OUTSIDE the skill body.
    expect(newText).toContain('[placeholder from skill template]');
    // Cross-check via the bubble's extractLastUserRequest regex pair: with
    // the close preserved, the FIRST `<user-request>` (BG wrapper) pairs
    // with the LAST `</user-request>` (also BG wrapper), not the inner
    // skill-body close.
    const firstOpen = newText.indexOf('<user-request>');
    const lastClose = newText.lastIndexOf('</user-request>');
    expect(lastClose).toBeGreaterThan(firstOpen);
    // The substring between BG's open and the LAST close spans the
    // directive + the rewritten user text + the trailing `\n` before
    // the close. That substring, after `stripDirectives` removes the
    // directive block, must yield exactly the slash command.
    const inside = newText.slice(firstOpen + '<user-request>'.length, lastClose);
    const withoutBlocks = inside.replace(
      /\[DIRECTIVE\s+—\s+ATTACHED\s+(?:PROMPT|SKILL):\s+"[^"]*"(?:\s+pinned="true")?\][\s\S]*?\[END\s+DIRECTIVE\]/g,
      '',
    );
    const cleaned = withoutBlocks
      .split('\n')
      .filter((line: string) => !/^\s*---\s*$/.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    expect(cleaned).toBe('/reminder-instructions');
  });

  it('falls back to whole-suffix replacement when the wrapper close is missing (defensive)', () => {
    // If the BG's wrapper is somehow truncated upstream and there's no
    // `</user-request>` after the separator, the fix's defensive path runs:
    // clobber the suffix with displayText rather than leave stale body.
    const text =
      '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nold text';
    const messages = asAgentMessages([
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ]);
    const out = rewriteLastUserMessage(messages, 'new');
    const newText = (out[0] as any).content[0].text;
    expect(newText).toContain('[DIRECTIVE — ATTACHED PROMPT: "english"]');
    expect(newText).toContain('[END DIRECTIVE]');
    expect(newText.endsWith('new')).toBe(true);
  });

  it('returns the same array reference when no user message is present', () => {
    const messages = asAgentMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
    ]);
    expect(rewriteLastUserMessage(messages, 'typing')).toBe(messages);
  });

  it('does not touch non-text blocks (e.g. image attachments)', () => {
    const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
    const messages = asAgentMessages([
      { role: 'user', content: [{ type: 'text', text: 'old text' }, image], timestamp: 1 },
    ]);
    const out = rewriteLastUserMessage(messages, 'new text');
    expect((out[0] as any).content[0].text).toBe('new text');
    expect((out[0] as any).content[1]).toBe(image);
  });
});