// Strip system-only XML tags that the background prompt composer / page
// context inject into user/assistant text but the user never typed
// themselves. They are not part of the conversation topic, so leaking
// them into displayed titles (sidebar list, header, delete confirm) or
// into the auto-title LLM prompt produces nonsense like
// "<reminder-instructions>" as the session's headline — a user-reported
// regression.
//
// The same helper is reused in two places, both of which used to ship
// their own near-duplicate regex (drift risk — already happened once):
//   - lib/agent/title-generation.ts: cleans user/assistant content before
//     sending to the title LLM AND sanitizes the LLM's raw output before
//     persisting. Defense in depth: model echoes are still our problem.
//   - components/layout/SidebarPanel.tsx: sanitizes the persisted title at
//     every display site (list, header, rename input, delete confirm) so
//     older sessions whose title was saved before this helper existed also
//     render clean — we don't have to migrate Dexie to fix the symptom.
//
// Tag list mirrors what entrypoints/background/agent/prompt-composer.ts
// and entrypoints/background/agent/page-context.ts emit — keep them in
// sync if a new system tag is added. Pattern tolerates whitespace inside
// the tag and is case-insensitive (defensive against casing drift).

const SYSTEM_TAG_RE =
  /<\s*(?:reminder-instructions|context|user-request|system-reminder)\s*(?:[^<>]*)?>([\s\S]*?)<\s*\/\s*(?:reminder-instructions|context|user-request|system-reminder)\s*>/gi;

/** Orphan closing tag (no matching open) — defensive cleanup. */
const SYSTEM_TAG_ORPHAN_CLOSE_RE =
  /<\s*\/\s*(?:reminder-instructions|context|user-request|system-reminder)\s*>/gi;

/** Strip system-only tags from `text`, collapsing 3+ newlines left
 *  behind and trimming outer whitespace. Plain prose passes through
 *  unchanged (idempotent + cheap; the fast-path skips even the regex
 *  walks when neither pattern can match). */
export function stripSystemTags(text: string): string {
  if (!text) return text;
  // Fast path: nothing to do if neither pattern can match.
  if (!SYSTEM_TAG_RE.test(text) && !SYSTEM_TAG_ORPHAN_CLOSE_RE.test(text)) {
    return text;
  }
  SYSTEM_TAG_RE.lastIndex = 0;
  SYSTEM_TAG_ORPHAN_CLOSE_RE.lastIndex = 0;
  return text
    .replace(SYSTEM_TAG_RE, '')
    .replace(SYSTEM_TAG_ORPHAN_CLOSE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}