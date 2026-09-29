import { describe, expect, it } from 'vitest';
import {
  buildTextPrefix,
  isPdfFile,
  MAX_IMAGE_SIZE,
  MAX_TEXT_FILE_SIZE,
  planFileIntake,
  type Attachment,
} from './attachments';


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

// ─── File intake rules（1.8.0：planFileIntake） ───

/** 造一个指定体积的 File；内容无关紧要，只看 name / type / size。 */
function makeFile(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

const png = (name = 'a.png', size?: number) => makeFile(name, 'image/png', size);
const md = (name = 'a.md', size?: number) => makeFile(name, 'text/markdown', size);

describe('planFileIntake', () => {
  it('按传入顺序接受图片与文本文件，并标出类别', () => {
    const files = [md('1.md'), png('2.png'), md('3.md')];
    const plan = planFileIntake(files, { remaining: 10, supportsImage: true });
    expect(plan.accepted.map((a) => [a.file.name, a.kind])).toEqual([
      ['1.md', 'text'],
      ['2.png', 'image'],
      ['3.md', 'text'],
    ]);
    expect(plan.rejected).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it('名额只计合格文件：前面不支持的文件不挤掉后面合格的', () => {
    const bad = makeFile('x.exe', 'application/octet-stream');
    const plan = planFileIntake([bad, md('1.md'), md('2.md')], { remaining: 2, supportsImage: true });
    expect(plan.accepted.map((a) => a.file.name)).toEqual(['1.md', '2.md']);
    expect(plan.rejected).toEqual([{ file: bad, reason: 'unsupported' }]);
    expect(plan.skipped).toBe(0);
  });

  it('名额用尽后，合格文件计入 skipped；不合格的仍照常报原因', () => {
    const big = md('big.md', MAX_TEXT_FILE_SIZE + 1);
    const plan = planFileIntake([md('1.md'), md('2.md'), big, md('3.md')], { remaining: 1, supportsImage: true });
    expect(plan.accepted.map((a) => a.file.name)).toEqual(['1.md']);
    expect(plan.skipped).toBe(2);
    expect(plan.rejected).toEqual([{ file: big, reason: 'too-large', maxSize: MAX_TEXT_FILE_SIZE }]);
  });

  it('remaining 为 0 或负数时一个都不接受', () => {
    expect(planFileIntake([md()], { remaining: 0, supportsImage: true }).skipped).toBe(1);
    expect(planFileIntake([md()], { remaining: -2, supportsImage: true }).accepted).toEqual([]);
  });

  it('当前模型不支持图片时拒绝图片，文本照常接受', () => {
    const img = png();
    const plan = planFileIntake([img, md()], { remaining: 10, supportsImage: false });
    expect(plan.rejected).toEqual([{ file: img, reason: 'no-image-model' }]);
    expect(plan.accepted.map((a) => a.kind)).toEqual(['text']);
  });

  it('模型不支持图片时，超大图片也按 no-image-model 报（模型能力优先于体积）', () => {
    const big = png('big.png', MAX_IMAGE_SIZE + 1);
    const plan = planFileIntake([big], { remaining: 10, supportsImage: false });
    expect(plan.rejected).toEqual([{ file: big, reason: 'no-image-model' }]);
  });

  it('图片与文本各按自己的体积上限判定（恰好等于上限算合格）', () => {
    const okImg = png('ok.png', MAX_IMAGE_SIZE);
    const bigImg = png('big.png', MAX_IMAGE_SIZE + 1);
    const okText = md('ok.md', MAX_TEXT_FILE_SIZE);
    const plan = planFileIntake([okImg, bigImg, okText], { remaining: 10, supportsImage: true });
    expect(plan.accepted.map((a) => a.file.name)).toEqual(['ok.png', 'ok.md']);
    expect(plan.rejected).toEqual([{ file: bigImg, reason: 'too-large', maxSize: MAX_IMAGE_SIZE }]);
  });

  it('图片按 MIME 白名单判定：白名单外的 image/* 视为不支持', () => {
    const bmp = makeFile('a.bmp', 'image/bmp');
    const plan = planFileIntake([bmp], { remaining: 10, supportsImage: true });
    expect(plan.rejected).toEqual([{ file: bmp, reason: 'unsupported' }]);
  });

  it('文本按扩展名判定，与 MIME 无关', () => {
    const plan = planFileIntake([makeFile('notes.TXT', '')], { remaining: 10, supportsImage: true });
    expect(plan.accepted.map((a) => a.kind)).toEqual(['text']);
  });
});
