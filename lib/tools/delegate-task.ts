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
//
// 命名：exports 集中在文件末尾（per AGENTS.md "Exports at the bottom"）。

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_DELEGATE_TASK } from '@/lib/tools/names';
import { VfsScopeError } from '@/lib/tools/vfs-whitelist';
import {
  assertInputFilesReadable,
  assertWithinSessionRoot,
  resolveSessionPath,
  skillRoot,
} from '@/lib/agent/path-safety';
import type { ModelIdentity, WorkerRole } from '@/lib/persistence/storage';

// ─── Parameters schema ───

/**
 * 8 个参数：2 必填（task / role，role 是 4 个 literal union 之一，**不**有
 * 默认值——LLM 不传会抛 schema 校验错）+ 6 可选（model_override / input_files /
 * output_path / expected_schema / skills / anti_patterns，全部 Type.Optional 包裹）。
 * 空数组与「不传」走同一条 path（skill list = [] → runner 跳过 hydration block）。
 *
 * 所有 `description` 是 LLM-facing，不走 i18n（与 `delegate_dom` 一致）：
 * 工具 schema 是协议契约，LLM 看英文最稳；UI 文案走 i18n。
 */
const DelegateTaskParameters = Type.Object({
  task: Type.String({
    description:
      `Natural-language task for the worker sub-agent. Be specific: ` +
      `"Extract 3 RACES cards about photosynthesis, one per grade 3-5, ` +
      `each with 1 question + 1 cite-paragraph reference" beats "write cards". ` +
      `Worker reads from VFS (fs_read_file / fs_list) and writes to VFS (fs_create_file / fs_edit_file). ` +
      `The worker's reply is a JSON handoff (status / output_file / summary / handoff_notes) — ` +
      `do not ask the worker to return long prose in its reply; route the actual content through \`output_path\`.`,
  }),
  role: Type.Union([
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
      'researcher: read VFS + query RAG collections; output is structured text or a new VFS file.',
  }),
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
      'but the file is missing, the runner auto-retries once.',
  })),
  expected_schema: Type.Optional(Type.String({
    description:
      'Optional. JSON Schema string applied to the worker\'s handoff JSON. On mismatch the runner ' +
      'auto-retries once with the validation error in the retry feedback. ' +
      'Example: `{"type":"object","required":["status","output_file","summary","handoff_notes"],"properties":{...}}`. ' +
      'If the schema itself is malformed JSON, the runner returns an error (no retry — your input was wrong).',
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
    'Fast Lane: HTML / dashboard / interactive-demo deliverables go to `frontend_coder`, NOT `content_writer`.',
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

/** output_content 截断（独立于 handoff JSON 截断）。`output_content` 是 runner
 *  从 VFS 读回的 worker 产物（已 50 KB cap），tool 这里再 cap 一遍避免极端
 *  情况下主代理收到 50 KB × N 个 handoff。 */
function summarizeOutputContent(content: string): string {
  if (content.length <= MAX_OUTPUT_CONTENT_IN_RESULT_CHARS) return content;
  return content.slice(0, MAX_OUTPUT_CONTENT_IN_RESULT_CHARS) + '…[truncated]';
}

// ─── Factory ───

/**
 * Per-session 工厂：每次 `buildSessionToolArray` 调用 create 一次，闭包
 * sessionId 进 execute()，让 path validation 锁在该 session 的 workspace 内。
 *
 * 设计取舍：考虑过顶层 singleton 闭包 lazy 查 sessionId，但 pi-agent-core
 * 的 tool execute() 不传 session context；让 factory 在注册期固定 sessionId
 * 是最直白的做法，与 `run-skill` 工厂（`createSessionRunSkillTool(ctx.sessionId)`
 * 在 `lib/tools/index.ts:111`）同姿态。
 */
export function createDelegateTaskTool(options: {
  sessionId: string;
}): AgentTool<typeof DelegateTaskParameters> {
  const { sessionId } = options;
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
    async execute(_toolCallId, args, signal): Promise<AgentToolResult<Record<string, never>>> {
      const a = args as {
        task: string;
        role: WorkerRole;
        model_override?: string;
        input_files?: readonly string[];
        output_path?: string;
        expected_schema?: string;
        skills?: readonly string[];
        anti_patterns?: readonly string[];
      };

      // ── 1. task 非空检查 ──────────────────────────────────────────
      if (!a.task || !a.task.trim()) {
        return {
          content: [{ type: 'text', text: 'Error: `task` is required and must not be empty.' }],
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

      // ── 6. mainModel：留 null，runner 自有 per-role + override 兜底 ──
      // 真正的 mainModel 解析需要 session DB（按 chatId 查 lastSelectedModel
      // 的覆盖），留到 Subtask 6/7 的 DelegationCard UI 或 session-manager
      // 集成时再补——届时把 mainModel 注入到 tool 闭包或 session-context。
      // 现在传 null，runner 还能走「modelOverride → workerModels[role]」两层。
      const mainModel: ModelIdentity | null = null;

      // ── 7. Lazy import + 调 runner ──────────────────────────────
      const { runWorker } = await import('@/entrypoints/background/agent/worker-runner');
      const handoff = await runWorker({
        task: a.task,
        role: a.role,
        ...(modelOverride ? { modelOverride } : {}),
        // 透传 resolve 后的绝对路径给 worker —— worker 用绝对路径调
        // fs_* 工具写入 /workspaces/<sessionId>/...，而非 VFS root
        // /content.json 这种「猜测根目录」（E2E 实测 bug）。
        ...(resolvedInputFiles ? { inputFiles: resolvedInputFiles } : {}),
        ...(resolvedOutputPath ? { outputPath: resolvedOutputPath } : {}),
        ...(a.expected_schema !== undefined ? { expectedSchema: a.expected_schema } : {}),
        ...(a.skills ? { skills: a.skills } : {}),
        ...(a.anti_patterns ? { antiPatterns: a.anti_patterns } : {}),
        sessionId,
        mainModel,
        ...(signal ? { signal } : {}),
        enableRetry: true,
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
