import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { executeInTabWithArgs } from '@/lib/browser/tab-actions';

/**
 * `subagent_scroll` — A strictly limited scrolling tool for the DOM sub-agent.
 *
 * The sub-agent runs in a read-only sandbox without access to the powerful
 * `interact` tool (which allows clicking, typing, and arbitrary DOM mutation).
 * However, the sub-agent needs the ability to scroll to trigger lazy-loaded
 * content or reveal elements below the fold.
 *
 * This tool wraps `window.scrollBy` (or `Element.scrollBy` when a selector
 * is given). The action is hardcoded — even if the sub-agent tries to pass a
 * different shape, the gate in `dom-sub-agent.ts` whitelists only
 * `subagent_scroll` and this implementation is read-only by design.
 */

/** In-page helper: scrolls the chosen element (or `document.documentElement`)
 *  by `(deltaX, deltaY)` and returns a short human-readable summary. */
async function performScroll(args: { deltaY?: number; deltaX?: number; selector?: string }): Promise<string> {
  const deltaX = args.deltaX ?? 0;
  const deltaY = args.deltaY ?? 300;
  let el: Element | Window = document.documentElement;
  if (args.selector) {
    const found = document.querySelector(args.selector);
    if (!found) throw new Error(`subagent_scroll: no element matches selector ${args.selector}`);
    el = found;
  }
  // For an Element, scrollBy uses the standard scroll behavior.
  // For Window, scrollBy scrolls the viewport.
  el.scrollBy({ left: deltaX, top: deltaY, behavior: 'smooth' });
  return args.selector
    ? `Scrolled ${args.selector} by (${deltaX}, ${deltaY})`
    : `Scrolled page by (${deltaX}, ${deltaY})`;
}

const SubagentScrollParameters = Type.Object({
  tabId: Type.Optional(Type.Number({
    description:
      'Optional. Tab ID is auto-injected by the host — omit it. If you ' +
      'see a "no active tab" error, return status="failed" and the host ' +
      'will surface the underlying issue.',
  })),
  deltaY: Type.Optional(Type.Number({
    description: 'Pixels to scroll vertically. Defaults to 500 (scroll down). Use negative for up.',
  })),
  selector: Type.Optional(Type.String({
    description: 'If scrolling an internal element (e.g. a scrollable div), provide its CSS selector. Otherwise scrolls the main page.',
  })),
  frameId: Type.Optional(Type.Number({
    description: 'Frame ID to scroll within. Omit for top frame.',
  })),
}, {
  description:
    'Scroll the page to trigger lazy-loaded content or reveal hidden data. ' +
    'Call this if the data you need isn\'t visible yet in the outline or markdown read.',
});

export const subagentScrollTool: AgentTool<typeof SubagentScrollParameters> = {
  name: 'subagent_scroll',
  label: 'Scroll Page',
  description: 'Scroll the page to trigger lazy-load content.',
  parameters: SubagentScrollParameters,
  async execute(_toolCallId, args, signal): Promise<AgentToolResult<Record<string, never>>> {
    signal?.throwIfAborted();
    if (args.tabId == null) {
      return {
        content: [{ type: 'text', text: 'Error: tabId is missing. The host should auto-inject it; report this as a bug.' }],
        details: {},
      };
    }
    const result = await executeInTabWithArgs(
      args.tabId,
      performScroll,
      [{ deltaY: args.deltaY ?? 500, selector: args.selector }],
      args.frameId,
    );
    const text = typeof result === 'string'
      ? result
      : `Scrolled page by (${args.deltaY ?? 500})`;
    return {
      content: [{ type: 'text', text }],
      details: {},
    };
  },
};