import { describe, expect, it } from 'vitest';
import { chunkText, ChunkOptionsError, contentHash } from './chunker';

describe('chunkText', () => {
  it('returns a single chunk when input fits within size', () => {
    const text = 'short text';
    expect(chunkText(text, { size: 100, overlap: 0 })).toEqual([text]);
  });

  it('returns empty array for empty/whitespace input', () => {
    expect(chunkText('', { size: 100, overlap: 0 })).toEqual([]);
    expect(chunkText('   \n\n   ', { size: 100, overlap: 0 })).toEqual([]);
  });

  it('splits long input into overlapping chunks', () => {
    // 300 chars, size=100, overlap=20 → first chunk ends at 100, next starts at 80, etc.
    const text = 'a'.repeat(300);
    const chunks = chunkText(text, { size: 100, overlap: 20 });
    // Each chunk should be ≤ 100 chars (the sentence snap may trim it shorter)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
    // Adjacent chunks should overlap
    expect(chunks[0]!.slice(-20)).toBe(chunks[1]!.slice(0, 20));
  });

  it('snaps to sentence boundaries when possible', () => {
    // The snap window is positions [size*0.8, size). With size=50 the
    // window is [40, 50) — placed to include the period+space after
    // "Sentence three." at position 42. The chunk should align with
    // that boundary rather than cutting mid-sentence.
    const text = 'Sentence one. Sentence two. Sentence three. Long filler text here to push fifty. More filler beyond.';
    const chunks = chunkText(text, { size: 50, overlap: 10 });
    expect(chunks[0]).toBe('Sentence one. Sentence two. Sentence three.');
    // And the next chunk picks up beyond the snap point.
    expect(chunks[1]).toContain('Long filler');
  });

  it('handles a single very long sentence without breaking it', () => {
    // No sentence terminators — should fall back to hard cut at `size`.
    const text = 'word '.repeat(60); // ~300 chars, no terminators except the spaces
    const chunks = chunkText(text, { size: 80, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(80);
  });

  it('normalizes Windows line endings', () => {
    const text = 'line1\r\nline2\r\nline3';
    const chunks = chunkText(text, { size: 100, overlap: 0 });
    expect(chunks).toEqual(['line1\nline2\nline3']);
  });

  it('rejects invalid options', () => {
    expect(() => chunkText('x', { size: 0, overlap: 0 })).toThrow(ChunkOptionsError);
    expect(() => chunkText('x', { size: -1, overlap: 0 })).toThrow(ChunkOptionsError);
    expect(() => chunkText('x', { size: 100, overlap: -1 })).toThrow(ChunkOptionsError);
    expect(() => chunkText('x', { size: 100, overlap: 100 })).toThrow(ChunkOptionsError);
    expect(() => chunkText('x', { size: 100, overlap: 200 })).toThrow(ChunkOptionsError);
  });

  it('every original character appears in some chunk (no data loss)', () => {
    const text = ('This is a sentence. '.repeat(50)).trim();
    const chunks = chunkText(text, { size: 100, overlap: 20 });
    // Concatenate chunks — characters will repeat (overlap) but no
    // character from the original should be missing. Pick a few
    // representative anchors that span positions.
    const joined = chunks.join('');
    expect(joined.length).toBeGreaterThanOrEqual(text.length);
    expect(joined).toContain('This is a sentence.');
    // Check that anchors at the 75% mark survive.
    const anchor = text.slice(Math.floor(text.length * 0.75));
    expect(joined).toContain(anchor.slice(0, 30));
  });
});

describe('contentHash', () => {
  it('returns the same hash for identical strings', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
  });

  it('returns different hashes for different strings', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });

  it('produces 8-char lowercase hex strings', () => {
    expect(contentHash('anything')).toMatch(/^[0-9a-f]{8}$/);
  });
});
