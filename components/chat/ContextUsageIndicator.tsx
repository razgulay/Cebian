import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FoldVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ContextUsage } from '@/lib/ipc/protocol';
import { formatCompactCount } from '@/lib/utils';
import { t } from '@/lib/i18n';

/** 环形进度的几何参数（viewBox 单位）。 */
const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 提示「快到压缩点了」的提前量：进入触发点的这个比例内就转成警示色。 */
const NEAR_TRIGGER_RATIO = 0.9;

type Tone = 'normal' | 'near' | 'over';

/** 占用配色只有三档：正常（低调）、接近压缩点（警示）、已过压缩点（更强的警示）。 */
function toneOf(tokens: number, triggerTokens: number | null): Tone {
  if (triggerTokens === null) return 'normal';
  if (tokens >= triggerTokens) return 'over';
  return tokens >= triggerTokens * NEAR_TRIGGER_RATIO ? 'near' : 'normal';
}

// 色阶只升不降：amber 是仓里既定的警示色，越过压缩点再往上走到 destructive。
// 用 primary 会读成「松一口气」，与语义相反。
const RING_CLASS: Record<Tone, string> = {
  normal: 'text-muted-foreground',
  near: 'text-amber-500',
  over: 'text-destructive',
};

/** spinner 最低保留时长（毫秒）——避免后台广播延迟造成「按钮闪一下又弹回」。 */
const MIN_PENDING_MS = 600;

/**
 * 手动压缩按钮的可用性输入。由调用方从会话状态派生——组件本身不持 IPC 状态，
 * 所有「压缩」动作都经同一个 `onCompact` 收敛。
 */
export interface CompactionControl {
  /** 触发一次手动压缩（后台 `compact_now`）。 */
  onCompact: () => void;
  /** 压缩进行中 → 显示 spinner 且禁用。 */
  isCompacting: boolean;
  /** agent 正在跑 → 禁用（避免与在途轮次抢 phase）。 */
  isAgentRunning: boolean;
  /** 已选模型。未选时后台解析不出压缩模型，按钮无意义。 */
  hasModel: boolean;
  /** 消息数 ≥ 2（至少一对 user + assistant）。单条 user 的切点无效，压不动。 */
  canCompact: boolean;
}

/** 按钮的禁用原因；`null` = 可点击。 */
type CompactDisableReason = 'busy' | 'noModel' | 'empty';

/**
 * 计算禁用原因。`pending` 是最近一次点击留下的乐观态，用来在后台广播
 * `isCompacting` 之前挡住第二次点击。
 */
function compactDisableReason(
  control: CompactionControl,
  pending: boolean,
): CompactDisableReason | null {
  if (pending || control.isCompacting || control.isAgentRunning) return 'busy';
  if (!control.hasModel) return 'noModel';
  if (!control.canCompact) return 'empty';
  return null;
}

/** 禁用原因 → 按钮文案（可点击时用 idle 文案）。 */
function compactLabel(reason: CompactDisableReason | null): string {
  if (reason === 'busy') return t('chat.session.compactNow.busy');
  if (reason === 'noModel') return t('chat.session.compactNow.noModel');
  if (reason === 'empty') return t('chat.session.compactNow.empty');
  return t('chat.session.compactNow.idle');
}

/**
 * 手动压缩按钮：占满 popover 一行，文案随禁用原因切换。
 *
 * optimistic pending：点击瞬间先进入 pending（spinner），600 ms 或后台真的广播
 * `isCompacting` 后才退出——否则按钮会在后台响应之前「闪一下又弹回」。
 */
function CompactNowAction({ control }: { control: CompactionControl }) {
  const [pending, setPending] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reason = compactDisableReason(control, pending);
  const disabled = reason !== null;
  const showSpinner = pending || control.isCompacting || reason === 'busy';

  // 后台已广播 isCompacting：提前收起乐观 spinner，让按钮立刻响应。600 ms 的
  // 兜底定时器仍然保留，防止后台广播延迟时按钮提前复活。
  useEffect(() => {
    if (pending && control.isCompacting) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setPending(false);
    }
  }, [pending, control.isCompacting]);

  // 卸载时清掉 timeout——避免 React 18 strict-mode 双调用悬挂的 timer
  // 在组件卸载后尝试 setState。
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleClick = useCallback(() => {
    if (disabled) return;
    setPending(true);
    control.onCompact();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setPending(false);
      timeoutRef.current = null;
    }, MIN_PENDING_MS);
  }, [disabled, control]);

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={handleClick}
      className="w-full justify-center gap-1.5 border-amber-500/40 text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
    >
      {showSpinner ? <Spinner className="size-3.5" /> : <FoldVertical className="size-3.5" />}
      {compactLabel(reason)}
    </Button>
  );
}

/**
 * 输入框右下角的上下文占用环：点开是一个小窗，报当前会话占了模型窗口的多少，
 * 并提供「立即压缩」入口。
 *
 * 数字一律来自后台（`context_usage` 帧），不在前端重算——前端拿不到模型的
 * `contextWindow`，而且两处各算一套必然漂移，会出现「显示 75% 却已经开始压缩」。
 *
 * 窄侧栏里只画环、不显示百分比，数字留给小窗；环本身足够表达「快满了」。
 *
 * 已知局限：在输入框里改了模型但还没发送时，环的分母仍是会话**当前实际在用**的模型
 * 窗口——模型选择在发送前只是前端草稿，后台并不知情。下一轮发出去之后即自动纠正。
 */
export function ContextUsageIndicator({
  usage,
  compaction,
}: {
  usage: ContextUsage | null;
  /** 不传则不渲染「立即压缩」按钮（只读展示）。 */
  compaction?: CompactionControl;
}) {
  const titleId = useId();
  // 没收到过快照、或模型没声明窗口（画不出比例）时整个不渲染，不占位、不显示假数据。
  // 显式挡掉 NaN：`NaN <= 0` 是 false，漏过去会渲染出 "NaN%" 和非法的 strokeDashoffset。
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;

  // 文字用真实百分比，只有环的填充夹到 [0,1]：超窗时（120K/100K）夹了文字就会显示
  // "100%"，把「超出多少」这个最要紧的信息藏起来。
  const rawRatio = usage.tokens / usage.contextWindow;
  const percent = Math.round(rawRatio * 100);
  const tone = toneOf(usage.tokens, usage.triggerTokens);
  const label = t('chat.contextUsage.label', [String(percent)]);

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={label} className="size-7">
              <svg viewBox="0 0 18 18" className={`size-4 -rotate-90 ${RING_CLASS[tone]}`} aria-hidden="true">
                <circle cx="9" cy="9" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" className="opacity-20" />
                <circle
                  cx="9"
                  cy="9"
                  r={RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, rawRatio)))}
                />
              </svg>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {/*
       * aria-labelledby：按钮的 aria-label 不会自动成为 dialog 的名称，要显式指到标题上。
       */}
      <PopoverContent align="end" aria-labelledby={titleId} className="w-64 space-y-2 p-3">
        <PopoverHeader className="flex-row items-baseline justify-between gap-2 p-0">
          <PopoverTitle id={titleId} className="text-sm font-medium">
            {t('chat.contextUsage.title')}
          </PopoverTitle>
          <span className="text-sm tabular-nums text-muted-foreground">{percent}%</span>
        </PopoverHeader>
        <PopoverDescription className="text-xs tabular-nums">
          {t('chat.contextUsage.amount', [
            formatCompactCount(usage.tokens),
            formatCompactCount(usage.contextWindow),
          ])}
        </PopoverDescription>
        <PopoverDescription className="text-xs">
          {usage.triggerTokens === null
            ? t('chat.contextUsage.compactionOff')
            : t('chat.contextUsage.threshold', [
                String(Math.round((usage.triggerTokens / usage.contextWindow) * 100)),
              ])}
        </PopoverDescription>
        {compaction && <CompactNowAction control={compaction} />}
        <PopoverDescription className="text-[0.7rem] text-muted-foreground/70">
          {t('chat.contextUsage.estimateNote')}
        </PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}
