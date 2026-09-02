// ContextUsagePill — ChatInput toolbar's context-usage status badge.
//
// Design goals (AGENTS.md §"Cohesion, coupling"):
// - Reads only `ContextUsage` (from `useContextUsage`); never touches storage,
//   model resolution, or IPC directly. ChatInput passes `usage` as a prop.
// - Severity tier (ok / warn / critical) is decided by `severity.ts` — this
//   component only maps severity → Tailwind class; thresholds live in one place.
// - Renders as a Radix `<PopoverTrigger asChild>` so positioning and keyboard
//   handling come for free. Owns hover/focus events that toggle popover open
//   state — the parent passes that state in via `popoverOpen` to highlight
//   the pill while the popover is showing.
//
// Visual:
// - 12 px mini-donut + percent + headroom chip, rounded-full pill container.
// - Idle opacity drops to 80% to recede; hover returns to 100% with a subtle
//   scale-up — never competes with the main input.
// - All transitions go through `transition-[color,opacity,transform]` with a
//   `motion-reduce` guard.

import { forwardRef, useMemo } from 'react';
import type { ContextUsage } from '@/components/chat/context/useContextUsage';
import { t } from '@/lib/i18n';
import { formatCompactCount } from '@/lib/utils';

interface ContextUsagePillProps {
  usage: ContextUsage;
  /** Controlled open state of the popover — pill mirrors this to show
   *  the highlighted bg while the popover is showing. */
  popoverOpen: boolean;
  onPopoverOpenChange: (open: boolean) => void;
}

/** severity → Tailwind class mapping. Three tiers share the same transition
 *  so colour changes never flash. `text-*` paints the pill container; the
 *  mini-donut and chips inherit via `currentColor`. */
const SEVERITY_CLASS = {
  ok: 'text-emerald-500 dark:text-emerald-400',
  warn: 'text-amber-500 dark:text-amber-400',
  critical: 'text-destructive',
} as const;

export const ContextUsagePill = forwardRef<HTMLButtonElement, ContextUsagePillProps>(function ContextUsagePill(
  {
    usage,
    popoverOpen,
    onPopoverOpenChange,
  },
  ref,
) {
  const { percent, severity, ratio, headroomTokens, unknown, isCompacting, isAgentRunning } = usage;

  // Headroom chip only when severity is 'ok' and there's actual room left;
  // hide past 70% to keep the percentage the dominant read.
  const showHeadroom = useMemo(() => {
    if (severity !== 'ok') return false;
    if (headroomTokens <= 0) return false;
    return ratio < 0.7;
  }, [severity, headroomTokens, ratio]);

  // Unknown state (no model / no resolved contextWindow): hide entirely.
  // Welcome screen (0 messages) still renders — the affordance should be
  // discoverable from first paint.
  if (unknown) return null;

  const colorClass = SEVERITY_CLASS[severity];
  const ringLabel = t('chat.context.percent', [String(percent)]);

  // Click-only toggle — hover does NOT open the popover (would steal focus
  // from textarea and flicker on every `usage` re-render during streaming).
  // `onPointerDown preventDefault` keeps keyboard focus on whatever the user
  // is currently typing into — the pill is a click affordance, not a focus
  // target.
  const toggle = () => onPopoverOpenChange(!popoverOpen);

  return (
    <button
      ref={ref}
      type="button"
      className={[
        'group/pill inline-flex items-center gap-1.5 h-7 rounded-full',
        'border border-current/20 bg-current/5 px-2.5',
        'text-[0.7rem] font-medium tabular-nums whitespace-nowrap',
        'transition-[color,background-color,border-color] duration-500 ease-out',
        'motion-reduce:transition-none',
        'hover:scale-[1.02] hover:bg-current/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        popoverOpen && 'bg-current/10',
        (isCompacting || isAgentRunning) && 'opacity-60',
        colorClass,
      ].filter(Boolean).join(' ')}
      onPointerDown={(e) => e.preventDefault()}
      onClick={toggle}
      aria-label={t('chat.context.usage')}
      aria-haspopup="dialog"
      aria-expanded={popoverOpen}
      data-state={popoverOpen ? 'open' : 'closed'}
    >
      {/* mini-donut: 12 px SVG. currentColor inherits pill severity tier; dasharray animates with ratio. */}
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden
        className="shrink-0"
      >
        <circle
          cx="6"
          cy="6"
          r="5"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="2"
        />
        <circle
          cx="6"
          cy="6"
          r="5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${ratio * 31.4} 31.4`}
          transform="rotate(-90 6 6)"
          style={{ transition: 'stroke-dasharray 500ms ease-out' }}
        />
      </svg>

      {/* Main percentage readout. */}
      <span className="font-semibold">{ringLabel}</span>

      {/* Headroom chip — only shown at low usage to hint at remaining room.
        * Hidden when severity is not 'ok' or ratio >= 0.7. */}
      {showHeadroom && (
        <span
          className="text-[0.6rem] opacity-70 font-normal border-l border-current/20 pl-1.5"
          aria-hidden
        >
          {t('chat.context.headroom', [formatCompactCount(headroomTokens)])}
        </span>
      )}
    </button>
  );
});