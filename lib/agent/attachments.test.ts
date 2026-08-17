import { describe, expect, it } from 'vitest';
import { buildTextPrefix, isPdfFile, type Attachment } from './attachments';

describe('isPdfFile', () => {
  it('accepts application/pdf MIME', () => {
    expect(isPdfFile(new File(['x'], 'doc.pdf', { type: 'application/pdf' }))).toBe(true);
  });

  it('falls back to extension when MIME is empty', () => {
    expect(isPdfFile(new File(['x'], 'doc.pdf', { type: '' }))).toBe(true);
  });

  it('falls back to extension when MIME is octet-stream', () => {
    // octet-stream alone is too generic to trust — must also have .pdf extension.
    expect(isPdfFile(new File(['x'], 'doc.pdf', { type: 'application/octet-stream' }))).toBe(true);
    expect(isPdfFile(new File(['x'], 'doc.bin', { type: 'application/octet-stream' }))).toBe(false);
  });

  it('rejects images and text files', () => {
    expect(isPdfFile(new File(['x'], 'pic.png', { type: 'image/png' }))).toBe(false);
    expect(isPdfFile(new File(['x'], 'README.md', { type: 'text/markdown' }))).toBe(false);
  });

  it('rejects when MIME is non-PDF and extension is .pdf (MIME wins)', () => {
    // A non-PDF MIME with .pdf extension is suspicious — MIME is more
    // authoritative than the extension. e.g. a misconfigured server returning
    // a real PNG with a .pdf URL.
    expect(isPdfFile(new File(['x'], 'doc.pdf', { type: 'image/png' }))).toBe(false);
  });
});

describe('buildTextPrefix — PDF attachments', () => {
  const pdfAttachment: Attachment = {
    type: 'pdf',
    content: '=== Page 1 ===\nHello PDF',
    name: 'PMI.pdf',
    mimeType: 'application/pdf',
    size: 12345,
    pageCount: 12,
    extractedPageCount: 5,
    truncated: true,
  };

  it('renders PDF as <attached-file> with pdf MIME and page attributes', () => {
    const xml = buildTextPrefix([pdfAttachment]);
    expect(xml).toContain('<attached-file name="PMI.pdf" type="application/pdf" pages="12" truncated="true"');
    expect(xml).toContain('Hello PDF');
    expect(xml).toContain('</attached-file>');
  });

  it('surfaces truncation note when truncated', () => {
    const xml = buildTextPrefix([pdfAttachment]);
    expect(xml).toMatch(/note="[^"]*truncated[^"]*"/);
  });

  it('omits truncation note when fully extracted', () => {
    const full: Attachment = { ...pdfAttachment, extractedPageCount: 12, truncated: false };
    const xml = buildTextPrefix([full]);
    expect(xml).not.toContain('truncated="true"');
    expect(xml).not.toMatch(/note="/);
  });

  it('escapes special characters in filename', () => {
    const tricky: Attachment = { ...pdfAttachment, name: 'my & "doc".pdf' };
    const xml = buildTextPrefix([tricky]);
    // & becomes &amp;, " becomes &quot; for attribute safety.
    expect(xml).toContain('name="my &amp; &quot;doc&quot;.pdf"');
    // Body content should NOT be escaped — it's inside the CDATA-like block.
    expect(xml).toContain('Hello PDF');
  });

  it('mixes with other attachment types without dropping them', () => {
    const element: Attachment = {
      type: 'element',
      selector: 'button.ok',
      tagName: 'button',
      path: '/html/body/button',
      attributes: { class: 'ok' },
    };
    const xml = buildTextPrefix([element, pdfAttachment]);
    expect(xml).toContain('<selected-element');
    expect(xml).toContain('type="application/pdf"');
  });
});

describe('buildTextPrefix — pinned mention envelopes', () => {
  it('emits pinned="true" on directory envelopes when the flag is set', () => {
    // Pin chips carry the flag so the chat bubble can suppress the badge
    // (the pin is already visible in the composer strip). The envelope
    // shape stays the same so the LLM still parses it as a directory.
    const dir: Attachment = {
      type: 'mention-directory',
      path: '~/.cebian/memories',
      label: 'memories',
      entries: [{ name: 'notes.md', kind: 'file', size: 100 }],
      pinned: true,
    };
    const xml = buildTextPrefix([dir]);
    expect(xml).toContain('<attached-directory pinned="true" path="~/.cebian/memories"');
    expect(xml).toContain('  - notes.md (100 B)');
  });

  it('omits pinned attribute when directory is not pinned (mention uses same envelope)', () => {
    const dir: Attachment = {
      type: 'mention-directory',
      path: '~/projects',
      label: 'projects',
      entries: [{ name: 'app/', kind: 'dir' }],
    };
    const xml = buildTextPrefix([dir]);
    expect(xml).not.toContain('pinned="true"');
    expect(xml).toContain('<attached-directory path="~/projects"');
  });

  it('emits pinned="true" on mention-file envelopes when the flag is set', () => {
    const file: Attachment = {
      type: 'mention-file',
      name: 'notes.md',
      content: '# Notes',
      sourcePath: '~/notes.md',
      mimeType: 'text/markdown',
      truncated: false,
      pinned: true,
    };
    const xml = buildTextPrefix([file]);
    expect(xml).toContain('<attached-file pinned="true" name="notes.md" type="text/markdown" path="~/notes.md"');
    expect(xml).toContain('# Notes');
  });

  it('emits pinned="true" on rag-context envelopes when the flag is set', () => {
    // RAG doesn't currently render a bubble chip, but the flag is kept on
    // the envelope for symmetry with directory/file and so any future
    // bubble rendering can skip it the same way.
    const rag: Attachment = {
      type: 'rag-context',
      collection: 'phaply',
      query: 'hello',
      chunks: [{ sourcePath: 'a.md', chunkIndex: 0, content: 'hi', score: 0.9 }],
      pinned: true,
    };
    const xml = buildTextPrefix([rag]);
    expect(xml).toContain('<attached-rag-context pinned="true" collection="phaply" count="1"');
  });
});