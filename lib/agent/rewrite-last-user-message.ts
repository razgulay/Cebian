import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * Rewrite the text of the last user message in `messages`, collapsing the
 * full prompt body the BG actually sent to the LLM back down to the short
 * string the user typed in the bubble. Called every time a broadcast
 * handler replaces local state: the BG assembles the full LLM payload
 * (including `/writing`-style slash command expansions or mention
 * prompt/skill directive chains), but the bubble must show only the
 * user's original input — otherwise they'd see unrelated content in
 * their own chat history.
 *
 * Behavior (matches the older in-place copy in `useBackgroundAgent`; the
 * regression tests here lock the contract):
 * - No user messages → return the original array reference, avoiding a
 *   needless re-render.
 * - Text carries a directive (hybrid injection) → preserve the directive
 *   prefix AND the BG wrapper's trailing `\n</user-request>` close. Dropping
 *   the close makes the bubble's `extractLastUserRequest` latch onto an
 *   inner skill-body close tag, leaking `<reminder-instructions>` /
 *   `<user-request>` template tags into the live bubble (a user-reported
 *   regression). Directives come in three variants:
 *     - PROMPT (mention chip)
 *     - SKILL (mention chip)
 *     - COMMAND (slash command `/foo`) — ChatInput builds the same shape
 *       from the expanded prompt body so slash commands render as a chip
 *       above the bubble instead of an inline bolded token.
 * - Directive only, no separator (user typed nothing) → return the text
 *   block identity-equal so the bubble still renders the chip.
 * - No directive → whole-text replacement.
 */

const DIRECTIVE_OPEN_RE = /\[DIRECTIVE\s+—\s+ATTACHED\s+(?:PROMPT|SKILL|COMMAND):/;
const DIRECTIVE_USER_SEP = '\n\n---\n\n';
const USER_REQUEST_CLOSE = '</user-request>';

export function rewriteLastUserMessage(messages: AgentMessage[], displayText: string): AgentMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages;
  const m: any = messages[lastUserIdx];
  const rewritten: any[] = m.content.map((b: any) => {
    if (b?.type !== 'text') return b;
    const text: string = b.text;
    if (DIRECTIVE_OPEN_RE.test(text)) {
      // Text carries the directive. Preserve it so the bubble can parse
      // and render the chip. Replace only the user-typed segment between
      // the last `\n\n---\n\n` and the BG wrapper's `\n</user-request>`
      // close — preserving the close keeps `extractLastUserRequest` from
      // latching onto an inner skill-body close tag.
      if (text.includes(DIRECTIVE_USER_SEP)) {
        const lastSep = text.lastIndexOf(DIRECTIVE_USER_SEP);
        // Find the BG wrapper's `\n</user-request>` close AFTER the
        // separator — the inner skill-body `</user-request>` (placeholder)
        // sits inside the directive block, so searching backwards from
        // `lastSep` would latch onto the placeholder's close, not the
        // outer wrapper's.
        const closeIdx = text.indexOf(USER_REQUEST_CLOSE, lastSep);
        if (closeIdx > lastSep) {
          // User-text segment lives between the separator and the close.
          // Preserve the trailing `\n` before the close so the wrapper
          // stays well-formed.
          const beforeUser = text.slice(0, lastSep + DIRECTIVE_USER_SEP.length);
          const afterUser = text.slice(closeIdx - 1); // includes the leading '\n'
          return { ...b, text: beforeUser + displayText + afterUser };
        }
        // No close after the separator — fall back to whole-suffix
        // replacement (defensive: the BG's wrapper got truncated
        // somewhere upstream; better to clobber than to keep the old
        // expanded body).
        const prefix = text.slice(0, lastSep + DIRECTIVE_USER_SEP.length);
        return { ...b, text: prefix + displayText };
      }
      // No separator — the text IS the directive (user typed nothing).
      // Keep the directive as-is so the bubble still renders the chip.
      return b;
    }
    return { ...b, text: displayText };
  });
  const out = [...messages];
  out[lastUserIdx] = { ...m, content: rewritten };
  return out;
}