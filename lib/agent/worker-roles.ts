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
  TOOL_EXECUTE_JS,
  TOOL_FS_CREATE_FILE,
  TOOL_FS_EDIT_FILE,
  TOOL_FS_LIST,
  TOOL_FS_READ_FILE,
  TOOL_FS_SEARCH,
  TOOL_INSPECT,
  TOOL_RAG_INSPECT,
} from '@/lib/tools/names';

// ─── Role config shape ───

/**
 * 4 个固定 worker role 之一的具体配置。Runner 拿这个对象造 agent：
 * - `systemPrompt` 直接喂 `createCebianAgent`
 * - `toolWhitelist` 用来从 `sharedTools` 过滤出该 role 的子集
 * - `displayName` 进 tool description / 日志（英文，LLM-facing）
 * - `i18nKey` 给 UI 查本地化标签（与 Subtask 1 落下的 `chat.workerTeamRoster.role.*` 复用）
 */
export interface WorkerRoleConfig {
  systemPrompt: string;
  toolWhitelist: readonly string[];
  displayName: string;
  i18nKey: `chat.workerTeamRoster.role.${WorkerRole}`;
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
const INSPECT = TOOL_INSPECT;
const EXECUTE_JS = TOOL_EXECUTE_JS;
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
    systemPrompt:
      'You are a content writer. Read source material from VFS files via ' +
      'fs_read_file / fs_list / fs_search, then produce written content into a ' +
      'VFS file via fs_create_file / fs_edit_file. Do not write or modify any ' +
      'code files.',
    toolWhitelist: [FS_READ, FS_WRITE, FS_EDIT, FS_LIST, FS_SEARCH, RAG_INSPECT],
    displayName: 'Content Writer',
    i18nKey: 'chat.workerTeamRoster.role.content_writer',
  },

  // ── frontend_coder ───────────────────────────────────────────
  // 写 HTML / CSS / JavaScript。读项目结构 + 写文件；绝不碰 browser tools。
  frontend_coder: {
    systemPrompt:
      'You are a frontend coder. Read project files via fs_read_file / ' +
      'fs_list, then write HTML / CSS / JavaScript into VFS files via ' +
      'fs_create_file / fs_edit_file. Do not invoke any browser-side tools ' +
      '(no execute_js / inspect / tab / screenshot / interact).',
    toolWhitelist: [FS_READ, FS_WRITE, FS_EDIT, FS_LIST],
    displayName: 'Frontend Coder',
    i18nKey: 'chat.workerTeamRoster.role.frontend_coder',
  },

  // ── reviewer ────────────────────────────────────────────────
  // 只读 + 测试运行。读文件、用 execute_js / inspect 验证行为；不修改任何文件。
  reviewer: {
    systemPrompt:
      'You are a reviewer. Read code and artifacts via fs_read_file / fs_list, ' +
      'then exercise them with execute_js / inspect to verify behavior. Do not ' +
      'modify any files (no fs_create_file / fs_edit_file / fs_delete).',
    toolWhitelist: [FS_READ, FS_LIST, INSPECT, EXECUTE_JS],
    displayName: 'Reviewer',
    i18nKey: 'chat.workerTeamRoster.role.reviewer',
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
  },
};

// ─── Helpers ───

/** 4 个 role 的运行时常量集合（key 集合测试与外部需要列举 role 时共用）。 */
export const WORKER_ROLE_KEYS: readonly WorkerRole[] = Object.keys(WORKER_ROLES) as WorkerRole[];

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
 */
export function buildAvailableWorkersBlock(): string {
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
    description:
      'Writes long-form text (markdown, lesson plans, articles, scripts) into VFS files. ' +
      'Reads source material via fs_*, then writes one output file.',
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
    description:
      'Read-only verification. Reads code via fs_read_file, exercises it with execute_js / ' +
      'inspect, reports issues. Cannot modify files.',
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
