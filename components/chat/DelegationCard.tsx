// `DelegationCard` —— inline collapsible 卡片，渲染 `delegate_task` 工具调用。
//
// 与通用 `ToolCard` 的差别：
//   - Header 强调 worker role（图标 + role 名）+ 状态 badge，而不是「label 字符串」。
//   - Body 显示 worker 实际产出（status / output file / summary / handoff notes / model），
//     而不是把整套 JSON dump 出来 —— 用户看到的是「这次委派做了什么」，不是 raw result。
//   - outputFile 是一等公民：成功时给一个按钮直接打开 VFS 预览（`/vfs.html#<path>`），
//     不必切到 VFS 页查文件。这是 plan 里「clickable link to output file (VFS preview)」
//     的落地。
//
// 状态来源：父组件 `chat/index.tsx` 解析 `toolResult.content[].text` 里的 handoff JSON
// （runner 给的就是 JSON；用 `summarizeHandoffJson` 缩过但仍是合法 JSON）。本组件只
// 关心结构化字段，不重新解析。
//
// Phase 2 visual feedback (delegated-task card 实时反馈):
//   - 2.1 Live elapsed timer：status='running' 时 header 显示 "Running… Xs / 120s"。
//     计时起点由 caller 传 `attemptStartedAt`（Date.now()）— 避免 component
//     re-mount 时 timer 被重置。`WORKER_TIMEOUT_MS` 来自 worker-runner.ts,
//     保持「UI 显示的上限」与「runner 实际 abort 阈值」single source of truth.
//   - 2.2 Pulse/shimmer：container 左边一道 warning border + 整卡 animate-pulse
//     + 跑中时角色图标改 spin。状态变 success/failed 后全部退场——保留
//     "card 还在动 = 还在跑" 的视觉信号.
//   - 2.3 Role action badge：status='running' 时 header 额外加 "writing /
//     coding / researching / reviewing" 的 action label（具体文案见 locales
//     `chat.delegation.action.*`），让用户一眼看出 "这个 worker 现在在做什么"（不只是 "在跑"）。
//
// Subtask 1.3 batch container：
//   当 `delegate_task` 用 `tasks: [...]` 形态调用时（最多 4 个独立 task 并行），
//   渲染 outer `DelegationCard`（不带 single-task 字段，header 显示 coarse 计数 + status badge），
//   body 渲染 N 个 `DelegationCardItem`（内层卡片，与单 task 视觉一致）。
//   Per-item 的状态 / elapsed timer / output 链接都独立 —— 一个 item 卡死不影响其他。
//   Outer status 决策表：all success → success；≥1 fail → partial；all fail → failed。
//
// Subtask 2.3 reviewer checklist mini-table：
//   `WorkerHandoff.checklist: [{item, status, evidence}]`（Subtask 2.2 schema）
//   在 inner card 渲染一个 mini-table：3 列（kebab id / status icon / evidence
//   truncated 80 chars），aggregate header 显示 X pass · Y warn · Z fail。
//   checklist 缺 / 空数组时**不**渲染 —— 非 reviewer role（content_writer /
//   frontend_coder / researcher）没有 checklist，老 reviewer 没 emit 也是空。
//   这条 prop 接受 `readonly ChecklistItem[]` 而非 enum-typed id：schema 用了
//   开放 pattern `^[a-z][a-z0-9-]*$`（Subtask 2.2 code-review #10），未来
//   加 item 不需要改 DelegationCard 编译；table 用 i18n lookup map 把 known 15
//   id 翻成 label，未知 id fallback 成 kebab 原文。

import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import {
  ChevronRight,
  Loader2,
  Check,
  X,
  AlertTriangle,
  PenLine,
  Code2,
  Search,
  BookOpen,
  ExternalLink,
  Clock,
} from 'lucide-react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { WorkerRole } from '@/lib/persistence/storage';
import type { WorkerLiveLine, WorkerLiveStreamBuffer } from '@/lib/agent/worker-live-stream';

/** 4 种角色对应 lucide icon —— `worker-roles.ts` 已为每个 role 定义 `i18nKey`
 *  指向 `chat.workerTeamRoster.role.<roleKey>`（Subtask 1 已 ship），这里复用。 */
const ROLE_ICONS: Record<WorkerRole, typeof PenLine> = {
  content_writer: PenLine,
  frontend_coder: Code2,
  reviewer: Search,
  researcher: BookOpen,
};

/** i18n 模板字面量在 WXT 强类型 `t()` 下没法拼 runtime 值 —— 列一份 4 role
 *  → labelKey 的 lookup 表，让 TS 拿到字面量 key。 */
const ROLE_LABEL_KEYS: Record<WorkerRole, 'chat.workerTeamRoster.role.content_writer' | 'chat.workerTeamRoster.role.frontend_coder' | 'chat.workerTeamRoster.role.reviewer' | 'chat.workerTeamRoster.role.researcher'> = {
  content_writer: 'chat.workerTeamRoster.role.content_writer',
  frontend_coder: 'chat.workerTeamRoster.role.frontend_coder',
  reviewer: 'chat.workerTeamRoster.role.reviewer',
  researcher: 'chat.workerTeamRoster.role.researcher',
};

/** Phase 2.3 role-action label：4 role 各自对应的「正在做什么」短语，状态
 *  running 时挂在 header 让用户一眼看出「这个 worker 现在在做什么」。
 *  English / 中文都双语，硬塞 i18n lookup table（runtime 拼 key 触发 TS
 *  字面量校验失败，所以走 Record<WorkerRole, literal-key> 这条老路）。 */
const ROLE_ACTION_LABEL_KEYS: Record<WorkerRole, 'chat.delegation.action.content_writer' | 'chat.delegation.action.frontend_coder' | 'chat.delegation.action.reviewer' | 'chat.delegation.action.researcher'> = {
  content_writer: 'chat.delegation.action.content_writer',
  frontend_coder: 'chat.delegation.action.frontend_coder',
  reviewer: 'chat.delegation.action.reviewer',
  researcher: 'chat.delegation.action.researcher',
};

/** Public API */

/** Reviewer audit row shape —— mirror `WorkerHandoff.checklist`（Subtask 2.2
 *  schema-validate.ts）。`item` 是 open-pattern kebab id（schema 用
 *  `^[a-z][a-z0-9-]*$`，不是 enum），所以这里也用 `string` 接受未知 id —— table
 *  渲染时走 i18n lookup map + 原文 fallback。 */
export interface ChecklistItem {
  item: string;
  status: 'pass' | 'fail' | 'warn';
  evidence: string;
}

/** Aggregate reviewer audit counts —— 驱动 mini-table header。
 *  空数组 / undefined 时 caller 不渲染 table（sane default）。 */
export interface ChecklistSummary {
  pass: number;
  warn: number;
  fail: number;
}

/** Pure counter —— 给 mini-table header 用，不依赖 React。
 *  undefined / 空数组时返回 undefined（caller 跳过 table 渲染）。
 *  非 ChecklistItem 元素被 silently skip（schema 校验过的 handoff
 *  不会走到这条路径，但 UI 不能因脏数据 crash）。 */
export function summarizeChecklist(
  items: readonly ChecklistItem[] | undefined,
): ChecklistSummary | undefined {
  if (!items || items.length === 0) return undefined;
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.status === 'pass') pass++;
    else if (it.status === 'warn') warn++;
    else if (it.status === 'fail') fail++;
  }
  return { pass, warn, fail };
}

/** Per-task inner card shape. Both `DelegationCardItem` (inner rendering) and
 *  the outer batch container accept this. The outer container's full
 *  props also accept `batch?: readonly DelegationCardItemProps[]` +
 *  `batchSummary?: BatchSummary`. */
export interface DelegationCardItemProps {
  /** Worker role —— 来自 tool argument `tc.arguments.role`。 */
  role: WorkerRole;
  /** 当前状态。`running` 时不传 toolResult；`success` / `failed` / `partial` 时
   *  由父组件解析 handoff JSON 后传入。`cancelled` 对应「主代理被 abort」
   *  （与 ToolCard 同样语义）。`timedOut` 是 worker 跑到 120s 上限被 runner
   *  主动 abort 的状态 —— 配套「换 model 再试」提示。 */
  status: DelegationStatus;
  /** Worker 收到的 task 字符串（来自 `tc.arguments.task`，running 时必传）。 */
  task: string;
  /** Worker 写出的文件相对路径（如 `content.json`），用于 VFS 预览链接。
   *  sessionId 必传才能拼出 `/workspaces/<sessionId>/<outputFile>`。 */
  outputFile?: string;
  sessionId?: string;
  /** Handoff JSON 里 `summary` 字段。 */
  summary?: string;
  /** Handoff JSON 里 `handoff_notes` 字段（通常是失败原因）。 */
  handoffNotes?: string;
  /** Handoff JSON 里 `modelKey` 字段（如 `openai/gpt-4o-mini`），小字展示。 */
  modelKey?: string;
  /** 重试次数（1 或 2）。attempts=2 时额外显示一个「retry」badge，
   *  帮用户理解这次委派 runner 内部自愈过一次。 */
  attempts?: number;
  /** Attempt 实际耗时（ms）。仅在 timedOut / failed 时显示「跑了 X 秒」，
   *  让用户判断「是真慢还是卡死」。 */
  attemptDurationMs?: number;
  /** Attempt 开始时间戳（`Date.now()` ms）。caller 在 tool call emit 时记录
   *  后传进来，让 card 第一次 render 就启动 elapsed timer 而不会因为 React
   *  re-mount 把 timer 归零。`status === 'running'` 时使用。 */
  attemptStartedAt?: number;
  /** Worker runner 的硬上限（ms）。caller 从 `WORKER_TIMEOUT_MS` 传进来，
   *  保持 "UI 显示的上限" 与 "runner 实际 abort 阈值" 同步—— hard-code
   *  120_000 会在 runner cap 改的瞬间漂移。`status === 'running'` 时用
   *  于渲染 "Xs / Ys" 倒计时分母。 */
  timeoutMs?: number;
  /** Reviewer 静态 audit 的结构化结果（Subtask 2.2 `REVIEWER_HANDOFF_SCHEMA`）。
   *  非 reviewer role 永远 undefined —— 不渲染 mini-table。 */
  checklist?: readonly ChecklistItem[];
  /** Phase 2 UI feedback：worker-runner 的实时流（已在
   *  `lib/agent/worker-live-stream.ts` 里 coalesce 成 lines）。caller
   *  （`<ChatPage>`，entrypoints/sidepanel/pages/chat/index.tsx）从
   *  `useBackgroundAgent().state.liveLines.get(<外层 toolCallId>)` 取值传进来。
   *  渲染条件与可见性契约见 `<LiveStreamBox>`。undefined / 空 = 没有流
   *  （box 不渲染）。 */
  liveBuffer?: WorkerLiveStreamBuffer;
}

interface DelegationStatusBadgeProps {
  status: DelegationStatus;
  /** Elapsed seconds since attempt started (running state only). Caller
   *  computes from `attemptStartedAt`; badge shows "(Xs / Ys)" when both
   *  elapsedSec and timeoutSec are provided, falls back to "Running…" text
   *  alone when caller doesn't track timing (e.g. older persisted state). */
  elapsedSec?: number;
  timeoutSec?: number;
}

function DelegationStatusBadge({ status, elapsedSec, timeoutSec }: DelegationStatusBadgeProps) {
  switch (status) {
    case 'running': {
      // 计时显示："Running… (Xs / Ys)" — 用户实时看到「跑了多久 / 还剩多久
      // 被 abort」。没计时信息时回退到原来的纯文本 "Running…"。
      const timerText =
        elapsedSec !== undefined && timeoutSec !== undefined
          ? ` (${elapsedSec}s / ${timeoutSec}s)`
          : '';
      return (
        <Badge variant="secondary" className="gap-1 py-0.5">
          <Loader2 className="size-3 animate-spin" />
          {t('chat.delegation.status.running')}
          {timerText && (
            <span className="font-mono text-[0.65rem] text-muted-foreground tabular-nums">
              {timerText}
            </span>
          )}
        </Badge>
      );
    }
    case 'success':
      return (
        <Badge variant="secondary" className="gap-1 py-0.5 text-success">
          <Check className="size-3" />
          {t('chat.delegation.status.success')}
        </Badge>
      );
    case 'partial':
      return (
        <Badge variant="secondary" className="gap-1 py-0.5 text-warning-foreground bg-warning/15">
          <AlertTriangle className="size-3" />
          {t('chat.delegation.status.partial')}
        </Badge>
      );
    case 'failed':
      return (
        <Badge variant="destructive" className="gap-1 py-0.5">
          <X className="size-3" />
          {t('chat.delegation.status.failed')}
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="outline" className="gap-1 py-0.5 text-muted-foreground">
          {t('chat.delegation.status.cancelled')}
        </Badge>
      );
    case 'timedOut':
      // Timeout 是 Fail-Fast 路径 —— 用 amber/orange 而不是 red（destructive）
      // 区分「模型没响应」vs「出错」：用户看到 amber 就知道「换 model 试」，
      // 看到 red 就知道「看 handoff_notes 找原因」，两条 action path 不同。
      return (
        <Badge variant="secondary" className="gap-1 py-0.5 text-warning-foreground bg-warning/15">
          <Clock className="size-3" />
          {t('chat.delegation.status.timedOut')}
        </Badge>
      );
  }
}

/** Public API */

export type DelegationStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'partial'
  | 'cancelled'
  | 'timedOut';

/** Phase 2 UI feedback（Subtask 9.0 Phase 2-D）：Live Micro-Stream Box ——
 *  worker-runner 的 text / thinking / tool 事件经 coalesce 后的 4 行 mono
 *  转录。finished 行数增加、或 in-progress 的 `current.text` 变化时自动滚到
 *  最新一行。`aria-live="polite"` 让读屏软件播报更新而不打断用户。
 *
 *  可见性契约：caller（`DelegationCardItem`）只在
 *  `status === 'running' && (buffer.lines.length > 0 || buffer.current)`
 *  时挂载本组件——空 buffer 不渲染（timer + spinner 已经表达了「正在启动」）。
 *
 *  渲染契约：父组件每次 flush 都会重渲本组件（50ms trailing-edge 节流，见
 *  `lib/agent/worker-live-stream.ts`），但布局稳定——`useLayoutEffect` 里把
 *  `scrollTop` 置底，不闪。
 *
 *  防御：`tool` 行绝不 `JSON.stringify(args)` —— 代理缓冲的 payload 可达
 *  25–135 KB 且可能含循环引用（会打爆 React）。args 到这一步之前已被 reducer
 *  的 `formatToolPath` 压成 `toolName:path`。 */
function LiveStreamBox({
  buffer,
}: {
  buffer: WorkerLiveStreamBuffer;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to newest whenever finished-line count grows or current text changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [buffer.lines.length, buffer.current?.text]);

  // 按 kind 取行内 className：thinking=斜体灰、tool=加粗 primary、text=正文。
  // 加 kind 时一并更新这里。
  const lineClass = (kind: WorkerLiveLine['kind']): string =>
    kind === 'thinking'
      ? 'text-muted-foreground italic'
      : kind === 'tool'
        ? 'text-primary font-semibold'
        : 'text-foreground/90';

  // 顶部状态：补上 Live Micro-Stream Box 之前那段"静默"——proxy buffer
  // toolcall_delta 时，长时间不会再有 delta 进来（最长 100–170s for coder 的
  // fs_create_file），仅靠 box 内的"text_delta 流"会让用户误以为 worker
  // 卡死。这里从 buffer 状态推断出 3 段语义：thinking / writing / generating，
  // generating 命中"刚 emit tool_start、还在等 tool_end"的隐性阶段。
  // 注意：worker-runner 当前不在 worker_stream 里发 tool_end（只发 text/thinking
  // delta + tool_start），所以 generating 阶段会一直显示到 handoff 抽出 / box
  // 卸载——这正是想要的效果。`charTotal` 一类的累积字数先不上：reducer 在
  // `lib/agent/worker-live-stream.ts` 里对 finished lines 做了 `MAX_LINES = 4`
  // FIFO 淘汰，reduce 出来的总数会在淘汰点往下跌，给用户的"正在生成"信号
  // 与实际反向。要做就得在 reducer 维护单调 charTotal —— 留作后续 subtask。
  const active = buffer.current ?? buffer.lines[buffer.lines.length - 1];
  const streamState: 'thinking' | 'writing' | 'generating' | null = active
    ? active.kind === 'thinking'
      ? 'thinking'
      : active.kind === 'tool'
        ? 'generating'
        : 'writing'
    : null;
  const stateLabel =
    streamState === 'thinking'
      ? t('chat.delegation.liveStream.thinking')
      : streamState === 'writing'
        ? t('chat.delegation.liveStream.writing')
        : streamState === 'generating'
          ? t('chat.delegation.liveStream.generating')
          : null;
  const dotClass =
    streamState === 'generating'
      ? 'bg-primary animate-pulse'
      : streamState === 'writing'
        ? 'bg-primary'
        : streamState === 'thinking'
          ? 'bg-amber-500/80'
          : 'bg-muted-foreground/40';

  return (
    // 外层包住 header —— 否则 header 会被 scroller 在长 transcript 时一起
    // 滚走，正好与"静默期要给用户看的提示"的目标相反。
    <div className="mt-2 rounded border border-border/60 bg-muted/30 p-2 font-mono text-[10.5px] leading-snug text-foreground/80">
      {stateLabel && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[9.5px] uppercase tracking-wide text-muted-foreground/70">
          <span
            className={`size-1.5 shrink-0 rounded-full ${dotClass}`}
            aria-hidden
          />
          <span>{stateLabel}</span>
        </div>
      )}
      <div
        ref={scrollRef}
        className="max-h-32 overflow-y-auto"
        aria-live="polite"
        aria-label={t('chat.delegation.liveStream.label')}
      >
        {buffer.lines.map((line, i) => (
          <div
            // Key 含行号 + kind：reducer 对同一行内容稳定 line identity，
            // 让 React 在可能时复用 DOM 节点，避免抖动。
            key={`line-${i}-${line.kind}`}
            className={lineClass(line.kind)}
          >
            {line.text || ' '}
          </div>
        ))}
        {buffer.current && (
          <div className={lineClass(buffer.current.kind)}>
            {buffer.current.text || ' '}
          </div>
        )}
      </div>
    </div>
  );
}

export function DelegationCardItem({
  role,
  status,
  task,
  outputFile,
  sessionId,
  summary,
  handoffNotes,
  modelKey,
  attempts,
  attemptDurationMs,
  attemptStartedAt,
  timeoutMs,
  checklist,
  liveBuffer,
}: DelegationCardItemProps) {
  // 默认展开策略：running / failed / partial / timedOut 一律展开（用户在等结果 /
  // 要看错误 / 要看「换 model」提示），success + 有 output 折叠（点 header 看
  // detail，点 outputFile 按钮直接预览），success 无 output / cancelled 折叠。
  const initiallyOpen =
    status === 'running' ||
    status === 'failed' ||
    status === 'partial' ||
    status === 'timedOut';
  const [open, setOpen] = useState(initiallyOpen);

  // Phase 2.1 live elapsed timer. 跑中每秒重算 elapsedSec；状态转出 running
  // 后 interval 自动清掉（依赖 `isRunning`），不会泄漏 setInterval。
  // attemptStartedAt 缺失时退化成 undefined → badge 回落到纯 "Running…" 文本
  // （兼容老 persisted state / 单元测试场景）。Math.max(0, ...) 兜底时钟漂移。
  const isRunning = status === 'running';
  const [elapsedSec, setElapsedSec] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!isRunning || attemptStartedAt === undefined) {
      setElapsedSec(undefined);
      return;
    }
    const compute = (): number =>
      Math.max(0, Math.floor((Date.now() - attemptStartedAt) / 1000));
    setElapsedSec(compute());
    const id = setInterval(() => setElapsedSec(compute()), 1000);
    return () => clearInterval(id);
  }, [isRunning, attemptStartedAt]);
  const timeoutSec =
    timeoutMs !== undefined ? Math.round(timeoutMs / 1000) : undefined;

  const RoleIcon = ROLE_ICONS[role] ?? PenLine;

  // Phase 2-D live 模式开关：stream 一开始吐字就隐藏 Task 区，让 card 紧凑
  // （只剩 header + LiveStreamBox）。首个事件之前（TTFT 1–5s）仍保留 Task，
  // 避免 card 一片空白；worker 结束后 Task 重新出现，承接最终 summary。
  const hasLive =
    isRunning && !!liveBuffer && (liveBuffer.lines.length > 0 || !!liveBuffer.current);

  // 输出文件 → VFS 预览。`/vfs.html#<encoded workspace path>` 是项目里既定的
  // 「在新 tab 打开独立 vfs.html」协议（见 `App.tsx:152` 与 `vfs/lib/path-utils.ts`）。
  // 缺 sessionId 时退化到不带 hash（vfs.html 会落到根目录），但实际上只要父组件
  // 从 `useParams` 拿了 sessionId 就会传进来；这两者都缺的多半是测试环境。
  const outputUrl = outputFile && sessionId
    ? `/vfs.html#${encodeURIComponent(`/workspaces/${sessionId}/${outputFile.replace(/^\/+/, '')}`)}`
    : null;

  return (
    // Phase 2.2 pulse/shimmer: while status='running' the whole card border
    // switches to a warning tint + animate-pulse (2s opacity 1 → 0.5 → 1
    // cycle). A peripheral-glimpse "the card is still breathing" signal that
    // tells the user "this is alive, still running". Once the attempt
    // resolves (success / failed / partial / cancelled / timedOut), the
    // border falls back to border-border and animate-pulse is removed — the
    // card visually settles.
    <div
      className={
        isRunning
          ? 'relative border border-warning/50 border-l-2 border-l-warning rounded-lg overflow-hidden text-[0.8rem] min-w-0 animate-pulse'
          : 'border border-border rounded-lg overflow-hidden text-[0.8rem] min-w-0'
      }
    >
      <button
        type="button"
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 bg-card hover:bg-accent/50 transition-colors text-left cursor-pointer"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {/* Role icon — always the role visual mark, decoupled from status.
            Phase 2.2: while running, spin the icon so the "this worker is
            still turning" signal is unmistakable; falls back to static when
            the attempt resolves. */}
        <RoleIcon
          className={
            isRunning
              ? 'size-4 text-warning shrink-0 animate-spin'
              : 'size-4 text-muted-foreground shrink-0'
          }
        />

        {/* Role label — reuses the i18n key already shipped in Sidebar Team Roster */}
        <span className="text-foreground font-medium">
          {t(ROLE_LABEL_KEYS[role])}
        </span>

        {/* Phase 2.3 role-action badge: an extra outline pill while running
            ("writing" / "coding" / "reviewing" / "researching") that lets
            the user see *what* this worker is doing, not just "running".
            Hidden once the attempt resolves — the status badge + summary
            already carry the outcome story at that point. */}
        {isRunning && (
          <Badge variant="outline" className="text-[0.65rem] py-0 text-warning border-warning/40">
            {t(ROLE_ACTION_LABEL_KEYS[role])}
          </Badge>
        )}

        {/* Status badge — running state carries the elapsed/timeout countdown. */}
        <DelegationStatusBadge
          status={status}
          elapsedSec={elapsedSec}
          timeoutSec={timeoutSec}
        />

        {/* Retry badge — runner self-healed once (parse / schema / missing file),
            helps the user understand why attempts > 1. */}
        {attempts === 2 && (
          <Badge variant="outline" className="text-[0.65rem] py-0">
            {t('chat.delegation.retryBadge')}
          </Badge>
        )}

        {/* Chevron — always rightmost, matches ToolCard layout */}
        <ChevronRight
          className={`ml-auto size-3.5 text-muted-foreground/50 shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
      </button>

      {open && (
        <div className="border-t border-border overflow-hidden">
          {/* Task body — shown while running so the user can see what the worker was actually asked to do.
              Phase 2-D: hidden once the live stream starts emitting (hasLive) —
              the transcript takes over the body; reappears when the attempt resolves. */}
          {!hasLive && (
            <div className="px-3.5 py-2.5 bg-background">
              <div className="text-[0.65rem] text-muted-foreground/60 mb-1 font-medium">
                {t('chat.delegation.section.task')}
              </div>
              <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                {task || <span className="italic text-muted-foreground/60">—</span>}
              </div>
            </div>
          )}

          {/* Phase 2-D Live Micro-Stream Box: 4-line mono transcript of the
              worker-runner's coalesced text/thinking/tool events, auto-scrolled
              to newest. Mounted only when running + has content (the timer /
              spinner already cover the empty "starting" state). Collapse
              contract: the parent re-renders when status flips to
              success/failed/etc., and `liveBuffer` is cleared by `tool_resolved`
              in the hook (no prop passed when not running = no re-render). */}
          {hasLive && liveBuffer && <LiveStreamBox buffer={liveBuffer} />}

          {/* Model — small monospace label, helps debug "why is the result so poor this time" */}
          {modelKey && (
            <div className="px-3.5 py-1.5 bg-background border-t border-border/50 flex items-center gap-2">
              <span className="text-[0.65rem] text-muted-foreground/60 font-medium">
                {t('chat.delegation.section.model')}
              </span>
              <code className="text-[0.7rem] text-muted-foreground font-mono">{modelKey}</code>
            </div>
          )}

          {/* Summary — one-liner the worker wrote itself */}
          {summary && (
            <div className="px-3.5 py-2.5 bg-background border-t border-border/50">
              <div className="text-[0.65rem] text-muted-foreground/60 mb-1 font-medium">
                {t('chat.delegation.section.summary')}
              </div>
              <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                {summary}
              </div>
            </div>
          )}

          {checklist && checklist.length > 0 && (() => {
            const summaryCounts = summarizeChecklist(checklist);
            return (
              <div className="px-3.5 py-2.5 bg-background border-t border-border/50">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-[0.65rem] text-muted-foreground/60 font-medium">
                    {t('chat.delegation.reviewer.auditHeader')}
                  </div>
                  {summaryCounts && (
                    <div className="flex items-center gap-2 text-[0.65rem] tabular-nums">
                      <span className="flex items-center gap-0.5 text-success">
                        <Check className="size-3" />
                        {summaryCounts.pass}
                      </span>
                      <span className="flex items-center gap-0.5 text-warning-foreground">
                        <AlertTriangle className="size-3" />
                        {summaryCounts.warn}
                      </span>
                      <span className="flex items-center gap-0.5 text-destructive">
                        <X className="size-3" />
                        {summaryCounts.fail}
                      </span>
                    </div>
                  )}
                </div>
                <table className="w-full text-[0.7rem] tabular-nums">
                  <tbody>
                    {checklist.map((row, idx) => (
                      <tr key={idx} className="border-t border-border/30 first:border-t-0 align-top">
                        <td className="py-1 pr-2 font-mono text-muted-foreground whitespace-nowrap">
                          {row.item}
                        </td>
                        <td className="py-1 pr-2 w-4 text-center">
                          {row.status === 'pass' && <Check className="size-3 text-success inline-block" aria-label={t('chat.delegation.reviewer.statusPass')} />}
                          {row.status === 'warn' && <AlertTriangle className="size-3 text-warning-foreground inline-block" aria-label={t('chat.delegation.reviewer.statusWarn')} />}
                          {row.status === 'fail' && <X className="size-3 text-destructive inline-block" aria-label={t('chat.delegation.reviewer.statusFail')} />}
                        </td>
                        <td className="py-1 text-muted-foreground break-words" title={row.evidence}>
                          {row.evidence.length > 80 ? `${row.evidence.slice(0, 80)}…` : row.evidence}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {/* Handoff notes — only present on failure / partial; sits at the bottom as the "why" tail */}
          {handoffNotes && (
            <div className="px-3.5 py-2.5 bg-background border-t border-border/50">
              <div className="text-[0.65rem] text-muted-foreground/60 mb-1 font-medium">
                {t('chat.delegation.section.notes')}
              </div>
              <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                {handoffNotes}
              </div>
            </div>
          )}

          {/* Timeout hint — amber banner shown when the runner aborted this
              attempt via the 120s hard timeout. Distinguishes "model/provider
              is slow or stuck" from "task failed" so the user takes the right
              action (switch model on Sidebar Team Roster) versus reading
              handoff_notes. The modelKey, when present, is interpolated into
              the copy so the user knows which model to swap. */}
          {status === 'timedOut' && (
            <div className="px-3.5 py-2.5 bg-amber-50 dark:bg-amber-900/15 border-t border-amber-200/60 dark:border-amber-700/40">
              <div className="flex items-start gap-2">
                <Clock className="size-3.5 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-900 dark:text-amber-200 whitespace-pre-wrap break-words leading-relaxed">
                  {/* i18n template with $1 = modelKey; falls back to "this worker" if missing */}
                  {modelKey
                    ? t('chat.delegation.timeoutHint.withModel', [modelKey])
                    : t('chat.delegation.timeoutHint.generic')}
                </div>
              </div>
            </div>
          )}

          {/* Duration footer — "Failed after Xs" / "Timed out after 120s" lets
              the user judge whether it was genuinely slow or API-stuck. Only
              shown on failed / timedOut; success cards skip it (handoff
              notes carry the same diagnostic). */}
          {(status === 'failed' || status === 'timedOut') && typeof attemptDurationMs === 'number' && (
            <div className="px-3.5 py-1.5 bg-background border-t border-border/50 flex items-center gap-2 text-[0.65rem] text-muted-foreground/60">
              <Clock className="size-3" />
              <span>
                {t('chat.delegation.duration', [
                  String(Math.max(1, Math.round(attemptDurationMs / 1000))),
                ])}
              </span>
            </div>
          )}

          {/* Output file action — first-class citizen: on success, jump to VFS preview in a new tab */}
          {outputUrl && (
            <div className="px-3.5 py-2.5 bg-background border-t border-border/50">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                // `target="_blank"` + `rel="noopener noreferrer"` 防止新 tab 拿到
                // opener 的 window.opener 引用 —— 标准安全实践。
                onClick={() => window.open(outputUrl, '_blank', 'noopener,noreferrer')}
              >
                <ExternalLink className="size-3" />
                {t('chat.delegation.openFile')}
                {outputFile && (
                  <span className="font-mono text-muted-foreground/80 ml-1">· {outputFile}</span>
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Batch container (Subtask 1.3) ────────────────────────────────────────
//
// 外层 `DelegationCard` 渲染 batch mode（`delegate_task({ tasks: [...] })`）：
// header 显示 "N tasks — X succeeded, Y failed" + 外层 status badge，
// body 渲染 N 个 `DelegationCardItem`（内层卡片，与单 task 视觉一致）。
//
// 外层 status 决策（与 `aggregateBatchHandoffs` 保持一致 — 单 source of truth）：
//   - 任一 item status='running'            → outer 'running'
//   - ≥1 success + ≥1 fail（非 running）    → outer 'partial'
//   - 所有 item 都 'success'                  → outer 'success'
//   - 所有 item 都 fail / cancelled / timedOut → outer 'failed'
//
// 为什么不在 DelegationCard 内部就聚合：聚合是纯函数，runner 已经做完了。
// UI 层只负责把 `batchSummary` + 每个 item 的 fields 渲染出来 —— 避免
// 让 React 组件重新跑一遍同样的决策逻辑导致和 runner drift。

export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
  partial: number;
  cancelled: number;
}

export interface DelegationCardProps {
  /** 单 task 模式：传这个 + `role` / `task` / 其它 item 字段。
   *  Batch 模式：传 `batch` 数组，外层 header 会用 batchSummary 算 status。 */
  role?: WorkerRole;
  status?: DelegationStatus;
  task?: string;
  outputFile?: string;
  sessionId?: string;
  summary?: string;
  handoffNotes?: string;
  modelKey?: string;
  attempts?: number;
  attemptDurationMs?: number;
  attemptStartedAt?: number;
  timeoutMs?: number;
  /** Reviewer 静态 audit（Subtask 2.3）—— 单 task mode 时挂在 outer card
   *  上而不是 inner item，因为这里 outer 自己也接受 inner 的全部字段。 */
  checklist?: readonly ChecklistItem[];
  /** Phase 2-D：worker-runner 的实时流 buffer。
   *  Single 模式：直接传到内层 `DelegationCardItem` 渲染 `<LiveStreamBox>`。
   *  Batch 模式：runner 在 batch 内所有 item 共用同一个 outer `delegate_task`
   *  toolCallId（一条 `worker_stream` 流的 key 来自外层 toolCallId，
   *  不是 per-item 的）—— 故 batch 只渲染**一个**共享的 box，挂在外层
   *  header 下方、内层 item 列表之上，不再 forward 到每个 item。
   *  可见性契约见 `<LiveStreamBox>`。 */
  liveBuffer?: WorkerLiveStreamBuffer;
  /** Batch 模式：per-item 渲染为内层 `DelegationCardItem`。
   *  传这个就忽略 outer single-task 字段（外层 header 改成 batchSummary）。 */
  batch?: readonly DelegationCardItemProps[];
  /** Batch 模式：外层 header 用的 coarse 计数（来自 runner 的 `aggregateBatchHandoffs`）。 */
  batchSummary?: BatchSummary;
}

/** 从 per-item 状态数组里聚合外层 status（保持和 `aggregateBatchHandoffs`
 *  决策表 1:1 镜像；index.tsx 解析阶段算好直接传，但允许 caller 临时手算）。
 *
 *  Decision table（与 runner 完全一致）：
 *    - 任一 item 'running'                → outer 'running'
 *    - 所有 item 都 'success'              → outer 'success'
 *    - ≥1 success + ≥1 非 success 且非 running → outer 'partial'
 *    - 全部 fail / cancelled / timedOut    → outer 'failed'
 *
 * 重要：'partial' 是「混合成功」的意思，不是「有 partial item」。runner
 * 用 succeeded count 算 outer status；所以 4/4 全 success → outer.success，
 * 3/4 success → outer.partial（即使第 4 个 item 自己 status='failed'）。
 */
export function aggregateBatchStatus(
  items: readonly DelegationCardItemProps[],
): DelegationStatus {
  if (items.length === 0) return 'failed';
  if (items.some((it) => it.status === 'running')) return 'running';
  const allSuccess = items.every((it) => it.status === 'success');
  if (allSuccess) return 'success';
  const anySuccess = items.some((it) => it.status === 'success');
  return anySuccess ? 'partial' : 'failed';
}

export function DelegationCard(props: DelegationCardProps) {
  const isBatch = props.batch !== undefined && props.batch.length > 0;
  if (!isBatch) {
    // 单 task 模式：直接代理到 inner item，保留原有 props 形状 / 默认展开策略
    if (!props.role || !props.task || !props.status) {
      // 类型守卫：缺少必要字段就 fallback 到 placeholder —— 测试 / 异常路径
      return (
        <div className="border border-border rounded-lg px-3.5 py-2.5 text-xs text-muted-foreground">
          —
        </div>
      );
    }
    return (
      <DelegationCardItem
        role={props.role}
        status={props.status}
        task={props.task}
        outputFile={props.outputFile}
        sessionId={props.sessionId}
        summary={props.summary}
        handoffNotes={props.handoffNotes}
        modelKey={props.modelKey}
        attempts={props.attempts}
        attemptDurationMs={props.attemptDurationMs}
        attemptStartedAt={props.attemptStartedAt}
        timeoutMs={props.timeoutMs}
        checklist={props.checklist}
        liveBuffer={props.liveBuffer}
      />
    );
  }

  // Batch 模式：渲染外层 container + N 个 inner items
  const items = props.batch ?? [];
  const summary: BatchSummary =
    props.batchSummary ?? {
      total: items.length,
      succeeded: items.filter((it) => it.status === 'success').length,
      failed: items.filter(
        (it) => it.status === 'failed' || it.status === 'timedOut',
      ).length,
      partial: 0,
      cancelled: items.filter((it) => it.status === 'cancelled').length,
    };
  const outerStatus = aggregateBatchStatus(items);
  const anyRunning = outerStatus === 'running';
  // Batch mode：所有 item 共用同一个 outer `delegate_task` toolCallId（流事件
  // 按外层 id 入 liveLines），所以也共用同一个 liveBuffer —— 只在 batch level
  // 渲染一个共享 box，避免每个 item 都重复一遍并把已 resolve 的 task 也压住。
  const batchHasLive =
    anyRunning &&
    !!props.liveBuffer &&
    (props.liveBuffer.lines.length > 0 || !!props.liveBuffer.current);

  return (
    <div
      className={
        anyRunning
          ? 'border border-warning/50 border-l-2 border-l-warning rounded-lg overflow-hidden text-[0.8rem] min-w-0 animate-pulse'
          : 'border border-border rounded-lg overflow-hidden text-[0.8rem] min-w-0'
      }
    >
      {/* Batch header —— coarse count + outer status badge */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-card">
        <span className="text-foreground font-medium">
          {t('chat.delegation.batch.header', [
            String(summary.total),
            String(summary.succeeded),
            String(summary.failed),
          ])}
        </span>
        <DelegationStatusBadge
          status={outerStatus}
          elapsedSec={
            // Batch mode: outer elapsed 显示 batch 整体运行时间 —— placeholder
            // 阶段所有 item 共享同一个 batchStartedAt（index.tsx 注入），
            // resolved 阶段 item 不带 attemptStartedAt 所以 undefined。
            anyRunning && items[0]?.attemptStartedAt !== undefined
              ? Math.max(
                  0,
                  Math.floor((Date.now() - items[0].attemptStartedAt!) / 1000),
                )
              : undefined
          }
          timeoutSec={
            items[0]?.timeoutMs !== undefined
              ? Math.round(items[0].timeoutMs! / 1000)
              : undefined
          }
        />
      </div>

      {/* Batch-level Live Micro-Stream Box — one shared box per batch because
          all items share the same outer `delegate_task` toolCallId (the
          `worker_stream` key is the outer id, not per-item). Mounted below
          the batch header and above the per-item list. */}
      {batchHasLive && props.liveBuffer && (
        <div className="px-3.5 pb-2.5">
          <LiveStreamBox buffer={props.liveBuffer} />
        </div>
      )}

      {/* Per-item body —— each inner card manages its own timer / output link /
          error fold; one item crashing/stuck does not affect the others' interactivity. */}
      <div className="border-t border-border divide-y divide-border/60">
        {items.map((item, idx) => (
          <div key={idx} className="px-2 py-2">
            <DelegationCardItem
              role={item.role}
              status={item.status}
              task={item.task}
              outputFile={item.outputFile}
              sessionId={item.sessionId}
              summary={item.summary}
              handoffNotes={item.handoffNotes}
              modelKey={item.modelKey}
              attempts={item.attempts}
              attemptDurationMs={item.attemptDurationMs}
              attemptStartedAt={item.attemptStartedAt}
              timeoutMs={item.timeoutMs}
              checklist={item.checklist}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
