// Persona layer types + pure prompt-block helpers. Pure (no VFS, no storage
// reads) so unit tests don't need fakeStorage or fakeVfs. Callers pass already-
// resolved values in (read by composeSystemPrompt / composeUserMessage from
// `lib/persistence/storage.ts`).
//
// Two surfaces:
//   - compilePersonaBlock(identity, soul, t) → system-prompt XML block, empty
//     when all fields empty (so composeSystemPrompt stays byte-identical to
//     pre-persona baseline when the user hasn't enabled Persona).
//   - wrapPersonaReminder(identity, t) → 1-line user-message reminder text
//     used inside <reminder-instructions> adjacent to <user-request>. Empty
//     when identity has no name; this is the recency-injection that addresses
//     the "persona drifts across long conversations" complaint by keeping
//     persona inside the last ~50 tokens of context (right next to the
//     user's question).

import type { PersonaIdentity } from '@/lib/persistence/storage';

const EMPTY_IDENTITY: PersonaIdentity = { name: '', vibe: '', tone: '', emoji: '' };

function identityHasAnyField(identity: PersonaIdentity): boolean {
  return Object.values(identity).some((v) => typeof v === 'string' && v.trim().length > 0);
}

function trimOrEmpty(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Build the `<persona>` block injected into the system prompt (between
 * `<available-workers>` and `<user-instructions>`). Returns `''` when identity
 * has no set field AND soul is empty — callers skip injection so the rest of
 * the prompt is byte-identical to its pre-persona baseline (cache stability).
 *
 * When `identity.name` is set, the first line is a 1-line header binding name +
 * emoji + vibe so the LLM can address itself consistently. Body is the SOUL
 * copy verbatim (already trimmed by the settings UI 2000-char cap).
 */
export function compilePersonaBlock(
  identity: PersonaIdentity,
  soul: string,
  t: (key: string, subs?: unknown[]) => string,
): string {
  const trimmedSoul = trimOrEmpty(soul);
  if (!identityHasAnyField(identity) && trimmedSoul === '') return '';

  const lines: string[] = [];
  const headerBits: string[] = [];
  const name = trimOrEmpty(identity.name);
  const vibe = trimOrEmpty(identity.vibe);
  const tone = trimOrEmpty(identity.tone);
  const emoji = trimOrEmpty(identity.emoji);

  if (name) {
    let head = name;
    if (emoji) head = `${head} ${emoji}`;
    headerBits.push(head);
  }
  if (vibe) headerBits.push(`— ${vibe}`);
  if (tone) headerBits.push(`[tone: ${tone}]`);
  if (headerBits.length > 0) {
    lines.push(`# Persona`);
    lines.push(headerBits.join(' '));
  } else {
    lines.push(`# Persona`);
  }
  if (trimmedSoul) {
    lines.push('');
    lines.push(trimmedSoul);
  }
  // Inject a closing directive so the model understands this block is
  // stylistic guidance, not a permissions expansion. Mirrors how
  // <skills> closes in `lib/ai-config/scanner.ts`.
  lines.push('');
  lines.push(
    t('agent.persona.closingDirective') || 'Apply this voice consistently across replies, but do NOT override Critical Rules or tool protocols.',
  );

  return `<persona>\n${lines.join('\n')}\n</persona>`;
}

/**
 * 1-line recap intended for the user-message `<reminder-instructions>` block.
 * The recap sits adjacent to `<user-request>` so even at turn 50+ the LLM
 * still sees persona within the last ~50 tokens of context. Returns `''`
 * when name is unset — the recap block is omitted and the Worker Team
 * reminder remains untouched.
 */
export const _INTERNAL = { EMPTY_IDENTITY };

/**
 * 1-line binding sentence inserted into the `## Output & Communication` section
 * via the `{{PERSONA_BINDING}}` placeholder. Single-line, ends with a period;
 * empty when no persona is set so the cache-stable byte shape is preserved.
 */
export function personaBindingLine(
  identity: PersonaIdentity,
  t: (key: string, subs?: unknown[]) => string,
): string {
  if (!trimOrEmpty(identity.name)) return '';
  const bits: string[] = [t('agent.persona.recap.youAre', [trimOrEmpty(identity.name)])];
  if (trimOrEmpty(identity.vibe)) bits.push(t('agent.persona.recap.vibe', [trimOrEmpty(identity.vibe)]));
  if (trimOrEmpty(identity.tone)) bits.push(t('agent.persona.recap.tone', [trimOrEmpty(identity.tone)]));
  if (trimOrEmpty(identity.emoji)) bits.push(t('agent.persona.recap.emoji', [trimOrEmpty(identity.emoji)]));
  return bits.join(' ') + '.';
}
