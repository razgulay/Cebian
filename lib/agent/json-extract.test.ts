// `extractJsonOrRaw` 单测 —— 纯函数，覆盖三档降级路径与边界。

import { describe, it, expect } from 'vitest';
import { extractJsonOrRaw } from '@/lib/agent/json-extract';

describe('extractJsonOrRaw', () => {
  it('首选：```json``` code block', () => {
    const text = '思考过程... 然后：\n```json\n{"status":"success"}\n```\n完了';
    expect(extractJsonOrRaw(text)).toEqual({
      json: '{"status":"success"}',
      raw: text,
    });
  });

  it('code block 大小写不敏感（```JSON）', () => {
    const text = '```JSON\n{"a":1}\n```';
    expect(extractJsonOrRaw(text).json).toBe('{"a":1}');
  });

  it('code block 自动 trim 首尾空白与换行', () => {
    const text = '```json\n\n   {"a":1}\n\n```';
    expect(extractJsonOrRaw(text).json).toBe('{"a":1}');
  });

  it('fallback：裸 { ... } 对象（无 code block）', () => {
    const text = '代理想了想，写：{"status":"failed","reason":"oops"} 就这样。';
    expect(extractJsonOrRaw(text).json).toBe('{"status":"failed","reason":"oops"}');
  });

  it('多组裸对象：greedy regex 抓首 { 到末 }（已知行为，上游 parse 会兜）', () => {
    // 当前 regex `\{[\s\S]*\}` 是 greedy，会从首个 `{` 抓到最末 `}`。多组对象
    // 时返回整段。工程化妥协：平衡大括号得靠上游 JSON.parse 二次过滤。这是与
    // dom-sub-agent-runner 抽出前的同一行为；保持原样，仅在此钉下供后人参考。
    const text = '先写 {"a":1} 然后 {"b":2}';
    expect(extractJsonOrRaw(text).json).toBe('{"a":1} 然后 {"b":2}');
  });

  it('code block 优先于裸对象（即使裸对象先出现）', () => {
    const text = '我先写 {"a":1} 但其实想用：\n```json\n{"final":true}\n```';
    expect(extractJsonOrRaw(text).json).toBe('{"final":true}');
  });

  it('没有 JSON 时 → json=null, raw 保留', () => {
    const text = 'I wrote some prose without any JSON.';
    expect(extractJsonOrRaw(text)).toEqual({ json: null, raw: text });
  });

  it('空字符串 → json=null, raw 是空串', () => {
    expect(extractJsonOrRaw('')).toEqual({ json: null, raw: '' });
  });

  it('非字符串入参（type 防御）→ json=null, raw 兜底', () => {
    // runner 上游应当只传 string，但本函数对意外入参不抛、不污染，仅把 raw
    // 兜成空串让上游能继续推进（避免 worker 全线死锁）。
    expect(extractJsonOrRaw(undefined as unknown as string).json).toBeNull();
    expect(extractJsonOrRaw(undefined as unknown as string).raw).toBe('');
    expect(extractJsonOrRaw(null as unknown as string).json).toBeNull();
  });

  it('code block 内是 malformed JSON 也照抽（parse 是上游的事）', () => {
    const text = '```json\n{not valid\n```';
    expect(extractJsonOrRaw(text).json).toBe('{not valid');
  });

  it('```lang 不是 json 的 code block 不匹配（避免误抓 ```js / ```ts）', () => {
    const text = '```js\n{"wouldBeConfused":true}\n```';
    // 不应匹配 json code block；接下来看是否能抓到裸对象——能抓到，但那是 fallback
    // 不是误抓 json 标签。两条路行为一致：抽出 {"wouldBeConfused":true}。
    expect(extractJsonOrRaw(text).json).toBe('{"wouldBeConfused":true}');
  });

  it('嵌套大括号：greedy regex 抓首 { 到末 }，把外层整段抽出来', () => {
    // 与「多组裸对象」同源：greedy `*` 配最末 `}`。嵌套情形下首段 `{` 到最
    // 末 `}` 正好覆盖整个 JSON 对象。harness 阶段 JSON.parse 才是权威。
    const text = '前置 {"outer": {"inner": 1}, "trail": 2} 后置';
    expect(extractJsonOrRaw(text).json).toBe('{"outer": {"inner": 1}, "trail": 2}');
  });
});
