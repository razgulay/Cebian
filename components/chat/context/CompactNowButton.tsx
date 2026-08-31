// CompactNowButton — ChatInput 工具栏里 ContextUsagePill 旁边的「手动压缩」按钮。
//
// 设计目标：
// - 唯一动作入口：所有「压缩」动作（popover footer、toolbar 按钮、未来的
//   快捷键）都通过同一个 `onClick` prop 收敛。组件本身不持 IPC 状态。
// - Optimistic pending：用户点击瞬间先进入 pending 态（spinner），避免 BG
//   异步广播 isCompacting=true 期间按钮「闪一下又弹回」——600 ms 最低 pending
//   守门，超时或 `isCompacting` 真翻转才退出 pending。
// - 禁用优先级：`isCompacting` / `isAgentRunning` > `!hasModel` > `!canCompact`。
//   tooltip 文案随原因切换。

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { FoldVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ContextUsage } from '@/components/chat/context/useContextUsage';
import { t } from '@/lib/i18n';

interface CompactNowButtonProps {
  usage: ContextUsage;
  onClick: () => void;
}

/** Compute the disable reason. Includes local `pending` (optimistic-pending
 *  state from the most recent click) so we don't fire a second `compact_now`
 *  IPC during the 600 ms window before the BG broadcasts isCompacting. */
function disabledReason(usage: ContextUsage, pending: boolean): { reason: 'busy' | 'noModel' | 'empty' } | null {
  if (pending || usage.isCompacting || usage.isAgentRunning) return { reason: 'busy' };
  if (!usage.hasModel) return { reason: 'noModel' };
  if (!usage.canCompact) return { reason: 'empty' };
  return null;
}

function tooltipFor(reason: 'busy' | 'noModel' | 'empty' | null): string {
  if (reason === 'busy') return t('chat.session.compactNow.busy');
  if (reason === 'noModel') return t('chat.session.compactNow.noModel');
  if (reason === 'empty') return t('chat.session.compactNow.empty');
  return t('chat.session.compactNow.idle');
}

/** spinner 最低保留时长（毫秒）——避免 BG 广播延迟造成「按钮闪一下又弹回」。 */
const MIN_PENDING_MS = 600;

export const CompactNowButton = forwardRef<HTMLButtonElement, CompactNowButtonProps>(function CompactNowButton(
  { usage, onClick },
  ref,
) {
  // optimistic pending：点击瞬间先置 true，600 ms 或 `isCompacting` 真翻转
  // 后才回 false。
  const [pending, setPending] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reason = disabledReason(usage, pending);
  const disabled = reason !== null;

  useEffect(() => {
    // BG has broadcast isCompacting — close the optimistic spinner early so
    // the button is responsive the instant the background takes over. The
    // 600 ms timeout below still acts as a floor against BG broadcast delay.
    if (pending && usage.isCompacting) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setPending(false);
    }
  }, [pending, usage.isCompacting]);

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
    onClick();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setPending(false);
      timeoutRef.current = null;
    }, MIN_PENDING_MS);
  }, [disabled, onClick]);

  const showSpinner = pending || usage.isCompacting || reason?.reason === 'busy';
  const tip = tooltipFor(reason?.reason ?? null);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          variant="ghost"
          size="icon-xs"
          // disabled 时保留点击区域但禁用交互；尺寸与 pill 一致（h-7）保证
          // 视觉对齐。amber tint 仅在 enabled 状态下生效。
          disabled={disabled}
          aria-label={tip}
          onClick={handleClick}
          className={[
            'size-7 rounded-full transition-colors duration-300',
            disabled
              ? 'text-muted-foreground/40'
              : 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 hover:text-amber-700 dark:hover:text-amber-300',
          ].join(' ')}
        >
          {showSpinner ? <Spinner className="size-3.5" /> : <FoldVertical className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
});