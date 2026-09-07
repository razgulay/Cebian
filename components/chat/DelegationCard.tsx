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

import { useState, useEffect } from 'react';
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

interface DelegationCardProps {
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

export function DelegationCard({
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
}: DelegationCardProps) {
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
          {/* Task body — shown while running so the user can see what the worker was actually asked to do */}
          <div className="px-3.5 py-2.5 bg-background">
            <div className="text-[0.65rem] text-muted-foreground/60 mb-1 font-medium">
              {t('chat.delegation.section.task')}
            </div>
            <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
              {task || <span className="italic text-muted-foreground/60">—</span>}
            </div>
          </div>

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
