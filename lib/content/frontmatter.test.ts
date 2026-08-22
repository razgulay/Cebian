import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  it('round-trips a simple frontmatter + body', () => {
    expect(parseFrontmatter('---\ntitle: Hello\n---\nbody text')).toEqual({
      data: { title: 'Hello' },
      body: 'body text',
    });
  });

  it('returns empty data + full content when no frontmatter', () => {
    expect(parseFrontmatter('just body\nlines')).toEqual({
      data: {},
      body: 'just body\nlines',
    });
  });

  it('returns empty for empty input', () => {
    expect(parseFrontmatter('')).toEqual({ data: {}, body: '' });
  });

  it('handles BOM', () => {
    expect(parseFrontmatter('﻿---\ntitle: A\n---\nrest')).toEqual({
      data: { title: 'A' },
      body: 'rest',
    });
  });

  it('handles CRLF', () => {
    expect(parseFrontmatter('---\r\ntitle: A\r\n---\r\nrest')).toEqual({
      data: { title: 'A' },
      body: 'rest',
    });
  });

  it('handles `= yaml =` start marker', () => {
    expect(parseFrontmatter('= yaml =\ntitle: A\n---\nrest')).toEqual({
      data: { title: 'A' },
      body: 'rest',
    });
  });

  it('handles `...` end marker', () => {
    expect(parseFrontmatter('---\ntitle: A\n...\nrest')).toEqual({
      data: { title: 'A' },
      body: 'rest',
    });
  });

  it('degrades to empty data on malformed YAML', () => {
    expect(parseFrontmatter('---\ntitle: : ::\n---\nrest')).toEqual({
      data: {},
      body: 'rest',
    });
  });

  it('preserves nested types', () => {
    expect(parseFrontmatter('---\nname: skill\ntags: [a, b]\n---\nbody')).toEqual({
      data: { name: 'skill', tags: ['a', 'b'] },
      body: 'body',
    });
  });

  it('with strict: false, last duplicate key wins', () => {
    expect(parseFrontmatter('---\ntitle: A\ntitle: B\n---\nrest')).toEqual({
      data: { title: 'B' },
      body: 'rest',
    });
  });

  it('YAML 1.2: bare `yes` becomes string', () => {
    expect(parseFrontmatter('---\nenabled: yes\n---\nrest')).toEqual({
      data: { enabled: 'yes' },
      body: 'rest',
    });
  });
});