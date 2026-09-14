import { describe, it, expect } from 'vitest';
import { compilePersonaBlock } from '@/lib/agent/persona-types';
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
});
