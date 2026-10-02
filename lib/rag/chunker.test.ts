import { describe, expect, it } from 'vitest';
import {
  chunkDocument,
  chunkText,
  ChunkOptionsError,
  contentHash,
  formatHeadingPath,
} from './chunker';

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

describe('chunkDocument — 结构感知切分', () => {
  /** 一段法律文书：3 个 Điều 属于同一个 Chương。 */
  const LEGAL = [
    'Chương I',
    '',
    'Điều 1. Phạm vi điều chỉnh',
    'Luật này quy định về tổ chức và hoạt động.',
    '',
    'Điều 2. Đối tượng áp dụng',
    'Áp dụng cho mọi tổ chức, cá nhân có liên quan.',
    '',
    'Điều 3. Hiệu lực thi hành',
    'Có hiệu lực kể từ ngày ký ban hành.',
  ].join('\n');

  it('放得下的 Điều 作为单个 chunk，带完整祖先路径', () => {
    const chunks = chunkDocument(LEGAL, { size: 500, overlap: 50 });
    const dieu2 = chunks.find((c) => c.text.startsWith('Điều 2'));
    expect(dieu2?.headingPath).toEqual(['Chương I', 'Điều 2. Đối tượng áp dụng']);
  });

  it('heading 不出现在 text 里——content 保持逐字原文', () => {
    const chunks = chunkDocument(LEGAL, { size: 500, overlap: 50 });
    const dieu1 = chunks.find((c) => c.text.startsWith('Điều 1'))!;
    // 路径里的 heading 不该被拼进正文。
    expect(dieu1.text).not.toContain('Chương I > ');
    expect(dieu1.text).toContain('Điều 1. Phạm vi điều chỉnh');
  });

  it('每个 chunk 的 text 都是原文的子串（CR 定位锚点不能破）', () => {
    const chunks = chunkDocument(LEGAL, { size: 120, overlap: 20 });
    for (const c of chunks) {
      expect(LEGAL.includes(c.text)).toBe(true);
    }
  });

  it('过长的 Điều 按 Khoản 拆，所有分片继承路径', () => {
    const long = [
      'Chương I',
      '',
      'Điều 1. A',
      'nội dung ngắn.',
      '',
      'Điều 2. B',
      `1. ${'x'.repeat(80)}`,
      `2. ${'y'.repeat(80)}`,
      `3. ${'z'.repeat(80)}`,
      '',
      'Điều 3. C',
      'nội dung.',
    ].join('\n');
    const chunks = chunkDocument(long, { size: 100, overlap: 10 });
    const fromDieu2 = chunks.filter((c) => c.headingPath.includes('Điều 2. B'));
    expect(fromDieu2.length).toBeGreaterThan(1);
    for (const c of fromDieu2) expect(c.text.length).toBeLessThanOrEqual(100);
    // 首个分片保留 heading 行。
    expect(fromDieu2[0]!.text).toContain('Điều 2. B');
  });

  it('单个 Khoản 仍过长 → 落到滑动窗口，路径仍保留', () => {
    const giant = [
      'Chương I',
      '',
      'Điều 1. A',
      'nội dung.',
      '',
      'Điều 2. B',
      `1. ${'q'.repeat(300)}`,
      '',
      'Điều 3. C',
      'nội dung.',
    ].join('\n');
    const chunks = chunkDocument(giant, { size: 80, overlap: 10 });
    const fromDieu2 = chunks.filter((c) => c.headingPath.includes('Điều 2. B'));
    expect(fromDieu2.length).toBeGreaterThan(1);
    for (const c of fromDieu2) {
      expect(c.text.length).toBeLessThanOrEqual(80);
      expect(c.headingPath).toEqual(['Chương I', 'Điều 2. B']);
    }
  });

  it('无结构文本的行为与改动前逐字一致（投影回 chunkText）', () => {
    const prose = 'Sentence one. Sentence two. Sentence three. Long filler text here to push fifty. More filler beyond.';
    const viaDoc = chunkDocument(prose, { size: 50, overlap: 10 });
    // 无结构 → headingPath 全为空，text 与旧窗口实现一致。
    expect(viaDoc.every((c) => c.headingPath.length === 0)).toBe(true);
    expect(chunkText(prose, { size: 50, overlap: 10 })).toEqual(viaDoc.map((c) => c.text));
  });

  it('代码里零星两个 # 不触发结构模式（低于 MIN_HEADINGS）', () => {
    const code = ['# cài đặt', 'npm install', '', '# chạy', 'npm start', '', 'console.log(1)'].join('\n');
    const chunks = chunkDocument(code, { size: 30, overlap: 5 });
    expect(chunks.every((c) => c.headingPath.length === 0)).toBe(true);
  });

  it('CRLF 输入也能识别结构', () => {
    const crlf = LEGAL.replace(/\n/g, '\r\n');
    const chunks = chunkDocument(crlf, { size: 500, overlap: 50 });
    expect(chunks.some((c) => c.headingPath.includes('Điều 2. Đối tượng áp dụng'))).toBe(true);
  });

  it('空/纯空白输入 → 空数组', () => {
    expect(chunkDocument('', { size: 100, overlap: 10 })).toEqual([]);
    expect(chunkDocument('   \n\n  ', { size: 100, overlap: 10 })).toEqual([]);
  });

  it('短于 size 的整体作为单个无路径 chunk', () => {
    const short = 'Điều 1. Ngắn';
    expect(chunkDocument(short, { size: 500, overlap: 50 })).toEqual([
      { text: short, headingPath: [] },
    ]);
  });

  it('非法选项抛 ChunkOptionsError（与 chunkText 同语义）', () => {
    expect(() => chunkDocument('x', { size: 0, overlap: 0 })).toThrow(ChunkOptionsError);
    expect(() => chunkDocument('x', { size: 100, overlap: 100 })).toThrow(ChunkOptionsError);
  });

  it('结构切分不丢数据：三个 Điều 的标题与正文都保留', () => {
    const chunks = chunkDocument(LEGAL, { size: 500, overlap: 50 });
    const joined = chunks.map((c) => c.text).join('\n');
    expect(joined).toContain('Điều 1. Phạm vi điều chỉnh');
    expect(joined).toContain('Điều 2. Đối tượng áp dụng');
    expect(joined).toContain('Điều 3. Hiệu lực thi hành');
    expect(joined).toContain('Có hiệu lực kể từ ngày ký ban hành.');
  });

  it('整篇小于 size 但含多个 Điều 时，仍按 Điều 切开', () => {
    // 这是本阶段的核心行为：判据是「每个 section 是否放得下」，不是「整篇是否
    // 放得下」。旧实现按整篇短路，会把 3 个 Điều 压成一个 chunk。
    expect(LEGAL.length).toBeLessThan(500);
    const chunks = chunkDocument(LEGAL, { size: 500, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.filter((c) => c.headingPath.length > 0).length).toBeGreaterThanOrEqual(3);
  });
});

describe('formatHeadingPath', () => {
  it('用 > 连接路径', () => {
    expect(formatHeadingPath(['Chương II', 'Điều 4'])).toBe('Chương II > Điều 4');
  });

  it('formatHeadingPath 空路径 → 空字符串', () => {
    expect(formatHeadingPath([])).toBe('');
  });

  it('container heading 无正文时不产生空 chunk', () => {
    const text = ['Chương I', 'Điều 1. A', 'nội dung một.', 'Điều 2. B', 'nội dung hai.', 'Điều 3. C', 'nội dung ba.'].join('\n');
    const chunks = chunkDocument(text, { size: 500, overlap: 50 });
    // 「Chương I」只有 heading、没有自己的正文——不该单独成为一个 chunk。
    expect(chunks.some((c) => c.text.trim() === 'Chương I')).toBe(false);
    // 但它的信息没丢：子 chunk 的路径里仍然有它。
    expect(chunks.some((c) => c.headingPath.includes('Chương I'))).toBe(true);
  });

  it('只有容器 heading、无任何正文时兜底保留，不返回空', () => {
    // 极端文档：只有 Chương，没有 Điều。过滤后会是空数组——必须兜底，
    // 否则静默什么都没索引。
    const text = ['Chương I', 'Chương II', 'Chương III'].join('\n');
    const chunks = chunkDocument(text, { size: 500, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('\\r\\r\\n 输入只归一化一次，输出是单次归一化结果的子串', () => {
    const weird = 'A\r\r\nB'.repeat(40);
    // 单次 `\r\n → \n` 之后仍会残留一个 `\r`（`A\r\nB`）——这是预期，不是 bug。
    // 回归点在于：旧实现只归一化一次，新实现若在 chunkByWindow 里再归一化一次，
    // 就会把残留的 `\r\n` 也折叠掉，输出与旧实现不再一致。
    const once = weird.replace(/\r\n/g, '\n').trim();
    const chunks = chunkDocument(weird, { size: 10, overlap: 2 });
    for (const c of chunks) expect(once.includes(c.text)).toBe(true);
  });
});
