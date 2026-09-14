// `delegate_task` 工具 — 把主代理自己处理会爆 context 的长任务委派给 4 种固定
// worker role（content_writer / frontend_coder / reviewer / researcher）中的
// 任一种。Worker 作为隔离 sub-agent 跑完整轮（与 dom-sub-agent-runner 同层），
// 通过 VFS 文件（输入 input_files、输出 output_path）与主代理交换产物，最后
// 返回结构化 handoff JSON。**主代理的 context 不会膨胀**——拿到的是一份
// ≤ 4 KB 的 handoff 文本（JSON 截 2 KB + output_content 截 2 KB），不是
// worker 实际写的整篇内容。
//
// 与 `delegate_dom` 工具的对照（设计意图相反，调用模型一致）：
//   - `delegate_dom`：单个固定 sub-agent（cheap 模型 + 只读工具），用于节省
//     「读网页」一类重 IO 任务的 context。**top-level singleton**（无状态）。
//   - `delegate_task`：4 种 worker role（每种 whitelist 不同），用于把长任务
//     拆分 / 隔离。**per-session factory**（tool 层需要 sessionId 做 path 验证）
//     —— 每个 session 拿到自己的实例。
//
// Path-safety gate 顺序（早失败、不调 runner）：
//   1. `args.task` 非空检查（最便宜）。
//   2. `args.output_path` 必须在 session root 内（assertWithinSessionRoot）。
//   3. `args.input_files` 必须都在 session root 内 + VFS 存在
//      （assertInputFilesReadable）。
//   4. `args.skills` 每个名字都通过 skillRoot gate（isValidSkillName 兜底）。
// 失败一律返回 text content（`{ content: [{ type: 'text', text }], details: {} }`），
// 走「错误是 caller 可见的 tool result」通道，不抛 —— 与 `delegate_dom` 同姿态。
// 例外：execute() 首部的开关复核（worker team disabled = policy 错，重新传参救不
// 回）→ throw（is_error 进 LLM，与 rag-search.ts 同款）；「参数形状错」仍返回 text。
//
// 命名：exports 集中在文件末尾（per AGENTS.md "Exports at the bottom"）。

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_DELEGATE_TASK } from '@/lib/tools/names';
import { VfsScopeError } from '@/lib/tools/vfs-whitelist';
import { FileNotFoundError } from '@/lib/agent/path-safety';
import {
  assertInputFilesReadable,
  assertWithinSessionRoot,
  resolveSessionPath,
  skillRoot,
} from '@/lib/agent/path-safety';
import { REVIEWER_HANDOFF_SCHEMA } from '@/lib/agent/schema-validate';
import { roleWritesDeliverable } from '@/lib/agent/worker-roles';
import { workerTeamEnabled, type ModelIdentity, type WorkerRole } from '@/lib/persistence/storage';
import type { WorkerHandoff } from '@/entrypoints/background/agent/worker-runner';
import type { ServerMessage, WorkerLiveStreamEvent } from '@/lib/ipc/protocol';

// ─── Parameters schema ───

// REVIEWER_HANDOFF_SCHEMA 是 `as const` literal object，runner 的 `expectedSchema`
// 字段要 string —— 预先 stringify 一次让 per-item resolver 复用，避免每个
// reviewer call 都重新 JSON.stringify 同一份 literal（cheap 但语义更清晰：
// "this is the canonical string contract"，不是临时 object）。
// `JSON.stringify` on plain object with no functions / undefined values 永远
// 不会 throw。
const REVIEWER_HANDOFF_SCHEMA_STRING = JSON.stringify(REVIEWER_HANDOFF_SCHEMA);

/** Reviewer role 的 expected_schema auto-inject（Subtask 2.2）。
 *  当 caller 没传 `expected_schema` 且 role 是 'reviewer' 时，自动注入
 *  `REVIEWER_HANDOFF_SCHEMA` —— 让 reviewer 第二轮（schema-fail retry）按
 *  结构化 15 条 checklist 重 emit，不用 caller 每次都重复声明 schema。
 *
 *  Caller 显式传的 `expected_schema` 优先级最高 —— auto-inject 只在 caller
 *  没传时兜底，避免覆盖 caller 自己的 schema（如部分 caller 想让 reviewer
 *  emit 更精简的 shape）。
 *
 *  Empty string（trim 后）按 undefined 处理（Subtask 2.2 code-review
 *  Finding #8）：call site 可能把 setting 默认值 '' 透传过来，空串 → 让
 *  parseExpectedSchema 抛「not valid JSON」runner error 是 UX 灾难，等同
 *  没传即可。 */
function defaultExpectedSchemaForRole(role: WorkerRole, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  if (role === 'reviewer') return REVIEWER_HANDOFF_SCHEMA_STRING;
  return undefined;
}

/** 单个 batch item 形态 —— mirror top-level 8 字段（task / role / model_override
 *  / input_files / output_path / expected_schema / skills / anti_patterns），
 *  让 caller 在一个 `delegate_task` call 里串 N 个独立 task 并行跑。
 *  任务**必须独立**——不能 task B 读 task A 的产物。依赖链（A → B）要分
 *  多 delegate_task 串行调用，否则 B 会在 A 写文件之前 race。 */
const DelegateTaskItem = Type.Object({
  task: Type.String({
    description: 'Natural-language task for this batch item. Same semantics as the top-level `task` parameter.',
  }),
  role: Type.Union([
    Type.Literal('content_writer'),
    Type.Literal('frontend_coder'),
    Type.Literal('reviewer'),
    Type.Literal('researcher'),
  ], {
    description:
      'Worker role for this batch item. Same constraints as the top-level `role` parameter — ' +
      'HTML/dashboard/interactive-demo deliverables use `frontend_coder` directly, not `content_writer`.',
  }),
  model_override: Type.Optional(Type.String({
    description: 'Per-item ModelIdentity JSON (same shape as top-level `model_override`).',
  })),
  input_files: Type.Optional(Type.Array(Type.String(), {
    description: 'Per-item VFS input files (same semantics as top-level `input_files`). Resolved to absolute paths internally.',
  })),
  output_path: Type.Optional(Type.String({
    description: 'Per-item VFS output path (same semantics as top-level `output_path`).',
  })),
  expected_schema: Type.Optional(Type.String({
    description: 'Per-item handoff JSON schema (same semantics as top-level `expected_schema`).',
  })),
  skills: Type.Optional(Type.Array(Type.String(), {
    description: 'Per-item skill list (same semantics as top-level `skills`).',
  })),
  anti_patterns: Type.Optional(Type.Array(Type.String(), {
    description: 'Per-item anti-pattern list (same semantics as top-level `anti_patterns`).',
  })),
}, { additionalProperties: false });

/** Batch dispatch 上限。schema `tasks.maxItems` 与 `execute()` 里的 runtime
 *  belt 共用此常量（single source of truth，漂移即测试红）。framework 层
 *  已在 pi-agent-core `execute()` 前跑 `validateToolArguments` 拦过一遍——
 *  runtime belt 兜的是 compat 怪 provider 不吃 schema enforcement 的情形：
 *  LLM 拿到可行动的错误（拆调用），而不是 5+ worker 无声并跑。 */
const MAX_BATCH_ITEMS = 4;

/**
 * 8 个参数 + 第 9 个 `tasks`（batch）。
 *
 * `task` 和 `role` 在 schema 层是 **Optional** —— 这是为了不阻挡 batch
 * 入口（`tasks: [...]` 单独调用）。真正的「必填」校验在 `execute()`
 * 互斥分支里完成：
 *   - 走 batch 分支（`tasks` 非空）→ top-level `task`/`role` 必须空
 *   - 走 single-task 分支 → top-level `task` 非空 + `role` 在 4 literal union
 *   - 两者都不满足 → text error
 *
 * Single source of truth 放 handler 是因为只有 handler 能区分「batch 调用」与
 * 「LLM 漏填参数」两种语义。Schema 层面如果保留 required=['task','role']
 * 会把 batch 路径整个堵死 —— 死锁：schema 不让进 batch，handler 不让混用，
 * LLM 没法表达 batch intent。这条 schema-level relaxation 也在测试里 pin
 * 死（`tasks` only call 必须 Value.Check 通过）。
 *
 * 空数组与「不传」走同一条 path（skill list = [] → runner 跳过 hydration block）。
 *
 * Subtask 1.2：再加一个第 9 个可选参数 `tasks`（1–4 个 DelegateTaskItem 并行
 * dispatch）。与 top-level `task`/`role` 互斥——callable 只用 1 形态
 *（「单 task」或「batch」），不能混。约束：
 *  - `tasks` 必须 ≥1 ≤4（max 4 是 keepalive budget + 4×50 KB content 总开销的 sanity cap）
 *  - 同一 call 里 `tasks` + (`task` 或 `role` 非空) → text error 「don't mix」
 *  - 全部 item 必须**独立**——B 不能 read A 的产物；依赖链要分多 delegate_task
 *
 * 所有 `description` 是 LLM-facing，不走 i18n（与 `delegate_dom` 一致）：
 * 工具 schema 是协议契约，LLM 看英文最稳；UI 文案走 i18n。
 */
const DelegateTaskParameters = Type.Object({
  task: Type.Optional(Type.String({
    description:
      `Natural-language task for the worker sub-agent. Be specific: ` +
      `"Extract 3 RACES cards about photosynthesis, one per grade 3-5, ` +
      `each with 1 question + 1 cite-paragraph reference" beats "write cards". ` +
      `Worker reads from VFS (fs_read_file / fs_list) and writes to VFS (fs_create_file / fs_edit_file). ` +
      `The worker's reply is a JSON handoff (status / output_file / summary / handoff_notes) — ` +
      `do not ask the worker to return long prose in its reply; route the actual content through \`output_path\`. ` +
      `Required when not using \`tasks: [...]\` batch shape. Mutually exclusive with \`tasks\`.`,
  })),
  role: Type.Optional(Type.Union([
    Type.Literal('content_writer'),
    Type.Literal('frontend_coder'),
    Type.Literal('reviewer'),
    Type.Literal('researcher'),
  ], {
    // Subtask 8.9：在 role schema description 加 Fast Lane routing hint——
    // HTML / dashboard / interactive-demo deliverable 直接走 `frontend_coder`，
    // 不经 `content_writer` 文字润色（实测 cebian-debug-20260907-183300.json
    // 主代理把 161 KB HTML 喂 content_writer 触发 4 次冗余 fs_edit_file、
    // 26–63s re-deliberation 一次，120s ceiling fire）。与
    // `<available-workers>` PREAMBLE 同句双布：tool schema 这一层在主代理
    // 选定具体 worker 时还会再 trigger 一次，defense in depth。reviewer
    // 描述顺便纠正 Subtask 8.7 之前的旧措辞（"execute_js / inspect"）。
    description:
      'Which fixed worker role to dispatch. Each role has a different tool whitelist and system prompt — ' +
      'pick the one that matches the task type, not a generic "do it" worker. ' +
      'content_writer: long-form text into VFS (markdown / lesson plans / articles), NOT for HTML artifacts. ' +
      'frontend_coder: HTML / CSS / JavaScript into VFS, no browser tools. ' +
      'Fast Lane: for HTML / dashboard / interactive-demo deliverables use `frontend_coder` directly. ' +
      'reviewer: read-only static text audit of generated artifacts (no DOM execution available); ' +
      'reviewer emits 15-item checklist (REVIEWER_HANDOFF_SCHEMA auto-injected) when caller omits `expected_schema`. ' +
      'researcher: read VFS + query RAG collections; output is structured text or a new VFS file. ' +
      'Required when not using `tasks: [...]` batch shape. Mutually exclusive with `tasks`.',
  })),
  model_override: Type.Optional(Type.String({
    description:
      'Optional. ModelIdentity JSON, e.g. `{"provider":"anthropic","modelId":"claude-sonnet-4-5"}`. ' +
      'Overrides both the per-role model (Settings → Advanced → Worker Models) and the main session model. ' +
      'Use sparingly: typically the configured per-role model is the right choice.',
  })),
  input_files: Type.Optional(Type.Array(Type.String(), {
    description:
      'Optional. VFS file paths (under the session workspace) the worker should read before starting. ' +
      'Each path must be inside the session workspace; missing files are silently skipped with a warning. ' +
      'Files are prepended to the task as a <input-files> block (path → content). ' +
      'Relative paths are auto-resolved to `/workspaces/<sessionId>/...`; the worker receives absolute paths.',
  })),
  output_path: Type.Optional(Type.String({
    description:
      'Optional. VFS file path the worker should write its result to (relative to the session workspace, ' +
      'e.g. "content.json" or "studio.html"). Relative paths are auto-resolved to `/workspaces/<sessionId>/...`; ' +
      'the worker receives the absolute path. The runner verifies the file exists after the worker ' +
      'completes and attaches the (truncated) content to the handoff. If the worker declares success ' +
      'but the file is missing, the runner auto-retries once. ' +
      'Ignored for read-only roles (reviewer / researcher) — they return findings as text in the handoff, ' +
      'and their `output_file` field names the file they audited/read, not a file they wrote.',
  })),
  expected_schema: Type.Optional(Type.String({
    description:
      'Optional. JSON Schema string applied to the worker\'s handoff JSON. On mismatch the runner ' +
      'auto-retries once with the validation error in the retry feedback. ' +
      'Example: `{"type":"object","required":["status","output_file","summary","handoff_notes"],"properties":{...}}`. ' +
      'If the schema itself is malformed JSON, the runner returns an error (no retry — your input was wrong). ' +
      'When `role: "reviewer"` and this field is omitted, the runner auto-injects `REVIEWER_HANDOFF_SCHEMA` ' +
      '(15-item checklist: status / output_file / summary / handoff_notes / checklist: [{item, status, evidence}]) ' +
      'so the reviewer emits a machine-parseable audit result. Caller-supplied schema takes precedence.',
  })),
  skills: Type.Optional(Type.Array(Type.String(), {
    description:
      'Optional. Skill names whose `~/.cebian/skills/<name>/SKILL.md` should be auto-loaded and ' +
      'injected as `<worker-skill>` context blocks (frontmatter stripped, body truncated to 100 KB). ' +
      'Use this when the task follows a known template (e.g. "races-template" for RACES cards) so the ' +
      'worker sees the structure without you re-stating it in the task prompt.',
  })),
  anti_patterns: Type.Optional(Type.Array(Type.String(), {
    description:
      'Optional. List of things the worker must NOT do. Each entry is wrapped in a `<rule>` element ' +
      'inside a `<do-not-do>` block prepended to the prompt. Keep entries short and concrete: ' +
      '"Do not fabricate quotes" beats "be careful with citations".',
  })),
  tasks: Type.Optional(Type.Array(DelegateTaskItem, {
    minItems: 1,
    maxItems: MAX_BATCH_ITEMS,
    description:
      `Optional. Up to ${MAX_BATCH_ITEMS} INDEPENDENT tasks to dispatch in parallel. Each item mirrors the top-level ` +
      'parameters (task / role / model_override / input_files / output_path / expected_schema / ' +
      'skills / anti_patterns / context). Items run concurrently via `Promise.allSettled` — one item failure ' +
      'does not cancel siblings. ' +
      '**Use only for independent tasks.** If task B reads task A\'s output (e.g. content_writer → ' +
      'frontend_coder reads content.json → reviewer reads studio.html), do NOT batch them: worker B ' +
      'may `fs_read_file` before worker A writes the file. Split into separate `delegate_task` calls. ' +
      'Mutually exclusive with the top-level `task`/`role` — pick one shape, not both.',
  })),
  context: Type.Optional(Type.String({
    description:
      'Optional. Context brief the worker has no other way to learn (it cannot see this chat\'s ' +
      'history). State: (1) goal — what success looks like in 1–2 sentences, (2) prior decisions ' +
      'or constraints the worker must respect, (3) acceptance criteria — how to know the work is done. ' +
      'When provided, the runner wraps this in a `<context-brief>` block ahead of `input_files` so ' +
      'the worker reads WHY before WHAT. Strongly recommended for multi-step pipelines and for ' +
      'reviewer/researcher audits; optional for single-shot content_writer / frontend_coder tasks ' +
      'where `task` itself is self-explanatory.',
  })),
}, {
  // Subtask 8.9：在 top-level description 加 Fast Lane routing 提点（一行，
  // 不展开论证——论证在 role param description 和 PREAMBLE 里），让 LLM 在
  // 选 role 之前就先记住 HTML → frontend_coder 的硬约束。
  description:
    'Delegate a sub-task to a fixed worker role (content_writer / frontend_coder / reviewer / researcher). ' +
    'The worker runs as an isolated sub-agent and communicates via VFS files, not the chat context. ' +
    'On success returns the handoff JSON + (truncated) output file content. ' +
    'On failure returns the handoff JSON with status="failed" — read `handoff_notes` to decide whether to retry, ' +
    'refine the task, or escalate to the user. ' +
    'Fast Lane: HTML / dashboard / interactive-demo deliverables go to `frontend_coder`, NOT `content_writer`. ' +
    'For 2–4 independent tasks in parallel, use `tasks: [...]` (up to 4 items, mutually exclusive with top-level `task`).',
});

// ─── Helpers (internal) ───

/** `model_override` 是个 JSON 字符串（TypeBox schema 不便直接嵌 object union），
 *  在 tool 层 parse 一次后传给 runner。失败返回 null 让 caller 转 text error。
 *  解析用宽松策略：吃下 {"provider": "...", "modelId": "..."} 即认为合法，
 *  多余字段会被 runner 忽略（runner 只读这两个）。 */
function parseModelOverride(raw: string | undefined): ModelIdentity | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>).provider === 'string' &&
    typeof (parsed as Record<string, unknown>).modelId === 'string'
  ) {
    return {
      provider: (parsed as Record<string, string>).provider,
      modelId: (parsed as Record<string, string>).modelId,
    };
  }
  return null;
}

/** Handoff 文本上限（cap 两条独立防爆：JSON 主体 + output_content）。
 *  与 worker-runner 内的 MAX_OUTPUT_CONTENT_CHARS（50 KB，给 handoff 内的
 *  output_content 用）**不冲突** —— 这里是主代理 tool result 的总量控制，
 *  runner 端是 worker 产物总量控制；两层 cap 各管一段。 */
const MAX_HANDOFF_JSON_CHARS = 2_000;
const MAX_OUTPUT_CONTENT_IN_RESULT_CHARS = 2_000;

/** 从 handoff JSON 文本里抽 status / output_file / summary / handoff_notes
 *  重新拼一份**精简版**（cap chars）。原 JSON 可能很长（output_file 路径 +
 *  handoff_notes 大段说明），主代理只需要看「成功 / 失败 + 总结 + 关键
 *  路径」，细节在 handoff 文件里也能查。
 *
 *  拼接走 `JSON.stringify(value)` 自动转义 `"` / `\` / 控制字符 —— 直接
 *  模板插值会让 `summary: 'He said "hi"'` 渲染成非法 JSON。runner 的
 *  handoff contract 允许 `output_file: null`（任务无产物），JSON `null` 的
 *  `typeof === 'object'`，下面 `typeof === 'string'` 已自动跳过该字段，
 *  不需要额外 `!== 'null'` 判断。
 *
 *  `timedOut` / `attemptDurationMs` 透传：runner 在 Fail-Fast 路径下会塞
 *  这两个字段，前者让 UI 渲染「timeout / 换 model」提示，后者让 UI 显示
 *  「跑了 X ms」。这两个对 LLM 也有用（模型可以自纠「worker timeout 了，
 *  下次换个更快的 model」），所以保留在精简版里而不是剥掉。
 *
 *  解析失败就降级返回原文 + 截断 —— 不丢信息。 */
function summarizeHandoffJson(rawJson: string): string {
  try {
    const obj = JSON.parse(rawJson) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.status === 'string') parts.push(`"status":${JSON.stringify(obj.status)}`);
    if (typeof obj.output_file === 'string') parts.push(`"output_file":${JSON.stringify(obj.output_file)}`);
    if (typeof obj.summary === 'string') parts.push(`"summary":${JSON.stringify(obj.summary)}`);
    if (typeof obj.handoff_notes === 'string' && obj.handoff_notes) {
      parts.push(`"handoff_notes":${JSON.stringify(obj.handoff_notes)}`);
    }
    if (obj.timedOut === true) parts.push(`"timedOut":true`);
    if (typeof obj.attemptDurationMs === 'number') {
      parts.push(`"attemptDurationMs":${obj.attemptDurationMs}`);
    }
    // Subtask 2.2 code-review Finding #3: surface reviewer audit fail/warn/pass
    // counts so the main agent can programmatically react. 15-entry evidence
    // array 太长不适合进 context（爆 3 KB+），count 聚合保留 fail/warn/pass
    // 决策信号同时只多 ~50 chars。
    const checklistSummary = summarizeChecklistSummary(rawJson);
    if (checklistSummary) {
      parts.push(`"checklist_summary":${JSON.stringify(checklistSummary)}`);
    }
    const compact = `{${parts.join(',')}}`;
    if (compact.length <= MAX_HANDOFF_JSON_CHARS) return compact;
    return compact.slice(0, MAX_HANDOFF_JSON_CHARS) + '…[truncated]';
  } catch {
    // 非 JSON（罕见 — runner 通常吐出 JSON），降级截断
    return rawJson.length <= MAX_HANDOFF_JSON_CHARS
      ? rawJson
      : rawJson.slice(0, MAX_HANDOFF_JSON_CHARS) + '…[truncated]';
  }
}

/** Reviewer checklist 三态计数（Subtask 2.2 code-review Finding #3 fix）。
 *  从 reviewer handoff 的 `checklist: [{item, status, evidence}]` 数组聚合
 *  pass / warn / fail 计数，附在 summarizeHandoffJson 输出末尾，让主代理
 *  LLM 一眼看出「audit 通过了吗？严重程度如何？」而不是只能从 prose
 *  summary 推断。`checklist` 字段本身不重复 emit —— 15 条 evidence 数组
 *  会让 handoff 文本爆 3 KB+，count 聚合才适合进主代理 context。
 *
 *  非 reviewer / 无 checklist 字段 / 空 checklist 数组 → undefined，输出
 *  skip 计数行。空数组也算 undefined —— reviewer 没 emit（minItems gate
 *  让 WorkerHandoff.checklist 是 undefined）和 emit 了空数组（schema-fail
 *  reject 路径）语义等价，都不该让主代理看到 `pass=0 warn=0 fail=0` 的
 *  误导「all-clear」视图。 */
function summarizeChecklistSummary(rawJson: string): { pass: number; warn: number; fail: number } | undefined {
  try {
    const obj = JSON.parse(rawJson) as Record<string, unknown>;
    if (!Array.isArray(obj.checklist) || obj.checklist.length === 0) return undefined;
    let pass = 0;
    let warn = 0;
    let fail = 0;
    for (const entry of obj.checklist) {
      if (entry && typeof entry === 'object' && 'status' in entry) {
        const status = (entry as { status: unknown }).status;
        if (status === 'pass') pass++;
        else if (status === 'warn') warn++;
        else if (status === 'fail') fail++;
      }
    }
    return { pass, warn, fail };
  } catch {
    return undefined;
  }
}

/** output_content 截断（独立于 handoff JSON 截断）。`output_content` 是 runner
 *  从 VFS 读回的 worker 产物（已 50 KB cap），tool 这里再 cap 一遍避免极端
 *  情况下主代理收到 50 KB × N 个 handoff。 */
function summarizeOutputContent(content: string): string {
  if (content.length <= MAX_OUTPUT_CONTENT_IN_RESULT_CHARS) return content;
  return content.slice(0, MAX_OUTPUT_CONTENT_IN_RESULT_CHARS) + '…[truncated]';
}

/** 把 batch handoff 渲染成主代理 tool result 的 text。规则：
 *  - 顶部一行 outer summary（coarse 计数）
 *  - 每个 item 一行：「[index] <modelKey> role=<role> status=<status> attempts=<N>」+ optional output_file
 *  - 每个 item 的 `summary` + `error` 单独行
 *  - 每个 item 的 `checklist_summary`（reviewer only，Subtask 2.2 code-review Finding #6 fix）
 *  - 每个 item 的 `output_content`（若有）作为 labeled chunk
 *  - 末尾 annotation（first item 的 modelKey+role as representative）
 *  总长度 cap `MAX_HANDOFF_JSON_CHARS × items.length + 余量`，避免主代理
 *  收到 16 KB+。这里走和 single-task 一样的 cap-per-item 哲学。
 *
 *  失败 (status: 'failed') outer 不展开 per-item 的 retryable 字段 —— 主代理
 *  通过 batchSummary 拿到 coarse 视图，per-item 详情如有需要再走 outer.ok 看
 *  是否整体有产物。 */
function renderBatchToolResult(handoff: WorkerHandoff): string {
  const lines: string[] = [];
  // Outer summary（coarse 计数 + outer status）
  lines.push(`[batch] ${handoff.summary}`);
  if (handoff.batchSummary) {
    const { total, succeeded, failed, partial, cancelled } = handoff.batchSummary;
    lines.push(
      `[batch-summary] total=${total} succeeded=${succeeded} failed=${failed} partial=${partial} cancelled=${cancelled}`,
    );
  }
  // Per-item 一行
  if (handoff.batch) {
    handoff.batch.forEach((item, idx) => {
      const mk = item.modelKey || '?';
      const attempts = item.attempts ?? 1;
      // Subtask 1.2 review #3: surface per-item `partial` so the chat parser
      // (chat/index.tsx) can map `status === 'partial'` to a meaningful badge
      // instead of silently lumping it with success. `output_file` quoted with
      // double quotes so paths containing `=` (e.g. `?query=value` or
      // `/path=k=v`) don't confuse the space-delimited field parser.
      const outFile = item.output_file
        ? ` file="${item.output_file.replace(/"/g, '\\"')}"`
        : '';
      // 标记 item 自己是否 partial（runner 的 batch 现在把 partial 当
      // success 等价的 "item 内 partial" —— 标 partial 让 caller 能区分
      // "完整成功" vs "item 跑出来了但 runner 标 partial"）。
      const partialTag = item.partial ? ' partial=true' : '';
      lines.push(
        `[item ${idx}] model=${mk} role=${item.role} status=${item.status} attempts=${attempts}${partialTag}${outFile}`,
      );
      if (item.summary) {
        lines.push(`  summary: ${item.summary}`);
      }
      if (item.error) {
        lines.push(`  error: ${item.error}`);
      }
      // Subtask 2.2 code-review Finding #6: surface per-item reviewer audit
      // counts in batch tool result text（与 single-task 路径对称）。从已
      // structured 的 `WorkerHandoff.checklist` 字段聚合，避免重新 parse 整
      // 个 handoff JSON。
      if (item.checklist && item.checklist.length > 0) {
        let pass = 0, warn = 0, fail = 0;
        for (const entry of item.checklist) {
          if (entry.status === 'pass') pass++;
          else if (entry.status === 'warn') warn++;
          else if (entry.status === 'fail') fail++;
        }
        lines.push(`  checklist_summary: pass=${pass} warn=${warn} fail=${fail}`);
      }
      if (item.output_content) {
        const label = item.output_file ?? 'output';
        lines.push(`  --- output_content (${label}) ---`);
        lines.push(`  ${summarizeOutputContent(item.output_content)}`);
      }
    });
  }
  // Annotation
  const annotation = `— via batch worker (${handoff.modelKey || '?'}, role=${handoff.role || '?'}, attempts=${handoff.attempts ?? 1})`;
  lines.push(annotation);
  const text = lines.join('\n');
  // Cap 一次，避免极端 batch（4 item × 2 KB handoff + 4 × 2 KB content = ~16 KB）
  if (text.length <= MAX_HANDOFF_JSON_CHARS * 4 + 1000) return text;
  return text.slice(0, MAX_HANDOFF_JSON_CHARS * 4 + 1000) + '…[truncated]';
}

// ─── Batch item gate (Subtask 1.2) ───
//
// Per-item path-safety + skill + model_override 校验。失败聚合到 caller 一
// 个 text error 上返回，不调 runner。所有 gate 镜像 top-level path-safety
// 路径（line 274-353），保证行为一致。Item-level gate 在 batch dispatch 之前
// 完成（vs 单 task 路径）—— 一个 item 不合法就让整批 fail-fast，不浪费
// runner cycle。

/** Batch item 的 raw 输入形态（来自 `tasks: [...]` 数组，每个元素未 resolve）。 */
interface BatchItemInput {
  task?: string;
  role?: WorkerRole;
  model_override?: string;
  input_files?: readonly string[];
  output_path?: string;
  expected_schema?: string;
  skills?: readonly string[];
  anti_patterns?: readonly string[];
  context?: string;
}

/** Per-item resolved 形态（绝对路径 + modelOverride parsed）—— 喂给
 *  `runBatchWorker` 的 BatchWorkerItem 形态。 */
type BatchItemResolved = {
  task: string;
  role: WorkerRole;
  modelOverride?: ModelIdentity;
  inputFiles?: readonly string[];
  outputPath?: string;
  expectedSchema?: string;
  skills?: readonly string[];
  antiPatterns?: readonly string[];
  context?: string;
};

/** 单个 batch item 的 gate 结果。成功返回 `{ item }`；失败返回 `{ error }`。
 *  `error` 是已构造好的 text content，主代理 execute() 直接 `return result.error`。
 *  `details` 在 FileNotFoundError 路径下承载 `{ suggestions: string[] }`——sibling-name
 *  模糊匹配候选，让 caller 知道「该读谁」而非「自己造一份」。
 *  AGENTS.md: details 是 per-tool structured side channel，不进 LLM context
 *  但 UI 可以消费——这里 widen BatchItemResult 的 details type，从 `{}` 升到
 *  `Record<string, never>` 的超集 `{ suggestions?: string[] }`。 */
type BatchItemResult =
  | { item: BatchItemResolved }
  | { error: AgentToolResult<{ suggestions?: string[] }> };

async function resolveBatchItem(
  sessionId: string,
  raw: BatchItemInput,
  index: number,
): Promise<BatchItemResult> {
  const label = `tasks[${index}]`;

  // 1. task 非空
  if (!raw.task || !raw.task.trim()) {
    return {
      error: {
        content: [{ type: 'text', text: `Error: \`${label}.task\` is required and must not be empty.` }],
        details: {},
      },
    };
  }
  // 2. role 必填（typebox 应已 enforce，runtime 兜底）
  if (!raw.role) {
    return {
      error: {
        content: [{ type: 'text', text: `Error: \`${label}.role\` is required.` }],
        details: {},
      },
    };
  }

  // 3. output_path resolve + assert
  let resolvedOutputPath: string | undefined;
  if (raw.output_path) {
    try {
      resolvedOutputPath = resolveSessionPath(sessionId, raw.output_path);
      assertWithinSessionRoot(sessionId, resolvedOutputPath);
    } catch (e) {
      if (e instanceof VfsScopeError) {
        return {
          error: {
            content: [{ type: 'text', text: `Error: \`${label}.output_path\` is outside the session workspace.` }],
            details: {},
          },
        };
      }
      throw e;
    }
  }

  // 4. input_files resolve + assert
  let resolvedInputFiles: readonly string[] | undefined;
  if (raw.input_files && raw.input_files.length > 0) {
    const absolutePaths: string[] = [];
    try {
      for (const p of raw.input_files) {
        absolutePaths.push(resolveSessionPath(sessionId, p));
      }
      await assertInputFilesReadable(sessionId, absolutePaths);
    } catch (e) {
      if (e instanceof VfsScopeError) {
        return {
          error: {
            content: [{
              type: 'text',
              text: `Error: one or more \`${label}.input_files\` paths are outside the session workspace.`,
            }],
            details: {},
          },
        };
      }
      // File-not-found 路径：throw 自带 message（可能含 Did-you-mean）+ .suggestions。
      // 这条命中是 QA 防「main agent 自创文件」的核心——文本把 sibling-name
      // 候选直接喂回 agent，agent 没有理由再 bịa 一份。
      if (e instanceof FileNotFoundError) {
        return {
          error: {
            content: [{ type: 'text', text: e.message }],
            details: e.suggestions.length ? { suggestions: [...e.suggestions] } : {},
          },
        };
      }
      throw e;
    }
    resolvedInputFiles = absolutePaths;
  }

  // 5. skills 名字合法
  if (raw.skills) {
    for (const name of raw.skills) {
      try {
        skillRoot(name);
      } catch (e) {
        if (e instanceof VfsScopeError) {
          return {
            error: {
              content: [{
                type: 'text',
                text: `Error: \`${label}.skills[${name}]\` is invalid. Use a simple lowercase/dash/dot identifier.`,
              }],
              details: {},
            },
          };
        }
        throw e;
      }
    }
  }

  // 6. model_override parse
  const modelOverride = parseModelOverride(raw.model_override);
  if (raw.model_override && !modelOverride) {
    return {
      error: {
        content: [{
          type: 'text',
          text: `Error: \`${label}.model_override\` must be a JSON object with \`provider\` and \`modelId\` strings.`,
        }],
        details: {},
      },
    };
  }

  // Reviewer auto-schema（Subtask 2.2）：caller 没传 expected_schema 时
  // 注入 REVIEWER_HANDOFF_SCHEMA。Caller 显式传 → 用 caller 的（不覆盖）。
  const resolvedExpectedSchema = defaultExpectedSchemaForRole(raw.role, raw.expected_schema);

  return {
    item: {
      task: raw.task,
      role: raw.role,
      ...(modelOverride ? { modelOverride } : {}),
      ...(resolvedInputFiles ? { inputFiles: resolvedInputFiles } : {}),
      // `roleWritesDeliverable` 从 role registry 的 whitelist 派生：只能写交付物的
      // role 才把 outputPath 交给 runner 做产物存在性检查。reviewer / researcher
      // 的 output_file 是输入目标路径，不能当作它们写出的文件检查。
      ...(roleWritesDeliverable(raw.role) && resolvedOutputPath ? { outputPath: resolvedOutputPath } : {}),
      ...(resolvedExpectedSchema ? { expectedSchema: resolvedExpectedSchema } : {}),
      ...(raw.skills ? { skills: raw.skills } : {}),
      ...(raw.anti_patterns ? { antiPatterns: raw.anti_patterns } : {}),
      ...(raw.context ? { context: raw.context } : {}),
    },
  };
}

// ─── Factory ───

/**
 * Per-session 工厂：每次 `buildSessionToolArray` 调用 create 一次，闭包
 * sessionId 进 execute()，让 path validation 锁在该 session 的 workspace 内。
 *
 * 设计取舍：考虑过顶层 singleton 闭包 lazy 查 sessionId，但 pi-agent-core
 * 的 tool execute() 不传 session context；让 factory 在注册期固定 sessionId
 * 是最直白的做法，与 `run-skill` 工厂（`createSessionRunSkillTool(ctx.sessionId)`
 * 在 `lib/tools/index.ts`）同姿态。
 *
 * `broadcast` 由 background 注入（见 `lib/tools/index.ts` 的
 * `createSessionTools`）：本工具在 lib/ 层，不得 runtime-import
 * `entrypoints/background` 的 `broadcastToViewers`（`lib-no-up-runtime`），
 * 故把「发到哪」这条 IO 边界留给 caller。缺省即不广播 worker stream
 * （worker 照跑，只是 UI 没有实时流）。
 */
export function createDelegateTaskTool(options: {
  sessionId: string;
  broadcast?: (msg: ServerMessage) => void;
  getMainModel?: () => ModelIdentity | null;
}): AgentTool<typeof DelegateTaskParameters> {
  const { sessionId, broadcast, getMainModel } = options;
  // Phase 2 UI feedback: 把 worker-runner 的 text/thinking delta + tool_start
  // 事件转成 `worker_stream` ServerMessage，经注入的 `broadcast` 发给 sidepanel。
  // WorkerCard 拿到后做 token-coalesce + 50ms throttle 渲染 LiveStreamBox。
  // `liveStreamBroadcaster` 是闭包：每次 tool execute 都生成新闭包（每次
  // `delegate_task` 调用的 toolCallId 不同），保持单-call 隔离。
  const liveStreamBroadcaster = (
    toolCallId: string,
    ev: WorkerLiveStreamEvent,
  ): void => {
    broadcast?.({
      type: 'worker_stream',
      sessionId,
      toolCallId,
      ev,
    } satisfies ServerMessage);
  };
  return {
    name: TOOL_DELEGATE_TASK,
    label: 'Delegate Task',
    description:
      'Delegate a sub-task to a fixed worker role (content_writer / frontend_coder / reviewer / researcher). ' +
      'The worker runs as an isolated sub-agent and communicates via VFS files. ' +
      'Returns a structured handoff JSON + (truncated) output content. ' +
      'Use this to keep the main agent\'s context lean: large content goes into VFS files, ' +
      'not into the chat.',
    parameters: DelegateTaskParameters,
    async execute(_toolCallId, args, signal): Promise<AgentToolResult<{ suggestions?: string[] }>> {
      // Promote `_toolCallId` to first-class `toolCallId`：Phase 2 UI feedback
      // 通过它把 worker live stream 关联回外层 delegate_task toolCallId。
      // 下划线前缀移除：现在真在用了。
      const toolCallId = _toolCallId;
      // ── −1. Execute-time 开关复核（worker team 版「belt」） ────────
      // 两侧 gate（tool 注册 + prompt 注入）由 `watchWorkerTeam` 同步刷新
      // 活会话工具数组，但 `refreshAllSessionTools` 失败只 warn——若某会话
      // 带着旧的 Team 工具数组在 Fast 模式下活着，这里是最后一道闸：重新
      // 读开关，关闭 → throw（pi-agent-core 置 is_error 进 LLM，与
      // rag-search.ts 的 disabled 复核同款；区别于本文件里「参数形状错 →
      // text 返回」的那批校验——那不是重新传参能救的）。worker 绝不启动。
      if (!(await workerTeamEnabled.getValue())) {
        throw new Error(
          'delegate_task refused: the worker team is currently disabled (Fast mode). ' +
          'Produce this deliverable with the native tools (fs_create_file / fs_edit_file / read_page …), ' +
          'or ask the user to switch to Team mode (composer chip or Settings → Advanced → Worker team).',
        );
      }
      // Schema 层 task / role 是 Optional（见 DelegateTaskParameters 注释）——
      // 真正「必填」由下面的 mutual-exclusion 分支校验。这里 cast 成 Optional
      // 与 schema 1:1 对齐，避免 TS 错把 schema 放宽当作 contract drift。
      const a = args as {
        task?: string;
        role?: WorkerRole;
        model_override?: string;
        input_files?: readonly string[];
        output_path?: string;
        expected_schema?: string;
        skills?: readonly string[];
        anti_patterns?: readonly string[];
        context?: string;
        tasks?: readonly BatchItemInput[];
      };

      // ── 0. Batch mode 分支（Subtask 1.2） ───────────────────────
      // `tasks` 存在 → 走 batch dispatch（最多 4 item 并行）。与 top-level
      // `task`/`role` 互斥：必须**只**用一个形态，混用直接 text error 早退。
      // batch 内部每个 item 仍走同一套 path-safety gate（resolveSessionPath
      // / assertWithinSessionRoot / assertInputFilesReadable / skillRoot），
      // 失败聚合后整批返回 text error，不调 runner。
      if (a.tasks && a.tasks.length > 0) {
        // 互斥校验：tasks + (task 或 role 非空) → 拒
        const hasTopLevel = !!(a.task && a.task.trim()) || !!a.role;
        if (hasTopLevel) {
          return {
            content: [{
              type: 'text',
              text: 'Error: `tasks` is mutually exclusive with top-level `task`/`role`. Pick one shape: single-task call or batch call, not both.',
            }],
            details: {},
          };
        }
        // 尺寸 belt：framework 的 validateToolArguments 已按 schema maxItems
        // 拦过一遍，这里兜不吃 enforcement 的 provider / 直连调用。形状错与
        // 互斥错同族 → 同样 text 返回（重新拆参可救），早退于任何 IO。
        if (a.tasks.length > MAX_BATCH_ITEMS) {
          return {
            content: [{
              type: 'text',
              text: `Error: batch \`tasks\` supports at most ${MAX_BATCH_ITEMS} items (got ${a.tasks.length}). Split the work into multiple delegate_task calls.`,
            }],
            details: {},
          };
        }
        // Item-level gate（path-safety / skills / model_override per item）
        const resolvedItems: BatchItemResolved[] = [];
        for (let i = 0; i < a.tasks.length; i++) {
          const item = a.tasks[i];
          const result = await resolveBatchItem(sessionId, item, i);
          if ('error' in result) return result.error;
          resolvedItems.push(result.item);
        }
        // 调 batch runner
        const { runBatchWorker } = await import('@/entrypoints/background/agent/worker-runner');
        const batchHandoff = await runBatchWorker({
          tasks: resolvedItems,
          sessionId,
          mainModel: getMainModel?.() ?? null,
          ...(signal ? { signal } : {}),
          // Phase 2 UI feedback: 给每个 batch item 共享同个 broadcaster 闭包；
          // batch 内 worker 的 toolCallId 仍由本层 tool execute 决定（外层
          // delegate_task toolCallId），所有 items 的 stream 统一显示在同一张卡里。
          // 没注入 broadcast 时整个 onLiveStream 不接（runner 侧零 fan-out 开销）。
          ...(broadcast
            ? { onLiveStream: (ev: WorkerLiveStreamEvent) => liveStreamBroadcaster(toolCallId, ev) }
            : {}),
        });
        return {
          content: [{ type: 'text', text: renderBatchToolResult(batchHandoff) }],
          details: {},
        };
      }

      // ── 1. task 非空检查 ──────────────────────────────────────────
      // 注意：schema 层 task 是 Optional（见 DelegateTaskParameters 注释）——
      // 真正的「单 task 形态必填」在这里由 mutual-exclusion 后续分支保证：
      // 这里过了就意味着走 single-task path，必须 `task` 非空 + `role` 在
      // 4 literal union（role 校验见 line 614+）。
      if (!a.task || !a.task.trim()) {
        return {
          content: [{ type: 'text', text: 'Error: `task` is required and must not be empty.' }],
          details: {},
        };
      }
      // role 同样在 schema 层 Optional（为了 batch 入口）。Single-task
      // 路径必须显式校验 —— 否则 runner 拿到 undefined 会 panic。
      const validRoles = ['content_writer', 'frontend_coder', 'reviewer', 'researcher'] as const;
      if (!a.role || !validRoles.includes(a.role)) {
        return {
          content: [{ type: 'text', text: 'Error: `role` is required and must be one of: content_writer, frontend_coder, reviewer, researcher.' }],
          details: {},
        };
      }

      // ── 2. output_path 必须在 session root 内 ─────────────────────
      // 用 `resolveSessionPath` 把 LLM 传入的相对路径 resolve 到绝对路径后
      // 再交给 `assertWithinSessionRoot` 校验（`assertWithinSessionRoot`
      // 期望绝对路径，normalize 后两端真形状对比）。resolve 后**保留**该
      // 绝对值，下游 `runWorker` 直接用绝对路径——worker 不知道 sessionId，
      // 它需要 absolute path 才能用 fs_create_file / fs_read_file 写到
      // /workspaces/<id>/... 而非 VFS root（E2E 实测 bug）。
      let resolvedOutputPath: string | undefined;
      if (a.output_path) {
        try {
          resolvedOutputPath = resolveSessionPath(sessionId, a.output_path);
          assertWithinSessionRoot(sessionId, resolvedOutputPath);
        } catch (e) {
          if (e instanceof VfsScopeError) {
            return {
              content: [{
                type: 'text',
                text: 'Error: `output_path` is outside the session workspace.',
              }],
              details: {},
            };
          }
          throw e;
        }
      }

      // ── 3. input_files 必须都在 session root 内 + VFS 存在 ────────
      // 先 resolve 成绝对路径（LLM 习惯给 relative），再交给 reader
      // 校验存在性 —— reader 内部仍会 normalize 一遍，是幂等的。
      // **resolved 后的绝对路径**传给下游 runner，让 worker 用绝对路径
      // 调用 fs_* 工具写到 /workspaces/<id>/... 而非 VFS root。
      let resolvedInputFiles: readonly string[] | undefined;
      if (a.input_files && a.input_files.length > 0) {
        const absolutePaths: string[] = [];
        try {
          for (const p of a.input_files) {
            absolutePaths.push(resolveSessionPath(sessionId, p));
          }
          await assertInputFilesReadable(sessionId, absolutePaths);
        } catch (e) {
          if (e instanceof VfsScopeError) {
            return {
              content: [{
                type: 'text',
                text: 'Error: one or more `input_files` paths are outside the session workspace.',
              }],
              details: {},
            };
          }
          if (e instanceof FileNotFoundError) {
            return {
              content: [{ type: 'text', text: e.message }],
              details: e.suggestions.length ? { suggestions: [...e.suggestions] } : {},
            };
          }
          // 其它错误是「File not found」类（assertInputFilesReadable 内部抛），
          // 直接透传 — LLM 需要知道哪个文件缺。
          throw e;
        }
        resolvedInputFiles = absolutePaths;
      }

      // ── 4. skills 名字合法（isValidSkillName 内部 gate）──────────
      if (a.skills) {
        for (const name of a.skills) {
          try {
            skillRoot(name);
          } catch (e) {
            if (e instanceof VfsScopeError) {
              return {
                content: [{
                  type: 'text',
                  text: `Error: skill name \`${name}\` is invalid. Use a simple lowercase/dash/dot identifier (no path separators, no \`..\`).`,
                }],
                details: {},
              };
            }
            throw e;
          }
        }
      }

      // ── 5. model_override 解析 ──────────────────────────────────
      const modelOverride = parseModelOverride(a.model_override);
      if (a.model_override && !modelOverride) {
        return {
          content: [{
            type: 'text',
            text: 'Error: `model_override` must be a JSON object with `provider` and `modelId` strings, e.g. `{"provider":"anthropic","modelId":"claude-sonnet-4-5"}`.',
          }],
          details: {},
        };
      }

      // ── 6. mainModel：由 session-manager 注入当前主会话模型 ─────────
      // runner 的兜底顺序是 modelOverride → workerModels[role] → mainModel。
      // 这里不反查 session DB，避免 lib/ 反向依赖 background；只读 tool factory
      // 闭包里传进来的语义回调。缺省仍为 null，保留单测 / 旧调用兼容。
      const mainModel: ModelIdentity | null = getMainModel?.() ?? null;

      // ── 7. Lazy import + 调 runner ──────────────────────────────
      const { runWorker } = await import('@/entrypoints/background/agent/worker-runner');
      // Reviewer auto-schema（Subtask 2.2）：caller 没传 expected_schema 时
      // 注入 REVIEWER_HANDOFF_SCHEMA，让 reviewer emit 结构化 15 条 checklist。
      // Caller 显式传 → 用 caller 的（不覆盖）。
      const resolvedExpectedSchema = defaultExpectedSchemaForRole(a.role!, a.expected_schema);
      const handoff = await runWorker({
        task: a.task,
        role: a.role,
        ...(modelOverride ? { modelOverride } : {}),
        // 透传 resolve 后的绝对路径给 worker —— worker 用绝对路径调
        // fs_* 工具写入 /workspaces/<sessionId>/...，而非 VFS root
        // /content.json 这种「猜测根目录」（E2E 实测 bug）。
        ...(resolvedInputFiles ? { inputFiles: resolvedInputFiles } : {}),
        // 同 resolveBatchItem：只有能写交付物的 role 才把 outputPath 交给 runner
        //（`a.role` 在 single-task 分支已被互斥校验保证非空，见上方 cast）。
        ...(roleWritesDeliverable(a.role!) && resolvedOutputPath ? { outputPath: resolvedOutputPath } : {}),
        ...(resolvedExpectedSchema ? { expectedSchema: resolvedExpectedSchema } : {}),
        ...(a.skills ? { skills: a.skills } : {}),
        ...(a.anti_patterns ? { antiPatterns: a.anti_patterns } : {}),
        ...(a.context ? { context: a.context } : {}),
        sessionId,
        mainModel,
        ...(signal ? { signal } : {}),
        enableRetry: true,
        // Phase 2 UI feedback：把 worker live stream 广播给 sidepanel。没注入
        // broadcast 时整个 onLiveStream 不接（runner 侧零 fan-out 开销）。
        ...(broadcast
          ? { onLiveStream: (ev: WorkerLiveStreamEvent) => liveStreamBroadcaster(toolCallId, ev) }
          : {}),
      });

      // ── 8. Runner-level 失败（model 解析失败 / abort / 异常） ────
      if (!handoff.ok) {
        const modelPart = handoff.modelKey ? ` (${handoff.modelKey})` : '';
        return {
          content: [{
            type: 'text',
            text: `Worker sub-agent failed${modelPart}: ${handoff.error ?? 'unknown error'}`,
          }],
          details: {},
        };
      }

      // ── 9. Handoff → text ───────────────────────────────────────
      // status=failed：worker 报失败（含 3 类机械失败 retry 后的最终结果）。
      // 把 handoff JSON 一起返回 — 主代理需要看 handoff_notes 决定下一步
      // （retry with different task / refine / escalate）。
      // 透传 `timedOut` + `attemptDurationMs` 给 UI（也顺带给 LLM 一次机会
      // 自纠：看到 timeout 就知道换 model / 换 role / 拆任务）。
      const annotation = `— via worker (${handoff.modelKey}, role=${handoff.role}, attempts=${handoff.attempts ?? 1})`;
      const compactJson = summarizeHandoffJson(JSON.stringify({
        status: handoff.status,
        output_file: handoff.output_file,
        summary: handoff.summary,
        handoff_notes: handoff.handoff_notes,
        timedOut: handoff.timedOut,
        attemptDurationMs: handoff.attemptDurationMs,
        // Subtask 2.2 code-review Finding #3：把 reviewer 的 checklist 透
        // 传到 summarizeHandoffJson，让 checklist_summary 聚合能用上。tool
        // 这里按需选字段（不直接 JSON.stringify(handoff) 是为了 cap 输出
        // 大小 + 避免把 runner 内部字段如 batch / attempts 等 leak 出去）。
        // 用 `?.length ?? 0` 守卫避免空 array 走 truthy 路径（empty array
        // 语义 = reviewer 没 emit，不该出现在主代理 view）。
        ...(handoff.checklist && handoff.checklist.length > 0 ? { checklist: handoff.checklist } : {}),
      }));

      if (handoff.status === 'failed') {
        return {
          content: [{
            type: 'text',
            text: `${compactJson}\n\n${annotation}`,
          }],
          details: {},
        };
      }

      // success / partial：JSON + output_content（如果有）
      const chunks: string[] = [compactJson];
      if (handoff.output_content) {
        // label 用 resolvedOutputPath（绝对）而不是 raw `a.output_path`
        // （相对），让用户看到的标签和实际落盘的路径形态一致。
        const outputLabel = handoff.output_file ?? resolvedOutputPath ?? a.output_path ?? 'output';
        chunks.push(`--- output_content (${outputLabel}) ---\n${summarizeOutputContent(handoff.output_content)}`);
      }
      chunks.push(annotation);
      return {
        content: [{ type: 'text', text: chunks.join('\n\n') }],
        details: {},
      };
    },
  };
}
