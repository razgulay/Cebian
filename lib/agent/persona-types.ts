// Persona layer types + pure prompt-block helpers. Pure (no VFS, no storage
// reads) so unit tests don't need fakeStorage or fakeVfs. Callers pass already-
// resolved values in (read by composeSystemPrompt / composeUserMessage from
// `lib/persistence/storage.ts`).
//
// Three surfaces:
//   - compilePersonaBlock(identity, soul, t) → system-prompt XML block. The
//     block contains: 1-line identity header → SOUL copy verbatim → imperative
//     constraints section → 1 few-shot example (Q&A in raw prose, no bullet
//     points) → closing directive. Empty when all fields empty (cache-stable
//     pre-persona baseline preserved).
//   - personaBindingLine(identity, t) → 1-line cross-link sentence inserted
//     into the `## Output & Communication` section via the `{{PERSONA_BINDING}}`
//     placeholder. Tells the LLM "above is who you are"; imperative rules
//     live in the system-prompt block, not here.
//   - wrapPersonaReminder(identity) → 1-line raw-prose directive used in the
//     user-message `<reminder-instructions>` block (recency injection). Empty
//     when name is unset.

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
 * Block layout (each section separated by a blank line):
 *   1. Identity header — 1-line "Name 🦞 — vibe [tone: x]"
 *   2. SOUL copy verbatim (trimmed by the settings UI 2000-char cap)
 *   3. **MANDATORY FORMATTING** — imperative constraints (no bullet /
 *      numbered list, no pleasantries, technical opinion). These rules + a
 *      1-pair few-shot Q&A example shift the LLM's prior away from
 *      `\n- ` bullet emission without any runtime cost.
 *   4. Few-shot example — 1 user/assistant pair in raw prose, domain =
 *      web extension / browser runtime. The example text is i18n-keyed so
 *      each locale loads its own example (avoids trilingual pollution).
 *   5. Closing directive — explicit "do NOT override Critical Rules".
 *
 * The `t()` function is the standard i18n resolver; few-shot example keys
 * (`agent.persona.example.user/assistant`) resolve to the active locale's
 * strings, so we never inject 3-language examples into a single prompt.
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

  // Imperative constraints + few-shot example — these are what actually shift
  // the LLM's prior away from bullet emission. The example text is i18n-keyed
  // so each locale gets a single-language anchor (no trilingual pollution).
  // Skip each section when the i18n keys have not been localized yet
  // (the t() shim returns the key string itself, which is not a usable
  // directive). This keeps the pre-Subtask-3 block shape intact if a locale
  // forgets to add the keys — a fresh test against a non-localized locale
  // sees the exact pre-Subtask-3 byte shape.
  //
  // CRITICAL: rule lines use PLAIN PROSE (no `- ` dash prefix) so the
  // constraint itself does not prime the LLM to emit bullets. A rule
  // written as "- Zero bullet points..." would defeat its own purpose
  // by activating the LLM's bullet-emission prior. Same defensive logic
  // applies to the bad-example block: never lead the bad text with `- `.
  const voiceHeader = t('agent.persona.constraints.header');
  const voiceLocalized =
    voiceHeader && voiceHeader !== 'agent.persona.constraints.header';
  if (voiceLocalized) {
    lines.push('');
    lines.push(voiceHeader);
    const noPleasantries = t('agent.persona.constraints.noPleasantries');
    if (noPleasantries && noPleasantries !== 'agent.persona.constraints.noPleasantries') {
      lines.push(noPleasantries);
    }
    const voiceOpinion = t('agent.persona.constraints.voiceOpinion');
    if (voiceOpinion && voiceOpinion !== 'agent.persona.constraints.voiceOpinion') {
      lines.push(voiceOpinion);
    }
  }

  // STYLE — separated from VOICE so the LLM parses them as distinct
  // semantic layers. The header is the section name only; rule lines
  // remain plain prose (no dash). If the locale has not yet localized
  // `style.*`, the whole section is skipped and the persona block
  // falls back to the pre-Subtask-4 byte shape (no STYLE gate at all).
  const styleHeader = t('agent.persona.style.header');
  const styleLocalized =
    styleHeader && styleHeader !== 'agent.persona.style.header';
  if (styleLocalized) {
    lines.push('');
    lines.push(styleHeader);
    const styleLength = t('agent.persona.style.length');
    if (styleLength && styleLength !== 'agent.persona.style.length') {
      lines.push(styleLength);
    }
    const stylePacing = t('agent.persona.style.pacing');
    if (stylePacing && stylePacing !== 'agent.persona.style.pacing') {
      lines.push(stylePacing);
    }
    const styleNoBullets = t('agent.persona.style.noBullets');
    if (styleNoBullets && styleNoBullets !== 'agent.persona.style.noBullets') {
      lines.push(styleNoBullets);
    }
  }

  const exampleUser = t('agent.persona.example.user');
  const exampleAssistant = t('agent.persona.example.assistant');
  // Defensive: empty string is NOT a valid gate, because `'' !== key` would
  // be true and a tag block with empty user/assistant lines would render.
  // Match the same `value && value !== key` pattern used by VOICE / STYLE /
  // bad-example gates above.
  const exampleLocalized =
    exampleUser &&
    exampleAssistant &&
    exampleUser !== 'agent.persona.example.user' &&
    exampleAssistant !== 'agent.persona.example.assistant';
  if (exampleLocalized) {
    lines.push('');
    lines.push('<example>');
    lines.push(`User: ${exampleUser}`);
    lines.push(`Assistant: ${exampleAssistant}`);
    lines.push('</example>');
  }

  // BAD-EXAMPLE — contrastive calibration. The header is a section
  // sentinel; if a locale has not localized `badExample.header`, the
  // whole block is skipped. Wrapped in <bad-example>...</bad-example> tags
  // (mirroring the <example> wrapper for the good example above) so the
  // LLM can pattern-match on the tag boundary when parsing the persona
  // block. The bad text intentionally includes the classic LLM failure
  // modes (greeting + bullet list + balanced disclaimer + "Hope this helps")
  // so the LLM can learn to suppress them.
  const badExampleHeader = t('agent.persona.badExample.header');
  const badExampleLocalized =
    badExampleHeader && badExampleHeader !== 'agent.persona.badExample.header';
  if (badExampleLocalized) {
    lines.push('');
    lines.push('<bad-example>');
    lines.push(badExampleHeader);
    const badOutput = t('agent.persona.badExample.badOutput');
    if (badOutput && badOutput !== 'agent.persona.badExample.badOutput') {
      // The bad output is already a multi-line blockquote in the i18n
      // string. Just push verbatim — no extra formatting, otherwise we
      // would be cleaning the very pattern we want the LLM to recognize.
      lines.push(badOutput);
    }
    const badWarning = t('agent.persona.badExample.warning');
    if (badWarning && badWarning !== 'agent.persona.badExample.warning') {
      lines.push(badWarning);
    }
    lines.push('</bad-example>');
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
 * 1-line cross-link sentence inserted into the `## Output & Communication` section
 * via the `{{PERSONA_BINDING}}` placeholder. Tells the LLM "above is who you
 * are"; the imperative formatting rules live in the system-prompt `<persona>`
 * block (compilePersonaBlock), not here, to keep this line cheap. Empty when
 * name is unset so the cache-stable byte shape is preserved.
 */
export function personaBindingLine(
  identity: PersonaIdentity,
  t: (key: string, subs?: unknown[]) => string,
): string {
  const name = trimOrEmpty(identity.name);
  if (!name) return '';
  // Delegate the actual prose to a single i18n string so the binding stays
  // stable + locale-specific without inline concatenation.
  return t('agent.persona.bindingNeo');
}
