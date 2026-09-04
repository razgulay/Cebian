// 从助手回复中抽取 JSON —— 同一段逻辑供 worker-runner 与 DOM sub-agent-runner
// 复用，从 `entrypoints/background/dom-sub-agent-runner.ts:92-102` 提出来。
//
// 三档降级：
//   1. ```json ... ``` 代码块（首选，LLM 最常给的形态）。
//   2. 裸 `{ ... }` 对象（fallback，code block 缺失时仍能抢救）。
//   3. 都抽不到 → 返回原文（让上游 LLM 自行判断；本模块不抛错，不强 parse）。
//
// 纯函数，依赖只有 string / RegExp，可单测、可静态导入、可在 BG / sidepanel
// 任意环境运行。

/** 抽取结果。`json` 非空时只是「看起来像 JSON 的字符串」——本模块不验证它能否
 *  JSON.parse，parse 与 schema 校验是上游职责。本模块只解决「字符串里哪里是
 *  JSON」的定位问题。 */
export interface ExtractedJson {
  /** 抽到的 JSON 字符串（已 trim）。null 表示「没抽到」。 */
  json: string | null;
  /** 原始文本。永远返回，不在内部丢弃——上游即使拿不到 JSON 也要把原文给 LLM
   *  看（比如让它自己 retry）。 */
  raw: string;
}

/** 从助手文本里抽 JSON。详见模块头注释。 */
export function extractJsonOrRaw(rawText: string): ExtractedJson {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return { json: null, raw: rawText ?? '' };
  }
  // 1. ```json code block```
  const codeBlock = rawText.match(/```json\s*([\s\S]+?)\s*```/i);
  if (codeBlock && codeBlock[1]) {
    return { json: codeBlock[1].trim(), raw: rawText };
  }
  // 2. 裸 { ... } —— 抓首个完整花括号对象。贪心但非贪婪到配对平衡是 RegExp
  //    做不到的工程化妥协；harness 阶段会 JSON.parse 二次过滤 malformed。
  const bare = rawText.match(/(\{[\s\S]*\})/);
  if (bare && bare[1]) {
    return { json: bare[1].trim(), raw: rawText };
  }
  // 3. 都没抽到
  return { json: null, raw: rawText };
}
