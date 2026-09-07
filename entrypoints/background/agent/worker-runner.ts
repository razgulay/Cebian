// Worker sub-agent runner —— 给 `delegate_task` 工具用：4 种固定 worker role
// (content_writer / frontend_coder / reviewer / researcher) 中的任一种作为
// 隔离 sub-agent 跑到结束，通过 VFS 文件而非主代理上下文交换产物。
//
// 与 `dom-sub-agent-runner.ts` 同层（都在 `entrypoints/background/`），但
// 不注入 tab-specific 工具（虽然 reviewer 用了 execute_js / inspect，runner
// 走 `withDefaultTabId` 兜底自动注入）。
//
// 设计要点：
//   1. **模型三层兜底**：modelOverride（LLM 显式传）→ workerModels[role]
//      （用户在 Settings 配的 per-role 模型）→ mainModel（主会话当前模型，
//      由 delegate_task 工具在 session-manager 上下文里注入）。任一层解析成
//      功即用，全失败返回 ok:false（不抛——保持与 dom-sub-agent-runner 一致
//      的「runner 永远不抛」约定，错误走 result.error）。
//   2. **工具白名单双重保险**：从 `lib/agent/worker-roles` 的 registry 拿
//      whitelist 过滤 `WORKER_TOOL_UNIVERSE`，再**无条件**剥掉
//      TOOL_DELEGATE_TASK / TOOL_DELEGATE_DOM（即便 whitelist 写错，也不让
//      worker 起 sub-agent 或再调 DOM sub-agent 形成 loop）。Subtask 3 的
//      registry test 已钉死白名单不含禁词；这一层是 belt-and-suspenders。
//   3. **路径安全前置**：outputPath / inputFiles 在 delegate_task 工具层
//      （Subtask 5.3）已经 `lib/agent/path-safety` 验证。本 runner 内部不再
//      重复 gate（防重复），仅在 VFS 读失败时返回常规「File not found」
//      错误（与 fs_* 工具一致），不再次抛 VfsScopeError。**Skills hydration**
//      是个例外：runner 内部直接读 `~/.cebian/skills/<name>/SKILL.md`，故
//      必须自己用 `skillRoot(name)` gate（路径安全 helper 已经在 Subtask 5.1
//      加好 skill-root scope）。
//   4. **Prompt 组合（Subtask 5.2）**：pre-pended 顺序为
//      `<worker-skill>` → `<do-not-do>` → `<input-files>` → task。
//      skills / anti-patterns / input-files 全部可选，缺失即 omit block。
//   5. **Single-pass retry（Subtask 5.2）**：3 类机械失败自动 retry 1 次：
//      (a) parse JSON 失败、(b) schema 校验失败、(c) worker 自称 success
//      但 VFS 文件缺失。每类都设 `retryable: true` 在第一次 attempt 的
//      handoff 上，outer `runWorker` 据此决定是否重试。`runnerOk:false`
//      （模型解析 / abort / 异常）一律不 retry——重试不会让这些问题消失。
//      Retry 创建全新 agent（与 dom-sub-agent-runner 同源），无 state 污染。
//   6. **Schema validation（Subtask 5.2）**：`Value.Check(parsed, schema)`
//      from `typebox/value`，与 `lib/mcp/client.ts:113-115` 同源；malformed
//      `expected_schema` → runner error（不 retry，让 LLM 知道自己的输入
//      有问题），schema processing error → lenient pass（与 MCP client 同
//      姿态，避免第三方奇葩 schema 把整条 pipeline 卡住）。
//   7. **生命周期**：acquireKeepAlive / try-finally release（与 dom-sub-agent-
//      runner 同源）；signal.aborted 早退 + 运行时 abort 透传到 agent.abort()。
//   8. **tabId 自动注入**：reviewer role 用了 execute_js / inspect（与
//      dom-sub-agent 同），runner 调 getActiveTabId 拿当前活动 tab id，
//      并用 withDefaultTabId 包一层 —— fs_* 工具收到 tabId 也无害（它们
//      只读 path 参数）。

import type { Api, Model, AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import { parseExpectedSchema, checkSchema } from '@/lib/agent/schema-validate';
import {
  workerModels,
  providerCredentials,
  customProviders,
  type ModelIdentity,
  type WorkerRole,
} from '@/lib/persistence/storage';
import { SKILL_ENTRY_FILE } from '@/lib/persistence/vfs-paths';
import { resolveModel } from '@/lib/providers/resolve-model';
import { acquireKeepAlive, releaseKeepAlive } from '../lifecycle/keepalive';
import { createCebianAgent } from './factory';
import { getAssistantText } from '@/lib/agent/message-helpers';
import { extractJsonOrRaw } from '@/lib/agent/json-extract';
import { stripFrontmatter, truncateBody, MAX_INLINE_BODY } from '@/lib/agent/mention-resolver';
import { skillRoot, sessionRoot } from '@/lib/agent/path-safety';
import {
  getRoleConfig,
  getWorkerToolNames,
  WORKER_TIMEOUT_MS,
  type WorkerRoleConfig,
} from '@/lib/agent/worker-roles';
import { TOOL_DELEGATE_DOM, TOOL_DELEGATE_TASK } from '@/lib/tools/names';
import { vfs } from '@/lib/persistence/vfs';
import { getActiveTabId, withDefaultTabId } from '../dom-sub-agent';
import { debugLog, withSession } from '@/lib/debug/log';
import { fsCreateFileTool } from '@/lib/tools/fs-create-file';
import { fsEditFileTool } from '@/lib/tools/fs-edit-file';
import { fsReadFileTool } from '@/lib/tools/fs-read-file';
import { fsListTool } from '@/lib/tools/fs-list';
import { fsSearchTool } from '@/lib/tools/fs-search';
import { ragInspectTool } from '@/lib/tools/rag-inspect';
import { inspectTool } from '@/lib/tools/inspect';
import { executeJsTool } from '@/lib/tools/execute-js';

// ─── Tool universe ───

/** 4 种 worker role 可能用到的工具并集。runner 启动时从这个池子按 whitelist
 *  过滤得到该 role 的实际 tool list。新增 worker role 的 whitelist 涉及
 *  新工具时，往这里加、再去 `lib/agent/worker-roles.ts` 改 whitelist 即可。 */
const WORKER_TOOL_UNIVERSE: readonly AgentTool<any>[] = [
  fsReadFileTool,
  fsCreateFileTool,
  fsEditFileTool,
  fsListTool,
  fsSearchTool,
  ragInspectTool,
  inspectTool,
  executeJsTool,
];

/** 永远不允许 worker 拿到的两个工具名（即便 whitelist 写错也再剥一遍）。 */
const FORBIDDEN_FOR_WORKERS: ReadonlySet<string> = new Set([
  TOOL_DELEGATE_TASK,
  TOOL_DELEGATE_DOM,
]);

/** `output_content` 截断上限（~50 KB）。超出则标 truncated，harness UI 显示
 *  「文件过大，截断」并保留下载/打开入口。主代理拿到的不应是整本 PDF。 */
const MAX_OUTPUT_CONTENT_CHARS = 50_000;

/** Handoff JSON 契约——worker 回复末尾的 shape。`composePrompt` 把它 append
 *  到 task 末尾（确保每个 worker 都看到一次）；retry 时 `composeRetryPrompt`
 *  会再贴一遍以防 worker 跑偏。`worker-roles.ts` 的 role systemPrompt **不**
 *  再写第二份——单点事实源在本文件里，避免重复字面量漂移。 */
const HANDOFF_CONTRACT_REMINDER =
  'Reply with a JSON object of the form ' +
  '{"status": "success" | "failed" | "partial", "output_file": "<path or null>", ' +
  '"summary": "<one line>", "handoff_notes": "<caveats>"} ' +
  'and end with the literal line END OF HANDOFF.';

// ─── Public types ───

export interface RunWorkerOptions {
  /** worker 要执行的自然语言任务。 */
  task: string;
  /** worker role（4 种固定之一）。 */
  role: WorkerRole;
  /** LLM 显式指定的模型身份（最高优先级）。 */
  modelOverride?: ModelIdentity;
  /** 任务开始前从 VFS 预读并嵌入 task 的文件列表。文件缺失静默跳过（warn）。 */
  inputFiles?: readonly string[];
  /** worker 应写入的输出文件路径。runner 跑完后读回内容（截断）挂到 handoff。 */
  outputPath?: string;
  /** 调用方 session 的 id（用于日志关联 / keepalive 排查）。 */
  sessionId: string;
  /** 主会话当前模型（workerModels[role] 解析失败时回退）。由 delegate_task
   *  工具在 session-manager 上下文里注入；runner 不主动查 session DB。 */
  mainModel?: ModelIdentity | null;
  /** 调用方（主代理）的 AbortSignal。已 abort → 早退；运行中 abort → 透传
   *  到 agent.abort()。 */
  signal?: AbortSignal;
  /** Skill hydration：要自动加载注入 worker 的 skill 名列表。runner 读
   *  `~/.cebian/skills/<name>/SKILL.md`、剥 frontmatter、截断到 100KB，
   *  wrap 在 `<worker-skill>` envelope。文件缺失静默跳过（warn），invalid
   *  name（`isValidSkillName` 拒绝的形态谱）→ 抛 VfsScopeError 让 caller
   *  在 tool 层早 gate。 */
  skills?: readonly string[];
  /** Anti-patterns：要 prepend 给 worker 的「禁止事项」列表。Wrap 在
   *  `<do-not-do>` envelope，置于 skills 之后、input-files 之前。空数组
   *  → block 完全 omit（不留空 wrapper）。 */
  antiPatterns?: readonly string[];
  /** Worker 输出 JSON schema（字符串）。runner 抽完 JSON 后用 typebox/value
   *  校验；失败 → retryable failure。Malformed schema（本身不是合法 JSON）
   *  → runner error（不 retry——LLM 自己的输入有问题）。 */
  expectedSchema?: string;
  /** Single-pass retry 开关。默认 true；tool 层显式设 true，runner 内部
   *  retry 时不传（仅一次）。关闭后 3 类机械失败直接返回给 caller。 */
  enableRetry?: boolean;
}

export interface WorkerHandoff {
  /** Worker 自报的 status（从 handoff JSON 抽）。runner 失败时为 'failed'。 */
  status: 'success' | 'failed' | 'partial';
  /** Runner 级：agent 是否跑到了结束（不抛、不被 abort、能抽到文本）。 */
  ok: boolean;
  /** !ok 时是 runner 失败原因；status=success 但 outputFile 缺失时是 worker
   *  自称成功与 VFS 状态不一致的诊断；schema 校验失败时是 typebox error。 */
  error?: string;
  /** worker 报告的输出文件路径。 */
  output_file?: string;
  /** worker 的一行总结。 */
  summary: string;
  /** worker 的 handoff notes（任意额外说明）。 */
  handoff_notes: string;
  /** outputPath 存在时挂载的文件内容（已截断到 50KB）。 */
  output_content?: string;
  /** 实际用的模型 key（provider/modelId），便于主代理 UI 展示。 */
  modelKey: string;
  /** 当前 role，便于 UI 标识。 */
  role: WorkerRole;
  /** 机械失败标志：parse 失败 / schema 失败 / 文件缺失其一。true 时
   *  outer `runWorker` 据此决定是否自动 retry 一次。Runner-level 错误
   *  （model resolve / abort）一律不 retry（重试不会让这些问题消失）。 */
  retryable?: boolean;
  /** Attempt 计数：1 表示未重试，2 表示已重试一次（即便重试后仍是同种
   *  失败也仍为 2——这是单次自愈的硬上限）。让 UI 能显示「已尝试 N 次」。
   *  锁死成 `1 | 2`：单次自愈的设计就是最多两次；`number` 留着只会让
   *  caller 误传 0 / 3 / undefined 进来 typecheck 通过但语义错。 */
  attempts?: 1 | 2;
  /** True khi attempt 跑过了 `WORKER_TIMEOUT_MS` 还没结束（vs caller abort /
   *  model exception）。让 UI / caller 能区分「timeout fail-fast」与「用户取消」，
   *  配套 actionable hint（「换 model」vs「再试一次」）。Additive —— 老 caller
   *  不读这字段不会 break。 */
  timedOut?: boolean;
  /** Attempt 实际耗时（ms），从 prompt 提交到结果/中断为止。让 log / UI 能
   *  显示「跑了 120000ms 后被 timeout」之类的诊断信息。caller abort / 异常
   *  时也填——任何「没成功结束」的 attempt 都让 caller 看到真实耗时，便于
   *  排查。 */
  attemptDurationMs?: number;
}

// ─── Pure helpers (exported for unit tests) ───

/**
 * 按 role whitelist 过滤工具集；再**无条件**剥掉 `TOOL_DELEGATE_TASK` /
 * `TOOL_DELEGATE_DOM`（recursion / loop 兜底）。保序：原数组中满足
 *  `whitelist ∩ name` 的工具按原顺序输出。
 */
export function filterToolsForRole(
  tools: readonly AgentTool<any>[],
  role: WorkerRole,
): AgentTool<any>[] {
  const whitelist = new Set(getWorkerToolNames(role));
  return tools.filter(
    (t) => whitelist.has(t.name) && !FORBIDDEN_FOR_WORKERS.has(t.name),
  );
}

/** Handoff JSON 的预期形状。worker 可能漏字段，runner 兜默认值。 */
interface ParsedHandoffJson {
  status?: 'success' | 'failed' | 'partial';
  output_file?: string;
  summary?: string;
  handoff_notes?: string;
}

export interface AssembleHandoffArgs {
  /** Runner 是否跑到了抽文本这一步。 */
  runnerOk: boolean;
  /** !runnerOk 时填的错误信息。 */
  runnerError?: string;
  role: WorkerRole;
  modelKey: string;
  /** 调用方声明的 outputPath（runner 据此判断 VFS 文件应存在）。 */
  declaredOutputPath?: string;
  /** VFS 是否确认 declaredOutputPath 存在。 */
  outputFileExists: boolean;
  /** 读到的文件内容（已截断），仅 outputFileExists 时有值。 */
  outputContent?: string;
  /** worker 最后一条 assistant 文本（截断前）。 */
  rawText: string;
  /** `extractJsonOrRaw(rawText).json`。 */
  json: string | null;
  /** 可选 schema 校验开关。提供时 `assembleHandoff` 会在 JSON parse 成功
   *  后跑 typebox `Value.Check`；schema 校验失败 → retryable failure，
   *  schema 本身 malformed → runner-level error（不 retry）。 */
  expectedSchema?: string;
  /** Attempt 计数透传。默认 undefined（兼容老 caller）；新 caller 显式
   *  设 1 或 2 让 UI 能区分是否已 retry。锁死成 `1 | 2`——和 `WorkerHandoff`
   *  同步；上层 runner 只发这两个值。 */
  attempts?: 1 | 2;
  /** True khi attempt 被 `WORKER_TIMEOUT_MS` 中断（setTimeout 触发了 abort）。
   *  只在 branch 1（runnerOk=false）路径生效——其它分支是 worker 跑完了，
   *  不存在 timeout。透传到 handoff.timedOut 让 UI / caller 能区分「timeout
   *  fail-fast」vs「用户取消 / 模型异常」，配套 actionable hint 走不同分支。 */
  timedOut?: boolean;
  /** Attempt 实际耗时（ms），从 createCebianAgent 到结果/中断为止。透传到
   *  handoff.attemptDurationMs，让 log / UI 能诊断「跑了 X ms 后失败」。 */
  attemptDurationMs?: number;
}

/**
 * 把 runner 跑完的散装状态（解析结果 + VFS 验证 + schema 校验 + 错误）合装
 * 成最终 handoff。纯函数，**不**碰 IO，所有判断走参数；这是它能被 unit
 * test 钉住的关键。
 *
 * 状态机：
 * 1. !runnerOk → 立刻 ok:false + status:failed，error 取 runnerError。
 *    非 retryable（runner 失败重试不会让它消失）。
 * 2. JSON parse 失败 → ok:true（runner 跑完了）+ status:failed，
 *    retryable:true，handoff_notes 放 rawText 前 500 字符供主代理诊断。
 * 3. expectedSchema 提供但本身不是合法 JSON → runner-level error
 *    （ok:false，status:failed，retryable 不设）——LLM 自己的输入有问题，
 *    retry 没意义。
 * 4. JSON parse 成功 + schema 校验失败 → ok:true + status:failed，
 *    retryable:true，error 写 `${instancePath}: ${message}`。
 * 5. worker 自称 success + outputPath 声明 + 文件缺失 → ok:true +
 *    status:failed + retryable:true + error 写明（worker 自称成功与 VFS
 *    不一致 = 明确失败信号，重试给 worker 第二次机会写文件）。
 * 6. 其它：透传 worker 自报的 status / summary / notes，可选挂 output_content。
 *    不设 retryable（worker 自报 failed 不是 mechanical failure，让主代理
 *    决定 retry / escalate）。
 */
export function assembleHandoff(args: AssembleHandoffArgs): WorkerHandoff {
  // 1. Runner 没跑成
  if (!args.runnerOk) {
    const handoff: WorkerHandoff = {
      status: 'failed',
      ok: false,
      error: args.runnerError ?? 'Unknown error',
      summary: args.runnerError ?? 'Worker run failed',
      handoff_notes: '',
      modelKey: args.modelKey,
      role: args.role,
    };
    if (args.timedOut) handoff.timedOut = true;
    if (args.attemptDurationMs !== undefined) handoff.attemptDurationMs = args.attemptDurationMs;
    if (args.attempts !== undefined) handoff.attempts = args.attempts;
    // 修：原来 branch 1（runnerOk=false）一律不 retry——「runner-level 错误
    // retry 不会让它消失」是正确原则，但 **timeout** 是例外：worker 被硬
    // abort, 不代表「同一 model + 同一 prompt 再跑 120s 还是会卡」——况且
    // 如果 worker 已经写了一半 output file, retry 让他接着写完比
    // fail-fast 更友好。区分三种情况:
    //   - timeout + file 存在 → retryable:true（mechanical self-heal — file
    //     是半成品, retry 可能把它写完）
    //   - timeout + file 不存在 → retryable:false（同样原因, fail-fast）
    //   - non-timeout（parent abort / exception）→ retryable:false（保持
    //     原原则, zero regression）
    if (args.timedOut && args.outputFileExists) {
      handoff.retryable = true;
    }
    return handoff;
  }

  // 2. JSON 解析失败
  let parsed: ParsedHandoffJson = {};
  if (args.json) {
    try {
      const v = JSON.parse(args.json);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        parsed = v as ParsedHandoffJson;
      }
    } catch {
      // 落到下面的「parse 失败」分支
      parsed = {};
    }
  }
  const parseSucceeded =
    parsed.status !== undefined ||
    parsed.output_file !== undefined ||
    parsed.summary !== undefined ||
    parsed.handoff_notes !== undefined;
  if (!parseSucceeded) {
    const handoff: WorkerHandoff = {
      status: 'failed',
      ok: true,
      retryable: true,
      summary: 'Worker handoff JSON could not be parsed',
      // rawText 截断到 500 字符——主代理 LLM 看前 500 字符足以判断 worker 在
      // 抱怨什么、是否值得 retry；整篇原文通常 > 10KB，主代理 context 撑不住。
      handoff_notes: args.rawText.slice(0, 500),
      modelKey: args.modelKey,
      role: args.role,
    };
    if (args.attemptDurationMs !== undefined) handoff.attemptDurationMs = args.attemptDurationMs;
    if (args.attempts !== undefined) handoff.attempts = args.attempts;
    return handoff;
  }

  // 3. Schema 校验（仅在 expectedSchema 提供时执行）。先看 schema 本身是否
  //    是合法 JSON（malformed → runner error，**不** retry——caller 输入有
  //    问题，重试不会变好），再看 worker 输出是否满足 schema（失败 →
  //    retryable）。顺序很重要：先 malformed gate，避免把 schema parse
  //    失败和 schema validation 失败混淆。
  if (args.expectedSchema !== undefined) {
    const schema = parseExpectedSchema(args.expectedSchema);
    if (schema === null) {
      const handoff: WorkerHandoff = {
        status: 'failed',
        ok: false,
        error: `Invalid expected_schema: not valid JSON`,
        summary: 'Invalid expected_schema',
        handoff_notes: '',
        modelKey: args.modelKey,
        role: args.role,
      };
      if (args.attemptDurationMs !== undefined) handoff.attemptDurationMs = args.attemptDurationMs;
      if (args.attempts !== undefined) handoff.attempts = args.attempts;
      return handoff;
    }
    // `parseExpectedSchema` 已经在前一步挡掉非 JSON 情况，所以这里 schema
    // 是合法 JSON.parse 输出（unknown）。TypeBox 的 Value.Check 在运行时
    // 接受任何对象作为 schema —— typing 只是 compile-time 形状断言，cast
    // 到 TSchema 是局部、显式、不污染外层。
    const schemaError = checkSchema(schema as TSchema, parsed);
    if (schemaError !== null) {
      const handoff: WorkerHandoff = {
        status: 'failed',
        ok: true,
        retryable: true,
        error: `Schema validation failed: ${schemaError}`,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        handoff_notes: typeof parsed.handoff_notes === 'string' ? parsed.handoff_notes : '',
        modelKey: args.modelKey,
        role: args.role,
      };
      if (args.attemptDurationMs !== undefined) handoff.attemptDurationMs = args.attemptDurationMs;
      if (args.attempts !== undefined) handoff.attempts = args.attempts;
      return handoff;
    }
  }

  // 4. 解析成功，但 worker 自称 success + 文件缺失
  const workerStatus = parsed.status;
  const safeStatus: 'success' | 'failed' | 'partial' =
    workerStatus === 'success' || workerStatus === 'partial' ? workerStatus : 'failed';
  const declaredOutput = args.declaredOutputPath;
  if (safeStatus === 'success' && declaredOutput && !args.outputFileExists) {
    const handoff: WorkerHandoff = {
      status: 'failed',
      ok: true,
      retryable: true,
      error: `Worker reported success but output file is missing: ${declaredOutput}`,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      handoff_notes: typeof parsed.handoff_notes === 'string' ? parsed.handoff_notes : '',
      output_file: declaredOutput,
      modelKey: args.modelKey,
      role: args.role,
    };
    if (args.attemptDurationMs !== undefined) handoff.attemptDurationMs = args.attemptDurationMs;
    if (args.attempts !== undefined) handoff.attempts = args.attempts;
    return handoff;
  }

  // 5. 正常路径
  const out: WorkerHandoff = {
    status: safeStatus,
    ok: true,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    handoff_notes: typeof parsed.handoff_notes === 'string' ? parsed.handoff_notes : '',
    modelKey: args.modelKey,
    role: args.role,
  };
  if (parsed.output_file) out.output_file = parsed.output_file;
  if (args.outputContent) out.output_content = args.outputContent;
  if (args.attemptDurationMs !== undefined) out.attemptDurationMs = args.attemptDurationMs;
  if (args.attempts !== undefined) out.attempts = args.attempts;
  return out;
}

// ─── Prompt composition (pure helpers) ───

/** Anti-patterns block：wrap 一组 raw string rule。空数组 → 空串（block
 *  完全 omit，不留空 wrapper；与 `<worker-skill>` / `<input-files>` 同姿态）。
 *  Rule string 不做转义——LLM-facing XML envelope 用作「视觉分段」，不是
 *  真要解析成 DOM 的 XML；trust LLM 看到 <rule> 是 anti-pattern，不是 HTML。 */
export function buildAntiPatternsBlock(rules: readonly string[]): string {
  if (!rules || rules.length === 0) return '';
  const lines = rules.map((r) => `<rule>${r}</rule>`).join('\n');
  return `<do-not-do>\n${lines}\n</do-not-do>`;
}

/** 构建 `<workspace>` block —— worker 的「我在哪个 session 工作」上下文。
 *  Worker sub-agent 是 fresh 创建的，没有 session context；fs_* 工具要求
 *  **absolute path**。不给这个块，worker 只能猜路径（E2E 实测：content_writer
 *  把 content.json 写到了 VFS root `/content.json` 而非
 *  `/workspaces/<sessionId>/content.json`）。这里显式告知：
 *    1. workspace 根绝对路径；
 *    2. 所有 fs_* 调用必须用该根下的绝对路径（含示例）；
 *    3. （若 tool layer 已 resolve output_path）直接把最终绝对路径钉死。
 *  Pure 函数，便于测试。 */
export function buildWorkspaceBlock(sessionId: string, absoluteOutputPath?: string): string {
  const root = sessionRoot(sessionId);
  const lines = [
    '<workspace>',
    `Your session workspace root is: ${root}`,
    'Every path you pass to fs_read_file / fs_create_file / fs_edit_file / fs_list MUST be an absolute path under this root.',
    `Example: to read "content.json" in the workspace, use "${root}/content.json".`,
  ];
  if (absoluteOutputPath) {
    lines.push(`Write your final output file to this absolute path: ${absoluteOutputPath}`);
  }
  lines.push('</workspace>');
  return lines.join('\n');
}

/** composePrompt 的输入 ctx。四个 block 都可选；缺失/空 → omit。 */
export interface PromptContext {
  /** Worker 的 session workspace 上下文（`<workspace>` block）——必须放最前，
   *  让 worker 在读 skill / 红线 / 数据 / 任务之前就知道「文件该落在哪」。 */
  workspaceBlock?: string;
  skillBlocks?: string;
  antiPatternsBlock?: string;
  inputFilesBlock?: string;
}

/** 把 workspace / skill / anti-patterns / input-files block 与 task 按顺序拼成
 *  完整 prompt，末尾附 handoff JSON 契约 reminder。顺序是 hard-coded：
 *    workspace → skills → anti-patterns → input-files → task → HANDOFF_CONTRACT_REMINDER。
 *  理由：
 *  - workspace 根（文件该落在哪）是所有后续动作的前提，必须最先出现；
 *  - guardrails（anti-patterns）应在数据（input-files）之前出现，让 worker 在读
 *    数据之前就知道红线；
 *  - skills（角色 / 流程约束）应在所有运行时上下文之前出现；
 *  - 任务本体在数据之后（worker 带着完整上下文读 task）；
 *  - handoff 契约 reminder 永远在最末——worker 读完 task 后才知道「该回什么 shape」，
 *    这条 reminder **不** 写在 `worker-roles.ts` 的 role systemPrompt 里（避免双
 *    点事实源漂移：role 系统提示只描述角色身份，harness 形式约束统一在 composePrompt）。 */
export function composePrompt(task: string, ctx: PromptContext = {}): string {
  const parts: string[] = [];
  if (ctx.workspaceBlock) parts.push(ctx.workspaceBlock);
  if (ctx.skillBlocks) parts.push(ctx.skillBlocks);
  if (ctx.antiPatternsBlock) parts.push(ctx.antiPatternsBlock);
  if (ctx.inputFilesBlock) parts.push(ctx.inputFilesBlock);
  parts.push(task);
  parts.push(HANDOFF_CONTRACT_REMINDER);
  return parts.join('\n\n');
}

/** Compose 第二次 attempt 的 prompt：保留原 prompt（同一 task / 同一 context
 *  blocks），末尾 append `<retry-feedback>` block 让 worker 看到上一次为何
 *  失败 + 重申 handoff 契约（防 worker 跑偏忘了 JSON shape）。 */
export function composeRetryPrompt(
  originalPrompt: string,
  failedHandoff: WorkerHandoff,
): string {
  const lines: string[] = ['<retry-feedback>', 'Your previous attempt produced:'];
  lines.push(`- status: ${failedHandoff.status}`);
  // summary 总是 string（assembleHandoff 兜底过），但兜底字面是
  // 「Worker handoff JSON could not be parsed」——这种 case 也照实告诉
  // worker，让它知道「你刚才根本没吐 JSON」是 retry 的根因。
  lines.push(`- summary: ${failedHandoff.summary}`);
  if (failedHandoff.error) {
    lines.push(`- error: ${failedHandoff.error}`);
  }
  if (failedHandoff.handoff_notes) {
    lines.push(`- handoff_notes: ${failedHandoff.handoff_notes}`);
  }
  lines.push('Please address the above and reply again.');
  lines.push(HANDOFF_CONTRACT_REMINDER);
  lines.push('</retry-feedback>');
  return `${originalPrompt}\n\n${lines.join('\n')}`;
}

/** 是否需要 retry。Pure 谓词，让 test 能钉死 retry 条件而不必起 agent。
 *  - 必须 retryable=true（标记为可自愈的机械失败）
 *  - 必须 attempts !== 2（已 retry 过一次，硬上限为单次自愈）
 *  - 必须 ok=true（runner 跑完了才有「失败的产物」可言）**或** timedOut=true
 *    （timeout + 已有部分 output file 是新增的例外——worker 被硬 abort，
 *    retry 让他接着写完比 fail-fast 友好；assembleHandoff 只在
 *    timeout+outputFileExists 时才设 retryable，所以这条 OR 不会误开
 *    别的 runner-level 错误） */
export function shouldRetry(handoff: WorkerHandoff): boolean {
  if (handoff.retryable !== true) return false;
  if (handoff.attempts === 2) return false;
  return handoff.ok === true || handoff.timedOut === true;
}

// ─── IO helpers (internal; tested via mock of `vfs`) ───

/** Read `~/.cebian/skills/<name>/SKILL.md`，剥 frontmatter，截断到 100KB，
 *  wrap 在 `<worker-skill name="...">` envelope。File missing / read fail
 *  → `debugLog.warn` + skip（不阻断 task 启动——与 inputFiles 同姿态）。
 *  Invalid skill name（`isValidSkillName` 拒绝的形态谱）→ 抛 VfsScopeError：
 *  这是「LLM 在 skills 参数里传了 `../escape`」的 programmer-error 级别信号，
 *  tool 层（Subtask 5.3）应该 gate 在前；万一漏过，让它 loud-fail。Frontmatter
 *  strip / 100KB cap 复用 mention-resolver（同一 cap 漂移审查已在 mention
 *  路径里建好——worker 路径就不再单写第二份）。 */
async function buildSkillBlocks(skills: readonly string[]): Promise<string> {
  if (!skills || skills.length === 0) return '';
  const blocks: string[] = [];
  for (const name of skills) {
    // skillRoot throws VfsScopeError on invalid name（不做静默 skip）——
    // LLM 在参数里传 `../escape` 是 caller-side bug，应该 loud fail。
    const root = skillRoot(name);
    const skillPath = `${root}/${SKILL_ENTRY_FILE}`;
    try {
      const raw = await vfs.readFile(skillPath, 'utf8');
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      // 复用 mention-resolver 的 frontmatter-strip + 100KB cap 逻辑——mention
      // 和 worker 走同一规则：「YAML 元数据不进 LLM context」「大文件应该
      // 选成普通 attachment」，避免两条 cap 飘移（reviewer 关心 cap 一致性）。
      const content = truncateBody(stripFrontmatter(text), MAX_INLINE_BODY);
      blocks.push(`<worker-skill name="${name}">\n${content}\n</worker-skill>`);
    } catch (e) {
      // File missing / read fail — warn + skip，**不** throw（与 inputFiles
      // 同姿态：缺失 skill 不应阻断 task 启动，caller 拿不到 skill 就当
      // 「没传」处理）。
      debugLog.warn('sub_agent', 'sub_agent:worker:skill:missing_or_unreadable', {
        skillPath,
        err: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
  }
  return blocks.join('\n');
}

/** Read inputFiles，wrap 在 `<input-files>` envelope。File missing / read
 *  fail → `debugLog.warn` + skip（与原 buildWorkerPrompt 同姿态）。 */
async function buildInputFilesBlock(inputFiles: readonly string[]): Promise<string> {
  if (!inputFiles || inputFiles.length === 0) return '';
  const blocks: string[] = [];
  for (const path of inputFiles) {
    try {
      const data = await vfs.readFile(path);
      if (data == null) {
        debugLog.warn('sub_agent', 'sub_agent:worker:input:missing', { path });
        continue;
      }
      const text =
        typeof data === 'string'
          ? data
          : new TextDecoder().decode(data as Uint8Array);
      blocks.push(`<file path="${path}">\n${text}\n</file>`);
    } catch {
      debugLog.warn('sub_agent', 'sub_agent:worker:input:read_error', { path });
    }
  }
  if (blocks.length === 0) return '';
  return `<input-files>\n${blocks.join('\n')}\n</input-files>`;
}

/** 读 outputPath（如有）→ 存在则挂内容到 handoff；不存在则触发「worker 自称
 *  成功但文件不在」的失败信号（在 assembleHandoff 里用 outputFileExists 判断）。 */
async function readOutputIfAny(outputPath: string | undefined): Promise<{
  exists: boolean;
  content?: string;
}> {
  if (!outputPath) return { exists: false };
  try {
    const data = await vfs.readFile(outputPath);
    if (data == null) return { exists: false };
    const text =
      typeof data === 'string'
        ? data
        : new TextDecoder().decode(data as Uint8Array);
    const content =
      text.length > MAX_OUTPUT_CONTENT_CHARS
        ? text.slice(0, MAX_OUTPUT_CONTENT_CHARS) +
          `\n\n... (truncated at ${MAX_OUTPUT_CONTENT_CHARS} chars; file is ${text.length} chars)`
        : text;
    return { exists: true, content };
  } catch {
    return { exists: false };
  }
}

// ─── Internal helpers ───

interface ResolvedWorkerModel {
  model: Model<Api>;
  modelKey: string;
}

/** 模型三层兜底：modelOverride → workerModels[role] → mainModel。
 *  任一层 `ModelIdentity` 经 `resolveModel` 解析成功即用，全失败返回 null。 */
async function resolveWorkerModel(args: {
  role: WorkerRole;
  modelOverride: ModelIdentity | undefined;
  mainModel: ModelIdentity | null;
}): Promise<ResolvedWorkerModel | null> {
  const [wm, creds, customProvs] = await Promise.all([
    workerModels.getValue(),
    providerCredentials.getValue(),
    customProviders.getValue(),
  ]);

  // 注意：保持顺序，modelOverride 最先，mainModel 最后。
  const candidates: (ModelIdentity | null | undefined)[] = [
    args.modelOverride,
    wm[args.role],
    args.mainModel,
  ];

  for (const identity of candidates) {
    if (!identity) continue;
    const model = resolveModel(identity, creds, customProvs ?? []);
    if (model) {
      return { model, modelKey: `${model.provider}/${model.id}` };
    }
  }
  return null;
}

/** runWorkerAttempt 的输入。一个 attempt 是一次完整的 agent lifecycle：
 *  建 agent → prompt → 抽文本 → 读 output → assembleHandoff。不做 retry
 *  判断（那是 outer `runWorker` 的事）；不做 pre-flight（abort / role /
 *  model resolve 也是 outer 的事）。保持内部纯净：相同的输入 + 相同的
 *  agent 行为 → 相同的 handoff。 */
interface RunWorkerAttemptOptions {
  role: WorkerRole;
  model: Model<Api>;
  modelKey: string;
  // 必须是 mutable array —— `createCebianAgent` 内部把它原样塞进
  // AgentOptions.initialState.tools（pi-agent-core 的类型是 mutable）；
  // 上游 `filterToolsForRole` 返回的就是 mutable array，但在这里显式
  // 声明可避免上游换签名时再次踩同样的 readonly-vs-mutable 雷。
  tools: AgentTool<any>[];
  roleConfig: WorkerRoleConfig;
  /** Pre-composed prompt（outer `runWorker` 调 `composePrompt` 后传入，
 *  retry 时 outer 用 `composeRetryPrompt` 再拼一次）。 */
  prompt: string;
  outputPath?: string;
  expectedSchema?: string;
  signal?: AbortSignal;
  sessionId: string;
  /** Attempt 计数（1 或 2），透传到 handoff.attempts。 */
  attempt: 1 | 2;
}

/** 一次 attempt 的完整 lifecycle：建 agent → 跑 → 抽文本 → 读 output →
 *  assembleHandoff。Keepalive 在 attempt 内 acquire/release（避免 retry
 *  跨 attempt 持锁）。信号 listener 在 finally 内 remove，cleanup 安全。
 *
 *  Fail-Fast (Subtask 1):
 *  - 每次 attempt 有 `WORKER_TIMEOUT_MS`（120s）硬上限——超时自动 abort，
 *    返回 `runnerOk:false, timedOut:true`。
 *  - Composed AbortController：把 caller `opts.signal` 与 timer 合成一个
 *    内部 controller，agent 只听这一个 signal（避免在 pi-agent-core 内部
 *    多 listener 互相打架）。Listener 在 `finally` 内 remove。
 *  - 6 个 instrumentation events (`sub_agent:worker:*`) 让 debug log 能看出
 *    attempt 卡在哪一阶段（model resolve / prompt / stream / handoff
 *    extract / output read）。 */async function runWorkerAttempt(
  opts: RunWorkerAttemptOptions,
): Promise<WorkerHandoff> {
  const attemptStartedAt = performance.now();
  const attemptNumber = opts.attempt;

  debugLog.info('sub_agent', 'sub_agent:worker:attempt:start', {
    role: opts.role,
    modelId: opts.model.id,
    modelKey: opts.modelKey,
    attempt: attemptNumber,
    timeoutMs: WORKER_TIMEOUT_MS,
  });

  let result: WorkerHandoff;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  // Composed controller 把 caller signal 与 timeout timer 合到一起；agent
  // 只订阅这个内部 signal，避免外部 caller 中途再换 opts.signal。
  const composedController = new AbortController();
  const onParentAbort = (): void => {
    try {
      composedController.abort();
    } catch {
      /* ignore — composedController 可能已被 timeout 自己 abort 过 */
    }
  };

  acquireKeepAlive();
  try {
    // 链：opts.signal → composedController → agent.abort()
    if (opts.signal) {
      if (opts.signal.aborted) {
        composedController.abort();
      } else {
        opts.signal.addEventListener('abort', onParentAbort, { once: true });
      }
    }
    // 链：timeout → composedController → agent.abort()
    if (!composedController.signal.aborted) {
      timeoutHandle = setTimeout(() => {
        if (!composedController.signal.aborted) {
          timedOut = true;
          debugLog.warn('sub_agent', 'sub_agent:worker:timeout:fired', {
            role: opts.role,
            modelId: opts.model.id,
            attempt: attemptNumber,
            timeoutMs: WORKER_TIMEOUT_MS,
            elapsedMs: Math.round(performance.now() - attemptStartedAt),
          });
          composedController.abort();
        }
      }, WORKER_TIMEOUT_MS);
    }

    try {
      // 1. 建 agent（每次新建，retry 时不带 state contamination）
      const agent = createCebianAgent({
        model: opts.model,
        systemPrompt: opts.roleConfig.systemPrompt,
        thinkingLevel: 'medium',
        tools: opts.tools,
        messages: [],
      });

      // 2. signal 透传：composedController.abort() → agent.abort()
      const onComposedAbort = (): void => {
        try {
          agent.abort();
        } catch {
          /* ignore — abort 在 agent 已结束时无害 */
        }
      };
      composedController.signal.addEventListener('abort', onComposedAbort, { once: true });

      // 2b. Instrumentation subscription：让 debug log 能看到 stream 进
      //     展——「first token」= 真正开始出活，「每个 tool result」= 在
      //     调工具的哪个阶段。仅设 firstTokenEmitted latch 防止重复打
      //     第一个 token 事件。`subscribe` 返回 unsubscribe 函数。
      let firstTokenEmitted = false;
      const unsubscribeStream = agent.subscribe((event: unknown) => {
        const ev = event as { type?: string };
        if (!firstTokenEmitted && (ev.type === 'message_update' || ev.type === 'text_delta')) {
          firstTokenEmitted = true;
          debugLog.info('sub_agent', 'sub_agent:worker:stream:first_token', {
            role: opts.role,
            modelId: opts.model.id,
            attempt: attemptNumber,
            elapsedMs: Math.round(performance.now() - attemptStartedAt),
          });
        }
        if (ev.type === 'tool_result') {
          debugLog.info('sub_agent', 'sub_agent:worker:tool:result', {
            role: opts.role,
            modelId: opts.model.id,
            attempt: attemptNumber,
            elapsedMs: Math.round(performance.now() - attemptStartedAt),
          });
        }
      });

      // 3. 跑
      try {
        await agent.prompt(opts.prompt);
        debugLog.info('sub_agent', 'sub_agent:worker:prompt:sent', {
          role: opts.role,
          modelId: opts.model.id,
          attempt: attemptNumber,
          elapsedMs: Math.round(performance.now() - attemptStartedAt),
        });
        // 修：之前 agent.prompt() 收到 composedController.abort() 时不会抛错
        // （pi-agent-core 把 abort 当 cancel 语义），函数返回时 msgs 里可能只有
        // 部分 text 或空串，flow 继续往下走到 extractJsonOrRaw → "JSON parse
        // fail" → 无用的 retry。这里如果 setTimeout 已在 prompt 运行期间 fire,
        // 主动 throw 让它落进下面的 catch block —— catch 里已经有
        // `runnerError = timedOut ? 'Worker timed out after ...ms'` 分支,
        // 于是会正确流进 `runnerOk: false` + `timedOut: true`.
        if (timedOut) {
          throw new Error('Worker timed out');
        }
      } finally {
        unsubscribeStream();
        composedController.signal.removeEventListener('abort', onComposedAbort);
      }

      // 4. 抽最后一条 assistant 文本
      const msgs = agent.state.messages;
      let rawText = '';
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          rawText = getAssistantText(msgs[i] as AssistantMessage);
          break;
        }
      }
      const { json } = extractJsonOrRaw(rawText);
      debugLog.info('sub_agent', 'sub_agent:worker:handoff:extracted', {
        role: opts.role,
        modelId: opts.model.id,
        attempt: attemptNumber,
        rawTextLength: rawText.length,
        parsedOk: json !== null,
      });

      // 5. 读 output（如果声明了 outputPath）
      const { exists, content } = await readOutputIfAny(opts.outputPath);

      const attemptDurationMs = Math.round(performance.now() - attemptStartedAt);
      // 修：原来这里硬写 `timedOut: false`，但 setTimeout 可能在 `agent.prompt()`
      // 返回前已经 fire（abort 只挂 listener，不抛错），导致 telemetry 报「attempt
      // 正常结束」而实际上 worker 是被 abort 的——debug log 上一片绿色，定位
      // bug 极其痛苦。从闭包读回真实值：timer 触发了 → true.
      debugLog.info('sub_agent', 'sub_agent:worker:attempt:done', {
        role: opts.role,
        modelId: opts.model.id,
        attempt: attemptNumber,
        attemptDurationMs,
        timedOut,
        outputFileExists: exists,
      });

      result = assembleHandoff({
        runnerOk: true,
        role: opts.role,
        modelKey: opts.modelKey,
        rawText,
        json,
        outputFileExists: exists,
        ...(content !== undefined ? { outputContent: content } : {}),
        ...(opts.outputPath ? { declaredOutputPath: opts.outputPath } : {}),
        ...(opts.expectedSchema !== undefined ? { expectedSchema: opts.expectedSchema } : {}),
        attempts: opts.attempt,
        attemptDurationMs,
      });
    } catch (e) {
      const attemptDurationMs = Math.round(performance.now() - attemptStartedAt);
      const isAbort = composedController.signal.aborted;
      const runnerError = timedOut
        ? `Worker timed out after ${WORKER_TIMEOUT_MS}ms (model "${opts.modelKey}" did not respond)`
        : isAbort
          ? 'Aborted'
          : e instanceof Error ? e.message : String(e);
      debugLog.warn('sub_agent', 'sub_agent:worker:attempt:error', {
        role: opts.role,
        modelId: opts.model.id,
        attempt: attemptNumber,
        attemptDurationMs,
        timedOut,
        parentAborted: isAbort && !timedOut,
        error: e instanceof Error ? e.message : String(e),
      });
      // 修：原来这里 `outputFileExists: false` 写死，导致 timeout path 永远
      // 看不到「worker 实际已经写了一半文件」的事实——Phase 1.4 的 smart retry
      // 决策需要知道这一点：file 存在 → retry 让 worker 写完；file 不存在 →
      // 再跑 120s 也是同样结局，fail-fast。Non-timeout catch（parent abort /
      // 真 exception）保持 `false`，zero regression——那些路径本来就不该 retry。
      // 只读 `exists` 标志：branch 1 的 handoff 不携带 output_content（失败
      // handoff 塞部分内容会改变主代理看到的信息面，超出本次修复范围）。
      let timeoutOutputExists = false;
      if (timedOut && opts.outputPath) {
        try {
          const r = await readOutputIfAny(opts.outputPath);
          timeoutOutputExists = r.exists;
        } catch (readErr) {
          // VFS read 失败（罕见）→ 保持 false + log，debug 仍有信号
          debugLog.warn('sub_agent', 'sub_agent:worker:output_read_after_timeout_failed', {
            role: opts.role,
            attempt: attemptNumber,
            error: readErr instanceof Error ? readErr.message : String(readErr),
          });
        }
      }
      result = assembleHandoff({
        runnerOk: false,
        runnerError,
        role: opts.role,
        modelKey: opts.modelKey,
        rawText: '',
        json: null,
        outputFileExists: timedOut ? timeoutOutputExists : false,
        attempts: opts.attempt,
        attemptDurationMs,
        ...(timedOut ? { timedOut: true } : {}),
      });
    }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener('abort', onParentAbort);
    releaseKeepAlive();
  }
  return result;
}

// ─── Main entry ───

/** 跑一个 worker sub-agent 到结束，返回 handoff。Outer orchestration：
 *  pre-flight（abort / role / model resolve / tools / tabId / prompt 组合）
 *  → first attempt → 条件 retry → 一次 done log。Pre-flight 故意不放
 *  keepalive 里（短时操作，让 SW 自然 idle 即可）；keepalive 在每个 attempt
 *  内部 acquire（避免 retry 跨 attempt 持锁）。 */
export async function runWorker(options: RunWorkerOptions): Promise<WorkerHandoff> {
  const { task, role, sessionId, signal } = options;
  const startedAt = performance.now();

  // 1. 早退：已 abort
  if (signal?.aborted) {
    return assembleHandoff({
      runnerOk: false,
      runnerError: 'Aborted before start',
      role,
      modelKey: '',
      rawText: '',
      json: null,
      outputFileExists: false,
    });
  }

  // 2. Role config（registry 内的合法 role 直接拿到；非法的走 throw → runner 错误）
  let roleConfig: WorkerRoleConfig;
  try {
    roleConfig = getRoleConfig(role);
  } catch (e) {
    return assembleHandoff({
      runnerOk: false,
      runnerError: e instanceof Error ? e.message : String(e),
      role,
      modelKey: '',
      rawText: '',
      json: null,
      outputFileExists: false,
    });
  }

  // 3. 解析模型（三层兜底）
  const resolved = await resolveWorkerModel({
    role,
    modelOverride: options.modelOverride,
    mainModel: options.mainModel ?? null,
  });
  if (!resolved) {
    return assembleHandoff({
      runnerOk: false,
      runnerError:
        `No model could be resolved for role "${role}". Configure a per-role model in ` +
        `Settings → Advanced → Worker Models, or pass modelOverride.`,
      role,
      modelKey: '',
      rawText: '',
      json: null,
      outputFileExists: false,
    });
  }
  const { model, modelKey } = resolved;
  debugLog.info('sub_agent', 'sub_agent:worker:model:resolved', {
    role,
    modelId: model.id,
  });

  // 4. 工具集：role whitelist + tabId 注入
  const tabId = await getActiveTabId();
  let tools = filterToolsForRole(WORKER_TOOL_UNIVERSE, role);
  if (tabId != null) {
    tools = tools.map((t) => withDefaultTabId(t, tabId));
  }

  // 5. Prompt 组合：workspace / skills / anti-patterns / input-files 全部可选，
  //    缺失即 omit。IO 部分（skill / input file 读 VFS）并行跑——互不依赖；
  //    anti-patterns 与 workspace 是纯函数，直接调用。
  //    `options.outputPath` 来自 tool layer，已 resolve 成绝对路径
  //    （`/workspaces/<sessionId>/...`），直接钉进 `<workspace>` block。
  const [skillBlocks, inputFilesBlock] = await Promise.all([
    buildSkillBlocks(options.skills ?? []),
    buildInputFilesBlock(options.inputFiles ?? []),
  ]);
  const antiPatternsBlock = buildAntiPatternsBlock(options.antiPatterns ?? []);
  const workspaceBlock = buildWorkspaceBlock(sessionId, options.outputPath);
  const initialPrompt = composePrompt(task, {
    workspaceBlock,
    skillBlocks,
    antiPatternsBlock,
    inputFilesBlock,
  });

  // 6. First attempt
  let handoff = await runWorkerAttempt({
    role,
    model,
    modelKey,
    tools,
    roleConfig,
    prompt: initialPrompt,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.expectedSchema !== undefined ? { expectedSchema: options.expectedSchema } : {}),
    signal,
    sessionId,
    attempt: 1,
  });

  // 7. Optional retry（max 1 次；shouldRetry 在 retryable + ok + 非 attempt=2 时 true）
  const enableRetry = options.enableRetry !== false;
  if (enableRetry && shouldRetry(handoff)) {
    debugLog.info('sub_agent', 'sub_agent:worker:retrying', {
      role,
      status: handoff.status,
      reason: handoff.error ?? handoff.summary,
    });
    const retryPrompt = composeRetryPrompt(initialPrompt, handoff);
    handoff = await runWorkerAttempt({
      role,
      model,
      modelKey,
      tools,
      roleConfig,
      prompt: retryPrompt,
      ...(options.outputPath ? { outputPath: options.outputPath } : {}),
      ...(options.expectedSchema !== undefined ? { expectedSchema: options.expectedSchema } : {}),
      signal,
      sessionId,
      attempt: 2,
    });
  }

  debugLog.info(
    'sub_agent',
    'sub_agent:worker:done',
    withSession(
      {
        ok: handoff.ok,
        status: handoff.status,
        attempts: handoff.attempts ?? 1,
        durationMs: Math.round(performance.now() - startedAt),
        role,
      },
      sessionId,
    ),
  );
  return handoff;
}
