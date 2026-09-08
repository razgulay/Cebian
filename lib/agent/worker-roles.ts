// Worker-role registry —— `delegate_task` 工具用的 4 种固定 worker role 配置
// 单一事实源。Runner / Tool / UI 都来此处查 role 字段，不在任何调用方硬编码。
//
// 设计要点（mirror `lib/tools/vfs-whitelist.ts` 的「split by concept」原则）：
//   1. `WorkerRole` 联合类型从 `lib/persistence/storage` 复用 —— storage /
//      registry / UI 共用同一份联合，加 role 只需扩一处，TS 编译会强制同步所有
//      `Record<WorkerRole, ...>` 站点。
//   2. `WORKER_ROLES` 用 `Record<WorkerRole, WorkerRoleConfig>`：TS 编译期强制
//      每个 role key 都填好 config；运行时配套「key 集合」测试，再加一道防线。
//   3. Tool 名白名单的字面量值都来自 `lib/tools/names.ts` 的 `as const` 常量，
//      拼写 / 重命名有 TS 兜底；不另起 `ToolName` 联合类型（项目里无此统一
//      抽象；tool 自身运行时就是 string）。
//   4. System prompt 用英文 + ≤ 500 字符 —— LLM-facing，且 worker 上下文预算
//      紧张（per-task prompt + read 上游文件 + 自家产出）。**只描述角色身份与
//      红线**，**不**写 handoff JSON 契约字面量——那条由 `composePrompt` 统一
//      append（`worker-runner.ts`），单点事实源；分散在 4 个 role prompt 里
//      容易漂移。
//   5. `i18nKey` 用模板字面量类型卡住 `chat.workerTeamRoster.role.<roleKey>`
//      形状，UI 复用 Subtask 1 落下的 i18n key，不重复定义。
//   6. **递归守卫硬编码到测试** —— whitelist 不允许出现 `TOOL_DELEGATE_TASK`
//      （worker 不能再起 worker）或 `TOOL_DELEGATE_DOM`（worker 不能再调
//      DOM sub-agent 工具形成 loop）。Whitelist 写得再宽泛，这层是最后一道。

import type { WorkerRole } from '@/lib/persistence/storage';
import { escapeXml } from '@/lib/utils';
import {
  TOOL_DELEGATE_DOM,
  TOOL_DELEGATE_TASK,
  TOOL_FS_CREATE_FILE,
  TOOL_FS_EDIT_FILE,
  TOOL_FS_LIST,
  TOOL_FS_READ_FILE,
  TOOL_FS_SEARCH,
  TOOL_RAG_INSPECT,
} from '@/lib/tools/names';

// ─── Role config shape ───

/**
 * 4 个固定 worker role 之一的具体配置。Runner 拿这个对象造 agent：
 * - `systemPrompt` 直接喂 `createCebianAgent`
 * - `toolWhitelist` 用来从 `sharedTools` 过滤出该 role 的子集
 * - `displayName` 进 tool description / 日志（英文，LLM-facing）
 * - `i18nKey` 给 UI 查本地化标签（与 Subtask 1 落下的 `chat.workerTeamRoster.role.*` 复用）
 * - `timeoutMs` per-role idle ceiling (outer wall-clock cap) — runner 用作「整轮
 *   不应超过这么久」的安全网。null = 用全局 `WORKER_TIMEOUT_MS` fallback。覆盖
 *   流式产出的长任务（如 frontend_coder 写 3–5K LOC）但仍保留硬上限防 hung model。
 */
export interface WorkerRoleConfig {
  systemPrompt: string;
  toolWhitelist: readonly string[];
  displayName: string;
  i18nKey: `chat.workerTeamRoster.role.${WorkerRole}`;
  /** 单次 attempt 的 idle ceiling (ms) — outer wall-clock cap。默认按 role
   *  registry 给（content_writer 120s / frontend_coder 300s / reviewer 90s /
   *  researcher 90s），UI 暴露 60/120/300/600s 4 档 preset 让 user override。 */
  timeoutMs?: number;
}

// ─── Tool name aliases (from names.ts) ───
//
// 把白名单里要用的工具名常量化到模块顶部，让每个 role 的 `toolWhitelist`
// 直接引用这些局部别名 —— 阅读 4 个 role 配置时不必跳到 names.ts 反查。

const FS_READ = TOOL_FS_READ_FILE;
const FS_WRITE = TOOL_FS_CREATE_FILE;
const FS_EDIT = TOOL_FS_EDIT_FILE;
const FS_LIST = TOOL_FS_LIST;
const FS_SEARCH = TOOL_FS_SEARCH;
const RAG_INSPECT = TOOL_RAG_INSPECT;
// 引用这两个只为测试断言；运行时 runner 不会再用到。这里「不导出的存在」本身
// 表达「本模块知道这两个是禁词」。
const FORBIDDEN_TOOLS = [TOOL_DELEGATE_TASK, TOOL_DELEGATE_DOM] as const;
void FORBIDDEN_TOOLS;

// ─── Role registry ───

/**
 * 4 种 worker role 的配置表。`Record<WorkerRole, WorkerRoleConfig>` 让 TS 强制
 * 每个 role key 都有完整 config；新增 role 时改 `WorkerRole` 联合类型 + 此表
 * 两处即可，编译不过即漏改。
 *
 * 每个 role 的白名单与 system prompt 都是**最小够用**原则：让 worker 能完成
 * 本职任务，越界工具一律不给（白名单 deny-by-default，不是黑名单）。例如
 * content_writer 不给 `execute_js` / `inspect` —— 它不需要也不该跑 JS；reviewer
 * 不给 `fs_create_file` / `fs_edit_file` —— 它只能看不能改。
 */
export const WORKER_ROLES: Record<WorkerRole, WorkerRoleConfig> = {
  // ── content_writer ───────────────────────────────────────────
  // 写长内容（markdown / 教案 / 文章 / 讲稿）。读源材料 + 写新文件，不动代码。
  content_writer: {
    // Subtask 8：要求 model 优先「单次完整写入」而非「增量 polish 循环」。
    // 实测主代理喂 161 KB HTML 给 content_writer（见
    // cebian-debug-20260907-183300.json）时，gemini-3.8-flash-high 在
    // per-role ceiling 300s 内只完成 4 次 ±100 B 的 fs_edit_file，几个
    // edit 之间的 re-deliberation（26–63s 一次）就把整轮时间烧光，从未
    // 写完全文。强制 ≤ 2 次 edit 并要求 model 之后用 fs_create_file 重写
    // 全文，避免 over-thinking loop。
    //
    // Subtask 8.5：Subtask 8 fix 上线后又观察到 2 类 over-deliberation
    // 模式（cebian-debug-20260907-194222.json）：pre-write over-read（5+ 次
    // fs_read_file 后仍未 fs_create_file，ceiling 120s 直接 fire）和
    // post-write verify（fs_create_file 写完 82 KB 后又读 + search 7 次，
    // 不出 final text，同样 ceiling 120s fire）。两者是同一个 over-think
    // 病的不同位置——pre-write 拖到 timeout、post-write 拖到 timeout。
    // 把 prompt 重写成 4 条 numbered rules 把 read → write → done 锁死：
    // rules 1/3/4 用 "at most N" / "do not" 这种 hard 表述兜底 over-delib；
    // rule 2 仍以 "prefer" 软引导单次完整写入，由 rule 3 的硬上限接管。
    systemPrompt:
      'You are a content writer. Read source material via fs_read_file / ' +
      'fs_list / fs_search, then write content via fs_create_file / ' +
      'fs_edit_file. Do not modify code files. Rules: (1) read at most 2 ' +
      'source files before writing; (2) prefer a single complete ' +
      'fs_create_file over many small edits; (3) at most 2 edits total — ' +
      'after that, rewrite the whole file with fs_create_file; (4) do not ' +
      're-read the file you just wrote — emit handoff and stop.',
    toolWhitelist: [FS_READ, FS_WRITE, FS_EDIT, FS_LIST, FS_SEARCH, RAG_INSPECT],
    displayName: 'Content Writer',
    i18nKey: 'chat.workerTeamRoster.role.content_writer',
    timeoutMs: 120_000,
  },

  // ── frontend_coder ───────────────────────────────────────────
  // 写 HTML / CSS / JavaScript。读项目结构 + 写文件；绝不碰 browser tools。
  frontend_coder: {
    // Subtask 8.8：本地 OpenAI-compatible 代理（如 Minimax-M3 via vilao.ai）
    // 会 buffer 整个 fs_create_file tool-call 流，结束后**不**发后续 text
    // message（cebian-debug-20260907-211322.json session 2：209s 完成，0 chars
    // text，file 已写 24 KB，assembleHandoff branch 2 误判 failed → retry 也
    // 同样失败 → final status failed）。Prompt rule (1) 是 preferred path——
    // 模型只要出一行 "Wrote <path>"，fix 即生效；Fix Y 是兜底（runner 层在
    // `outputFileExists=true && rawText 空` 时合成最小 handoff）。
    //
    // Subtask 8.9：在 8.8 silent-write rule 基础上叠加 artifact skill
    // (`skills/artifact/SKILL.md`) 的 5 条 hard rules：单文件 self-contained
    // / 无 storage APIs（sandbox 内 SecurityError）/ show at rest / 语义色
    // token / 一次性 fs_create_file + handoff。**保留 frontend_coder 的通用
    // 性**——multi-file project 或 edit 既有 code 也合法，靠末尾 scope qualifier
    // 区分（artifact 任务全规则、非 artifact 任务只保 2 + 4）。理由：cebain
    // 里 `delegate_task` 主代理可能派任何 frontend 工作，不只是 artifact；硬
    // 锁 artifact 会让 multi-file task 走错路径。Cebian 调试日志
    // cebian-debug-20260907-183300.json 显示主代理曾把 161 KB HTML 喂给
    // content_writer，触发 4 次冗余 fs_edit_file 把 120s ceiling 烧光——
    // 现在主代理有 Fast Lane rule 直接走 frontend_coder（见 PREAMBLE 注释）。
    systemPrompt:
      'You are a frontend coder. After fs_create_file emit a short text handoff ' +
      '(runner parses final text, no text = failure). ' +
      'For artifact tasks (single self-contained HTML): ' +
      '(1) inline CSS/JS, libs via https://; ' +
      '(2) NO localStorage / sessionStorage / document.cookie (sandbox SecurityError); ' +
      '(3) initial DOM shows all content statically (scripts enhance, not construct); ' +
      '(4) semantic color tokens on :root for light + dark; ' +
      '(5) one fs_create_file then handoff. ' +
      'Non-artifact: keep rules 2 + 4; relax 1/3/5.',
    toolWhitelist: [FS_READ, FS_WRITE, FS_EDIT, FS_LIST],
    displayName: 'Frontend Coder',
    i18nKey: 'chat.workerTeamRoster.role.frontend_coder',
    // 3–5K LOC code → 25 tok/s 算 ≈ 160s+ → 默认 300s 留 buffer
    timeoutMs: 300_000,
  },

  // ── reviewer ────────────────────────────────────────────────
  // 只读 + 推理 review。读文件 → 根据内容推理 → 写 review handoff。
  reviewer: {
    // Subtask 8.6：实测 `cebian-debug-20260907-202523.json` 中 reviewer
    //（`claude-opus-4-6-thinking`，ceiling 90s）在 85 秒内调了 14 次
    // `fs_read_file`，但 0 次 `execute_js` / 0 次 `inspect`（reviewer 本职该用
    // 的验证工具），也没出 final text，ceiling 直接 fire——这是与 Subtask 8.5
    // content_writer 同源的 over-deliberation 病。Reviewer 不能写文件，所以
    // Subtask 8.5 的 fs_create_file cap 不能直接复用——加 3 条 numbered rules
    // 把 read → reason → handoff 锁死。
    //
    // Subtask 8.7：`cebian-debug-20260907-211322.json` 暴露新事实——Subtask
    // 8.6 prompt 里的"rule 2: 跑 execute_js 或 inspect"是 unfunded 的：实测
    // 9/9 次 `inspect` 和 `execute_js` 全部 errored（reviewer 是 SW 后台
    // worker，没有 sidepanel 那种 active tab context，`tabs.query({ active: true
    // })` 拿不到），claude 试了几次发现工具坏了就 fallback 多读文件，把 rule 1
    // "最多 3 次"也连带突破（实际打了 9 次 fs_read_file）。把 `inspect` 和
    // `execute_js` 从 reviewer `toolWhitelist` 砍掉，rule 2 改成"读完后自己
    // 推理代码（accessibility / correctness / edge cases），别再调 verify 工
    // 具"——白名单收窄到只读后，唯一的路径就是 read → reason → emit，与 reviewer
    // 本意一致。
    //
    // Subtask 8.9：8.6+8.7 砍掉 execute_js / inspect 之后，reviewer 实际**没
    // 有 DOM 执行能力**（SW 后台 worker 跑不出 iframe）。把角色重新定位为
    // 「Artifact Quality Inspector」——静态文本 grep audit 4 条 sandbox 规
    // 则（artifact skill `references/sandbox.md` + `references/design.md`）：
    // (1) 无 storage API（substr 检测 localStorage / sessionStorage /
    // document.cookie）；(2) 所有 CDN 用 https://；(3) :root 定义 light + dark
    // 语义色 token；(4) layout 用 Grid / Flexbox + overflow-x: auto on wide
    // content。Audit method 显式说"grep file content"——防止模型又试 execute_js
    // 已删工具或对此困惑。提案里写死的 "<30s" budget 拿掉，靠 90s ceiling 自
    // 然兜底；100 KB+ 文件 grep + 推理 30s 不够，会假阳性 abort。
    systemPrompt:
      'You are an artifact reviewer. Read the generated HTML (≤ 3 files via fs_read_file). ' +
      'Audit by grepping file content — no DOM execution available in this context: ' +
      '(1) NO localStorage / sessionStorage / document.cookie as substrings; ' +
      '(2) all <script src> / <link href> use https:// (no http:// or relative); ' +
      '(3) :root defines color tokens for light + dark themes; ' +
      '(4) layout uses CSS Grid / Flexbox with overflow-x: auto on wide content. ' +
      'Emit findings as a text handoff within the 90s ceiling.',
    toolWhitelist: [FS_READ, FS_LIST],
    displayName: 'Reviewer',
    i18nKey: 'chat.workerTeamRoster.role.reviewer',
    timeoutMs: 90_000,
  },

  // ── researcher ──────────────────────────────────────────────
  // 信息搜集与综合。读 VFS + 查 RAG collection；产物为结构化文本或文件。
  researcher: {
    systemPrompt:
      'You are a researcher. Find and synthesize information by reading VFS ' +
      'files (fs_read_file / fs_list / fs_search) and querying RAG collections ' +
      '(rag_inspect). Output either structured text in your reply or a new VFS ' +
      'file via fs_create_file. Do not invoke browser-side tools.',
    toolWhitelist: [FS_READ, FS_LIST, FS_SEARCH, RAG_INSPECT],
    displayName: 'Researcher',
    i18nKey: 'chat.workerTeamRoster.role.researcher',
    timeoutMs: 90_000,
  },
};

// ─── Helpers ───

/** 4 个 role 的运行时常量集合（key 集合测试与外部需要列举 role 时共用）。 */
export const WORKER_ROLE_KEYS: readonly WorkerRole[] = Object.keys(WORKER_ROLES) as WorkerRole[];

/**
 * Worker attempt 超时常量 + 阶段决策——三段协同（TTFT + 阶段化 idle-window +
 * per-role ceiling）取代「单点 120s hard wall-clock」。常量与决策放一起是单点事实
 * 源：runner 内部、sidepanel UI、调试日志都读这里，不会因阈值漂移导致 runner
 * abort 阈值 ≠ 倒计时显示分母。
 *
 * 1. **TTFT (Time-to-first-token) ceiling** = 120s。`agent.prompt()` 提交后
 *    若 120s 内 subscriber 还没收到第一个 `message_update` / `text_delta`，视为
 *    「endpoint 真正挂了 / 鉴权错 / 模型 hung」→ fail-fast。**不可重置**：超时
 *    即 fire，避免模型 hang 在「准备输出」阶段时 idle-window 一直被重新 arm。
 *    上调到 120s 是因为 Gemini 3 / GPT-5 thinking / o-series 等推理模型在
 *    first byte 之前内部 reasoning 可能 60–90s，45s 旧值会误伤（Subtask 4 调试
 *    log 印证 idle 实际 fire 是因为 thinking-model silent gap，不是 re-arm bug）。
 *    仍比 per-role ceiling（frontend_coder 300s）小 2.5×，hung endpoint 不会
 *    干等 5 分钟才报错。TTFT 阶段无 idle（由 TTFT timer 独管）。
 *
 * 2. **Idle window** = 180s。**只**适用于 `between_turns` / `tool_running` 两个
 *    阶段（见下 `StreamPhase`）——即模型上一轮已结束、等下一轮开始的间歇期，或
 *    tool 正在执行但没 progress event 的等待期。Subscriber 每次收到事件
 *    （`message_start` / `message_update` / `message_end` / `tool_execution_*`）
 *    重新 arm 一次；静默 180s（端点假死 / 模型陷入循环 / tool result 长时间不
 *    出 / thinking-model reasoning gap）→ fail-fast + smart retry。从 60s 调到
 *    180s 是因为 Subtask 4 调试 log（cebian-debug-20260907-144158.json）实测
 *    Gemini 3 Flash thinking 在长产出任务（HTML5 页面 + SVG + quiz）的
 *    last-event→idle 静默达 60s，上限预估可达 120s——60s 旧值会假阳性 fire。
 *    180s 比实测最坏 120s 留 60s（1 分钟）buffer。
 *
 *    **不在 emit 阶段生效**：emit 阶段（`emitting`，模型正在生成 assistant
 *    message content）idle 阈值取 per-role ceiling。**这是 Subtask 7 的核心
 *    修复**——本地 OpenAI-compatible 代理会 buffer 整个 tool-call argument 流，
 *    只在末尾一次性发完整 tool call 给 pi-ai（参见
 *    `@earendil-works/pi-agent-core/dist/agent-loop.js:201-244`）。结果就是
 *    Gemini 3.8 / GPT 5.5 / Kimi K3 在 emit 阶段有 140–227s 完全静默（无
 *    `message_update` 事件），但模型其实在写 25–135 KB 的 tool argument。旧的
 *    180s idle 把这种「正在工作」误判为「hung」，导致 Kimi K3 直接 retry。
 *    Subtask 7 用 `resolvePhaseTimeout` 把 emit 阶段阈值放成 ceiling，
 *    `message_end` 总在 ceiling 内 fire → idle 不再误杀。
 *
 * 3. **Per-role ceiling** 来自 `WORKER_ROLES[role].timeoutMs`，每个 role 单独
 *    配置（content_writer 120s / frontend_coder 300s / reviewer & researcher 90s）。
 *    这是 outer wall-clock cap——emit 阶段 idle 也用这个值（`resolvePhaseTimeout`
 *    在 `emitting` 时返回 `ceilingMs`），TTFT + idle 漏掉时（long tool chain 期
 *    间没新 token 但也没真 hang）兜底。Default `WORKER_TIMEOUT_MS` 仅是 role
 *    config 缺失时的全局兜底。
 *
 * 设计依据：实测主代理 485s ghost gap（model 解析后到 agent.prompt settle
 * 之间的静默）表明 LLM 链路可能 hang 数分钟；让 user 干等毫无意义。三段协同
 * + 阶段决策：hung model → TTFT 秒级发现；emit 阶段 → 用 ceiling 兜底（不
 * 误杀 buffer 模型）；真正 inter-turn 静默 → 180s idle fail-fast；总时间
 * → per-role ceiling 兜底，绝不中途截断。四层 defense in depth。
 *
 * 放在 `lib/agent/worker-roles.ts`（而非 `entrypoints/background/agent/worker-runner.ts`）
 * 是因为这个常量被**两个 context** 用到：background runner 用它触发 abort，
 * sidepanel UI 用它渲染倒计时。如果留在 runner，sidepanel 要从 entrypoint 跨
 * 边界 import 一个常量（带出 factory + 8 个 tool 模块 → 拖大 bundle），且
 * 违反 AGENTS.md「按 concept 归档」的语义。`StreamPhase` + `resolvePhaseTimeout`
 * 放一起也是同一理由：阶段→阈值的映射是策略，跟常量同住一处；runner 只 import
 * 不重新发明轮子。
 */

// Subtask 8.10 drift-fix：plan / CHANGELOG（Subtask 8.5 时期）原本记的 TTFT 45s
// + idle 20s 是「理想值」；实测落地后被运行时调成 **TTFT 120s + idle 180s**，
// 因为真实场景里本地 OpenAI-compatible proxy（Kimi K3 emit gap 227s、
// Minimax-M3 冷启首字节 30–60s）的 buffer / 冷启动时间会拉爆 45s/20s。
// 这**不是 bug**——是 runtime tuning 后的真值。CHANGELOG 已在本期（Subtask 8.10）
// 加双语条目订正。任何后续想改这两个常量，必须**同一笔 commit**里同步更新：
//   1. CHANGELOG `## [Unreleased]` 加中英双语条目
//   2. 计划文件 `clever-greeting-hennessy.md` 记录 design rationale
//   3. `worker-roles.test.ts` 里 `WORKER_TTFT_MS === 120_000` /
//      `WORKER_IDLE_MS === 180_000` 两个 pinning test 必须同步改字面量
// 否则会被 CI 直接 fail——这就是 pinning test 的存在意义：强制 plan/code/CHANGELOG
// 三处同步，杜绝再次漂移。
//
// 另一个 design trade-off（Subtask 7 引入、`resolvePhaseTimeout` 文档里有详述）：
// `emitting` 阶段 idle 阈值故意用 per-role ceiling 而非 WORKER_IDLE_MS。
// 后果是「model emit 1 token 后永远 hang」（如 Minimax-M3 stall 模式）只能由
// ceiling（frontend_coder 300s）兜底，不会被 idle 早 fire。这是 Subtask 7
// 时期为兼容 buffering proxy 显式做出的取舍，不是 bug；详见 Subtask 8.10
// CHANGELOG 解释为什么选 ceiling 而不是另起一个更短的「emit_idle」phase。
export const WORKER_TIMEOUT_MS = 120_000;
export const WORKER_TTFT_MS = 120_000;
export const WORKER_IDLE_MS = 180_000;

/** Runner 用来驱动 idle timer 的阶段。**Phase 决定 idle 阈值**——不是固定 180s。
 *
 * 阶段转移由 `agent.subscribe` 收到的 `AgentEvent` 驱动：
 * - `before_ttft` → `emitting`：`message_start` (assistant) 或首个 `message_update`
 * - `emitting` → `between_turns`：`message_end` (assistant)
 * - `between_turns` → `tool_running`：`tool_execution_start`
 * - `between_turns` / `tool_running` ↔ `emitting`：下一轮 `message_start` (assistant)
 *
 * 阈值映射见 `resolvePhaseTimeout`：emit 阶段用 per-role ceiling（避免误杀
 * buffer 型 proxy），其余阶段用 `WORKER_IDLE_MS` (180s)。`before_ttft` 由
 * TTFT timer 独管，无 idle arm。 */
export type StreamPhase =
  | 'before_ttft'
  | 'emitting'
  | 'between_turns'
  | 'tool_running';

/** Resolve 某 phase 下 idle 定时器的阈值（ms）。
 *
 * 决策表：
 * - `emitting` → `ceilingMs`（per-role ceiling）。emit 阶段用 ceiling 兜底，
 *   避免本地 proxy buffer 整个 tool-call 时 idle 误杀。Hung model 在 emit
 *   阶段仍 fail-fast——ceiling 同时也是 outer wall-clock cap。
 *   **设计取舍**：这意味着 model 在 emit 阶段 stall（如 Minimax-M3 emit 1
 *   token 后 hang）只能由 ceiling 兜底，不会被 idle 早 fire——是 Subtask 7
 *   显式选 ceiling 而不是另起一个更短的「emit_idle」phase 的取舍，理由是
 *   兼容 buffer 巨型 tool-call args 的本地 proxy。详见 Subtask 8.10 CHANGELOG。
 * - 其余 phase（`between_turns` / `tool_running` / `before_ttft`）→
 *   `WORKER_IDLE_MS` (180s)。`before_ttft` 实际不 arm idle（TTFT timer 独管），
 *   这里返回 180s 是兜底——caller 不该在 `before_ttft` 调本函数，但若误调也不
 *   会给一个奇怪的阈值。
 *
 * 纯函数：无 IO、无 storage 读；单元测试 `worker-runner.test.ts` 直接覆盖。
 * Runner 每收到一个 phase transition 就调一次，重新 arm idle timer。 */
export function resolvePhaseTimeout(phase: StreamPhase, ceilingMs: number): number {
  return phase === 'emitting' ? ceilingMs : WORKER_IDLE_MS;
}

/**
 * 查一个 role 的 config。**仅**接受 `WorkerRole` 联合里的值；外部拿到可疑
 * 字符串（LLM 误传、用户手填）时抛错，避免 silently 返回 undefined 让 runner
 * 后面再炸出更难读的栈。
 */
export function getRoleConfig(role: WorkerRole): WorkerRoleConfig {
  const config = WORKER_ROLES[role];
  if (!config) {
    // 理论上 `role: WorkerRole` 编译期已经兜底；这里是 runtime 兜底（防 Object
    // 被人为改 / WorkerRole 类型被绕过）。
    throw new Error(`Unknown worker role: ${String(role)}`);
  }
  return config;
}

/** 取一个 role 的白名单 tool 名列表（runner 用来 filter `sharedTools`）。
 *  等价 `getRoleConfig(role).toolWhitelist`，提供独立 API 让调用方不必
 *  关心 config 的其它字段。 */
export function getWorkerToolNames(role: WorkerRole): readonly string[] {
  return getRoleConfig(role).toolWhitelist;
}

/**
 * 解析 role 的最终 attempt 超时阈值（ms）。优先级（高→低）：
 *   1. `overrideMap[role]` —— UI / storage 设的 user-tunable 覆盖；
 *   2. `WORKER_ROLES[role].timeoutMs` —— role registry 写的合理默认；
 *   3. `WORKER_TIMEOUT_MS` —— 全局兜底（role config 字段缺失或工作期间临时
 *      kick 走 registry 时用）。
 *
 * 仅读 storage 在 caller 侧做（pure helper 不依赖 IO），让上层（runner /
 * sidepanel UI / debug log）共享同一份决议逻辑——避免「UI 显示 300s 但 runner
 * 实际 120s」漂移问题。`overrideMap` 缺省 `{}` 等价「用户没设」等价「走默认」，
 * 但显式传 `{}` 也对（map 是 partial）。 */
export function resolveWorkerRoleTimeoutMs(
  role: WorkerRole,
  overrideMap?: Readonly<Partial<Record<WorkerRole, number>>>,
): number {
  const fromStorage = overrideMap?.[role];
  if (typeof fromStorage === 'number' && fromStorage > 0) return fromStorage;
  const fromRegistry = WORKER_ROLES[role]?.timeoutMs;
  if (typeof fromRegistry === 'number' && fromRegistry > 0) return fromRegistry;
  return WORKER_TIMEOUT_MS;
}

// ─── L1 <available-workers> block ───

/**
 * 主代理 system prompt 用的「可用 worker」L1 索引。
 *
 * 设计意图：让 main agent 在用户请求一进来就看到 4 种固定 worker 的能力
 * 切片 + 一个最小可复制的调用示例，主动把"我能不能 delegate？"这件事放
 * 进它的视野，避免模型**只在用户显式说 "delegate" 时才想得起 delegate_task**。
 *
 * 关键设计选择——**prescriptive polarity**：preamble 把"delegate"作为默认
 * 行为，只有 3 个明确例外（短答案 / 多轮迭代 / 单次工具调用）才让主代理
 * 自己动手。原因：实测发现描述性写法（"delegate when ..."）让模型把
 * "Build a Web Studio" 误判为 "few tool calls 自己能做"，结果打 20+ 次
 * fs_read_file / fs_search 才开始写——主代理 context 全被中间工具调用吃光，
 * 用户在 105 秒时 cancel。Prescriptive polarity（"DEFAULT to delegate"）
 * + "Why" 数字（"30+ tool calls vs ~50 tokens handoff"）让模型理解：每
 * 个 native tool call 的 tool result 都会进主代理 context，delegate 把中
 * 间步骤隔离到 worker session 里，主代理只收到 ≤4 KB handoff。Schema
 * description 已经说过各 role 的 use case，但描述是被动的——L1 块是主
 * 动菜单，在 system prompt 里位置紧邻 `<skills>`，与 skill 的 L1 索引
 * 同姿态（同样的 XML 包裹、同样的"先扫索引再决定要不要开 SKILL.md"协议）。
 *
 * 形态约定（与 `<skills>` 块对齐，方便主代理学会同一种解析方式）：
 *   - 顶层 `<available-workers>` XML 标签。
 *   - preamble 说明何时 delegate / 何时不 delegate。Prescriptive polarity
 *     故意冗余——必须明确写出 DEFAULT 行为 + 3 个具体例外 + 数字对比，
 *     模型才走 delegate 路径不绕回 native tool。实际尺寸 ≈1.2 KB /
 *     ~250 tokens（system prompt cache prefix 命中后该块不再计入成本）。
 *   - 每个 role 一个 `<worker>` 子块，3 个固定子标签：`<role>` 标识符、
 *     `<description>` 一句话最佳场景、`<example>` 一段可直接复制的最小
 *     delegate_task 调用（含 output_path / input_files / skills 等常用字段）。
 *
 * 故意**不**塞进 block 的信息：
 *   - tool whitelist（runner 自己负责过滤，LLM 只管调工具，无需看见）。
 *   - 系统 prompt 全文（worker 内部行为，main agent 无需关心）。
 *   - 模型名（per-role 模型在 Settings → Advanced 配置；会变，缓存不友好）。
 *   - 递归守卫（runner 强制，与 LLM 决策无关）。
 *
 * `getRoleConfig(role).i18nKey` 的标签化展示留给 UI（Subtask 6 已落下的
 * Team Roster widget），LLM-facing 文本保持英文以匹配 schema description
 * 的协议契约（与 `lib/tools/delegate-dom.ts` 同姿态）。
 *
 * 纯函数：registry 改了就重渲染；不读 storage / VFS / session。每轮派发
 * 重新拼一次（≈ 1.5 KB 的字符串拼接，开销可忽略），命中缓存的 system
 * prompt 仍按字节一致——block 跟 registry 同步变化，registry 不变则字节
 * 不变。
 *
 * `enabled` 参数：本块的存在与否由主代理的 Worker Team 总开关
 * (`workerTeamEnabled` storage) 控制——OFF 时返回空串，必须与
 * `lib/tools/index.ts` 里是否 push `delegate_task` 工具同步（任一缺失
 * 都会让 LLM 幻觉调用或不知何时该用 worker）。这是 `rag_search` 那个
 * "tool + prompt must agree" 模式的镜像。 */
export function buildAvailableWorkersBlock(enabled: boolean = true): string {
  if (!enabled) return '';
  const entries = WORKER_ROLE_KEYS.map((role) => {
    const meta = WORKER_ROLES[role];
    return `<worker>
<role>${escapeXml(role)}</role>
<description>${escapeXml(META[role].description)}</description>
<example>${escapeXml(META[role].example)}</example>
</worker>`;
  });

  return `<available-workers>
${PREAMBLE}

Available workers:
${entries.join('\n')}
</available-workers>`;
}

/**
 * Preamble——主代理决定 delegate 还是自己动手的核心规则。
 *
 * Polarity 选择：DEFAULT to delegate, 三种例外才自己来。原因：把规则翻
 * 转成"默认 delegate"比"delegate when ..."明显更不易让模型走 native
 * tool 路径；native tool 一旦开始走，每个 tool result 都会进主代理 context，
 * 中间步骤 20+ 次就把 chat context 烧光。Delegate 把中间过程隔离到 worker
 * session，主代理只收 handoff JSON（≤ 4 KB）。
 *
 * "Why" 数字要具体（"30+ tool calls vs ~50 tokens handoff"），不要抽
 * 象说"省 context"——模型理解具体数字比理解抽象概念更可靠。
 *
 * Subtask 8.9：在"DEFAULT to delegate"基础上叠加 **Fast Lane routing**——
 * 进一步指定 HTML / dashboard / interactive demo 类 deliverable 直接走
 * `frontend_coder`，**禁止**经 `content_writer` 文字润色。理由：
 * `cebian-debug-20260907-183300.json` 显示主代理曾把 161 KB 生成好的
 * HTML 喂给 content_writer「polish」，触发 4 次冗余 fs_edit_file、re-
 * deliberation 26–63s 一次，120s ceiling 直接 fire。Fast Lane rule 与
 * `delegate_task` tool description（[lib/tools/delegate-task.ts:67-72](lib/tools/delegate-task.ts)
 * 同句双布——preamble + tool schema 两层 defense in depth，确保 LLM
 * 在任一入口都看见同一 routing 约束。
 */
const PREAMBLE = `You can delegate long or specialized sub-tasks to a fixed roster of
worker sub-agents via the \`delegate_task\` tool. Each worker runs in an
isolated context — it does NOT see this conversation's history — so spell
out everything it needs in \`task\`, \`input_files\`, and \`output_path\`. The
worker returns a compact JSON handoff (status / output_file / summary /
handoff_notes) plus (truncated) output file content.

DEFAULT to \`delegate_task\` when the task produces a non-trivial artifact
(a file, a long document, a UI page, code, a structured report). This
includes "write / build / create / generate / draft X" requests even
when you have the native tools to do it yourself — the worker runs in
isolation, so its intermediate reads / searches / tool calls do NOT
enter your context. For "Build a Web Studio" delegated to
\`frontend_coder\` you spend ~50 tokens of handoff; doing it directly
can cost 30+ tool calls before producing anything.

**Fast Lane routing (HTML / dashboards / interactive demos)**:
delegate HTML / dashboard / interactive-demo deliverables directly to
\`frontend_coder\`. Do NOT route generated HTML through \`content_writer\`
for textual polish — \`content_writer\` is for prose / markdown, and
routing 100 KB+ HTML into it triggers proxy buffer bottlenecks and
multi-minute deliberation (a previous run hit 4 redundant fs_edit_file
calls and burned the 120s ceiling without producing a complete file).
\`frontend_coder\` writes the full artifact in one fs_create_file; let
\`reviewer\` audit sandbox compliance afterward.

Do it YOURSELF (native tools) only when:
  • the answer fits in a few short sentences (Q&A, brief explanations),
  • the task needs back-and-forth with the user (iterative refinement),
  • the task is exactly one tool call (one read, one search, one query).`;

/** L1 索引里 role 的两段固定文案——description（一句话最佳场景）+ example
 *  （最小可复制调用）。放模块顶部方便 diff；与 `WORKER_ROLES` 用同一组
 *  `WorkerRole` key，编译期 `Record<WorkerRole, ...>` 强制每个 role 都填。
 *  故意不用 `Record<WorkerRole, ...>` 形式（看起来更整齐）——这两个字段
 *  是 LLM-facing 元数据，不是 worker 运行时配置，单独一层更易演进
 *  （扩字段不污染 `WorkerRoleConfig`）。 */
interface WorkerL1Meta {
  /** 一句话最佳场景（≤ 150 字符，便于主代理在 ~5 行内扫完整张菜单）。 */
  description: string;
  /** 最小可复制调用示例：覆盖典型字段（task / output_path / input_files /
   *  skills），让 main agent 看见"这个 role 实际长这样调"。 */
  example: string;
}

const META: Record<WorkerRole, WorkerL1Meta> = {
  content_writer: {
    // Subtask 8.9：Fast Lane routing 要求主代理把 HTML 任务直接派给
    // frontend_coder（见 PREAMBLE）；content_writer description 必须同步表
    // 明「不接 HTML artifact」——否则 LLM 看到 "long-form text" 描述还会
    // 把 161 KB HTML 喂进来（cebian-debug-20260907-183300.json）。把否定
    // 约束写在 description 里比靠 preamble 单点稳：preamble + description
    // 双点同步，defense in depth。
    description:
      'Writes long-form text (markdown, lesson plans, articles, scripts) into VFS. ' +
      'Reads source material via fs_*, writes one output file. Not for HTML artifacts ' +
      '(use frontend_coder via Fast Lane).',
    example:
      `delegate_task({ role: 'content_writer', task: 'Write 3 RACES cards about ` +
      `photosynthesis to content.json', output_path: 'content.json', skills: ['races-template'], ` +
      `anti_patterns: ['Do not fabricate quotes'] })`,
  },
  frontend_coder: {
    description:
      'Writes HTML / CSS / JavaScript into VFS files. No browser tools — pure code output.',
    example:
      `delegate_task({ role: 'frontend_coder', task: 'Read content.json and build an ` +
      `interactive HTML5 RACES writing studio with Tailwind, font size slider, and squiggly ` +
      `underlines', input_files: ['content.json'], output_path: 'studio.html' })`,
  },
  reviewer: {
    // Subtask 8.7：whitelist 已砍掉 execute_js / inspect（实测 SW-background
    // worker 拿不到 active tab，工具 9/9 errored），description 必须同步——
    // 否则主代理还会按旧理解派「exercise code with execute_js」的任务。
    description:
      'Read-only review. Reads up to 3 files via fs_read_file, reasons about ' +
      'correctness / accessibility / edge cases, emits findings as a text ' +
      'handoff. Cannot modify files or invoke browser tools.',
    example:
      `delegate_task({ role: 'reviewer', task: 'Review studio.html for accessibility ` +
      `issues and report 3 concrete bugs', input_files: ['studio.html'] })`,
  },
  researcher: {
    description:
      'Finds and synthesizes information by reading VFS files and querying RAG collections. ' +
      'Output is structured text in the reply or a new VFS file.',
    example:
      `delegate_task({ role: 'researcher', task: 'Summarize the structure of ` +
      `content.json into a markdown outline', input_files: ['content.json'], ` +
      `output_path: 'outline.md' })`,
  },
};
