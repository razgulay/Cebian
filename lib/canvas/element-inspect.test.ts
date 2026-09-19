// element-inspect 的单测：覆盖 selector 拼接规则（id 锚点 / class / nth-of-type /
// 深度上限）、normalizePick 的不可信 payload 清洗（截断、坏 chain 回退）与合成
// attachment 的形状。纯函数，不需要 fakeBrowser。

import { describe, it, expect } from 'vitest';
import {
  buildCssSelector,
  normalizePick,
  buildCanvasElementAttachment,
  pickDedupeKey,
  type SelectorNode,
  type RawCanvasPick,
} from './element-inspect';

/** 便捷构造：root-first 链。 */
function chain(...nodes: Array<[tag: string, opts?: Partial<SelectorNode>]>): SelectorNode[] {
  return nodes.map(([tagName, opts]) => ({
    tagName,
    id: opts?.id ?? null,
    className: opts?.className ?? '',
    nthOfType: opts?.nthOfType ?? 1,
  }));
}

const valid: RawCanvasPick = {
  tagName: 'BUTTON',
  id: null,
  className: 'btn btn-primary',
  snippet: '<button class="btn btn-primary">Go</button>',
  // 叶子只有 class、id 在祖先上——让 selector 走「class 段 + id 锚点」完整路径。
  chain: chain(['div', { id: 'app' }], ['form', { className: 'login' }], ['button', { className: 'btn' }]),
};

describe('buildCssSelector', () => {
  it('目标自身带 id 时直接锚定，不再回溯祖先', () => {
    expect(buildCssSelector(chain(['div', { id: 'app' }], ['button', { id: 'submit' }]))).toBe(
      'button#submit',
    );
  });

  it('祖先 id 作为锚点终止回溯', () => {
    expect(
      buildCssSelector(
        chain(['div', { id: 'app' }], ['div', { className: 'container' }], ['button', { className: 'btn' }]),
      ),
    ).toBe('div#app > div.container > button.btn');
  });

  it('无 class 的节点用 nth-of-type 消歧，顺序 root-first', () => {
    expect(buildCssSelector(chain(['div'], ['ul'], ['li', { nthOfType: 3 }]))).toBe(
      'div:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(3)',
    );
  });

  it('class 最多取前 2 个', () => {
    expect(buildCssSelector([chain(['div', { className: 'a b c d' }])[0]])).toBe('div.a.b');
  });

  it('链最多取 5 段（不含 id 锚点段）', () => {
    const deep = chain(['div1'], ['div2'], ['div3'], ['div4'], ['div5'], ['div6'], ['div7']);
    const result = buildCssSelector(deep);
    expect(result.split(' > ')).toHaveLength(5);
    expect(result).toBe('div3:nth-of-type(1) > div4:nth-of-type(1) > div5:nth-of-type(1) > div6:nth-of-type(1) > div7:nth-of-type(1)');
  });

  it('空链返回空串', () => {
    expect(buildCssSelector([])).toBe('');
  });
});

describe('normalizePick', () => {
  it('合法 payload 原样通过且 selector 由 chain 计算（tagName 归一为小写）', () => {
    const pick = normalizePick(valid);
    expect(pick).not.toBeNull();
    expect(pick!.tagName).toBe('button');
    expect(pick!.id).toBeNull();
    expect(pick!.selector).toBe('div#app > form.login > button.btn');
    expect(pick!.snippet).toBe(valid.snippet);
  });

  it('非对象 / tagName 非法 → null', () => {
    expect(normalizePick(null)).toBeNull();
    expect(normalizePick('x')).toBeNull();
    expect(normalizePick({ tagName: '123' })).toBeNull();
    expect(normalizePick({})).toBeNull();
  });

  it('超长字段被截断（snippet 500 / id 120 / className 200）', () => {
    const pick = normalizePick({
      tagName: 'div',
      id: 'i'.repeat(500),
      className: 'c'.repeat(500),
      snippet: 'x'.repeat(2000),
      chain: [],
    });
    expect(pick!.id).toHaveLength(120);
    expect(pick!.className).toHaveLength(200);
    expect(pick!.snippet).toHaveLength(500);
  });

  it('chain 超深时取末尾最近 6 段——被裁掉的头部坏节点不连累整条链', () => {
    // 关键：坏节点必须放在会被 slice(-6) 丢掉的头部。若实现没有裁剪，坏节点
    // 会令整条链弃用、退化成顶层字段单段链（button.btn.btn-primary）；裁剪
    // 生效时链完好、selector 由尾部链拼出（叶子 id 锚点 → 单段）。
    const tail = chain(['d1'], ['d2'], ['d3'], ['d4'], ['d5'], ['d6', { id: 'leaf' }]);
    const pick = normalizePick({
      ...valid,
      chain: [{ tagName: '!!bad' } as unknown as SelectorNode, ...tail],
    });
    expect(pick!.selector).toBe('d6#leaf');
  });

  it('chain 中有坏节点 → 整条弃用，回退为顶层字段单段链', () => {
    const pick = normalizePick({
      ...valid,
      chain: [chain(['div', { id: 'app' }])[0], { tagName: '!!bad' }],
    });
    expect(pick).not.toBeNull();
    expect(pick!.selector).toBe('button.btn.btn-primary');
  });

  it('chain 缺失 → 回退单段链，nthOfType 缺省为 1', () => {
    const pick = normalizePick({ tagName: 'span', className: 'label', snippet: '<span class="label">x</span>' });
    expect(pick!.selector).toBe('span.label');
    const pick2 = normalizePick({ tagName: 'span', snippet: '<span>x</span>' });
    expect(pick2!.selector).toBe('span:nth-of-type(1)');
  });

  it('nthOfType 非法值被夹回 ≥1 整数', () => {
    const pick = normalizePick({
      tagName: 'li',
      snippet: '<li>x</li>',
      chain: chain(['ul'], ['li', { nthOfType: 2.9 }]),
    });
    expect(pick!.selector).toBe('ul:nth-of-type(1) > li:nth-of-type(2)');
    const pickNeg = normalizePick({
      tagName: 'li',
      snippet: '<li>x</li>',
      chain: chain(['ul'], ['li', { nthOfType: -5 }]),
    });
    expect(pickNeg!.selector).toBe('ul:nth-of-type(1) > li:nth-of-type(1)');
  });
});

describe('buildCanvasElementAttachment', () => {
  it('合成 TextFileAttachment：名字为 tag#id.html，正文含 canvas 路径 + selector + snippet', () => {
    const pick = { ...normalizePick(valid)!, id: 'submit' };
    const att = buildCanvasElementAttachment(pick, '/demo/index.html');
    expect(att.type).toBe('file');
    expect(att.name).toBe('button#submit.html');
    expect(att.mimeType).toBe('text/html');
    expect(att.content).toContain('<!-- Element picked from canvas: /demo/index.html -->');
    expect(att.content).toContain('<!-- selector: div#app > form.login > button.btn -->');
    expect(att.content).toContain(valid.snippet);
    expect(att.size).toBe(att.content.length);
  });

  it('正文以 pickDedupeKey 开头（去重契约：builder 与订阅方共用同一格式源）', () => {
    const pick = normalizePick(valid)!;
    const att = buildCanvasElementAttachment(pick, '/demo/index.html');
    expect(att.content.startsWith(pickDedupeKey(pick, '/demo/index.html'))).toBe(true);
  });

  it('id 里的怪字符从 chip 名剔除，全空时回落 element', () => {
    const weird = buildCanvasElementAttachment(
      { ...normalizePick(valid)!, id: 'fo o/b ar' },
      '/x.html',
    );
    expect(weird.name).toBe('button#foobar.html');
    const empty = buildCanvasElementAttachment({ tagName: 'div', id: null, className: '', selector: 'div', snippet: '' }, '/x.html');
    expect(empty.name).toBe('div.html');
  });
});
