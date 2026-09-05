// ─── Schema validation helper ───
// Pure functions for parsing caller-supplied JSON Schemas (TypeBox) and
// validating parsed JSON against them. Shared between `worker-runner`
// (`delegate_task`) and `dom-sub-agent-runner` (`delegate_dom`) so the
// two tools enforce schema-conformant output the same way.
//
// Lives at `lib/agent/` (not in `entrypoints/background/agent/`) because:
// - Pure logic with no chrome.* / window / SW globals — importable from
//   anywhere in the project (unit tests, future MCP tools, etc.).
// - Same trust boundary as `json-extract.ts` — a sibling pure helper.
//
// Error format mirrors `lib/mcp/client.ts:113-115` (`${instancePath}: ${message}`)
// so upstream callers / logs / UI see one consistent shape regardless of
// which validator produced the error.
//
// ——
// 共享给 `worker-runner`（`delegate_task`）和 `dom-sub-agent-runner`
// （`delegate_dom`）的 schema 解析与校验纯函数，两边用同一套契约守住
// 「schema-合规输出」。放在 `lib/agent/`（而非 `entrypoints/background/agent/`）
// 是因为它是 pure logic，不依赖 chrome.* / window / SW 任何特权 API，
// 任何 context 都能 import（包括 unit test、未来可能的 MCP 工具等），
// 和同目录的 `json-extract.ts` 是同一类 sibling pure helper。
// 错误格式 mirror `lib/mcp/client.ts:113-115`（`${instancePath}: ${message}`），
// 上游 caller / log / UI 看到的是统一形状，跟是哪边的 validator 无关。

import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import { debugLog } from '@/lib/debug/log';

/**
 * Parse a caller-supplied `expected_schema` string into a JSON object.
 * Returns `null` if the string is not valid JSON — caller decides whether
 * that means "no schema" (treat as unvalidated) or "runner-level error"
 * (reject the whole call before spending LLM tokens).
 *
 * `JSON.parse` returns `any`; we cast to `unknown` at the parse boundary
 * because TypeBox's `Value.Check` accepts any object as a schema at
 * runtime — typing is only a compile-time shape assertion.
 *
 * —— 把 caller 给的 `expected_schema` 字符串 JSON.parse 出来。失败返回 null，
 * caller 自己决定含义：「没给 schema」按 unvalidated 走，还是「caller 输入
 * 错了」直接拒掉（不烧 LLM token）。`JSON.parse` 返回 `any`，这里 cast 成
 * `unknown`——TypeBox 的 `Value.Check` 运行时接受任何对象当 schema，typing
 * 只是 compile-time 形状断言。
 */
export function parseExpectedSchema(expectedSchema: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(expectedSchema);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Validate `parsedJson` against a TypeBox `schema`. Returns:
 * - `null` → schema matches.
 * - `string` (`${instancePath}: ${message}`) → first validation error.
 * - `null` + warn log → schema itself is malformed (TypeBox can't evaluate
 *   it, e.g. weird third-party shape). Lenient pass — mirrors `lib/mcp/client.ts`'s
 *   "unprocessable schema accept + log" stance; refusing the whole pipeline
 *   for a weird caller-supplied schema would be overkill.
 *
 * —— 用 TypeBox schema 校验 `parsedJson`。
 * - null 表示通过。
 * - string（`${instancePath}: ${message}`）是第一条错误。
 * - null + warn log 表示 schema 本身 TypeBox 解析不了（caller 给了奇怪的形状）——
 *   走 lenient pass + warn，mirror `lib/mcp/client.ts`「unprocessable schema
 *   也接受」的态度；为了一个怪 schema 把整条 pipeline 拒掉成本太高。
 */
export function checkSchema(schema: TSchema, parsedJson: unknown): string | null {
  try {
    if (Value.Check(schema, parsedJson)) return null;
    const firstError = Value.Errors(schema, parsedJson)[0];
    const path = firstError?.instancePath || '/';
    const message = firstError?.message ?? 'schema validation failed';
    return `${path}: ${message}`;
  } catch (err) {
    debugLog.warn('sub_agent', 'schema:unprocessable', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
