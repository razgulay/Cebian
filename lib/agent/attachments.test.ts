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