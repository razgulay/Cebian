import { describe, it, expect } from 'vitest';
import {
  MAX_IMAGES_PER_RESULT,
  _isUsableImageUrl,
  filterSearchImages,
} from '@/lib/search/images';

const BASE = 'https://www.bing.com/search?q=cat';
const SOURCE = 'https://example.test/article';

describe('isUsableImageUrl（直链判定）', () => {
  it('位图扩展名直接放行（pathname 判定，查询串不影响）', () => {
    expect(_isUsableImageUrl(new URL('https://a.test/cat.jpg'))).toBe(true);
    expect(_isUsableImageUrl(new URL('https://a.test/cat.JPEG?x=1'))).toBe(true);
    expect(_isUsableImageUrl(new URL('https://a.test/img/photo.webp'))).toBe(true);
    expect(_isUsableImageUrl(new URL('https://a.test/img/photo.avif'))).toBe(true);
  });

  it('无扩展名 → 仅引擎缩略图域放行（favicon / 页面资源被挡）', () => {
    expect(_isUsableImageUrl(new URL('https://th.bing.com/th/id/OIP.abc?w=250&h=180'))).toBe(true);
    expect(_isUsableImageUrl(new URL('https://tse1.mm.bing.net/th?id=x'))).toBe(true);
    expect(_isUsableImageUrl(new URL('https://encrypted-tbn0.gstatic.com/images?q=tbn:abc'))).toBe(true);
    expect(_isUsableImageUrl(new URL('https://imgs.search.brave.com/abc.png'))).toBe(true);
    // 普通 gstatic / google 域上的无扩展名地址（如 faviconV2）不放行。
    expect(_isUsableImageUrl(new URL('https://www.gstatic.com/faviconV2?client=SOCIAL'))).toBe(false);
    expect(_isUsableImageUrl(new URL('https://a.test/page'))).toBe(false);
    expect(_isUsableImageUrl(new URL('https://a.test/favicon.ico'))).toBe(false);
  });

  it('.svg 刻意排除（即使有扩展名）', () => {
    expect(_isUsableImageUrl(new URL('https://a.test/logo.svg'))).toBe(false);
  });

  it('非 http(s) 协议全部拒绝', () => {
    expect(_isUsableImageUrl(new URL('data:image/png;base64,AAAA'))).toBe(false);
    expect(_isUsableImageUrl(new URL('javascript:alert(1)'))).toBe(false);
    expect(_isUsableImageUrl(new URL('chrome-extension://abc/x.png'))).toBe(false);
  });

  it('跟踪像素特征词拒绝（含扩展名分支也要过这道关）', () => {
    expect(_isUsableImageUrl(new URL('https://t.a.test/1x1.png'))).toBe(false);
    expect(_isUsableImageUrl(new URL('https://www.google-analytics.com/collect.png'))).toBe(false);
    expect(_isUsableImageUrl(new URL('https://www.facebook.com/tr?img=1'))).toBe(false);
    // 正常路径里只是「长得像」的图不受影响。
    expect(_isUsableImageUrl(new URL('https://a.test/analytics-guide.png'))).toBe(true);
  });

  it('URL 尺寸提示 < 100 拒绝（低分辨率 / 占位图）', () => {
    expect(_isUsableImageUrl(new URL('https://a.test/img.png?w=32'))).toBe(false);
    expect(_isUsableImageUrl(new URL('https://a.test/img.png?width=64&h=64'))).toBe(false);
    expect(_isUsableImageUrl(new URL('https://th.bing.com/th/id/x?w=250&h=48'))).toBe(false);
    expect(_isUsableImageUrl(new URL('https://a.test/img.png?w=640'))).toBe(true);
  });
});

describe('filterSearchImages（归一化层入口）', () => {
  it('合法图通过；sourceUrl 用调用方给的 result url 补齐', () => {
    const out = filterSearchImages(
      [{ url: 'https://a.test/cat.jpg', alt: 'A cat' }, { url: 'https://th.bing.com/th/id/x' }],
      SOURCE,
      BASE,
    );
    expect(out).toEqual([
      { url: 'https://a.test/cat.jpg', alt: 'A cat', sourceUrl: SOURCE },
      { url: 'https://th.bing.com/th/id/x', sourceUrl: SOURCE },
    ]);
  });

  it('相对地址按 baseUrl 解析（与 result url 同一基准）', () => {
    const out = filterSearchImages([{ url: '/thumbs/a.png' }], SOURCE, 'https://www.bing.com/search?q=x');
    expect(out).toEqual([{ url: 'https://www.bing.com/thumbs/a.png', sourceUrl: SOURCE }]);
  });

  it('DuckDuckGo 代理解包出真实 URL；解包失败回落代理 URL 本身', () => {
    const proxy = 'https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fa.test%2Fcat.png&f=1';
    expect(filterSearchImages([{ url: proxy }], SOURCE, BASE)).toEqual([
      { url: 'https://a.test/cat.png', sourceUrl: SOURCE },
    ]);
    // `u` 缺失 → 代理域名在 thumb-host allowlist 上，原样放行。
    expect(filterSearchImages([{ url: 'https://external-content.duckduckgo.com/iu/?f=1' }], SOURCE, BASE)).toEqual([
      { url: 'https://external-content.duckduckgo.com/iu/?f=1', sourceUrl: SOURCE },
    ]);
  });

  it('噪音图全部被过滤 → undefined（item 不带字段）', () => {
    expect(filterSearchImages([{ url: '/favicon.ico' }, { url: 'data:image/png;base64,x' }], SOURCE, BASE)).toBeUndefined();
  });

  it('非数组 / 条目畸形 → undefined 或跳过，不抛错', () => {
    expect(filterSearchImages(undefined, SOURCE, BASE)).toBeUndefined();
    expect(filterSearchImages('https://a.test/a.png', SOURCE, BASE)).toBeUndefined();
    expect(filterSearchImages([42, null, {}, { url: '' }, { alt: 'no url' }], SOURCE, BASE)).toBeUndefined();
  });

  it(`单条 result 上限 ${MAX_IMAGES_PER_RESULT} 张，按 url 去重`, () => {
    const raw = [
      { url: 'https://a.test/1.png' },
      { url: 'https://a.test/2.png' },
      { url: 'https://a.test/3.png' },
      { url: 'https://a.test/4.png' },
      { url: 'https://a.test/1.png' },
    ];
    const out = filterSearchImages(raw, SOURCE, BASE);
    expect(out).toHaveLength(3);
    expect(out!.map((i) => i.url)).toEqual([
      'https://a.test/1.png',
      'https://a.test/2.png',
      'https://a.test/3.png',
    ]);
  });

  it('alt 截断与单行化', () => {
    const out = filterSearchImages([{ url: 'https://a.test/a.png', alt: '  a\nb  ' + 'x'.repeat(300) }], SOURCE, BASE);
    // oneLine 折叠空白（前导 trim、\n → 空格），truncate 到 200 字符并追加省略号。
    expect(out![0].alt!.startsWith('a b x')).toBe(true);
    expect(out![0].alt!.endsWith('…')).toBe(true);
    expect(out![0].alt).toHaveLength(201); // 200 + 省略号
  });
});
