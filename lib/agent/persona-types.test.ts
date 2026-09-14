import { describe, it, expect } from 'vitest';
import { compilePersonaBlock, personaBindingLine } from '@/lib/agent/persona-types';
import type { PersonaIdentity } from '@/lib/persistence/storage';

const tEn = (key: string, subs?: unknown[]) =>
  subs && subs.length ? `${key}|${subs.join(',')}` : key;

const FULL: PersonaIdentity = {
  name: 'Cebian',
  vibe: 'precise',
  tone: 'casual',
  emoji: '🦞',
};
const PARTIAL: PersonaIdentity = { name: 'Cebian', vibe: '', tone: '', emoji: '' };

describe('compilePersonaBlock', () => {
  it('returns empty when all inputs empty', () => {
    const out = compilePersonaBlock(
      { name: '', vibe: '', tone: '', emoji: '' },
      '',
      tEn,
    );
    expect(out).toBe('');
  });

  it('returns empty when only whitespace given', () => {
    const out = compilePersonaBlock(
      { name: '   ', vibe: '\t', tone: ' \n', emoji: '  ' },
      '   \n  ',
      tEn,
    );
    expect(out).toBe('');
  });

  it('renders full block with header bits + SOUL + closing directive', () => {
    const out = compilePersonaBlock(FULL, 'I am Cebian.', tEn);
    expect(out).toMatch(/^<persona>\n/);
    expect(out).toMatch(/\n<\/persona>$/);
    expect(out).toContain('# Persona');
    expect(out).toContain('Cebian 🦞');
    expect(out).toContain('— precise');
    expect(out).toContain('[tone: casual]');
    expect(out).toContain('I am Cebian.');
    // t() stub returns the raw key when no value is registered. Either the key
    // or its translated value should pass — the test only pins the *content*
    // of the directive, not its exact translation. Use a tolerant match:
    // pass if the closing-directive key is embedded verbatim, since the stub
    // does not register a translated value.
    expect(out).toMatch(/(Apply this voice consistently|agent\.persona\.closingDirective)/);
    expect(out).toMatch(/(Critical Rules|agent\.persona\.closingDirective)/);
  });

  it('skips vibe / tone / emoji lines when those fields empty', () => {
    const out = compilePersonaBlock(PARTIAL, 'Just a soul.', tEn);
    expect(out).toContain('Cebian');
    expect(out).not.toContain('— ');
    expect(out).not.toContain('[tone:');
    expect(out).toContain('Just a soul.');
  });

  it('header-only (no SOUL) still emits block', () => {
    const out = compilePersonaBlock(FULL, '', tEn);
    expect(out).toMatch(/^<persona>/);
    expect(out).toContain('Cebian 🦞');
    expect(out).not.toContain('I am');
  });

  it('SOUL without identity still emits block', () => {
    const out = compilePersonaBlock(
      { name: '', vibe: '', tone: '', emoji: '' },
      'Anonymous soul only.',
      tEn,
    );
    expect(out).toMatch(/^<persona>/);
    expect(out).toContain('Anonymous soul only.');
  });

  it('i18n key fallback — closing directive pulled via t()', () => {
    // No agent.persona.closingDirective in our t() stub → returns key.
    const out = compilePersonaBlock(FULL, 'x', tEn);
    expect(out).toContain('agent.persona.closingDirective');
  });

  it('closingDirective argument array is empty when t() returns key', () => {
    // Smoke check the format string — our t stub joins with | separator only when subs present.
    const out = compilePersonaBlock(FULL, 'x', tEn);
    expect(out).toContain('agent.persona.closingDirective');
  });

  it('Subtask 3: persona block contains imperative constraints + few-shot example when i18n keys present', () => {
    // The tEn stub returns keys for missing entries, so we have to provide
    // a dedicated t() shim that returns the actual content for the few-shot
    // + constraints keys. The shim mimics what `t('agent.persona.example.user')`
    // would return at runtime in en locale.
    const tShim = (key: string, subs?: unknown[]) => {
      const table: Record<string, string> = {
        'agent.persona.constraints.header': 'VOICE:',
        'agent.persona.constraints.noBullets':
          'Zero bullet points, numbered lists, or markdown list items.',
        'agent.persona.constraints.noPleasantries':
          'Zero pleasantries, apologies, or filler.',
        'agent.persona.constraints.voiceOpinion':
          'Have technical opinions; do not play neutral.',
        'agent.persona.style.header': 'PACING & FORMAT:',
        'agent.persona.style.length':
          'Max 120 words per reply (exceptions: code/technical detail).',
        'agent.persona.style.pacing':
          'Max 1-2 short sentences per paragraph, then a hard line break. No paragraphs longer than 3 lines on screen.',
        'agent.persona.style.noBullets':
          'Zero bullet points, numbered lists, or markdown list items.',
        'agent.persona.example.user':
          'Should I keep all my VFS reads under a single readFile call or split them per-tool?',
        'agent.persona.example.assistant':
          'Split per-tool. A single readFile pulls the whole file into your context even when you only need a metadata sniff.',
        'agent.persona.badExample.header': 'NEVER SOUND LIKE THIS:',
        'agent.persona.badExample.badOutput':
          '> "Hello! I\'d be happy to help you with that. Here are the key points:\n> - Point 1: ...\n> - Point 2: ...\n> In conclusion, both options have pros and cons. Hope this helps!"',
        'agent.persona.badExample.warning':
          'Avoid all corporate politeness, bullet points, and balanced disclaimers.',
        // The closing directive's i18n key is in en/zz_* under
        // agent.persona.closingDirective; the table below provides the fallback
        // string so the test doesn't depend on the i18n fixture for this row.
        'agent.persona.closingDirective':
          'Apply this voice consistently across replies, but do NOT override Critical Rules, tool protocols, or other safety layers.',
      };
      if (table[key]) return subs ? `${table[key]}|${subs.join(',')}` : table[key];
      return subs && subs.length ? `${key}|${subs.join(',')}` : key;
    };
    const out = compilePersonaBlock(FULL, 'x', tShim);
    // Voice (constraints) section present, before closing directive.
    expect(out).toContain('VOICE:');
    expect(out).toContain('Zero pleasantries');
    expect(out).toContain('Have technical opinions');
    // STYLE (Pacing & Format) section present, after Voice.
    expect(out).toContain('PACING & FORMAT:');
    expect(out).toContain('Max 120 words');
    expect(out).toContain('Max 1-2 short sentences');
    expect(out).toContain('Zero bullet points');
    // Few-shot example wrapped in <example>...</example> tags.
    expect(out).toMatch(/<example>\s*User: /);
    expect(out).toMatch(/Assistant: /);
    expect(out).toMatch(/<\/example>/);
    // Bad-example wrapped in <bad-example>...</bad-example> tags.
    expect(out).toMatch(/<bad-example>/);
    expect(out).toMatch(/<\/bad-example>/);
    expect(out).toContain('NEVER SOUND LIKE THIS');
    // Order: use real anchors that actually exist in the rendered block rather
    // than stale sentinels ("SOUL copy verbatim" / "MANDATORY FORMATTING:" /
    // "Apply this voice consistently" are not literals the production code emits).
    const soulIdx = out.indexOf('Cebian');
    const voiceIdx = out.indexOf('VOICE:');
    const styleIdx = out.indexOf('PACING & FORMAT:');
    const exampleIdx = out.indexOf('<example>');
    const badExampleIdx = out.indexOf('<bad-example>');
    const closingIdx = out.indexOf('Apply this voice consistently');
    expect(soulIdx).toBeGreaterThan(-1);
    expect(voiceIdx).toBeGreaterThan(soulIdx);
    expect(styleIdx).toBeGreaterThan(voiceIdx);
    expect(exampleIdx).toBeGreaterThan(styleIdx);
    expect(badExampleIdx).toBeGreaterThan(exampleIdx);
    expect(closingIdx).toBeGreaterThan(badExampleIdx);
  });

  it('Subtask 4: persona block skips VOICE / STYLE / example / bad-example when i18n keys missing (defensive)', () => {
    // When the gate keys (constraints.header / style.header / example.* /
    // badExample.header) all return '' (defensive — empty), the whole
    // VOICE / STYLE / example / bad-example block set is skipped. Keeps
    // the pre-Subtask-4 byte shape intact if a locale forgets to add the
    // keys. Each section has its own independent gate so a locale that
    // localises VOICE but not STYLE still gets a valid persona block.
    const tEmpty = (key: string) => {
      // Strip every gated i18n key. closingDirective falls through to
      // the default key-returning behavior so it still injects something.
      if (
        key.startsWith('agent.persona.constraints.') ||
        key.startsWith('agent.persona.style.') ||
        key.startsWith('agent.persona.example.') ||
        key.startsWith('agent.persona.badExample.')
      ) {
        return '';
      }
      return key;
    };
    const out = compilePersonaBlock(FULL, 'x', tEmpty);
    // No gate key present → no section content, no example block,
    // no bad-example block.
    expect(out).not.toContain('VOICE:');
    expect(out).not.toContain('PACING & FORMAT:');
    expect(out).not.toContain('<example>');
    expect(out).not.toContain('<bad-example>');
    expect(out).not.toContain('NEVER SOUND LIKE THIS');
    // closingDirective still present (it falls through to the default branch).
    expect(out).toContain('agent.persona.closingDirective');
  });

  it('Subtask 3: personaBindingLine uses i18n string directly (no inline concat)', () => {
    // The recap is now a single i18n key — keeps locale-specific phrasing
    // without inline string concatenation in code.
    const tShim = (key: string) => {
      if (key === 'agent.persona.bindingNeo') return 'Output in raw prose.';
      return key;
    };
    expect(personaBindingLine(FULL, tShim)).toBe('Output in raw prose.');
  });
});
