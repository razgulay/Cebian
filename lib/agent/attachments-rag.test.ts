import { describe, expect, it } from 'vitest';
import { buildTextPrefix, type Attachment } from './attachments';

describe('buildTextPrefix — RAG context attachments', () => {
  const ragAttachment: Attachment = {
    type: 'rag-context',
    collection: 'research-papers',
    query: 'attention mechanism',
    chunks: [
      {
        sourcePath: 'papers/attention.pdf',
        chunkIndex: 3,
        content: 'The attention mechanism computes a weighted sum…',
        score: 0.8732,
      },
      {
        sourcePath: 'papers/transformer.md',
        chunkIndex: 0,
        content: 'A transformer is a deep learning model…',
        score: 0.8124,
      },
    ],
  };

  it('renders chunks inside <attached-rag-context> with score + path', () => {
    const xml = buildTextPrefix([ragAttachment]);
    expect(xml).toContain('<attached-rag-context collection="research-papers" count="2">');
    expect(xml).toContain('<chunk path="papers/attention.pdf" index="3" score="0.8732">');
    expect(xml).toContain('<chunk path="papers/transformer.md" index="0" score="0.8124">');
    expect(xml).toContain('The attention mechanism computes a weighted sum…');
    expect(xml).toContain('A transformer is a deep learning model…');
    expect(xml).toContain('</attached-rag-context>');
  });

  it('emits an empty-count envelope when the retriever returned nothing', () => {
    const empty: Attachment = {
      type: 'rag-context',
      collection: 'empty-coll',
      query: 'irrelevant query',
      chunks: [],
      // No `reason` → defaults to "no_match" hint in the XML body
    };
    const xml = buildTextPrefix([empty]);
    // `reason="no_match"` is the default for an attachment with no
    // explicit reason — keeps the hint useful without forcing callers
    // to thread reason through every resolver.
    expect(xml).toContain('<attached-rag-context collection="empty-coll" count="0" reason="no_match">');
    // The hint names the `rag_inspect` tool so the LLM has a path
    // forward that doesn't involve fs_*.
    expect(xml).toContain('rag_inspect');
    expect(xml).toContain('</attached-rag-context>');
    expect(xml).not.toContain('<chunk');
  });

  it('emits reason="empty" hint when the collection has zero chunks', () => {
    const empty: Attachment = {
      type: 'rag-context',
      collection: 'phaply',
      query: 'phaply',
      chunks: [],
      reason: 'empty',
    };
    const xml = buildTextPrefix([empty]);
    expect(xml).toContain('reason="empty"');
    expect(xml).toContain('no indexed chunks yet');
    expect(xml).toContain('rag_inspect');
  });

  it('escapes XML-unsafe characters in chunk content', () => {
    const dangerous: Attachment = {
      type: 'rag-context',
      collection: 'esc',
      query: 'q',
      chunks: [
        {
          sourcePath: 'a&b<c>.md',
          chunkIndex: 0,
          content: 'if (a < b && c > d) { return "<x>"; }',
          score: 0.5,
        },
      ],
    };
    const xml = buildTextPrefix([dangerous]);
    // Attribute: `&` and `<` must be escaped; `>` is left as-is in
    // XML attributes (only `<` and `&` are required to be escaped there).
    expect(xml).toContain('path="a&amp;b&lt;c>.md"');
    // Body content: `<` and `&` must be escaped; `>` is preserved
    // here too (escapeXml only escapes `<` and `&`, not `>`).
    expect(xml).toContain('if (a &lt; b &amp;&amp; c > d)');
    expect(xml).toContain('return "&lt;x>"; }');
    // Sanity: the raw "<x>" must NOT appear anywhere unescaped.
    expect(xml).not.toContain('"<x>"');
  });

  it('coexists with other attachment types in one envelope', () => {
    const file: Attachment = {
      type: 'file',
      content: 'plain text',
      name: 'note.md',
      mimeType: 'text/markdown',
      size: 10,
    };
    const xml = buildTextPrefix([file, ragAttachment]);
    expect(xml).toContain('<attached-file');
    expect(xml).toContain('<attached-rag-context');
    expect(xml.startsWith('<attachments>')).toBe(true);
    expect(xml.endsWith('</attachments>')).toBe(true);
  });
});
