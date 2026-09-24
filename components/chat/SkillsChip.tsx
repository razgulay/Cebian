import { useStorageItem } from '@/hooks/useStorageItem';
import { chatSkillAuto } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { ComponentProps } from 'react';

/**
 * Composer toolbar 的 Skills 切换芯片 —— 镜像 `PersonaChip.tsx` / `WorkerTeamChip.tsx`
 * 的 UX：Manual（默认，需经 permission card 才能跑 skill） / Auto（跳过权限询问）。
 * 点击立即翻转，状态写回共享 storage（`local:chatSkillAuto`）—— Settings 之外的
 * 唯一入口，useStorageItem 双向同步。
 *
 * 关键语义：**不持久化 grant**。Toggle ON 后 runSkillGate 直接放行、不写
 * skillGrants——所以 toggle OFF 立即恢复询问，不留"残余永久授权"。
 * Toggle 仅控制"本次及以后是否跳过"，与"已 Allow always 的 skill"是正交的两层。
 *
 * 设计要点与现有 chip 一致：单 button + icon + label、aria-pressed、title 与
 * aria-label 同步、颜色双态（Manual=slate+盾问号、Auto=violet+盾勾——与 Persona
 * OpenClaw 共用 violet 色系，区分于 Worker Team 的 indigo）。
 */
export function SkillsChip({
  className,
  ...rest
}: Omit<ComponentProps<'button'>, 'children' | 'onClick'>) {
  const [auto, setAuto] = useStorageItem(chatSkillAuto, false);
  const onClick = () => void setAuto(!auto);
  const label = auto
    ? t('chat.composer.skillAutoToggle.auto')
    : t('chat.composer.skillAutoToggle.manual');
  const Icon = auto ? ShieldCheck : ShieldQuestion;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={auto}
      aria-label={t('chat.composer.skillAutoToggle.toggleHint')}
      title={t('chat.composer.skillAutoToggle.toggleHint')}
      data-state={auto ? 'auto' : 'manual'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 h-7 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        auto
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
