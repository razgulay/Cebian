import { describe, expect, it } from 'vitest';
import {
  canSplitByClause,
  detectHeadings,
  splitByClause,
  splitHeadingSections,
  MIN_HEADINGS,
} from './structure';

describe('detectHeadings — 越南法律 heading', () => {
  it('识别 Chương / Mục / Điều 及其层级', () => {
    const text = ['Chương II', 'Mục 1. Quy định chung', 'Điều 4. Phạm vi', 'Nội dung.'].join('\n');
    const hs = detectHeadings(text);
    // Phần=1 Chương=2 Mục=3 Tiểu mục=4 Điều=5
    expect(hs.map((h) => h.level)).toEqual([2, 3, 5]);
    expect(hs.map((h) => h.text)).toEqual(['Chương II', 'Mục 1. Quy định chung', 'Điều 4. Phạm vi']);
  });

  it('把 Điều 标为叶子、Chương/Mục 标为容器', () => {
    const text = ['Chương I', 'Điều 1. A', 'x', 'Điều 2. B', 'y', 'Điều 3. C', 'z'].join('\n');
    const kinds = detectHeadings(text).map((h) => h.kind);
    expect(kinds).toContain('leaf');
    expect(kinds.filter((k) => k === 'container')).toHaveLength(1); // Chương I
  });

  it('接受罗马数字与 spelled-out 序数', () => {
    expect(detectHeadings('Chương IV').map((h) => h.level)).toEqual([2]);
    expect(detectHeadings('Phần thứ nhất').map((h) => h.level)).toEqual([1]);
  });

  it('拒绝句中的 Điều 引用', () => {
    const text = 'Theo quy định tại Điều 5 của Luật này thì mọi tổ chức phải tuân thủ.';
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('拒绝「Điều 4 quy định rằng」——有数字但无标点且非行尾', () => {
    expect(detectHeadings('Điều 4 quy định rằng mọi người phải tuân thủ')).toHaveLength(0);
  });

  it('Tiểu mục 是 Mục 的子级，占独立层级', () => {
    const hs = detectHeadings('Tiểu mục 2. Chi tiết');
    expect(hs).toHaveLength(1);
    // 与 Mục 不同级——同级会让祖先栈在遇到 Tiểu mục 时弹掉 Mục。
    expect(hs[0]!.level).toBeGreaterThan(detectHeadings('Mục 1. A')[0]!.level);
  });

  it('Tiểu mục 嵌套在 Mục 下时保留 Mục 祖先', () => {
    const text = [
      'Chương II',
      'Mục 1. Quy định chung',
      'Tiểu mục 1. Chi tiết',
      'Điều 4. A',
      'nội dung',
      'Điều 5. B',
      'nội dung',
      'Điều 6. C',
      'nội dung',
    ].join('\n');
    const dieu4 = splitHeadingSections(text).find((s) => s.text.startsWith('Điều 4'));
    expect(dieu4?.headingPath).toContain('Mục 1. Quy định chung');
  });

  it('代码围栏内的一切都不算 heading', () => {
    const text = ['```', '# Đây là comment', 'Điều 4. Không phải heading', '```'].join('\n');
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('~~~ 围栏同样屏蔽', () => {
    const text = ['~~~', 'Chương I', '~~~'].join('\n');
    expect(detectHeadings(text)).toHaveLength(0);
  });

  it('#hashtag（无空格）不是 heading', () => {
    expect(detectHeadings('#hashtag')).toHaveLength(0);
  });

  it('ATX 前有空行才算 heading', () => {
    expect(detectHeadings('## Title')).toHaveLength(1); // 行首，视为文档开头
    expect(detectHeadings('code line\n## NotHeading')).toHaveLength(0);
    expect(detectHeadings('code line\n\n## Heading')).toHaveLength(1);
  });

  it('识别全大写 PHẦN / CHƯƠNG / MỤC / ĐIỀU（越南法律文书常见写法）', () => {
    // 回归：正则原缺 `i` 标志，全大写标题整类漏掉，导致最外层结构丢失。
    const text = ['PHẦN I', 'CHƯƠNG II', 'MỤC 1. Quy định', 'ĐIỀU 4. Phạm vi', 'Nội dung.'].join('\n');
    const hs = detectHeadings(text);
    expect(hs.map((h) => h.level)).toEqual([1, 2, 3, 5]);
  });

  it('heading_path 保留原文大小写，不被改写成 Phần', () => {
    const text = [
      'PHẦN I',
      'QUY ĐỊNH CHUNG',
      'CHƯƠNG I',
      'ĐIỀU 1. Phạm vi điều chỉnh',
      'Nội dung điều một.',
      'ĐIỀU 2. Đối tượng',
      'Nội dung điều hai.',
      'ĐIỀU 3. Hiệu lực',
      'Nội dung điều ba.',
    ].join('\n');
    const dieu1 = splitHeadingSections(text).find((s) => s.text.startsWith('ĐIỀU 1'));
    expect(dieu1?.headingPath).toContain('PHẦN I');
    expect(dieu1?.headingPath).toContain('CHƯƠNG I');
    // 关键：原文是 PHẦN，输出就必须是 PHẦN。
    expect(dieu1?.headingPath.some((h) => h === 'Phần I')).toBe(false);
  });

  it('全大写容器 heading 的正文规则与常小写一致', () => {
    // PHẦN I 后直接跟 CHƯƠNG I（无自身正文）——容器型，必须保留。
    const text = ['PHẦN I', 'CHƯƠNG I', 'ĐIỀU 1. A', 'x', 'ĐIỀU 2. B', 'y', 'ĐIỀU 3. C', 'z'].join('\n');
    const hs = detectHeadings(text);
    expect(hs.some((h) => h.text === 'PHẦN I')).toBe(true);
    expect(hs.some((h) => h.text === 'CHƯƠNG I')).toBe(true);
  });

  it('大小写混排也识别（Chương / CHƯƠNG / chương）', () => {
    for (const w of ['Chương I', 'CHƯƠNG I', 'chương I']) {
      expect(detectHeadings(w)).toHaveLength(1);
    }
  });

  it('句中引用在全大写形式下同样被拒', () => {
    expect(detectHeadings('Theo quy định tại ĐIỀU 5 của Luật này.')).toHaveLength(0);
  });

  it('全大写 PHẦN 修复了「目录末行幸存为假 heading」的连带 bug', () => {
    // 修复前 `PHẦN I` 不被识别 → 目录最后一行「Điều 6. Trình tự…」把它当成
    // 自己的正文，于是躲过空正文规则、成为假 heading。识别 `PHẦN I` 后，
    // 目录的每一行都正确地被降级。
    const text = [
      'Điều 5. Thời hạn giải quyết',
      'Điều 6. Trình tự giải quyết khiếu nại lần đầu',
      '',
      'PHẦN I',
      'QUY ĐỊNH CHUNG',
      '',
      'CHƯƠNG I',
      'ĐIỀU 1. Phạm vi điều chỉnh',
      'Nội dung điều một.',
      'ĐIỀU 2. Đối tượng áp dụng',
      'Nội dung điều hai.',
      'ĐIỀU 3. Hiệu lực thi hành',
      'Nội dung điều ba.',
    ].join('\n');
    const hs = detectHeadings(text);
    expect(hs.some((h) => h.text === 'PHẦN I')).toBe(true);
    expect(hs.some((h) => h.text.startsWith('Điều 6'))).toBe(false);
  });

  it('NFD 分解形式的 Điều 也能识别，且 text 保持原文', () => {
    // 叶子型 heading 必须有正文，否则会被空正文规则降级——补一行内容。
    const nfd = ['Điều 4. Phạm vi', 'Nội dung điều bốn.'].join('\n').normalize('NFD');
    const hs = detectHeadings(nfd);
    expect(hs).toHaveLength(1);
    // 关键：返回的是原串切片，不是归一化后的串。
    expect(hs[0]!.text).toBe('Điều 4. Phạm vi'.normalize('NFD'));
    expect(hs[0]!.text).not.toBe('Điều 4. Phạm vi');
  });
});

describe('detectHeadings — 空正文规则（两遍扫描）', () => {
  it('目录：40 行 Điều 全部降级，而不是降到 39 就停', () => {
    const toc = Array.from({ length: 40 }, (_, i) => `Điều ${i + 1}. Mục lục`).join('\n');
    // 无正文——全部应被降级。
    expect(detectHeadings(toc)).toHaveLength(0);
  });

  it('目录后接真正的正文：降级不连锁，正文 heading 保留', () => {
    const toc = ['Điều 1. Mục lục', 'Điều 2. Mục lục', 'Điều 3. Mục lục'].join('\n');
    const body = ['Điều 1. Phạm vi điều chỉnh', 'Nội dung thật của điều một.', '', 'Điều 2. Đối tượng', 'Nội dung thật.', '', 'Điều 3. Hiệu lực', 'Nội dung.'].join('\n');
    const hs = detectHeadings(`${toc}\n${body}`);
    // 目录 3 行降级；正文 3 行保留。
    expect(hs.map((h) => h.text)).toEqual([
      'Điều 1. Phạm vi điều chỉnh',
      'Điều 2. Đối tượng',
      'Điều 3. Hiệu lực',
    ]);
  });

  it('容器型 heading 即使无正文也保留（Chương 后直接是 Điều con）', () => {
    const text = ['Chương I', 'Điều 1. A', 'x', 'Điều 2. B', 'y', 'Điều 3. C', 'z'].join('\n');
    const hs = detectHeadings(text);
    expect(hs.some((h) => h.text === 'Chương I')).toBe(true);
  });

  it('Điều 后只有空行与下一个 heading → 降级', () => {
    const text = ['Điều 1. A', '', 'Điều 2. B', 'nội dung', '', 'Điều 3. C', 'nội dung'].join('\n');
    const hs = detectHeadings(text);
    expect(hs.map((h) => h.text)).toEqual(['Điều 2. B', 'Điều 3. C']);
  });
});

describe('splitHeadingSections', () => {
  const LEGAL = [
    'Chương I',
    '',
    'Điều 1. Phạm vi điều chỉnh',
    'Luật này quy định về tổ chức.',
    '',
    'Điều 2. Đối tượng áp dụng',
    'Áp dụng cho mọi tổ chức.',
    '',
    'Điều 3. Hiệu lực thi hành',
    'Có hiệu lực từ ngày ký.',
  ].join('\n');

  it('每个 section 带完整祖先路径', () => {
    const sections = splitHeadingSections(LEGAL);
    const dieu2 = sections.find((s) => s.text.startsWith('Điều 2'));
    expect(dieu2?.headingPath).toEqual(['Chương I', 'Điều 2. Đối tượng áp dụng']);
  });

  it('无结构时返回单个空路径 section', () => {
    const prose = 'Chỉ là văn xuôi. Không có điều khoản nào ở đây cả.';
    const sections = splitHeadingSections(prose);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.headingPath).toEqual([]);
  });

  it('低于 MIN_HEADINGS 时整篇作为一个 section', () => {
    const few = ['Điều 1. A', 'nội dung', 'Điều 2. B', 'nội dung'].join('\n');
    expect(detectHeadings(few).length).toBeLessThan(MIN_HEADINGS);
    const sections = splitHeadingSections(few);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.headingPath).toEqual([]);
  });

  it('heading 之前的序言作为空路径 section', () => {
    const text = ['Lời nói đầu.', '', LEGAL].join('\n');
    const sections = splitHeadingSections(text);
    expect(sections[0]!.headingPath).toEqual([]);
    expect(sections[0]!.text).toBe('Lời nói đầu.\n');
  });

  it('不变式：所有 section 拼回原文（无数据丢失）', () => {
    const sections = splitHeadingSections(LEGAL);
    expect(sections.map((s) => s.text).join('\n')).toBe(LEGAL);
  });

  it('祖先栈正确：同级 heading 不互相嵌套', () => {
    const sections = splitHeadingSections(LEGAL);
    const dieu3 = sections.find((s) => s.text.startsWith('Điều 3'));
    // Điều 3 与 Điều 2 同级——路径里不应含 Điều 2。
    expect(dieu3?.headingPath).toEqual(['Chương I', 'Điều 3. Hiệu lực thi hành']);
  });

  it('CRLF 输入也能识别（调用方归一化前的原串）', () => {
    const crlf = LEGAL.replace(/\n/g, '\r\n');
    // detectHeadings 按 \n 切，\r 留在行尾——正则的 `\s*$` 吸收它。
    expect(detectHeadings(crlf).length).toBeGreaterThanOrEqual(MIN_HEADINGS);
  });
});

describe('splitByClause', () => {
  it('按 1. 2. 边界切分', () => {
    const text = ['Điều 4. Phạm vi', '1. Khoản một.', '2. Khoản hai.'].join('\n');
    const parts = splitByClause(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('Điều 4. Phạm vi\n1. Khoản một.');
    expect(parts[1]).toBe('2. Khoản hai.');
  });

  it('无 Khoản 边界时原样返回', () => {
    const text = 'Điều 4. Một đoạn văn dài không có khoản nào.';
    expect(splitByClause(text)).toEqual([text]);
  });

  it('首个分片保留 heading 行', () => {
    const text = ['Điều 4. Tên điều', '1. A', '2. B'].join('\n');
    expect(splitByClause(text)[0]).toContain('Điều 4. Tên điều');
  });

  it('切分后拼回原文', () => {
    const text = ['Điều 4. X', '1. A', '2. B', '3. C'].join('\n');
    expect(splitByClause(text).join('\n')).toBe(text);
  });
});

describe('canSplitByClause — 门控用 kind，不用层级数字', () => {
  it('markdown #### 不会启用 Khoản 切分（其 level 也是 4）', () => {
    const text = [
      '# Install',
      'Intro text here.',
      '',
      '#### Notes',
      'Nội dung ghi chú ở đây.',
      '',
      '#### More',
      'Thêm nội dung nữa.',
      '',
      '1. aaaa',
      '2. bbbb',
      '3. cccc',
    ].join('\n');
    const sections = splitHeadingSections(text);
    // 每个 section 的 innermostKind 都不是 'leaf'——ATX 一律是容器型。
    expect(sections.every((s) => !canSplitByClause(s))).toBe(true);
  });

  it('Điều 是叶子型，启用 Khoản 切分', () => {
    const text = ['Chương I', 'Điều 1. A', '1. x', '2. y', 'Điều 2. B', 'z', 'Điều 3. C', 'w'].join('\n');
    const dieu = splitHeadingSections(text).find((s) => s.text.startsWith('Điều 1'));
    expect(canSplitByClause(dieu!)).toBe(true);
  });
});
