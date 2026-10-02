//
// 状态圆点 — 跨页面共用的小圆点指示器。
//
// 模式取自 `components/settings/mcp/MCPServerRow.tsx`：`size-2 rounded-full`
// 实心圆，语义由 `title` / `aria-label` 承担（圆点本身是装饰，文字标签由调用方
// 另给）。抽成共用组件，是因为这个模式在本仓库里已经被手抄过两份——继续抄下去
// 只会让「改一处、漏两处」。
//

import { cn } from '@/lib/utils';

/** 语义色。用语义 token 而不是字面色值，深色模式自动跟随。 */
export type StatusTone = 'ok' | 'warn' | 'error' | 'idle' | 'busy';

const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground/30',
  busy: 'bg-sky-500',
};

/** 单个圆点。`label` 是必须的——纯色圆点对读屏用户没有意义。 */
export function StatusDot({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span
      role="img"
      className={cn('size-2 rounded-full shrink-0', TONE_CLASS[tone])}
      title={label}
      aria-label={label}
    />
  );
}
