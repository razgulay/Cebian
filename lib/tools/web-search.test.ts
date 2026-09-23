import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createWebSearchTool, formatAllFailed, formatSearchResults, type EngineAttempt } from '@/lib/tools/web-search';
import type { ResolvedSearchEngine } from '@/lib/search/engines';

function engine(id: string, over: Partial<ResolvedSearchEngine> = {}): ResolvedSearchEngine {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    kind: 'builtin',
    enabled: true,
    urlTemplate: `https://${id}.test/?q={query}`,
    extract: 'function extract() { return { status: "ok", results: [] }; }',
    modified: false,
    ...over,
  };
}

const attempt = (id: string, status: EngineAttempt['status'], reason?: string): EngineAttempt => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  status,
  ...(reason ? { reason } : {}),
  ms: 1,
});

beforeEach(() => {
  fakeBrowser.reset();
});

describe('formatSearchResults', () => {
  it('标题行带引擎名与原 query，条目为「编号 + 粗体标题 / URL / 摘要」，无摘要则省第三行', () => {
    const text = formatSearchResults(
      'Bing',
      'cebian extension',
      [
        { title: 'Cebian', url: 'https://cebian.app/', snippet: 'AI in your browser' },
        { title: 'GitHub', url: 'https://github.com/maotoumao/Cebian' },
      ],
      [],
    );
    expect(text).toBe(
      [
        'Search results from Bing for "cebian extension":',
        '',
        '1. **Cebian**',
        '   https://cebian.app/',
        '   AI in your browser',
        '2. **GitHub**',
        '   https://github.com/maotoumao/Cebian',
      ].join('\n'),
    );
  });

  it('之前失败过的引擎只在有的时候追加一行', () => {
    const text = formatSearchResults('Brave', 'q', [{ title: 't', url: 'https://a.test/' }], [
      attempt('bing', 'blocked'),
      attempt('google', 'failed', 'navigation failed: timeout'),
    ]);
    expect(text.endsWith(
      'Earlier engine attempts: Bing — blocked (CAPTCHA or access interstitial); Google — failed (navigation failed: timeout).',
    )).toBe(true);
  });
});

describe('formatAllFailed', () => {
  it('逐引擎列出结局，区分 no results / empty / blocked / failed / skipped，并给出下一步建议', () => {
    const text = formatAllFailed('q', [
      attempt('bing', 'no-results'),
      attempt('brave', 'empty', 'still missing after 5s of retries'),
      attempt('google', 'blocked'),
      attempt('duckduckgo', 'failed', 'extract() timed out after 10s'),
      attempt('baidu', 'skipped', 'tool time budget exhausted'),
    ]);
    expect(text).toContain('No usable search results were retrieved for "q". Engine outcomes:');
    expect(text).toContain('- Bing — no results');
    expect(text).toContain('- Brave — results container did not appear (still missing after 5s of retries)');
    expect(text).toContain('- Google — blocked (CAPTCHA or access interstitial)');
    expect(text).toContain('- Duckduckgo — failed (extract() timed out after 10s)');
    expect(text).toContain('- Baidu — skipped (tool time budget exhausted)');
    expect(text).toContain('Settings → Chat → Web search');
  });
});

describe('createWebSearchTool', () => {
  it('零引擎：描述指向设置页，调用即抛可操作错误，不碰标签页', async () => {
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    const tool = createWebSearchTool([]);
    expect(tool.name).toBe('web_search');
    expect(tool.description).toContain('No search engines are enabled');
    await expect(tool.execute('c1', { query: 'x' }, undefined)).rejects.toThrow(/Settings → Chat → Web search/);
    expect(create).not.toHaveBeenCalled();
  });

  it('描述按顺序列出启用引擎，带适用场景提示', () => {
    const tool = createWebSearchTool([engine('bing'), engine('baidu', { when: 'Chinese queries' })]);
    expect(tool.description).toContain('Enabled engines in fallback order: bing (Bing), baidu (Baidu; Chinese queries).');
  });

  it('空白 query / 未知 engine → 抛错且不碰标签页', async () => {
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    const tool = createWebSearchTool([engine('bing'), engine('brave')]);
    await expect(tool.execute('c1', { query: '   ' }, undefined)).rejects.toThrow('"query" must not be empty.');
    await expect(tool.execute('c2', { query: 'x', engine: 'kagi' }, undefined)).rejects.toThrow(
      'Unknown search engine "kagi". Enabled engines: bing, brave',
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('formatSearchResults — images 行', () => {
  const img = (url: string, alt?: string) => ({ url, ...(alt ? { alt } : {}), sourceUrl: 'https://src.test/' });

  it('有图的条目追加 images: 行（带 alt 的拼在 URL 后）', () => {
    const text = formatSearchResults(
      'Bing',
      'cat',
      [{ title: 'Cats', url: 'https://a.test/', images: [img('https://cdn.test/1.jpg', 'A cat'), img('https://cdn.test/2.png')] }],
      [],
    );
    expect(text).toContain('   images: https://cdn.test/1.jpg (A cat) | https://cdn.test/2.png');
  });

  it('无 images 字段的条目不追加该行（与旧行为逐字节一致）', () => {
    const text = formatSearchResults('Bing', 'q', [{ title: 't', url: 'https://a.test/' }], []);
    expect(text).not.toContain('images:');
  });

  it('整次调用封顶 12 张：预算耗尽后剩余条目不再输出 images 行', () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`,
      url: `https://r.test/${i}`,
      // 每条 3 张 → 8×3=24，预算 12：第 4 条后耗尽。
      images: [img(`https://cdn.test/${i}a.jpg`), img(`https://cdn.test/${i}b.jpg`), img(`https://cdn.test/${i}c.jpg`)],
    }));
    const text = formatSearchResults('Bing', 'q', results, []);
    expect(text.match(/images: /g)).toHaveLength(4);
    // 第 5 条起不再有 images 行。
    expect(text).toContain('5. **t4**\n   https://r.test/4\n6. **t5**');
  });

  it('预算耗尽落在某条中间时，该行只输出剩余预算内的图（部分截断）', () => {
    const n = (i: number) => Array.from({ length: i }, (_, k) => img(`https://cdn.test/${k}.jpg`));
    // 4+4+3=11 → 第 4 条只剩 1 张预算；第 5 条 0。
    const results = [
      { title: 't0', url: 'https://r.test/0', images: n(4) },
      { title: 't1', url: 'https://r.test/1', images: n(4) },
      { title: 't2', url: 'https://r.test/2', images: n(3) },
      { title: 't3', url: 'https://r.test/3', images: n(5) },
      { title: 't4', url: 'https://r.test/4', images: n(2) },
    ];
    const text = formatSearchResults('Bing', 'q', results, []);
    expect(text.match(/cdn\.test/g)).toHaveLength(12);
    // 第 4 行部分截断：预算内 1 张。
    expect(text).toContain('4. **t3**\n   https://r.test/3\n   images: https://cdn.test/0.jpg');
    expect(text).not.toContain('5. **t4**\n   https://r.test/4\n   images:');
  });

  it('工具描述说明 images 行的用法', () => {
    const tool = createWebSearchTool([engine('bing')]);
    expect(tool.description).toContain('images:');
    expect(tool.description).toContain('inline-image rules');
  });
});
