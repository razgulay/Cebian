import { useStorageItem } from '@/hooks/useStorageItem';
import { personaEnabled } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Sparkles, Bot } from 'lucide-react';
import type { ComponentProps } from 'react';

/**
 * Composer toolbar 上的 Persona 切换芯片 —— 镜像 `WorkerTeamChip.tsx` 的 UX：
 * Normal (默认 Cebian) / OpenClaw (自定义人设 + 身份 + 1-line recap)。点击
 * 立即翻转，状态写回共享 storage (`local:personaEnabled`) —— Settings →
 * Advanced 的 Switch 和本芯片通过同一个 `useStorageItem` hook 监听，双向
 * 同步。Persona 副本本身存在 Settings → Persona，不在 chip 上编辑。
 *
 * 选 Normal vs OpenClaw：
 *   - Normal：persona block 不注入 system prompt / user message，prompt 字节
 *     稳定（与未启用前完全一致，cache 仍可命中）。
 *   - OpenClaw：persona block 进入 system prompt，1-line recap 钉在
 *     <reminder-instructions> 里。同一份 storage 也决定 worker sub-agent 是否
 *     看到 persona 副本（不在本组件范围里；Subtask 2 决定 worker prompt 策略）。
 *
 * 设计要点与 WorkerTeamChip 一致：单 button + icon + label、aria-pressed、
 * title 与 aria-label 同步、颜色双态（Normal=slate、OpenClaw=violet/pink
 * 与 Sparkles icon 匹配）。
 */
export function PersonaChip({
  className,
  ...rest
}: Omit<ComponentProps<'button'>, 'children' | 'onClick'>) {
  const [enabled, setEnabled] = useStorageItem(personaEnabled, false);
  const onClick = () => void setEnabled(!enabled);
  const label = enabled
    ? t('chat.composer.persona.openclaw')
    : t('chat.composer.persona.normal');
  const Icon = enabled ? Sparkles : Bot;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={enabled}
      aria-label={t('chat.composer.persona.toggleHint')}
      title={t('chat.composer.persona.toggleHint')}
      data-state={enabled ? 'openclaw' : 'normal'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 h-7 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        enabled
          ? 'border-violet-200 text-violet-700 bg-violet-50 hover:bg-violet-100 dark:border-violet-800 dark:text-violet-300 dark:bg-violet-950/40 dark:hover:bg-violet-950/60'
          : 'border-slate-200 text-slate-700 bg-slate-50 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:bg-slate-950/40 dark:hover:bg-slate-950/60',
        className,
      )}
      {...rest}
    >
      <Icon className="size-3.5" />
      <span>{label}</span>
    </button>
  );
}
