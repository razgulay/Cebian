// ContextUsagePopover — hover-triggered "context-usage detail" panel that
// appears above the pill.
//
// Design goals:
// - Controlled (open + onOpenChange) — pill drives the open state via its
//   hover/focus handlers, the popover just renders content. Avoids the race
//   where cursor leaves pill before popover mounts.
// - Pure presentational + one "Compact now" jump-link that focuses the
//   toolbar button and closes the popover. No IPC, no new hooks.
// - Severity tier continues to come from `severity.ts` — no re-derivation.

import type { RefObject } from 'react';
import { PopoverContent } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import type { ContextUsage } from '@/components/chat/context/useContextUsage';
import { t } from '@/lib/i18n';
import { formatCompactCount } from '@/lib/utils';

interface ContextUsagePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  usage: ContextUsage;
  /** CompactNowButton ref — the "Compact now" link focuses it after click,
   *  keeping keyboard focus in the toolbar. */
  compactButtonRef: RefObject<HTMLButtonElement | null>;
}

const SEVERITY_STROKE = {
  ok: 'stroke-emerald-500 dark:stroke-emerald-400',
  warn: 'stroke-amber-500 dark:stroke-amber-400',
  critical: 'stroke-destructive',
} as const;

const SEVERITY_TEXT = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  critical: 'text-destructive',
} as const;

function severityStatusCopy(severity: ContextUsage['severity']): string {
  if (severity === 'critical') return t('chat.context.nearFull');
  if (severity === 'warn') return t('chat.context.tight');
  return t('chat.context.plenty');
}

export function ContextUsagePopover({
  open,
  onOpenChange,
  usage,
  compactButtonRef,
}: ContextUsagePopoverProps) {
  const { percent, severity, ratio, headroomTokens, contextWindow, contextTokenEstimate } = usage;

  // Defence-in-depth: if contextWindow is null, the pill is already hidden,
  // but render nothing here too so a stale prop can't surface an empty panel.
  if (contextWindow === null || contextWindow <= 0) return null;

  const usedTokens = contextTokenEstimate;
  const freeTokens = headroomTokens;
  const usedPct = ratio;
  const freePct = 1 - usedPct;
  // Cache breakdown isn't currently surfaced by useBackgroundAgent; the
  // stacked bar degrades to a two-segment used/free split when cachedPct is 0.
  const cachedPct = 0;

  return (
    <PopoverContent
      side="top"
      align="end"
      sideOffset={8}
      className="w-72 p-3"
      // mouseEnter / mouseLeave inside the popover also keep `open` true,
      // otherwise sliding off the pill onto the popover would flash-close.
      // Radix's default close-on-outside-pointer logic still applies once
      // the cursor leaves both the pill and the popover.
      onMouseEnter={() => onOpenChange(true)}
      onMouseLeave={() => onOpenChange(false)}
    >
      {/* Title row */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">{t('chat.context.used')}</span>
        <span className="text-[0.65rem] text-muted-foreground/70 font-mono tabular-nums">
          {formatCompactCount(usedTokens)} / {formatCompactCount(contextWindow)}
        </span>
      </div>

      {/* Mini radial gauge */}
      <div className="flex items-center justify-center py-1">
        <div className="relative w-[90px] h-[90px]">
          <svg width="90" height="90" viewBox="0 0 90 90" aria-hidden>
            {/* Background ring */}
            <circle
              cx="45"
              cy="45"
              r="38"
              fill="none"
              className="stroke-current opacity-15"
              strokeWidth="8"
            />
            {/* Foreground arc: dasharray = 2*PI*r ≈ 238.76 */}
            <circle
              cx="45"
              cy="45"
              r="38"
              fill="none"
              strokeWidth="8"
              strokeLinecap="round"
              className={SEVERITY_STROKE[severity]}
              strokeDasharray={`${usedPct * 238.76} 238.76`}
              transform="rotate(-90 45 45)"
              style={{ transition: 'stroke-dasharray 500ms ease-out' }}
            />
          </svg>
          <div className={`absolute inset-0 flex items-center justify-center text-xl font-semibold tabular-nums ${SEVERITY_TEXT[severity]}`}>
            {t('chat.context.percent', [String(percent)])}
          </div>
        </div>
      </div>

      {/* Stacked bar — used / cached / free segments. cached is 0 today
        * (no cache breakdown surfaced through useBackgroundAgent yet), so
        * the bar degrades to a two-segment used/free split when not used. */}
      <div className="mt-3 h-2 rounded-full overflow-hidden flex bg-foreground/10">
        <div
          className={SEVERITY_STROKE[severity].replace('stroke-', 'bg-')}
          style={{ width: `${usedPct * 100}%`, transition: 'width 500ms ease-out' }}
        />
        {cachedPct > 0 && (
          <div
            className="bg-sky-500 dark:bg-sky-400"
            style={{ width: `${cachedPct * 100}%`, transition: 'width 500ms ease-out' }}
          />
        )}
        <div
          className="bg-foreground/10"
          style={{ width: `${freePct * 100}%` }}
        />
      </div>

      {/* Token breakdown */}
      <div className="mt-3 space-y-1 text-[0.7rem]">
        <Row label={t('chat.context.used')} tokens={usedTokens} accent={SEVERITY_TEXT[severity]} />
        <Row label={t('chat.context.free')} tokens={freeTokens} accent="text-muted-foreground" />
        <Separator className="my-1.5 bg-border" />
        <Row label={t('chat.context.total')} tokens={contextWindow} accent="text-foreground" bold />
      </div>

      {/* Severity-based status copy */}
      <p className={`mt-2 text-[0.7rem] ${SEVERITY_TEXT[severity]}`}>
        {severityStatusCopy(severity)}
      </p>

      {/* Footer link: focuses the toolbar CompactNowButton and closes the
        * popover. We don't directly call usage.compactNow() — clicking the
        * button preserves the optimistic-pending / disabled logic in one place. */}
      <button
        type="button"
        className="mt-2 text-[0.7rem] text-primary underline-offset-2 hover:underline focus-visible:underline cursor-pointer"
        onClick={() => {
          onOpenChange(false);
          compactButtonRef.current?.focus();
          compactButtonRef.current?.click();
        }}
      >
        {t('chat.context.compactNow')} →
      </button>
    </PopoverContent>
  );
}

function Row({
  label,
  tokens,
  accent,
  bold,
}: {
  label: string;
  tokens: number;
  accent: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={accent}>{label}</span>
      <span className={`font-mono tabular-nums ${bold ? 'font-semibold' : ''}`}>
        {formatCompactCount(tokens)}
      </span>
    </div>
  );
}