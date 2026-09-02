// ContextUsageBadge — floating context-usage badge for the chat scroll area.
//
// Lifted out of ChatInput's toolbar because the compact-now affordance reads
// better as a status indicator anchored to the chat content itself than as
// another toolbar button — it sits in the top-right corner of the message
// area, the way sidebars / Copilot / Claude.ai place their context gauges,
// so the eye doesn't have to drop to the composer to check pressure.
//
// Design goals:
// - Single component that owns: popover open state, pill ref, compact button
//   ref. The chat page just passes `usage` + `onCompact` and renders this
//   once inside the relative scroll container — no prop drilling through
//   Message / ChatInput.
// - Anchored absolute, bottom-right. Pointer-events-none on the wrapper so it
//   never blocks scroll or clicks on chat content; re-enabled per child.
// - Severity tier (ok / warn / critical) flows through from `usage.severity`
//   — this component only maps severity to colour, never re-derives.
//
// Popover behaviour mirrors the old ChatInput mount: click-to-toggle on the
// pill, click "Compact now →" in the popover to drive the toolbar button
// (now driven via the same forwarded ref, but the button lives next to the
// pill in this same badge, not in the toolbar).

import { useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CompactNowButton } from '@/components/chat/context/CompactNowButton';
import { ContextUsagePill } from '@/components/chat/context/ContextUsagePill';
import { ContextUsagePopover } from '@/components/chat/context/ContextUsagePopover';
import type { ContextUsage } from '@/components/chat/context/useContextUsage';

interface ContextUsageBadgeProps {
  usage: ContextUsage;
  onCompact: () => void;
}

export function ContextUsageBadge({ usage, onCompact }: ContextUsageBadgeProps) {
  const compactButtonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // When usage hasn't been resolved yet (unknown state), the pill hides
  // itself — so we also skip the wrapper to avoid an empty floating div
  // anchoring nothing.
  if (usage.unknown) return null;

  return (
    <div
      // Anchor to the chat scroll container's bottom-right. `pointer-events-none`
      // on the wrapper so the floating layer never swallows scroll/clicks on
      // chat content; children re-enable pointer-events for their interactive
      // surfaces. `z-10` keeps the badge above message bubbles that scroll
      // under it.
      className="absolute bottom-3 right-3 z-10 pointer-events-none"
    >
      <div className="inline-flex items-center gap-0.5 pointer-events-auto">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <ContextUsagePill
              usage={usage}
              popoverOpen={open}
              onPopoverOpenChange={setOpen}
            />
          </PopoverTrigger>
          <ContextUsagePopover
            open={open}
            onOpenChange={setOpen}
            usage={usage}
            compactButtonRef={compactButtonRef}
          />
        </Popover>
        <CompactNowButton ref={compactButtonRef} usage={usage} onClick={onCompact} />
      </div>
    </div>
  );
}