import { useStorageItem } from '@/hooks/useStorageItem';
import { workerTeamEnabled } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Zap, Users } from 'lucide-react';
import type { ComponentProps } from 'react';

/**
 * Composer toolbar 上的 Worker Team 切换芯片 —— 用一个紧凑按钮展示当前
 * 委派策略：Fast（主代理直接产出 native fs_* 工具）或 Team（委派给 worker
 * 子代理）。点击立即翻转，并把状态写回共享 storage —— Settings → Advanced
 * 的 Switch 和本芯片通过同一个 `useStorageItem` hook 监听，自然双向同步。
 *
 * 设计要点：
 *   - 单 button + icon + label，不做下拉：只有 2 态，不需要 dropdown 复杂度。
 *   - aria-pressed：屏幕阅读器把它当 toggle button。
 *   - tooltip = title（同时 aria-label）：同文案不重复（见 i18n-naming
 *     skill：tooltip 与 button 文案一致时不必分两键）。
 *   - 颜色：Team = indigo（与 Settings Worker card 同色系）；Fast = amber
 *     （强调「即时」，与 indigo 形成视觉对比，扫一眼就知道当前在哪侧）。两
 *     态都 hover 加深；无文本颜色硬编码到 component，外层若想覆盖用
 *     className 传即可（forward 到 button）。
 *   - 位置：放 ChatInput toolbar LEFT group 末尾，在 ThinkingLevelSelector
 *     之后。是 "secondary setting" 而不是 primary action，所以放在左组而非
 *     右组的 send 旁——后者空间已饱和（mention + mic + send）。
 *   - 状态显示：开关本身已经表达状态，颜色不需要重复——用户读 icon + label
 *     即知。
 */
export function WorkerTeamChip({
  className,
  ...rest
}: Omit<ComponentProps<'button'>, 'children' | 'onClick'>) {
  const [enabled, setEnabled] = useStorageItem(workerTeamEnabled, true);
  const onClick = () => void setEnabled(!enabled);
  const label = enabled
    ? t('chat.composer.workerTeam.team')
    : t('chat.composer.workerTeam.fast');
  const Icon = enabled ? Users : Zap;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={enabled}
      aria-label={t('chat.composer.workerTeam.toggleHint')}
      title={t('chat.composer.workerTeam.toggleHint')}
      data-state={enabled ? 'team' : 'fast'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 h-7 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        enabled
          ? 'border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 dark:border-indigo-800 dark:text-indigo-300 dark:bg-indigo-950/40 dark:hover:bg-indigo-950/60'
          : 'border-amber-200 text-amber-700 bg-amber-50 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-300 dark:bg-amber-950/40 dark:hover:bg-amber-950/60',
        className,
      )}
      {...rest}
    >
      <Icon className="size-3.5" />
      <span>{label}</span>
    </button>
  );
}
