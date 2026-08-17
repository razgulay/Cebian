import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { executeInTabWithArgs } from '@/lib/browser/tab-actions';

/**
 * `subagent_click` — A strictly limited click tool for the DOM sub-agent.
 *
 * Allows the sub-agent to click "Show more" / "Load more" / "Xem thêm" / "Read more"
 * / pagination buttons so it can read content that would otherwise be hidden
 * behind an expand interaction. The sub-agent is otherwise strictly read-only
 * (no clicks / no typing / no form submission / no destructive actions).
 *
 * Two selection modes:
 *  1. `textContains` (preferred) — scan the page for the first element whose
 *     visible text contains the given substring. Most reliable across page
 *     re-renders since class names change but button text doesn't.
 *  2. `selector` — direct CSS selector for a specific element.
 *
 * If both are given, `textContains` wins. If neither is given, throw — we
 * don't want the sub-agent to click whatever happens to be at coordinates
 * 0,0 (the page corner).
 *
 * When added to `DOM_SUB_AGENT_TOOLS`, the existing `withDefaultTabId` wrapper
 * auto-injects `tabId` — no extra wiring needed.
 */

/** In-page helper: resolve the target element from `textContains` or `selector`,
 *  scroll it into view, then dispatch a synthetic mouse-down / up / click
 *  sequence. Returns a human-readable summary. */
async function performClick(args: { textContains?: string; selector?: string }): Promise<string> {
  if (!args.textContains && !args.selector) {
    throw new Error('subagent_click: must specify either `textContains` or `selector`');
  }
  let el: HTMLElement;
  if (args.textContains) {
    const needle = args.textContains.toLowerCase();
    // querySelectorAll("*") is heavy on huge pages but acceptable here
    // since the sub-agent calls this sparingly (only on "show more" / pagination).
    const all = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"], summary, [tabindex]'));
    el = all.find((node) => (node.textContent ?? '').trim().toLowerCase().includes(needle))
      ?? (() => {
        // Fallback: any element whose text contains the substring.
        const fallback = Array.from(document.querySelectorAll<HTMLElement>('*'))
          .find((node) => (node.textContent ?? '').trim().toLowerCase().includes(needle));
        return fallback ?? null;
      })() as HTMLElement | null ?? undefined as unknown as HTMLElement;
    if (!el) {
      throw new Error(`subagent_click: no element with text containing "${args.textContains}"`);
    }
  } else {
    el = document.querySelector(args.selector!) as HTMLElement;
    if (!el) {
      throw new Error(`subagent_click: no element matches selector "${args.selector}"`);
    }
  }
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  const point = {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  const desc = args.textContains
    ? `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 60)}"`
    : (args.selector ?? '');
  // Dispatch a synthetic pointer sequence so frameworks that listen for
  // pointerdown (instead of just click) also pick it up. Mirrors the
  // dispatchPointerSequence helper used by `interact`.
  const dispatch = (type: string) => {
    el!.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: point.clientX,
      clientY: point.clientY,
    }));
    el!.dispatchEvent(new MouseEvent(type === 'pointerdown' ? 'mousedown' : 'mouseup', {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: 0,
      clientX: point.clientX,
      clientY: point.clientY,
    }));
  };
  dispatch('pointerdown');
  dispatch('pointerup');
  el!.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    clientX: point.clientX,
    clientY: point.clientY,
  }));
  return `Clicked: ${desc}`;
}

const SubagentClickParameters = Type.Object({
  tabId: Type.Optional(Type.Number({
    description:
      'Optional. Tab ID is auto-injected by the host — omit it. If you ' +
      'see a "no active tab" error, return status="failed" and the host ' +
      'will surface the underlying issue.',
  })),
  textContains: Type.Optional(Type.String({
    description: 'Click the first element whose visible text contains this substring (case-insensitive). E.g. "Show more", "Xem thêm", "Load more", "Read more", "See all".',
  })),
  selector: Type.Optional(Type.String({
    description: 'CSS selector for the element to click. Use this when you need a specific known element. Prefer `textContains` when you only know the button label.',
  })),
  frameId: Type.Optional(Type.Number({
    description: 'Frame ID to click within. Omit for top frame.',
  })),
}, {
  description:
    'Click an element on the page to reveal hidden content. ' +
    'Use this when the data you need is behind a "Show more" / "Load more" / "Xem thêm" / pagination button. ' +
    'Specify exactly one of `textContains` (preferred) or `selector`.',
});

export const subagentClickTool: AgentTool<typeof SubagentClickParameters> = {
  name: 'subagent_click',
  label: 'Click Element',
  description: 'Click an element on the page (e.g. "Show more" button) to reveal hidden content.',
  parameters: SubagentClickParameters,
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
      performClick,
      [{ textContains: args.textContains, selector: args.selector }],
      args.frameId,
    );
    const text = typeof result === 'string'
      ? result
      : `Clicked: ${args.textContains ?? args.selector ?? ''}`;
    return {
      content: [{ type: 'text', text }],
      details: {},
    };
  },
};
