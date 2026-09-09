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

// ─── Reviewer checklist handoff schema (Subtask 2.2) ──────────────────────
//
// Reviewer 角色（`WORKER_ROLES.reviewer`）的 systemPrompt inline 15 条静态
// checklist（Subtask 2.1）后，需要让 reviewer emit 的 handoff JSON 携带结构
// 化的 `checklist: [{item, status, evidence}]` 字段，让主代理 / DelegationCard
// （Subtask 2.3）能 machine-parse 出 fail / warn / pass 三态分布，而不是
// 只能从 prose summary 里 grep 'fail' / 'warn' 字面。
//
// 设计要点：
// 1. `item` 用 stable kebab-case id（`no-localstorage` / `overflow-x-auto` …）
//    而非 numeric `(1)..(15)`：numeric id 在 prompt 里好看，但 schema 校验
//    对 LLM emit 更友好的是 string literal（`evidence: 'line 42 has localStorage'`）
//    —— kebab id 还能 cross-reference future skill `cl-review-checklist` 的
//    item row。`REVIEWER_CHECKLIST_ITEM_IDS` constant 把 numeric ↔ kebab
//    的映射表钉死。
// 2. `evidence` 上限 200 chars：15 条 × 200 = 3000 chars worst case，
//    `MAX_HANDOFF_JSON_CHARS = 2_000` 是 tool-layer render cap 但 handoff
//    内部 JSON 字段总和可以超 —— 真正收紧的是 schema 这层的 maxLength，
//    避免 LLM 写长 evidence 撑爆主代理 context。Plan 原本写 500，实测 prompt
//    已经标"brief (line / pattern)"——200 字够写一行 grep 结果。
// 3. `minItems: 1`：reviewer 必须至少 emit 1 条 —— 哪怕「audit passed all
//    15」也要 emit 一条 `{item: 'all-pass', status: 'pass'}` 显式说明，不能
//    让 caller 看到空数组以为是 worker 漏 emit。这是 schema-as-protocol 的
//    「不要默认 silent-pass」姿态。
// 4. `additionalProperties: false` 在 checklist items + handoff root：
//    避免 LLM 把整段 handoff JSON 当成 checklist item 塞进数组（实测 1 次）。
//    TypeBox 默认 additionalProperties:true，留口子会失去 schema 的 catch-bug
//    价值。
//
// —— 把上面的形状写成 TypeBox 兼容的 JSON Schema literal —— `Value.Check`
// 接受任何对象作为 schema，typing 只是 compile-time 形状断言，所以不需要
// import `Type` 直接写字面量。`reviewerChecklistSchema` 抽出成命名 const
// 是给将来 DelegationCard（Subtask 2.3）渲染 fail/warn/pass 计数复用。
export const REVIEWER_HANDOFF_SCHEMA = {
  type: 'object',
  required: ['status', 'output_file', 'summary', 'handoff_notes', 'checklist'],
  properties: {
    status: { enum: ['success', 'failed', 'partial'] },
    output_file: { type: ['string', 'null'] },
    summary: { type: 'string', maxLength: 200 },
    handoff_notes: { type: 'string' },
    checklist: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['item', 'status', 'evidence'],
        properties: {
          item: { type: 'string', pattern: '^[a-z][a-z0-9-]*$', maxLength: 64 },
          status: { enum: ['pass', 'fail', 'warn'] },
          evidence: { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

// Stable kebab-case item ids for the 15-item reviewer checklist
// (Subtask 2.1 `systemPrompt` 里的 `(1)..(15)` numeric label ↔ schema id
// 映射)。这是「文档级」的 source of truth —— schema 本身用开放 pattern
// `^[a-z][a-z0-9-]*$`（Subtask 2.2 code-review Finding #10 comment vs
// enum），不强制 enum 锁死，让未来加 item 不需要改 schema literal。改这
// 个数组时**先**改 `WORKER_ROLES.reviewer.systemPrompt` 的 id 列表（两处
// 必须同步 —— Subtask 2.2 prompt 末尾的「Allowed `item` ids」段落是 LLM
// 唯一看到的 id 清单），再扩 schema 描述。
//
// Order 与 prompt `(1)..(15)` 一致，让 reader 能从数组 index → numeric
// label 一秒对回去（`(0)` = `(1)`，`(7)` = `(8)`）。
export const REVIEWER_CHECKLIST_ITEM_IDS = [
  'no-localstorage', // (1) fail: no localStorage
  'no-sessionstorage', // (2) fail: no sessionStorage
  'no-document-cookie', // (3) fail: no document.cookie
  'no-indexeddb', // (4) warn: no indexedDB
  'https-only-script-src', // (5) fail: <script src> uses https:// only
  'https-only-link-href', // (6) warn: <link href> uses https://
  'root-color-tokens', // (7) fail: :root defines color tokens
  'prefers-color-scheme', // (8) warn: prefers-color-scheme media query present
  'grid-or-flexbox', // (9) fail: layout uses CSS Grid or Flexbox
  'viewport-meta', // (10) warn: viewport meta tag present
  'title-present', // (11) fail: <title>...</title> present
  'img-alt-attr', // (12) fail: <img> tags have alt attribute
  'prefers-reduced-motion', // (13) warn: prefers-reduced-motion media query present
  'no-inline-event-handlers', // (14) warn: no inline event handlers
  'overflow-x-auto', // (15) fail: wide content uses overflow-x: auto
] as const;

// `ReviewerChecklistItemId` 是数组 element 的 type alias —— AGENTS.md
// 「keep exported surface minimal」：当前没有跨文件 consumer（Subtask 2.3
// DelegationCard 也只 import 数组本身拿 length / 值），un-export 直到真有
// caller 需要。改成 file-local type。
type ReviewerChecklistItemId = (typeof REVIEWER_CHECKLIST_ITEM_IDS)[number];

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
