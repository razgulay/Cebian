import { describe, it, expect } from 'vitest';
import { buildSlashPromptBlock } from '@/lib/ai-config/slash-prompt';

describe('buildSlashPromptBlock', () => {
  it('名字进属性，正文原样放进块里（首尾空白去掉）', () => {
    expect(buildSlashPromptBlock({ name: 'summarize', body: '\n  总结这个页面。\n' })).toBe(
      '<slash-prompt name="summarize">\n总结这个页面。\n</slash-prompt>',
    );
  });

  it('名字按属性规则转义，不破坏标签结构', () => {
    const block = buildSlashPromptBlock({ name: 'a"b&c<d', body: 'x' });
    expect(block.startsWith('<slash-prompt name="a&quot;b&amp;c&lt;d">')).toBe(true);
  });

  // 提示词里出现 XML / HTML 片段是家常便饭，转义会篡改用户本意——与 <user-request>
  // 对用户文本的处理保持一致（都视为可信内容）。
  it('正文不转义：提示词里的尖括号原样保留', () => {
    const body = 'Wrap the answer in <result> tags & keep "quotes".';
    expect(buildSlashPromptBlock({ name: 'x', body })).toContain(body);
  });

  // 正文里页面可控的部分已在 replaceTemplateVars 转义过；这里不再做任何剥离，否则会把
  // 用户模板里的 React / TS 代码一起删掉，静默改写他自己写的提示词。
  it('正文里的代码写法原样保留，不做剥离', () => {
    const body = '照 <Context.Provider> 与 Array<Context> 的写法改。';
    expect(buildSlashPromptBlock({ name: 'x', body })).toContain(body);
  });

  it('正文为空 → 仍产出结构完整的块', () => {
    expect(buildSlashPromptBlock({ name: 'x', body: '   ' })).toBe(
      '<slash-prompt name="x">\n\n</slash-prompt>',
    );
  });
});
