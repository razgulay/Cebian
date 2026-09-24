import { describe, it, expect } from 'vitest';
import { extractInlineImages } from '@/lib/telegram-gateway/inline-images';

describe('extractInlineImages — 提取 + 剥离 markdown 内联图片', () => {
  it('提取单张图；alt trim；URL 原样保留', () => {
    const out = extractInlineImages('Look: ![A cat](https://cdn.test/cat.jpg) nice.');
    expect(out.images).toEqual([{ url: 'https://cdn.test/cat.jpg', alt: 'A cat' }]);
    expect(out.cleanText).toBe('Look:  nice.');
  });

  it('多张图按出现顺序提取；cleanText 剥离全部图片标签', () => {
    const out = extractInlineImages(
      'Intro ![a](https://x.test/1.png) middle ![b]( https://x.test/2.webp ) end',
    );
    expect(out.images.map((i) => i.url)).toEqual(['https://x.test/1.png', 'https://x.test/2.webp']);
    expect(out.cleanText).toBe('Intro  middle  end');
  });

  it('同一 URL 重复出现 → 图片去重（保留首次），但每处标签都从文本剥离', () => {
    const out = extractInlineImages(
      '![x](https://x.test/same.jpg) text ![y](https://x.test/same.jpg) more',
    );
    expect(out.images).toEqual([{ url: 'https://x.test/same.jpg', alt: 'x' }]);
    // 首尾 trim：图片在开头被剥离后残留的前导空格一并去掉。
    expect(out.cleanText).toBe('text  more');
  });

  it('VFS 内联图（#/...）不匹配、原样留在文本里（由既有文本路径处理）', () => {
    const out = extractInlineImages('![ws](#/workspaces/abc/img.png) hello');
    expect(out.images).toEqual([]);
    expect(out.cleanText).toBe('![ws](#/workspaces/abc/img.png) hello');
  });

  it('无图片 → images 空数组、cleanText 等于原文 trim', () => {
    const out = extractInlineImages('  just text  ');
    expect(out.images).toEqual([]);
    expect(out.cleanText).toBe('just text');
  });

  it('纯图片回复 → cleanText 空串', () => {
    const out = extractInlineImages('![only](https://x.test/only.jpg)');
    expect(out.images).toHaveLength(1);
    expect(out.cleanText).toBe('');
  });

  it('剥离后段间 3+ 连换行收敛为 1 个空行', () => {
    const out = extractInlineImages('para one\n\n![img](https://x.test/i.jpg)\n\n\n\npara two');
    expect(out.cleanText).toBe('para one\n\npara two');
  });

  it('URL 含一层平衡括号（Wikipedia 式）→ 完整提取、无残渣', () => {
    const out = extractInlineImages('See ![wiki](https://en.wikipedia.org/wiki/Code_(identifier)) here');
    expect(out.images).toEqual([
      { url: 'https://en.wikipedia.org/wiki/Code_(identifier)', alt: 'wiki' },
    ]);
    expect(out.cleanText).toBe('See  here');

    const nested = extractInlineImages('Ok ![a](https://x.test/a_(b)_c.jpg) end');
    expect(nested.images[0]!.url).toBe('https://x.test/a_(b)_c.jpg');
    expect(nested.cleanText).toBe('Ok  end');
  });

  it('URL 段含中文 / 编码字符照常提取；非 http(s) 协议不匹配', () => {
    const out = extractInlineImages('![vn](https://x.test/ảnh%20dep.jpg) ![no](javascript:alert(1))');
    expect(out.images).toEqual([{ url: 'https://x.test/ảnh%20dep.jpg', alt: 'vn' }]);
    expect(out.cleanText).toContain('![no](javascript:alert(1))');
  });
});
