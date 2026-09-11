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
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import { parseExpectedSchema, checkSchema } from '@/lib/agent/schema-validate';
import {
  workerModels,
  workerRoleTimeouts,
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
  WORKER_TTFT_MS,
  WORKER_IDLE_MS,
  resolveWorkerRoleTimeoutMs,
  resolvePhaseTimeout,
  type StreamPhase,
  type WorkerRoleConfig,
} from '@/lib/agent/worker-roles';
import { TOOL_DELEGATE_DOM, TOOL_DELEGATE_TASK } from '@/lib/tools/names';
import type { WorkerLiveStreamEvent } from '@/lib/ipc/protocol';
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
  /** 任务开始前从 VFS 预读并嵌入 task 的文件列表。文件缺失会在 prompt 末尾
   *  追加 `<missing-inputs>` block（fail-loud），而不是静默跳过——worker 必须知道
   *  它本该有这些文件才能正确标出 scope gap。 */
  inputFiles?: readonly string[];
  /** worker 应写入的输出文件路径。runner 跑完后读回内容（截断）挂到 handoff。 */
  outputPath?: string;
  /** 调用方 session 的 id（用于日志关联 / keepalive 排查）。 */
  sessionId: string;
  /** 主会话当前模型（workerModels[role] 解析失败时回退）。由 delegate_task
   *  工具在 session-manager 上下文里注入；runner 不主动查 session DB。 */
  mainModel?: ModelIdentity | null;
  /** 调用方（主代理）写的「上下文简报」：goal / 约束 / 先前决定 / 验收标准。
   *  Worker 看不到会话历史，这是它唯一的「为什么做」来源（context-handoff
   *  hardening #1：把写 prompt 的纪律变成 schema 契约）。 */
  context?: string;
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
  /** Optional Phase 2 UI feedback hook: 接到 worker 的 text/thinking delta +
   *  tool_execution_start 事件，caller 用它把实时 stream 广播给 chat sidebar
   *  （典型用法：`delegate-task.ts` 的 `liveStreamBroadcaster` 走
   *  `broadcastToViewers`）。未传 = 现有行为，零 IO。`toolCallId` 由 caller
   *  透过 closure 注进 broadcast payload —— runner 这层不知道也不关心
   *  外层 delegate_task toolCallId。
   *
   *  这里是**纯 fan-out**：不参与 IO、决策、retry，只保证「流出的事件频率合
   *  理」（provider 自带 50–100Hz delta；tool_start 是离散事件）。渲染层的
   *  token-coalesce + 50ms 节流在 `lib/agent/worker-live-stream.ts`。 */
  onLiveStream?: (ev: WorkerLiveStreamEvent) => void;
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
  /** True khi attempt 被任一 timer fail-fast 中断（vs caller abort /
   *  model exception）。让 UI / caller 能区分「timeout fail-fast」与「用户取消」，
   *  配套 actionable hint（「换 model」vs「再试一次」）。具体哪一路 timer
   *  触发由 `failureReason` 区分（`ttft` / `idle` / `timeout` / `ceiling`）。
   *  Additive —— 老 caller 不读这字段不会 break。 */
  timedOut?: boolean;
  /** Attempt 实际耗时（ms），从 prompt 提交到结果/中断为止。让 log / UI 能
   *  显示「跑了 120000ms 后被 timeout」之类的诊断信息。caller abort / 异常
   *  时也填——任何「没成功结束」的 attempt 都让 caller 看到真实耗时，便于
   *  排查。 */
  attemptDurationMs?: number;
  /** 区分是哪一种超时机制触发的 fail-fast，让 LLM / 主代理 / UI 给针对性修
   *  复指引：
   *  - `'ttft'`   — Time-to-first-token 超 45s，模型端点 hung / 鉴权错，
   *                retry 同一 model 不会变好（retryable:false）。
   *  - `'idle'`   — stream 静默 20s（中途 token 全停），可能 tool hang，
   *                retry + output file 存在时让 worker 接着写完（retryable:true）。
   *  - `'timeout'`— 兼容旧 world：固定 120s 触发（理论不再 hit，但保留让老
   *                测试 / debug log 兼容）。
   *  - `'ceiling'`— 超过 role 的 timeoutMs（90/120/300s 等），兜底 wall-clock
   *                cap。同 `'idle'` 一样：file 存在 → retryable:true。
   *  - `'stuck_loop'`— Subtask 9.0 新增：模型陷入 fs_read_file / fs_list
   *                loop（同一 path ≥4 次 或 post-write ≥6 consecutive
   *                read-only tool）被 stuck detector 强制 abort。属 deterministic
   *                行为（同一 model + 同一 prompt 再跑还是 loop），所以
   *                **不论 file 是否存在都 retryable:false**——assembleHandoff
   *                branch 1 已显式排除这个 failureReason。L3 file rescue
   *                走 synthesizeStuckLoopHandoff 走 success path（runnerOk:true），
   *                不再走 branch 1。
   *  Undefined = 非 timeout 分支（ok:true / abort / exception），与本字段配套
   *  的 `timedOut` 字段保持正交：`timedOut` 仅 truthy iff `failureReason ∈
   *  {ttft, idle, timeout, ceiling}`. `'stuck_loop'` 时 `timedOut` 也为
   *  true（detector 通过 abort 触发失败，与 timer 触发同姿态）。 */
  failureReason?: 'ttft' | 'idle' | 'timeout' | 'ceiling' | 'stuck_loop';
  /** Batch result：仅 batch dispatch 时有值。`batch.length === tasks.length`，
   *  顺序与 tasks 一致。每个 item 是独立的 WorkerHandoff（自己的 ok / status /
   *  attempts / failureReason）—— 一个 item 失败不影响 siblings。 */
  batch?: readonly WorkerHandoff[];
  /** Batch coarse summary：主代理不用扫 N 个 item 就能判断「全 ok / 部分 ok /
   *  全 fail」。Computed from batch items；batch 缺失时为 undefined。 */
  batchSummary?: BatchSummary;
  /** Per-item self-reported partial：worker 在 handoff JSON 里把 status 标
   *  partial 时设为 true。区别于 runner-level partial（status 字段）：这是
   *  「item 自己说产物不完整」但 batch outer status 仍按 partial 算。
   *  Additive —— 单 task 模式永远为 undefined。 */
  partial?: boolean;
  /** Reviewer checklist：reviewer 角色按 Subtask 2.1 prompt emit 15 条静态
   *  audit 结果（item / status / evidence）让主代理 / DelegationCard 能
   *  machine-parse 出 fail / warn / pass 分布，而不是 grep prose。
   *  校验走 `REVIEWER_HANDOFF_SCHEMA`（`lib/agent/schema-validate.ts`）——
   *  schema fail → retryable，让 reviewer 第二轮有机会按 schema 重 emit。
   *  Additive —— 非 reviewer role 永远为 undefined。 */
  checklist?: readonly ChecklistItem[];
}

/** Reviewer 角色专属 checklist item shape。Stable kebab-case id（来自
 *  `REVIEWER_CHECKLIST_ITEM_IDS` 常量），三态 status（pass / fail / warn，
 *  区别于外层 WorkerHandoff.status 的 success / failed / partial），
 *  evidence 是 200 char 内的 grep 命中证据（line number / pattern literal）。
 *
 *  与外层 `status: 'success' | 'failed' | 'partial'` 的关系：
 *  - reviewer 外层 `status: 'success'` + checklist 里有 fail / warn = 任务
 *    成功交付但 audit 发现问题，让主代理决定 escalate。
 *  - reviewer 外层 `status: 'failed'` + checklist 都空 / 缺 = worker 自身
 *    跑挂了（runner-level），checklist 没有意义。
 */
export interface ChecklistItem {
  item: string;
  status: 'pass' | 'fail' | 'warn';
  evidence: string;
}

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  partial: number;
  cancelled: number;
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
  /** Reviewer 角色（Subtask 2.2）携带 15 条 checklist 结果。
   *  Schema 校验走 `REVIEWER_HANDOFF_SCHEMA`（`lib/agent/schema-validate.ts`），
   *  这里只做 narrow 类型守卫；schema 校验失败会让整个 handoff 走 schema-fail
   *  分支（不挂 checklist 字段，避免把坏数据传给 UI）。 */
  checklist?: unknown;
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
  /** True khi attempt 被 timer 中断（setTimeout 触发了 abort）。
   *  只在 branch 1（runnerOk=false）路径生效——其它分支是 worker 跑完了，
   *  不存在 timeout。透传到 handoff.timedOut 让 UI / caller 能区分「timeout
   *  fail-fast」vs「用户取消 / 模型异常」，配套 actionable hint 走不同分支。
   *
   *  配合下面的 `failureReason` 给 timer 来源细化（ttft / idle / ceiling /
   *  timeout 四种可能），透传到 handoff 字段用于 telemetry + 主代理针对性
   *  修复（ttft → 换 model；idle + file 已写 → retry；ceiling → 用户上调阈值）。 */
  timedOut?: boolean;
  /** Attempt 实际耗时（ms），从 createCebianAgent 到结果/中断为止。透传到
   *  handoff.attemptDurationMs，让 log / UI 能诊断「跑了 X ms 后失败」。 */
  attemptDurationMs?: number;
  /** 哪段 timer 触发 fail-fast（与 `timedOut` 同时设）。undefined = branch 1
   *  但不是 timeout 引起（caller abort / model exception）。Subtask 9.0 增加
   *  `'stuck_loop'` —— 由 stuck detector 主动 abort 触发，行为同 timeout
   *  路径但**永不 retryable**（deterministic）。 */
  failureReason?: 'ttft' | 'idle' | 'timeout' | 'ceiling' | 'stuck_loop';
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
    if (args.failureReason) handoff.failureReason = args.failureReason;
    // 修：原来 branch 1（runnerOk=false）一律不 retry——「runner-level 错误
    // retry 不会让它消失」是正确原则，但 **timeout** 是例外：worker 被硬
    // abort, 不代表「同一 model + 同一 prompt 再跑 120s 还是会卡」——况且
    // 如果 worker 已经写了一半 output file, retry 让他接着写完比
    // fail-fast 更友好。区分三种情况:
    //   - ttft / idle / ceiling + file 存在 → retryable:true（self-heal；ttft
    //     特殊：理论上 endpoint 真挂了 retry 也没用，但若 file 已写一半，
    //     续写比 fail-fast 友好，行为对齐 Phase 1.4）
    //   - ttft / idle / ceiling + file 不存在 → retryable:false（fail-fast）
    //   - non-timeout（parent abort / exception）→ retryable:false（保持
    //     原原则, zero regression）
    //
    // Subtask 9.0: `'stuck_loop'` 显式除外——这是 deterministic 行为
    // （Minimax-M3 / vilao.ai proxy re-read 同 file 已被 reproduce 验证
    // 100% 复现, cebian-debug-20260909-163313.json）。不论 file 是否
    // 存在 retry 都无效，所以两条 case 都 → retryable:false。File 存在
    // 的 case 在 L3 file rescue path 里走 synthesizeStuckLoopHandoff
    // 走 success path (runnerOk:true, branch 6), 不进这里 —— branch 1
    // 只在 file 不存在时 hit。
    if (
      args.failureReason &&
      args.failureReason !== 'stuck_loop' &&
      args.outputFileExists
    ) {
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
  //
  //    Phase 2 (Postel's Law): trước khi `checkSchema` chạy, walker schema
  //    qua `autoTruncateHandoff` để clamp mọi string field vượt `maxLength`
  //    (vd reviewer's `summary` 250 chars → cắt về 200 chars + '...'). Schema
  //    ceiling quá khắc nghiệt cho natural-language fields; clamp-and-accept
  //    gracefully giúp tránh retry-loop lặp lại cùng một length error. Các
  //    shape errors (type / required / pattern / enum) vẫn fail + retryable
  //    như cũ —— clamp không làm giảm sensitivity.
  //
  //    Refactor nhẹ: `parseExpectedSchema` được gọi 1 lần (thay vì 2 lần ở
  //    Phase 1) và reuse cho cả `autoTruncateHandoff` + `checkSchema`.
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
    // Postel's Law clamp: schema-driven walker, không hard-code cap nào.
    // `autoTruncateHandoff` trả về parsed mới (immutable) —— reassign
    // trước khi validate.
    parsed = autoTruncateHandoff(parsed, schema);
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
  // Reviewer checklist pass-through（Subtask 2.2）—— schema 校验已在 branch 3
  // 跑过，这里再做一遍 narrow 类型守卫把坏数据剥掉而不是 throw：
  // - array.length === 0：reviewer emit 空数组 = 「忘了 emit」语义错误，
  //   drop 字段比传空数组给 UI 友好（DelegationCard 看不到就当 reviewer 没
  //   audit，UI 显示「no checklist」fallback 而非「0 pass」误导）。
  // - 单个 item 字段缺 / 类型错：drop 整个 checklist 字段（不让 partial
  //   data 渲染成误导表），不让 worker 自己 trigger schema-fail retry 来
  //   重写 —— schema-fail 已在 branch 3 跑过，没失败说明 narrow 不该再
  //   throw。这层是「UI 兜底」非「合约兜底」。
  if (Array.isArray(parsed.checklist) && parsed.checklist.length > 0) {
    const items: ChecklistItem[] = [];
    let allValid = true;
    for (const raw of parsed.checklist) {
      if (
        raw &&
        typeof raw === 'object' &&
        typeof (raw as ChecklistItem).item === 'string' &&
        ((raw as ChecklistItem).status === 'pass' ||
          (raw as ChecklistItem).status === 'fail' ||
          (raw as ChecklistItem).status === 'warn') &&
        typeof (raw as ChecklistItem).evidence === 'string'
      ) {
        items.push(raw as ChecklistItem);
      } else {
        allValid = false;
        break;
      }
    }
    if (allValid) {
      out.checklist = items;
    }
  }
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

/** composePrompt 的输入 ctx。六个 block 都可选；缺失/空 → omit。 */
export interface PromptContext {
  /** Worker 的 session workspace 上下文（`<workspace>` block）——必须放最前，
   *  让 worker 在读 skill / 红线 / 数据 / 任务之前就知道「文件该落在哪」。 */
  workspaceBlock?: string;
  skillBlocks?: string;
  antiPatternsBlock?: string;
  /** 主代理写的「上下文简报」（`<context-brief>` block）：goal / 约束 / 先前
   *  决定 / 验收标准。Worker 看不到会话历史，这是它唯一的「为什么做」来源——
   *  把写 prompt 的纪律变成 schema 契约（Subtask context-handoff #1）。 */
  contextBlock?: string;
  inputFilesBlock?: string;
  /** 请求了但读不到的 input 清单（`<missing-inputs>` block）——fail-loud：
   *  worker 必须知道它**本该**有这些文件，而不是静默少读后照报 success
   *  （Subtask context-handoff #2）。 */
  missingInputsBlock?: string;
}

/** 把 workspace / skill / anti-patterns / context-brief / input-files /
 *  missing-inputs block 与 task 按顺序拼成完整 prompt，末尾附 handoff JSON
 *  契约 reminder。顺序是 hard-coded：
 *    workspace → skills → anti-patterns → context-brief → input-files →
 *    missing-inputs → task → HANDOFF_CONTRACT_REMINDER。
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
  if (ctx.contextBlock) parts.push(ctx.contextBlock);
  if (ctx.inputFilesBlock) parts.push(ctx.inputFilesBlock);
  if (ctx.missingInputsBlock) parts.push(ctx.missingInputsBlock);
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

// ─── Silent-write fallback (Subtask 8.8 Fix Y) ──────────────────────────
//
// Local OpenAI-compatible proxies (Minimax-M3 via vilao.ai / 9Router 等) 会
// buffer 整个 tool-call argument 流，最后只发 `toolcall_*` + `done`，不留后续
// text 块。结果就是 worker 在 `message_end` 时 `rawText` 为空、`json` 为 null，
// 但声明的 output file 实际已经在 VFS 里——assembleHandoff branch 2 (parse
// fail) 误判 failed。Retry 同一 model + 同一 prompt 是 deterministic 行为，
// 100% 重现「写文件 + 不说话」，徒增 attempts=2 后 fail-fast 的 ceiling 风险。
//
// Detection（这里）+ decision（assembleHandoff branch 6）分两个函数：detection
// 决定「要不要合成 handoff」，decision 仍是 assembleHandoff 既有的 success
// path，零修改、零回归。

/** Silent-write fallback：model 抽不到 text + json parse 失败 + 但 VFS 里的
 *  output file 已存在 → 合成最小合法 handoff，让 assembleHandoff 走 success
 *  path。
 *
 *  触发条件（all 4 都要满足）：
 *    - `declaredOutputPath` 已声明（caller 给 runner 钉过产物路径）
 *    - `outputFileExists === true`（`readOutputIfAny` 在 attempt 末确认）
 *    - `json === null`（`extractJsonOrRaw` 没抽到 JSON）
 *    - `rawText.length === 0`（模型完全没说话；rawText 非空 + json null 是另一
 *      种失败——prose 但忘 JSON shape，应走 retry 让它记得写 JSON shape）
 *
 *  Returns `{rawText, json}` if synthesis applies, `null` otherwise.
 *  Pure function: 无 IO，单元测试可独立覆盖。Runner 调用处拿返回值替换
 *  `rawText` / `json`，再走 `assembleHandoff`——assembleHandoff 看到 status:
 *  'success' + outputFileExists=true → branch 6 (success path) → 挂 output_content，
 *  不触发 retry。
 *
 *  Synthesis 出的 summary / handoff_notes 显式标注「runner synthesized」，
 *  让主代理 LLM / 用户看到这条是兜底产物、不是 model 自己说的——避免掩盖
 *  proxy 行为异常，也便于 debug log 区分 Fix X 生效 vs Fix Y 兜底。 */
export function synthesizeSilentWriteHandoff(args: {
  rawText: string;
  json: string | null;
  declaredOutputPath: string | undefined;
  outputFileExists: boolean;
}): { rawText: string; json: string } | null {
  if (!args.declaredOutputPath) return null;
  if (args.outputFileExists !== true) return null;
  if (args.json !== null) return null;
  if (args.rawText.length !== 0) return null;
  const summary =
    `Worker emitted no text after fs_create_file; output file present at "${args.declaredOutputPath}".`;
  const notes =
    'Runner synthesized this handoff because the worker emitted no text message but the ' +
    'declared output file exists in VFS. This pattern is common with local OpenAI-compatible ' +
    'proxies (e.g. Minimax-M3 via vilao.ai, 9Router) that buffer the entire tool-call ' +
    'argument stream and emit the tool call without a follow-up text message. The output ' +
    'file is the authoritative artifact — its presence is treated as success.';
  const json = JSON.stringify({
    status: 'success',
    output_file: args.declaredOutputPath,
    summary,
    handoff_notes: notes,
  });
  return { rawText: json, json };
}

// ─── Stuck-loop file rescue (Subtask 9.0 L3) ──────────────────────────
//
// Stuck detector (L2) 在 worker re-read 同 file ≥4 次 或 post-write ≥6 次
// consecutive read-only tool 时强制 abort。Abort 时如果 file output 已经
// 写好 (pre-write over-read 时可能没写, post-write verify 时通常已写),
// 不该 fail 整个 attempt —— file 是 worker 在 loop 开始前产出的,
// deterministic loop 行为 retry 不会变好, 把 file 当 success 给主代理看。
//
// Detection 在 subscriber 的 `shouldTriggerStuckLoop` (export); decision
// 在这里 (synthesizeStuckLoopHandoff) + assembleHandoff branch 1
// retryable override (file 缺失 case)。与 `synthesizeSilentWriteHandoff`
// (Subtask 8.8 Fix Y) 分两个 helper 的理由: 单点职责 + summary/notes
// 文案不同, debug log / 主代理 LLM 能区分 Fix Y 兜底 vs Fix StuckLoop 兜底。

/** Stuck-loop file rescue: stuck detector 已 abort + output file 已写好
 *  → 合成最小 handoff, 走 assembleHandoff branch 6 success path。
 *
 *  与 `synthesizeSilentWriteHandoff` 的区别:
 *    - silent-write 要求 `rawText.length === 0` (model 完全没说话);
 *      stuck-loop 不要求 —— model 可能写了大段 prose 但仍被 detector
 *      强制 abort, rawText 内容不靠谱, **不**复用。
 *    - silent-write 不要求 `json === null` (model 可能 emit 有效 handoff
 *      但 silent 流派常 rawText 空); stuck-loop 要求 json 是 null —— 如
 *      果 worker 已 emit 有效 handoff JSON 就不该被 stuck rescue 覆盖,
 *      应让 assembleHandoff 走正常 success path。
 *    - summary / notes 文案明示 "stuck-loop" 而非 "silent write", 区分
 *      两种兜底路径。
 *
 *  Pure function: 无 IO, 单元测试可独立覆盖。Runner 调用处拿返回值替换
 *  `rawText` / `json` 再走 assembleHandoff branch 6 → status:'success' +
 *  no retryable (Subtask 9.0 retryable override 只在 branch 1 生效;
 *  branch 6 永远无 retryable, 无需额外处理)。本 helper 不挂 output_content
 *  —— output_content 由调用方从 readOutputIfAny 单独捕获后传入, 与
 *  silent-write fallback 同模式 (assembleHandoff branch 6 收到
 *  outputContent 才挂 output_content 字段)。
 *
 *  Returns `{rawText, json}` if rescue applies, `null` otherwise. */
export function synthesizeStuckLoopHandoff(args: {
  declaredOutputPath: string | undefined;
  outputFileExists: boolean;
}): { rawText: string; json: string } | null {
  if (!args.declaredOutputPath) return null;
  if (args.outputFileExists !== true) return null;
  const summary =
    `Worker entered a stuck-loop after fs_create_file; output file present at "${args.declaredOutputPath}".`;
  const notes =
    'Runner detected a stuck-loop (same path repeated ≥4 times OR post-write over-read ≥6) and ' +
    'aborted the attempt. The output file is treated as authoritative since it was written before ' +
    'the loop started. This is a deterministic model behavior pattern seen with local OpenAI-compatible ' +
    'proxies (e.g. Minimax-M3 via vilao.ai / 9Router) — retry would not change the outcome.';
  const json = JSON.stringify({
    status: 'success',
    output_file: args.declaredOutputPath,
    summary,
    handoff_notes: notes,
  });
  return { rawText: json, json };
}

// ─── Stuck-loop detector (Subtask 9.0 L2) ─────────────────────────────
//
// Pure decision helper —— runner subscriber 调一次决定是否触发 abort。
// 拆成 export pure function 让 unit test 能钉死 threshold, 不必起 agent。
//
// Trigger 决策表 (两个 threshold, OR):
//   A) **same-path ≥4**: 同一 file path 在 `fs_read_file` 连续出现 4 次
//      (`fs_list` 无 path 不计数, 也不 reset)。防 pre-write over-read
//      (model 反复读同一 file 永远不写) + post-write over-read (model
//      反复 verify 自己刚写的 file)。
//   B) **post-write ≥6**: 已见至少 1 次 write/edit tool, 此后连续
//      read-only ≥6 次。防「不同 path 也算 loop」场景 (model 写完
//      后扫全 VFS 想 verify) + 给研究类 role (researcher/reviewer)
//      留余地: 它们**没有** write tool, hasWritten 永远 false, 这条
//      永远不触发 → 研究型 multi-file read 是合法的。
//
// Write/edit tool (fs_create_file / fs_edit_file) reset 所有 counter
// (`consecutiveReads` / `sameChunkRepeats` / `lastReadSignature`), 然后
// `hasWrittenThisAttempt = true` 永久 sticky 直到 attempt 结束。

/** Reason tag for stuck_loop trigger — used in debug log + assert pure
 *  decision table in test. */
export type StuckLoopReason = 'same_path_repeat' | 'post_write_over_read';

/** Decide whether the current tool_execution_start event should fire
 *  stuck_loop abort. Pure helper — no IO, no closure reads. Caller passes
 *  all state explicitly so unit test can pin threshold boundaries.
 *
 *  Return shape: `{ trigger: false, reason: null }` (don't fire) or
 *  `{ trigger: true, reason: 'same_path_repeat' | 'post_write_over_read' }`
 *  (fire stuck_loop abort).
 *
 *  Phase 2 (smart dedup, Subtask 9.0 follow-up): the `sameChunkRepeats`
 *  counter is incremented by the caller only when the **full read
 *  signature** (`path|start_line|end_line`) is identical to the previous
 *  read. Legitimate pagination — 4 reads of the same 60 KB file with
 *  increasing `start_line` — keeps the counter at 1 instead of climbing
 *  to 4. This prevents the false-positive that
 *  `cebian-debug-20260909-211043.json` attempt 4 reproduced (reviewer
 *  reading `contact-form.html` in chunks tripped Threshold A before).
 *
 *  Threshold math unchanged from Phase 1:
 *    - Threshold A (`sameChunkRepeats ≥ 4`): pre-write over-read, or
 *      post-write same-chunk verify loop (same chunk = same path **and**
 *      same range). `fs_list` without path makes caller reset the
 *      counter (`lastReadSignature = undefined`).
 *    - Threshold B (`consecutiveReads ≥ 6` with `hasWrittenThisAttempt`):
 *      post-write over-read, regardless of chunk identity. Researcher /
 *      reviewer (`hasWritten` always false) never trip Threshold B.
 *
 *  Write/edit tool (fs_create_file / fs_edit_file) resets both counters
 *  (`consecutiveReads` / `sameChunkRepeats` / `lastReadSignature`), then
 *  sticky-sets `hasWrittenThisAttempt = true` until attempt ends.
 */
export function shouldTriggerStuckLoop(args: {
  toolName: string;
  toolArgs: unknown;
  /** Number of consecutive read-only tool calls in this attempt (caller
   *  tracks; reset to 0 on write/edit tool). */
  consecutiveReads: number;
  /** Number of consecutive reads with the **same** `lastReadSignature`
   *  (path + start_line + end_line tuple). Phase 2: was `samePathRepeats`
   *  in Phase 1, renamed to `sameChunkRepeats` to reflect that the
   *  signature now includes the line range. Caller resets to 0 on
   *  signature mismatch or `fs_list` without path. */
  sameChunkRepeats: number;
  /** Signature = `${path}|${start_line ?? ''}|${end_line ?? ''}` —
   *  identical sig = same chunk; different sig = pagination transition
   *  (caller resets counter). `undefined` if last call was fs_list
   *  without path. */
  lastReadSignature: string | undefined;
  /** True iff at least one fs_create_file / fs_edit_file has been seen
   *  in this attempt. Researcher/reviewer (no write tool) → always false. */
  hasWrittenThisAttempt: boolean;
}): { trigger: boolean; reason: StuckLoopReason | null } {
  const isReadOnly = args.toolName === 'fs_read_file' || args.toolName === 'fs_list';
  if (!isReadOnly) return { trigger: false, reason: null };
  // Threshold B first: post-write over-read —— 让 post-write verify loop
  // (不论同 chunk 还是不同 chunk) 都被抓住. Threshold A 兜底防 pre-write
  // over-read (cùng chunk, không bao giờ viết).
  if (args.hasWrittenThisAttempt && args.consecutiveReads >= 6) {
    return { trigger: true, reason: 'post_write_over_read' };
  }
  if (args.sameChunkRepeats >= 4) {
    return { trigger: true, reason: 'same_path_repeat' };
  }
  return { trigger: false, reason: null };
}

// ─── buildWorkerRunnerError (Subtask 9.0 Finding #2 follow-up) ──────────────
//
// Pure formatter —— catch block 拿到 `failureReason` + abort 标志 + 原始
// exception 后, 拼出 user-visible runnerError。Decision table:
//
//   failureReason=undefined, isAbort=true            → "Aborted"
//   failureReason=undefined, isAbort=false           → e.message / String(e)
//   failureReason='ttft'                             → ttft-specific 文案
//   failureReason='idle'                             → idle-specific 文案
//   failureReason='stuck_loop'                       → 「Worker aborted: stuck-loop detected」+ duration
//   failureReason='ceiling' (or other)               → 「Worker timed out after Xms」
//
// 为什么 stuck_loop 必须用「aborted」而不是「timed out」: stuck_loop 是
// detector 主动 abort 的 deterministic loop, 不是等 ceiling 烧满。用
// 「timed out」会误导 user 去调 ceiling 配置, 但根本原因是 model loop,
// ceiling 调长也没用。Duration 字段保留方便对比 fix 前 300s 烧满 → 现
// 在 30–60s abort, 一眼看出 detector 生效。
export function buildWorkerRunnerError(args: {
  reason: 'ttft' | 'idle' | 'ceiling' | 'stuck_loop' | undefined;
  modelKey: string;
  attemptDurationMs: number;
  attemptCeilingMs: number;
  isAbort: boolean;
  originalError: unknown;
}): string {
  const { reason, modelKey, attemptDurationMs, attemptCeilingMs, isAbort, originalError } = args;
  if (reason) {
    if (reason === 'ttft') {
      return `Worker timed out: no first token within ${WORKER_TTFT_MS}ms (model "${modelKey}" did not respond)`;
    }
    if (reason === 'idle') {
      return `Worker timed out: stream idle for ${WORKER_IDLE_MS}ms (model "${modelKey}" stalled)`;
    }
    if (reason === 'stuck_loop') {
      return `Worker aborted: stuck-loop detected (same path read ≥4 times or post-write over-read ≥6) after ${attemptDurationMs}ms — model "${modelKey}" was repeatedly re-reading instead of emitting handoff`;
    }
    // 'ceiling' (or any future failureReason)
    return `Worker timed out after ${attemptCeilingMs}ms (model "${modelKey}" did not respond)`;
  }
  // reason === undefined: distinguish parent-abort from genuine exception
  if (isAbort) return 'Aborted';
  return originalError instanceof Error ? originalError.message : String(originalError);
}

// ─── autoTruncateHandoff (Subtask 9.0 Phase 2 B: Postel's Law) ──────────────
//
// Pure walker —— clamp schema-bounded string fields về schema's `maxLength`
// (nếu có) trước khi `checkSchema` chạy。Schema ceiling (vd reviewer
// `summary.maxLength = 200`) 对 reviewer's natural-language prose 太苛刻
// (`handoff_notes` 经常 250+ chars 的 bug-report 上下文)；Phase 1
// hard-fail + retry-only 让事情更糟 (retry 仍然因同一 length error 失败，
// 浪费 attempt)。根据 Postel's Law ("be liberal in what you accept")，
// runner 用 "..." 后缀 graceful clamp —— schema validation 现在只在
// genuine shape error (type / required / pattern / enum) 上失败，仍按
// retryable 旧逻辑走。`handoff_notes` 在 schema 里没有 `maxLength` →
// 不 clamp (reviewer 可以写长)。
//
// Schema 是 cap 的 source of truth —— helper 递归走 `schema.properties`，
// 不硬编码任何 cap。Phase 2 只覆盖 TypeBox `Value.Check` 接受的 JSON Schema
// 子集 + `REVIEWER_HANDOFF_SCHEMA` 实际用的部分：
//   - top-level string + `maxLength` → 直接 clamp value
//   - 顶层 array of object → recurse 1 cấp vào items (covers
//     `checklist.items.*` pattern)。
// **Recursive bound**：array-of-object 链任意深度都能继续 recurse
// (每层通过 `applyClampToField` 重新进入)；但 **non-array object
// properties** 不向下 recurse (顶层 `properties.foo` 是 object 时不进
// 入 `foo.properties.bar`)。如果将来 schema 改成 nested-object
// properties 形态，walker 必须扩 —— 是 pure refactor，不改 public API。
//
// `parsed` argument 在以下情况 trả về unchanged：
//   - `schema` 不是 object / 没有 `.properties` (malformed 或 schema 不
//     是 object shape)
//   - `parsed` 中所有 string value 都已经 ≤ schema cap (no work needed)
// Output 始终是新对象 (immutable update) —— caller reassigns
// `parsed = autoTruncateHandoff(parsed, schema)` —— 不 mutate argument。
//
// Pin: `parsed.summary = 'a'.repeat(250)` với schema cap 200 → output
// `'a'.repeat(197) + '...'` (length = 200 exactly)。`maxLength < 3` 时
// ellipsis suffix 会超出 cap (vd `maxLength=2` → output `'...'` length 3)；
// 当前所有 schema cap (200/200/64) 都 ≥ 64，所以不会触发；guard 在
// `applyClampToField` 里以 `maxLength ≥ 3` 为前提。
export function autoTruncateHandoff(
  parsed: ParsedHandoffJson,
  schema: unknown,
): ParsedHandoffJson {
  // 始终 shallow-clone `parsed` —— immutability contract: helper 永不
  // mutate argument。即使 schema invalid 也要 clone，让 caller 可以
  // 比较 `out !== parsed` 来 detect "no schema" / "no work" downstream
  // (nếu cần)。`out` 被当作 `Record<string, unknown>` 用于 walker 字段
  // 读写 (`ParsedHandoffJson` 没有 index signature，不能 generic key
  // read/write)；最终结果 cast 回 `ParsedHandoffJson` 匹配 public
  // signature —— runtime shape 是 input 的 spread，cast 是 safe 的。
  const out = { ...parsed } as Record<string, unknown>;
  if (!schema || typeof schema !== 'object') return out as ParsedHandoffJson;
  const s = schema as { properties?: unknown };
  if (!s.properties || typeof s.properties !== 'object') return out as ParsedHandoffJson;
  const properties = s.properties as Record<string, unknown>;
  for (const [key, propSchema] of Object.entries(properties)) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value === undefined) continue;
    applyClampToField(out, key, value, propSchema);
  }
  return out as ParsedHandoffJson;
}

/** 对 `parsed` 的 1 个 field 应用 schema-driven clamp。
 *  - Mức 1 (top-level string + maxLength) 是主路径
 *  - 若 schema 是 array of object，recurse 1 cấp vào items
 *    (covers `REVIEWER_HANDOFF_SCHEMA` `checklist.items.*` pattern)
 *  - file-local helper，public API 不导出 (AGENTS.md "keep exported
 *    surface minimal") */
function applyClampToField(
  out: Record<string, unknown>,
  key: string,
  value: unknown,
  propSchema: unknown,
): void {
  if (!propSchema || typeof propSchema !== 'object') return;
  const ps = propSchema as {
    type?: unknown;
    maxLength?: unknown;
    items?: unknown;
    properties?: unknown;
  };
  // String + maxLength → clamp value trực tiếp. Formula `slice(0, n-3)
  // + '...'` 保证 `out.length === maxLength` (200 cap → 197 + '...' =
  // 200)。`maxLength < 3` 时 `slice(0, n-3)` 退化成空串 + '...' (length
  // 3 > cap) —— current schemas cap 都 ≥ 64, JSDoc 已 pin 前提。
  if (ps.type === 'string' && typeof ps.maxLength === 'number') {
    if (typeof value === 'string' && value.length > ps.maxLength) {
      out[key] = value.slice(0, ps.maxLength - 3) + '...';
    }
    return;
  }
  // Array of objects: recurse 1 level vào items (covers REVIEWER_HANDOFF_SCHEMA
  // `checklist.items.*` pattern)。Mỗi item 在 clamp sub-field 之前先
  // shallow-clone，保持 array level 的 immutability。
  if (
    ps.type === 'array' &&
    ps.items &&
    typeof ps.items === 'object' &&
    Array.isArray(value)
  ) {
    const itemsSchema = ps.items as {
      type?: unknown;
      properties?: unknown;
    };
    if (
      itemsSchema.type === 'object' &&
      itemsSchema.properties &&
      typeof itemsSchema.properties === 'object'
    ) {
      const subProperties = itemsSchema.properties as Record<string, unknown>;
      const newArr = value.map(item => {
        if (!item || typeof item !== 'object') return item;
        const cloned = { ...(item as Record<string, unknown>) };
        for (const [subKey, subSchema] of Object.entries(subProperties)) {
          applyClampToField(
            cloned,
            subKey,
            (item as Record<string, unknown>)[subKey],
            subSchema,
          );
        }
        return cloned;
      });
      out[key] = newArr;
    }
  }
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

/** Read inputFiles，wrap 在 `<input-files>` envelope；同时把读不到的 path 收集
 *  成 missing 清单（fail-loud，见 `buildMissingInputsBlock`）。File missing /
 *  read fail → `debugLog.warn` + skip（与原 buildWorkerPrompt 同姿态），但不再
 *  静默：missing 清单会进 prompt 让 worker 知道它本该有这些文件。 */
async function buildInputFilesBlock(
  inputFiles: readonly string[],
): Promise<{ block: string; missing: string[] }> {
  if (!inputFiles || inputFiles.length === 0) return { block: '', missing: [] };
  const blocks: string[] = [];
  const missing: string[] = [];
  for (const path of inputFiles) {
    try {
      const data = await vfs.readFile(path);
      if (data == null) {
        debugLog.warn('sub_agent', 'sub_agent:worker:input:missing', { path });
        missing.push(path);
        continue;
      }
      const text =
        typeof data === 'string'
          ? data
          : new TextDecoder().decode(data as Uint8Array);
      blocks.push(`<file path="${path}">\n${text}\n</file>`);
    } catch {
      debugLog.warn('sub_agent', 'sub_agent:worker:input:read_error', { path });
      missing.push(path);
    }
  }
  const block =
    blocks.length === 0 ? '' : `<input-files>\n${blocks.join('\n')}\n</input-files>`;
  return { block, missing };
}

/** 把主代理写的上下文简报 wrap 成 `<context-brief>` envelope。Worker 看不到
 *  会话历史——这段是它唯一的「为什么做 / 之前决定了什么 / 怎么算合格」来源。
 *  空串 / undefined → 空串（composePrompt omit），保持向后兼容（旧调用不传
 *  就完全没有这个 block）。 */
function buildContextBriefBlock(context: string | undefined): string {
  if (!context || context.trim() === '') return '';
  return `<context-brief>\n${context.trim()}\n</context-brief>`;
}

/** 把读不到的 input path 列表 wrap 成 `<missing-inputs>` envelope。Worker 看到
 *  这个 block 就知道：caller 请求了这些文件但它们不存在 / 读失败——它**不该**
 *  假装读到了，也不该静默忽略后照报 success。空清单 → 空串（composePrompt omit）。 */
function buildMissingInputsBlock(missing: readonly string[]): string {
  if (!missing || missing.length === 0) return '';
  return (
    `<missing-inputs>\nThe caller asked you to read these files but they were ` +
    `missing or unreadable at task start. Do NOT pretend you read them; note ` +
    `the gap in your handoff_notes and adjust scope accordingly:\n` +
    missing.map((p) => `- ${p}`).join('\n') +
    `\n</missing-inputs>`
  );
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
  /** Optional Phase 2 UI feedback hook（从 `RunWorkerOptions.onLiveStream`
   *  透传下来；retry attempt 也必须传，UI 才有 attempt 2 的 stream）。 */
  onLiveStream?: (ev: WorkerLiveStreamEvent) => void;
}

/** 一次 attempt 的完整 lifecycle：建 agent → 跑 → 抽文本 → 读 output →
 *  assembleHandoff。Keepalive 在 attempt 内 acquire/release（避免 retry
 *  跨 attempt 持锁）。信号 listener 在 finally 内 remove，cleanup 安全。
 *
 *  Fail-Fast (Subtask 7 — 重构 Phase 1.5 的固定 idle-window):
 *  - 三段协同 timer + **阶段化 idle-window**，超时走 `runnerOk:false,
 *    timedOut:true`，并在 `failureReason` 字段区分（`'ttft' | 'idle' |
 *    'timeout' | 'ceiling'`）：
 *    • TTFT (`WORKER_TTFT_MS` = 120s)：prompt 提交后无 first token →
 *      fail-fast。**不可重置**——避免 idle 一直被重新 arm 走偏。
 *    • **阶段化 Idle window**（核心 Subtask 7 改动）：
 *      - `emitting` 阶段（模型正在生成 assistant message content）→ idle
 *        阈值 = per-role ceiling。**关键修复**：本地 OpenAI-compatible 代理
 *        会 buffer 整个 tool-call argument 流（25–135 KB），期间
 *        pi-agent-core 看不到任何 `message_update` 事件（只有 `message_start`
 *        → `message_end`），旧的 180s idle 把这种「正在工作」误判为 hung。
 *        Kimi K3 的 227s emit gap 就是这种场景——Subtask 7 前 idle 会 fire
 *        并触发无用 retry。
 *      - `between_turns` / `tool_running` 阶段（turn 间 / tool 执行中）→
 *        idle 阈值 = `WORKER_IDLE_MS` (180s)。这两阶段才是真静默期（端点假死
 *        / 工具卡住 / thinking-model reasoning gap），需要 fail-fast。
 *      - `before_ttft` 阶段无 idle（TTFT timer 独管）。
 *      - Phase 转移逻辑见 `enterPhase()` + subscriber 内的 `switch (ev.type)`。
 *      - 决策函数在 `resolvePhaseTimeout(phase, ceilingMs)` —— 纯函数，测试
 *        覆盖于 `worker-runner.test.ts`。
 *    • Per-role ceiling (来自 `WORKER_ROLES[role].timeoutMs`，用户可 override
 *      via `local:workerRoleTimeouts`)：outer wall-clock cap——emit 阶段 idle
 *      也用这个值（兜底 buffer 模型），仅在 idle/ttft 全漏（long tool chain
 *      期间）时 fire。
 *  - Composed AbortController：把 caller `opts.signal` 与三 timer 合成一个
 *    内部 controller，agent 只听这一个 signal（避免在 pi-agent-core 内部
 *    多 listener 互相打架）。Listener 在 `finally` 内 remove。
 *  - 7 个 instrumentation events (`sub_agent:worker:*`) 让 debug log 能看出
 *    attempt 卡在哪一阶段（model resolve / prompt / stream / phase / handoff
 *    extract / output read），并带 `failureReason` 区分哪一路 timer 赢。
 *    `stream:phase`（Subtask 7 新增）记录阶段转移——比 Subtask 4 的 DIAG
 *    console.log 更结构化，直接进 debug log JSON，sidepanel 可直接渲染。 */
async function runWorkerAttempt(
  opts: RunWorkerAttemptOptions,
): Promise<WorkerHandoff> {
  let attemptStartedAt = performance.now();
  const attemptNumber = opts.attempt;
  // 决议 attempt ceiling：用户 storage override → role registry 默认 → 全局
  // WORKER_TIMEOUT_MS 兜底（三层优先级在 `resolveWorkerRoleTimeoutMs` JSDoc）。
  // 这里一次性 resolve——attempt 内部不重读 storage。若 attempt 1 跑完用户
  // 改了阈值，attempt 2 才看得到（acceptable per plan §4）。
  // 必须读 storage 而不是传 const：UI 端已经在 `useStorageItem(workerRoleTimeouts, {})`
  // 订阅，user override 在 runner 这里也必须生效——否则会出现「DelegationCard
  // 显示 300s 但 runner 实际按 120s abort」的 UI/runtime drift。
  const overrideTimeouts = await workerRoleTimeouts.getValue();
  const attemptCeilingMs = resolveWorkerRoleTimeoutMs(opts.role, overrideTimeouts);

  // ─── Stuck-loop 诊断 + abort 计数器（debug + abort trigger）───
  // 目的：捕获 cebian-debug-20260909-154111.json + -163313.json 中观察到
  // 的 2 个 hypothesis——
  // A) 模型无法自行结束（停不下来发 `end_turn`）+ C) `fs_read_file` /
  //    `fs_list` 不限速 → 模型反复读。Subtask 9.0 把 diagnostic 升级成
  //    abort trigger：两个 threshold (same-path ≥4 / post-write ≥6) 任
  //    一命中 → composedController.abort() + failureReason='stuck_loop'。
  //    L3 file rescue 在 catch block 接 (synthesizeStuckLoopHandoff)
  //    让写好的 file 走 success path。debugLog.warn 既有 stuck_loop:
  //    reads heartbeat 保留 (信息密度高, 1 entry = 1 read, 比 one-shot
  //    强), 加新 stuck_loop:trigger event 标 reason + snapshot。状态
  //    变量都在 `runWorkerAttempt` 闭包里：每次新 attempt 重新从 0 开始。
  let consecutiveReads = 0;
  let lastStopReason: string | undefined;
  // 最近 6 次 read-only tool 的 path ring buffer——日志里一起带上，方便区分
  // 「反复读同一个文件」（A 嫌疑）和「读不同文件做 research」（合法流程）。
  const recentReadPaths: string[] = [];
  // Subtask 9.0 新增: stuck detector state。`lastReadSignature` +
  // `sameChunkRepeats` 给 Threshold A (same-chunk ≥4); `hasWrittenThisAttempt`
  // 给 Threshold B (post-write ≥6). Phase 2 rename `lastReadPath` →
  // `lastReadSignature` + `samePathRepeats` → `sameChunkRepeats` để dedup key
  // là full `(path, start_line, end_line)` tuple thay vì chỉ path — chống
  // false-positive khi reviewer / researcher paginate 1 file qua nhiều
  // chunk hợp lệ (reproduce trong cebian-debug-20260909-211043.json
  // attempt 4). 写工具 (fs_create_file / fs_edit_file) reset cả 3 state và
  // sticky-set `hasWrittenThisAttempt = true` đến khi attempt kết thúc.
  let lastReadSignature: string | undefined;
  let sameChunkRepeats = 0;
  let hasWrittenThisAttempt = false;
  /** Const helper: 提取 path 字段 (fs_list không có path → undefined) 用来
   *  给 `formatToolPath` 做 debug log. Read-only nhưng无 path 的 fs_list
   *  không vào `lastReadSignature` / `sameChunkRepeats` 计数, 留给
   *  Threshold B (consecutiveReads 仍累计, không phụ thuộc path). */
  const formatToolPath = (toolName: string, args: unknown): string => {
    if (args && typeof args === 'object' && typeof (args as { path?: unknown }).path === 'string') {
      return `${toolName}:${(args as { path: string }).path}`;
    }
    return toolName;
  };
  /** Build dedup signature cho `lastReadSignature`. `fs_read_file` 的
   *  pagination params (`start_line` / `end_line`) cũng tham gia — cùng
   *  path nhưng khác range là khác chunk, là pagination hợp lệ, không
   *  tính vào `sameChunkRepeats`. Trả về `undefined` khi không có
   *  `path` (vd `fs_list` với `{path, options?}` mà path không phải
   *  string, hoặc args khác shape) để caller reset counter. */
  const buildReadSignature = (args: unknown): string | undefined => {
    if (!args || typeof args !== 'object') return undefined;
    const a = args as { path?: unknown; start_line?: unknown; end_line?: unknown };
    if (typeof a.path !== 'string') return undefined;
    const sl = typeof a.start_line === 'number' ? String(a.start_line) : '';
    const el = typeof a.end_line === 'number' ? String(a.end_line) : '';
    return `${a.path}|${sl}|${el}`;
  };

  debugLog.info('sub_agent', 'sub_agent:worker:attempt:start', {
    role: opts.role,
    modelId: opts.model.id,
    modelKey: opts.modelKey,
    attempt: attemptNumber,
    timeoutMs: attemptCeilingMs,
    ttftMs: WORKER_TTFT_MS,
    idleMs: WORKER_IDLE_MS,
  });

  let result: WorkerHandoff;
  // 哪个 timer 是真正赢的那个（idempotent 检查保证三选一）。闭包读回后给
  // assembleHandoff 透传到 handoff.failureReason。`timedOut` 函数时 truthy
  // iff failureReason 已设——catch 分支用同一个标志控制 retryable 与 error 文案。
  let failureReason: 'ttft' | 'idle' | 'ceiling' | 'stuck_loop' | undefined;
  const timedOut = (): boolean => failureReason !== undefined;
  let firstTokenEmitted = false;
  // 3 个独立 timer handle——`finally` 里 clearTimeout 清掉。
  // `clearTimeout(undefined)` 是 no-op，所以未设置过的 handle 也安全 clear。
  let ttftHandle: ReturnType<typeof setTimeout> | undefined;
  let idleHandle: ReturnType<typeof setTimeout> | undefined;
  let ceilingHandle: ReturnType<typeof setTimeout> | undefined;
  // Composed controller 把 caller signal 与 3 个 timer 合成一个；agent
  // 只订阅这个内部 signal，避免外部 caller 中途再换 opts.signal。
  const composedController = new AbortController();
  const onParentAbort = (): void => {
    try {
      composedController.abort();
    } catch {
      /* ignore — composedController 可能已被 timer 自己 abort 过 */
    }
  };

  // 三个 timer handler 共用 idempotent 规则:
  //   1. 只在「composedController 尚未 abort」时接管（避免父 caller 已经 abort
  //      后再 fire 产生 noise）；
  //   2. 三者只能赢一个——`failureReason` 一旦设过就不覆盖（先到先得）；
  //   3. abort + 设 failureReason，clean-up 在 finally。阈值由参数传入便于日志。
  function setFailureReason(
    reason: 'ttft' | 'idle' | 'ceiling',
    thresholdMs: number,
  ): void {
    if (composedController.signal.aborted) return;
    failureReason = reason;
    debugLog.warn('sub_agent', `sub_agent:worker:timeout:${reason}`, {
      role: opts.role,
      modelId: opts.model.id,
      attempt: attemptNumber,
      elapsedMs: Math.round(performance.now() - attemptStartedAt),
      thresholdMs,
    });
    composedController.abort();
  }

  acquireKeepAlive();
  // ─── Phase-aware timer state（Subtask 7）───
  // 声明在 outer try 顶层，让下面的 subscriber 闭包能稳定引用——
  // 即便 `composedController.signal.aborted` 已经是 true（pre-aborted 早退
  // 路径），helpers 仍可被引用，`armPhaseTimer` 内的 abort guard 兜底
  // 不会真正 arm。
  let phase: StreamPhase = 'before_ttft';
  const armPhaseTimer = (): void => {
    if (idleHandle !== undefined) clearTimeout(idleHandle);
    if (composedController.signal.aborted) return;
    // before_ttft 阶段不 arm——TTFT timer 单独管。
    if (phase === 'before_ttft') return;
    const ms = resolvePhaseTimeout(phase, attemptCeilingMs);
    idleHandle = setTimeout(() => setFailureReason('idle', ms), ms);
  };
  const enterPhase = (next: StreamPhase): void => {
    phase = next;
    armPhaseTimer();
    debugLog.info('sub_agent', 'sub_agent:worker:stream:phase', {
      role: opts.role,
      modelId: opts.model.id,
      attempt: attemptNumber,
      phase: next,
      elapsedMs: Math.round(performance.now() - attemptStartedAt),
    });
  };

  try {
    // 链：opts.signal → composedController → agent.abort()
    if (opts.signal) {
      if (opts.signal.aborted) {
        composedController.abort();
      } else {
        opts.signal.addEventListener('abort', onParentAbort, { once: true });
      }
    }
    // 链：3 timer → composedController → agent.abort()
    if (!composedController.signal.aborted) {
      // TTFT (Time-to-first-token) ceiling — 不可重置。Stream 一旦出 first
      // token，下面 subscriber 会把 firstTokenEmitted latch 锁上 + clearTimeout
      // 掉 ttftHandle；不靠 re-create 新 timer（避免 race）。
      ttftHandle = setTimeout(
        () => {
          if (!firstTokenEmitted) setFailureReason('ttft', WORKER_TTFT_MS);
        },
        WORKER_TTFT_MS,
      );

      // 注（Subtask 7）：此处不调 `armPhaseTimer()`——phase 初始为
      // `before_ttft`，TTFT timer 单独管这一阶段；idle 由 subscriber 在首个
      // `message_start` / `message_update` 时通过 `enterPhase('emitting')`
      // 触发。

      // Outer ceiling — per-role hard cap。兜底 wall-clock safety net。Stream
      // 真在动时 idle-window 持续 reset；只在极端边界 fire。belt-and-suspenders。
      ceilingHandle = setTimeout(
        () => setFailureReason('ceiling', attemptCeilingMs),
        attemptCeilingMs,
      );
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

      // 2b. Instrumentation subscription + 阶段化 idle re-arming（Subtask 7）。
      //     旧逻辑只在 message_update / text_delta / tool_result 上 re-arm，
      //     对「本地 proxy buffer 整个 tool-call argument 流」的场景完全失明
      //     （Gemini/GPT-5.5/Kimi 实测 140–227s 无任何 message_update，但模型
      //     其实在生成 25–135 KB 的 fs_create_file 参数）→ 180s idle 误杀。
      //     新逻辑把 idle 阈值与 stream 阶段绑定：
      //       message_start(assistant)  → emitting（idle = ceiling）
      //       message_update            → re-arm 当前阶段
      //       message_end(assistant)    → between_turns（idle = 180s）
      //       tool_execution_start      → tool_running（idle = 180s）
      //       tool_execution_update/end → re-arm
      //     first token 出现则取消 TTFT timer。Guard 顶部检查 composedController
      //     避免 abort 后还重新 arm timer。
      const unsubscribeStream = agent.subscribe((event: unknown) => {
        if (composedController.signal.aborted) return;
        const ev = event as AgentEvent;

        // First-token latch：出现即取消 TTFT（clearTimeout 这个 handle），
        // 后续不再判 TTFT。message_start(assistant) 也算 first token——
        // proxy buffer 场景下这是 stream 存活的第一个信号。
        const markFirstToken = (): void => {
          if (firstTokenEmitted) return;
          firstTokenEmitted = true;
          if (ttftHandle !== undefined) {
            clearTimeout(ttftHandle);
            ttftHandle = undefined;
          }
          debugLog.info('sub_agent', 'sub_agent:worker:stream:first_token', {
            role: opts.role,
            modelId: opts.model.id,
            attempt: attemptNumber,
            elapsedMs: Math.round(performance.now() - attemptStartedAt),
          });
        };

        switch (ev.type) {
          case 'message_start':
            if (ev.message.role === 'assistant') {
              markFirstToken();
              enterPhase('emitting');
            } else {
              // toolResult / user message_start：re-arm 当前阶段，不转移。
              armPhaseTimer();
            }
            break;
          case 'message_update':
            markFirstToken();
            if (phase === 'before_ttft') enterPhase('emitting');
            else armPhaseTimer();
            // Phase 2 UI feedback: 把 text/thinking delta 扇出给 caller。
            // `assistantMessageEvent` 是 pi-ai 的 `AssistantMessageEvent` discriminated
            // union（`text_delta` / `thinking_delta` / `toolcall_*` / …）；我们只
            // 关心 text/thinking 的 delta（1–3 chars/token，rate 50–100Hz），渲染层
            // 的 `reduceStreamEvents`（lib/agent/worker-live-stream.ts）负责
            // token-coalesce + 50ms throttle。
            if (opts.onLiveStream) {
              const aev = ev.assistantMessageEvent;
              if (aev.type === 'text_delta') {
                opts.onLiveStream({
                  kind: 'text_delta',
                  sessionId: opts.sessionId,
                  toolCallId: undefined,
                  delta: aev.delta,
                });
              } else if (aev.type === 'thinking_delta') {
                opts.onLiveStream({
                  kind: 'thinking_delta',
                  sessionId: opts.sessionId,
                  toolCallId: undefined,
                  delta: aev.delta,
                });
              }
              // 其他 assistantMessageEvent type（text_start/thinking_start/
              // text_end/thinking_end/toolcall_*）—— start/end 不渲染，
              // toolcall_* 的 25–135KB args payload 不能流进 LiveStreamBox
              // （tool args 只经 tool_start 的 `formatToolPath` 以顶层 `args.path`
              //  的形式出现在 UI 上）。
            }
            break;
          case 'message_end':
            if (ev.message.role === 'assistant') {
              enterPhase('between_turns');
              // Site 1（debug-only）：把 stopReason 转发到 debug log，下次
              // 复现就能验证 hypothesis A（模型停不下来）。StopReason 取值
              // 范围 = "pending" | "stop" | "length" | "toolUse" | "error"
              // | "aborted" | "deferred"——如果全是 toolUse、从来不会出现
              // "stop"，即确认 hypothesis A。`consecutiveReads` 同步带上，
              // 方便看到发出最后一条 assistant message 时 loop 计数器走到哪。
              const am = ev.message as AssistantMessage;
              lastStopReason = am.stopReason;
              debugLog.warn('sub_agent', 'sub_agent:worker:stream:stop_reason', {
                role: opts.role,
                modelId: opts.model.id,
                attempt: attemptNumber,
                stopReason: lastStopReason,
                consecutiveReads,
                elapsedMs: Math.round(performance.now() - attemptStartedAt),
              });
            } else {
              armPhaseTimer();
            }
            break;
          case 'tool_execution_start':
            debugLog.info('sub_agent', 'sub_agent:worker:tool:start', {
              role: opts.role,
              modelId: opts.model.id,
              attempt: attemptNumber,
              toolName: ev.toolName,
              elapsedMs: Math.round(performance.now() - attemptStartedAt),
            });
            // Phase 2 UI feedback: 工具开始时给 caller 一条 self-contained
            // 「● tool_name:path」线。`args` 原样透传——`liveStreamBroadcaster`
            // 走 `formatToolPath` 只读 `args.path`（顶层 string），不会
            // 触发 25–135 KB fs_create_file 序列化。
            if (opts.onLiveStream) {
              opts.onLiveStream({
                kind: 'tool_start',
                sessionId: opts.sessionId,
                toolCallId: undefined,
                toolName: ev.toolName,
                args: ev.args,
              });
            }
            enterPhase('tool_running');
            // Site 2（debug + abort trigger）：连续 read-only 检测器。
            //   - 旧版 (Subtask 诊断阶段) 只发 WARN，不 abort——确认 hypothesis 后
            //     才升级成 abort。Subtask 9.0 升级成 dual threshold detector：
            //       Threshold A (same-path ≥4) 抓 pre-write over-read
            //         (model 反复读同一 file 永远不写)
            //       Threshold B (post-write ≥6) 抓 post-write verify loop
            //         (写完再 verify，无论同 path 还是不同 path)
            //     命中 → composedController.abort() + failureReason='stuck_loop'，
            //     catch block 走 L3 file rescue (synthesizeStuckLoopHandoff) 让
            //     写好的 file 走 success path。Debug heartbeat 保留：≥6
            //     consecutiveReads 后每次 read 都发 stuck_loop:reads WARN (1 entry
            //     对应 1 read, 信息密度高于 one-shot); 新加 stuck_loop:trigger
            //     event 标 abort 触发时刻 + reason + snapshot, 便于 export log
            //     看到 "loop 起点 → 触发点" 全貌。
            //   - 写工具 (fs_create_file / fs_edit_file) reset 所有 counter 并
            //     sticky set hasWrittenThisAttempt=true，让 Threshold B 进入
            //     armed 状态。
            const isReadOnlyTool =
              ev.toolName === 'fs_read_file' || ev.toolName === 'fs_list';
            if (isReadOnlyTool) {
              consecutiveReads++;
              const summary = formatToolPath(ev.toolName, ev.args);
              if (recentReadPaths.length >= 6) recentReadPaths.shift();
              recentReadPaths.push(summary);
              // 提取 path 字段 (fs_list 无 path → undefined, 不计数 / 不 reset)
              // 给 Threshold A 用。Read-only 但无 path 的 fs_list 不进入 same-path
              // 计数 (researcher 调 fs_list 浏览目录是合法流程, 不该被 Threshold A
              // 误抓)，但 consecutiveReads 仍累计 (post-write ≥6 不区分 read/list)。
              const readSig = buildReadSignature(ev.args);
              if (readSig !== undefined) {
                sameChunkRepeats =
                  readSig === lastReadSignature ? sameChunkRepeats + 1 : 1;
                lastReadSignature = readSig;
              } else {
                // fs_list không có path / args shape lạ → reset
                // (different concept, same as Phase 1)
                lastReadSignature = undefined;
                sameChunkRepeats = 0;
              }
              // Subtask 9.0: stuck_loop detector — 两个 threshold 任一命中就
              // 触发 abort。Decision helper (`shouldTriggerStuckLoop`) 是 pure
              // function, 所有 state 由 caller 传, unit test 钉死阈值边界。
              const stuckDecision = shouldTriggerStuckLoop({
                toolName: ev.toolName,
                toolArgs: ev.args,
                consecutiveReads,
                sameChunkRepeats,
                lastReadSignature,
                hasWrittenThisAttempt,
              });
              if (stuckDecision.trigger) {
                failureReason = 'stuck_loop';
                debugLog.warn(
                  'sub_agent',
                  'sub_agent:worker:stuck_loop:trigger',
                  {
                    role: opts.role,
                    modelId: opts.model.id,
                    attempt: attemptNumber,
                    triggerReason: stuckDecision.reason,
                    consecutiveReads,
                    sameChunkRepeats,
                    lastReadSignature,
                    hasWrittenThisAttempt,
                    elapsedMs: Math.round(performance.now() - attemptStartedAt),
                  },
                );
                composedController.abort();
                // 不 break —— 让外层 subscriber 自然走完, agent.abort() 在
                // composedController listener 里 fire, attempt 进 catch block。
              } else if (consecutiveReads >= 6) {
                // Debug heartbeat: ≥6 consecutive reads 时每次 tool:start 都
                // 发一条 WARN (one entry per read) —— 信息密度高于 one-shot,
                // 让 export log 能看到 loop 长度。threshold = 6 与 Threshold B
                // 触发线对齐 (consecutiveReads >= 6 → B 必 trigger, 等同于
                // stuck_loop:trigger 的同一个 step), 但 hasWrittenThisAttempt
                // 未设时不 trigger (researcher 多 read)。
                debugLog.warn('sub_agent', 'sub_agent:worker:stuck_loop:reads', {
                  role: opts.role,
                  modelId: opts.model.id,
                  attempt: attemptNumber,
                  consecutiveReads,
                  lastReadPaths: recentReadPaths.slice(),
                  lastStopReason,
                  elapsedMs: Math.round(performance.now() - attemptStartedAt),
                });
              }
            } else {
              // Write/edit tool: reset consecutiveReads + same-chunk tracker.
              // hasWrittenThisAttempt sticky true until attempt 结束 ——
              // 一旦写过, 后续任何 ≥6 consecutive read 都触发 Threshold B
              // (post-write verify loop, 不论同 chunk 还是不同 chunk).
              consecutiveReads = 0;
              sameChunkRepeats = 0;
              lastReadSignature = undefined;
              if (
                ev.toolName === 'fs_create_file' ||
                ev.toolName === 'fs_edit_file'
              ) {
                hasWrittenThisAttempt = true;
              }
            }
            break;
          case 'tool_execution_update':
          case 'tool_execution_end':
            if (ev.type === 'tool_execution_end') {
              debugLog.info('sub_agent', 'sub_agent:worker:tool:end', {
                role: opts.role,
                modelId: opts.model.id,
                attempt: attemptNumber,
                toolName: ev.toolName,
                isError: ev.isError,
                elapsedMs: Math.round(performance.now() - attemptStartedAt),
              });
            }
            armPhaseTimer();
            break;
          // agent_start / agent_end / turn_start / turn_end：不转移 phase、
          // 不 re-arm——它们是 run/turn 边界信号，真正的存活证据是 message /
          // tool_execution 事件。
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
        // fail" → 无用的 retry。这里如果 timer 已在 prompt 运行期间 fire,
        // 主动 throw 让它落进下面的 catch block —— catch 里已有
        // `runnerError = timedOut() ? '<reason> timeout...'` 分支，
        // 会正确流进 `runnerOk: false` + `failureReason` + `timedOut: true`.
        if (timedOut()) {
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
      // 修：原来这里硬写 `timedOut: false`，但 timer 可能在 `agent.prompt()`
      // 返回前已经 fire（abort 只挂 listener，不抛错），导致 telemetry 报「attempt
      // 正常结束」而实际上 worker 是被 abort 的——debug log 上一片绿色，定位
      // bug 极其痛苦。从闭包读回真实值：failureReason 已设 → true，并通过
      // failureReason 把 timer 来源传下去（ttft/idle/ceiling）。
      debugLog.info('sub_agent', 'sub_agent:worker:attempt:done', {
        role: opts.role,
        modelId: opts.model.id,
        attempt: attemptNumber,
        attemptDurationMs,
        timedOut: timedOut(),
        failureReason,
        outputFileExists: exists,
      });

      // Fix Y（Subtask 8.8）：silent-write fallback。本地 proxy 把 fs_create_file
      // tool call 一并发完、不发后续 text 时，rawText 为空但 file 已落地——直接
      // 合成 handoff JSON 让 assembleHandoff 走 success path。Retry 不会让
      // deterministic 行为变好，徒增 attempts=2 后 fail-fast 的 ceiling 风险。
      // Detection 在 `synthesizeSilentWriteHandoff`；decision 仍走 assembleHandoff
      // branch 6 (success path)——零修改 assembleHandoff、零回归。
      let effectiveRawText = rawText;
      let effectiveJson = json;
      const synthesized = synthesizeSilentWriteHandoff({
        rawText,
        json,
        declaredOutputPath: opts.outputPath,
        outputFileExists: exists,
      });
      if (synthesized !== null) {
        effectiveRawText = synthesized.rawText;
        effectiveJson = synthesized.json;
        debugLog.info('sub_agent', 'sub_agent:worker:handoff:synthesized', {
          role: opts.role,
          modelId: opts.model.id,
          attempt: attemptNumber,
          reason: 'silent_write_with_output_file_present',
          declaredOutputPath: opts.outputPath,
          rawTextLength: rawText.length,
          outputFileExists: exists,
        });
      }

      result = assembleHandoff({
        runnerOk: true,
        role: opts.role,
        modelKey: opts.modelKey,
        rawText: effectiveRawText,
        json: effectiveJson,
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
      // Failure reason 已设 → 给可读的错误文案（含模型 key + 是哪种 timeout）。
      // 老的「Worker timed out after 120000ms (model did not respond)」对诊断
      // 不够友好：ttft / idle / ceiling / stuck_loop 的修复路径不一样，下
      // 面用对应文案。具体 message 构造抽到 `buildWorkerRunnerError` 纯函数
      // ——测试用, 见 worker-runner.test.ts「buildWorkerRunnerError」describe。
      const reason = failureReason;
      const runnerError = buildWorkerRunnerError({
        reason,
        modelKey: opts.modelKey,
        attemptDurationMs,
        attemptCeilingMs,
        isAbort,
        originalError: e,
      });
      debugLog.warn('sub_agent', 'sub_agent:worker:attempt:error', {
        role: opts.role,
        modelId: opts.model.id,
        attempt: attemptNumber,
        attemptDurationMs,
        failureReason: reason,
        parentAborted: isAbort && reason === undefined,
        // Subtask 9.0 Finding #2 follow-up: 用 `runnerError` (已走
        // buildWorkerRunnerError 的 reason-aware 文案), 不用 `e.message`
        // raw。否则 stuck_loop case `error` field 会是 "Worker timed out"
        // (来自 line 1495 generic throw), 与 handoff.error UI 端文案
        // 不一致 —— debug log grep 时一眼以为是 ceiling 烧满, 实际是
        // detector 主动 abort (smoke test attempt 8 已 reproduce 这个
        // split-brain: handoff 报 "aborted: stuck-loop" 但 debug log
        // `error` 字段还是 "Worker timed out")。
        error: runnerError,
      });
      // 修：原来这里 `outputFileExists: false` 写死，导致 timeout path 永远
      // 看不到「worker 实际已经写了一半文件」的事实——Phase 1.4 的 smart retry
      // 决策需要知道这一点：file 存在 → retry 让 worker 写完；file 不存在 →
      // 再跑 ceiling 也是同样结局，fail-fast。Non-timeout catch（parent abort /
      // 真 exception）保持 `false`，zero regression——那些路径本来就不该 retry。
      // 同时缓存 `content`：Subtask 9.0 L3 stuck_loop file rescue 需要把 file
      // 作为 success handoff 走 branch 6, branch 6 会把 content 挂到
      // `output_content` 让主代理 `--- output_content (...) ---` marker 能渲染
      // 出 worker 实际写的产物, 与 silent-write fallback 行为对齐。Branch 1
      // (failure) path 不挂 output_content（失败 handoff 塞部分内容会改变主
      // 代理看到的信息面, 超出本次修复范围）。
      let timeoutOutputExists = false;
      let timeoutOutputContent: string | undefined;
      if (reason !== undefined && opts.outputPath) {
        try {
          const r = await readOutputIfAny(opts.outputPath);
          timeoutOutputExists = r.exists;
          timeoutOutputContent = r.content;
        } catch (readErr) {
          // VFS read 失败（罕见）→ 保持 false + log，debug 仍有信号
          debugLog.warn('sub_agent', 'sub_agent:worker:output_read_after_timeout_failed', {
            role: opts.role,
            attempt: attemptNumber,
            error: readErr instanceof Error ? readErr.message : String(readErr),
          });
        }
      }
      // Subtask 9.0 L3: stuck_loop file rescue。stuck detector 已 abort +
      // output file 已落地 → 不走 branch 1 failure path, 用
      // `synthesizeStuckLoopHandoff` 走 success path (branch 6)。File 是
      // worker 在 loop 开始前产出的, deterministic loop 行为 retry 不会变
      // 好, 把 file 当 success 给主代理看。File 不存在 → 仍走 branch 1
      // failure (assembleHandoff 已显式除外 stuck_loop 的 retryable 设位,
      // 即使 file 存在也不设 — 但 file 存在时根本进不了 branch 1, 因为
      // 上面 if 分支走了 success path)。
      if (reason === 'stuck_loop' && timeoutOutputExists) {
        const stuckSynth = synthesizeStuckLoopHandoff({
          declaredOutputPath: opts.outputPath,
          outputFileExists: true,
        });
        if (stuckSynth !== null) {
          debugLog.info('sub_agent', 'sub_agent:worker:handoff:synthesized', {
            role: opts.role,
            modelId: opts.model.id,
            attempt: attemptNumber,
            reason: 'stuck_loop_with_output_file_present',
            triggerReason:
              'stuck_loop_detector_aborted_with_file_rescue',
            declaredOutputPath: opts.outputPath,
            outputFileExists: true,
            attempts: opts.attempt,
            attemptDurationMs,
          });
          // 与 silent-write fallback 对齐：挂 output_content 让主代理 `---
          // output_content (...) ---` marker 能渲染 worker 实际写的产物,
          // 与 assembleHandoff branch 6 的内容挂载约定一致。stuck_loop 是
          // file rescue 语义 (output file authoritative), 不挂 content 等于
          // 把这份已落地的产物对主代理隐藏, 用户必须再点开 VFS 才能看到。
          result = assembleHandoff({
            runnerOk: true,
            role: opts.role,
            modelKey: opts.modelKey,
            rawText: stuckSynth.rawText,
            json: stuckSynth.json,
            outputFileExists: true,
            ...(timeoutOutputContent !== undefined
              ? { outputContent: timeoutOutputContent }
              : {}),
            ...(opts.outputPath ? { declaredOutputPath: opts.outputPath } : {}),
            attempts: opts.attempt,
            attemptDurationMs,
          });
        } else {
          // 合成失败 (declaredOutputPath 缺失——不该 hit, 因为
          // timeoutOutputExists=true 隐含 opts.outputPath 已设) → 走原
          // branch 1 路径。
          result = assembleHandoff({
            runnerOk: false,
            runnerError,
            role: opts.role,
            modelKey: opts.modelKey,
            rawText: '',
            json: null,
            outputFileExists: timeoutOutputExists,
            attempts: opts.attempt,
            attemptDurationMs,
            ...(timedOut() ? { timedOut: true } : {}),
            ...(reason !== undefined ? { failureReason: reason } : {}),
          });
        }
      } else {
        result = assembleHandoff({
          runnerOk: false,
          runnerError,
          role: opts.role,
          modelKey: opts.modelKey,
          rawText: '',
          json: null,
          outputFileExists: reason !== undefined ? timeoutOutputExists : false,
          attempts: opts.attempt,
          attemptDurationMs,
          ...(timedOut() ? { timedOut: true } : {}),
          ...(reason !== undefined ? { failureReason: reason } : {}),
        });
      }
    }
  } finally {
    if (ttftHandle !== undefined) clearTimeout(ttftHandle);
    if (idleHandle !== undefined) clearTimeout(idleHandle);
    if (ceilingHandle !== undefined) clearTimeout(ceilingHandle);
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

  // 5. Prompt 组合：workspace / skills / anti-patterns / context-brief /
  //    input-files / missing-inputs 全部可选，缺失即 omit。IO 部分（skill /
  //    input file 读 VFS）并行跑——互不依赖；anti-patterns 与 workspace 是纯
  //    函数，直接调用。`options.outputPath` 来自 tool layer，已 resolve 成绝对
  //    路径（`/workspaces/<sessionId>/...`），直接钉进 `<workspace>` block。
  const [skillBlocks, inputResult] = await Promise.all([
    buildSkillBlocks(options.skills ?? []),
    buildInputFilesBlock(options.inputFiles ?? []),
  ]);
  const antiPatternsBlock = buildAntiPatternsBlock(options.antiPatterns ?? []);
  const workspaceBlock = buildWorkspaceBlock(sessionId, options.outputPath);
  const contextBlock = buildContextBriefBlock(options.context);
  const missingInputsBlock = buildMissingInputsBlock(inputResult.missing);
  const initialPrompt = composePrompt(task, {
    workspaceBlock,
    skillBlocks,
    antiPatternsBlock,
    contextBlock,
    inputFilesBlock: inputResult.block,
    missingInputsBlock,
  });

  // Observability（context-handoff hardening）：debug log không ghi nội dung
  // prompt / delegate_task args, nên mắt thường không thể verify từ export
  // rằng main agent có điền `context` hay runner có nhúng `<missing-inputs>`
  // hay không. Event này chỉ ghi **shape** của prompt đã compose (có/không
  // từng block + đếm số file), đủ để QA sau nhìn thấy block nào fire, mà
  // không leak nội dung vào log. Không đổi hành vi.
  debugLog.info('sub_agent', 'sub_agent:worker:prompt:blocks', {
    role,
    hasContextBrief: contextBlock !== '',
    hasMissingInputs: missingInputsBlock !== '',
    inputFilesCount: (options.inputFiles ?? []).length,
    missingCount: inputResult.missing.length,
    hasSkills: skillBlocks !== '',
    hasAntiPatterns: antiPatternsBlock !== '',
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
    ...(options.onLiveStream ? { onLiveStream: options.onLiveStream } : {}),
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
      ...(options.onLiveStream ? { onLiveStream: options.onLiveStream } : {}),
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

// ─── Batch dispatch (Subtask 1.1) ───
//
// `delegate_task` 一次最多带 4 个独立 task 并行跑（Phase 1 调研：「3 个文件
// 并行能跑 1/3 时间」是 user 实际 latency 期望；上限 4 是 keepalive budget
// + 4×50 KB content 总开销的 sanity cap）。每个 item 仍是独立 `runWorker`
// —— 自己的 retry / timer / abort 状态。一个 item 失败不影响 siblings
//（`Promise.allSettled`）。Outer handoff 提供 `batch`（per-item 详情）+
// `batchSummary`（coarse 计数）让主代理 / UI 不必扫 N 个 item。
//
// **重要：仅用于独立 task。** 任务 B 读任务 A 的产物时（如
// content_writer → frontend_coder reads content.json → reviewer reads
// studio.html），不要 batch 起来——worker B 会在 A 写文件之前 race。
// 这种依赖链必须分多 delegate_task 串行调用，或等 Phase 1.5 加
// `depends_on: number[]` 显式声明。这条 caveat 在 PREAMBLE + tool schema
// description 里 defense-in-depth 写明。

export interface BatchWorkerItem {
  /** worker 要执行的自然语言任务。 */
  task: string;
  /** worker role（4 种固定之一）。 */
  role: WorkerRole;
  /** LLM 显式指定的模型身份（最高优先级）。 */
  modelOverride?: ModelIdentity;
  /** 任务开始前从 VFS 预读并嵌入 task 的文件列表。文件缺失会在 prompt 末尾
   *  追加 `<missing-inputs>` block（fail-loud）。 */
  inputFiles?: readonly string[];
  /** worker 应写入的输出文件路径。runner 跑完后读回内容（截断）挂到 handoff。 */
  outputPath?: string;
  /** 调用方（主代理）写的「上下文简报」：goal / 约束 / 先前决定 / 验收标准。 */
  context?: string;
  /** Worker 输出 JSON schema（字符串）。runner 抽完 JSON 后用 typebox/value
   *  校验；失败 → retryable failure。Malformed schema（本身不是合法 JSON）
   *  → runner error（不 retry）。 */
  expectedSchema?: string;
  /** Skill hydration：要自动加载注入 worker 的 skill 名列表。 */
  skills?: readonly string[];
  /** Anti-patterns：要 prepend 给 worker 的「禁止事项」列表。 */
  antiPatterns?: readonly string[];
}

export interface RunBatchWorkerOptions {
  /** 待并行的 task 列表（顺序保留；最多 4 个）。 */
  tasks: readonly BatchWorkerItem[];
  /** 调用方 session 的 id。 */
  sessionId: string;
  /** 主会话当前模型（per-item 解析失败时回退）。 */
  mainModel?: ModelIdentity | null;
  /** 调用方（主代理）的 AbortSignal。已 abort → 早退所有 items；
   *  运行中 abort → 透传到每个 in-flight runWorker。 */
  signal?: AbortSignal;
  /** Optional Phase 2 UI feedback hook（透传到每个 item 的 runWorker）。
   *  单个 callback 共享给所有 batch items —— sidepanel 拿到 stream 时按
   *  toolCallId 隔离即可（per-item 状态共享同张 WorkerCard）。 */
  onLiveStream?: (ev: WorkerLiveStreamEvent) => void;
}

/** Batch dispatch 主入口：并行跑 N 个 `runWorker`，组装 outer handoff。
 *  每个 item 用 `Promise.allSettled` 隔离 —— 一个 item reject 不会中断其它
 *  in-flight 调用。返回的 outer handoff 永远 `ok:true`（即便所有 item 都
 *  fail 也是「batch 本身跑完了」），`status` 反映 coarse 结果。
 *
 *  Pre-flight abort：signal 在入口处已 abort → 不调 runWorker，直接返回
 *  batch handoff：所有 items 是「Aborted before start」+ outer `failed`。
 *  调用方仍能根据 outer.status 判断 batch 没跑。 */
export async function runBatchWorker(
  options: RunBatchWorkerOptions,
): Promise<WorkerHandoff> {
  const { tasks, sessionId, signal } = options;

  if (signal?.aborted) {
    const aborted = tasks.map<WorkerHandoff>((t) => ({
      status: 'failed',
      ok: false,
      error: 'Aborted before start',
      summary: 'Aborted before start',
      handoff_notes: '',
      modelKey: '',
      role: t.role,
    }));
    return aggregateBatchHandoffs(tasks, aborted);
  }

  const settled = await Promise.allSettled(
    tasks.map((item) =>
      runWorker({
        task: item.task,
        role: item.role,
        ...(item.modelOverride ? { modelOverride: item.modelOverride } : {}),
        ...(item.inputFiles ? { inputFiles: item.inputFiles } : {}),
        ...(item.outputPath ? { outputPath: item.outputPath } : {}),
        ...(item.expectedSchema !== undefined
          ? { expectedSchema: item.expectedSchema }
          : {}),
        ...(item.skills ? { skills: item.skills } : {}),
        ...(item.antiPatterns ? { antiPatterns: item.antiPatterns } : {}),
        sessionId,
        mainModel: options.mainModel ?? null,
        ...(signal ? { signal } : {}),
        ...(options.onLiveStream ? { onLiveStream: options.onLiveStream } : {}),
      }),
    ),
  );

  const items: WorkerHandoff[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    // runWorker 自身 never throws（per 顶部 contract 「runner 永远不抛」）；
    // 但 promise.allSettled 仍防御性包一层，让 batch 在 runtime exception
    // 下也有 degraded handoff 而不是 throw。
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return {
      status: 'failed',
      ok: false,
      error: msg,
      summary: 'Worker run threw an exception',
      handoff_notes: '',
      modelKey: '',
      role: tasks[i].role,
    };
  });

  return aggregateBatchHandoffs(tasks, items);
}

/** 把 batch items 聚合成 outer handoff。纯函数，可被 unit test 钉死。
 *  Status 决策表：
 *  - 全部 `ok:true` + `status:'success'` → outer `status:'success'`
 *  - 至少 1 个 ok（success/partial）+ 至少 1 个非 ok → outer `status:'partial'`
 *  - 全部 `ok:false` → outer `status:'failed'`
 *
 *  outer `modelKey` / `role`：取第一个 item 的 modelKey + role 作为
 *  「代表性」值，方便旧 caller / UI 渲染 header 时不报「缺字段」错；
 *  实际 per-item 数据在 `batch` 数组里。 */
export function aggregateBatchHandoffs(
  tasks: readonly BatchWorkerItem[],
  items: readonly WorkerHandoff[],
): WorkerHandoff {
  const total = tasks.length;
  let succeeded = 0;
  let failed = 0;
  let partial = 0;
  let cancelled = 0;
  let okCount = 0;

  for (const item of items) {
    if (item.ok) okCount++;
    if (item.status === 'success') succeeded++;
    else if (item.status === 'partial') partial++;
    else failed++;
    // cancelled = item 自报 failed + reason 包含 abort / 取消字样
    if (!item.ok && item.error && /abort|cancel/i.test(item.error)) {
      cancelled++;
    }
  }

  let outerStatus: 'success' | 'partial' | 'failed';
  if (total === 0) {
    // Edge case：空 tasks 列表不该走 batch 路径，但作为兜底避免未定义行为。
    outerStatus = 'failed';
  } else if (succeeded === total) {
    outerStatus = 'success';
  } else if (okCount === 0) {
    outerStatus = 'failed';
  } else {
    outerStatus = 'partial';
  }

  const first = items[0];
  const summary =
    total === 0
      ? 'Batch dispatch: no tasks'
      : `Batch: ${succeeded} succeeded, ${partial} partial, ${failed - cancelled} failed, ${cancelled} cancelled (${total} total)`;

  return {
    status: outerStatus,
    ok: okCount > 0,
    summary,
    handoff_notes: '',
    modelKey: first?.modelKey ?? '',
    role: first?.role ?? 'content_writer',
    // Per-item `partial` flag 让 chat parser / DelegationCardItem 知道这个 item
    // 是「runner 完整跑完了，worker 自称部分产出」（区别于「item ok 但 batch
    // outer 部分失败」）。只在 item.status === 'partial' 时挂 true —— 其他
    // 状态不污染字段。
    batch: items.map((it) => (it.status === 'partial' ? { ...it, partial: true } : it)),
    batchSummary: { total, succeeded, failed, partial, cancelled },
  };
}

