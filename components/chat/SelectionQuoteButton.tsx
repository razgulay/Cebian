import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Quote } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * SelectionQuoteButton — floating "Quote" button that appears when the user
 * selects text inside a message bubble.
 *
 * Behavior inspired by Gemini / Slack / GitHub: when text is selected, a small
 * button floats above the selection. Clicking it wraps the selected text in
 * Unicode curly quotes (with a thin vertical-bar marker) and inserts the
 * result into the chat input via the `onQuote` callback.
 *
 * Anchor semantics:
 *  - The button's position is computed from the START of the user's selection
 *    (the left edge of the bounding rect, anchored at the top). Once the user
 *    finishes the selection and the button appears, the button does NOT chase
 *    the cursor — it stays put at the original selection's top-left corner.
 *  - On the very first frame after the selection becomes non-empty, we position
 *    the button. Subsequent mouse moves inside an already-existing selection
 *    only update the position if the START POINT of the selection itself
 *    changes (i.e. the user is dragging to extend / shrink the selection).
 *    Plain mouse movement without button-held doesn't fire `selectionchange`
 *    in modern browsers, so the button stays put.
 *
 * Visual:
 *  - White background, dark text — matches the sidepanel's light card surfaces
 *    so the button doesn't disappear on a dark theme.
 *  - Has a soft shadow + border so it stands out against any chat background.
 */
export interface SelectionQuoteButtonProps {
  /** CSS selector — selections inside matching elements trigger the button. */
  scopeSelector: string;
  /** Called with the formatted Markdown blockquote text when the user clicks. */
  onQuote: (text: string) => void;
  /** Optional callback to run on every selection change (e.g. to clear the user's
   *  browser text selection once the quote has been inserted). */
  onConsumed?: () => void;
}

/** Wrap a free-form user selection as a visible quoted block. The user's
 *  requested format is the literal word `quote` framing the selected text
 *  with angle brackets:
 *
 *      quote <Th\u1EF1c ch\u1EA5t b\u1ED9 nh\u1EDB trong h\u1EC7 th\u1ED1ng> quote
 *
 *  The literal word is preferred over a graphical marker (an earlier version
 *  used `\u258E` block characters, which rendered as solid black bars in
 *  the chat input's monospace font and visually dominated the excerpt;
 *  a later version used Unicode curly quotes `\u201C \u201D`, which the user
 *  found too noisy when the excerpt already contains its own punctuation).
 *  Markdown treats all of this as plain text \u2014 no italic / bold markers,
 *  since `rehypeRaw` is not enabled. A single trailing newline keeps the
 *  quoted block close to whatever the user types next instead of being
 *  separated by a blank line. */
function formatBlockquote(raw: string): string {
  const trimmed = raw.replace(/\s+$/g, '');
  if (!trimmed) return '';
  const lines = trimmed
    .split('\n')
    .map((line) => line.replace(/^\s*>?\s?/, ''));
  if (lines.length === 1) {
    return `quote <${lines[0]}> quote\n`;
  }
  // Multi-line: keep the `quote \u2026 quote` framing visible at the top/bottom
  // edges so it's obvious even when the selection spans many lines.
  const framed = lines.map((l) => `> ${l}`).join('\n');
  return `quote\n${framed}\nquote\n`;
}
export function SelectionQuoteButton({
  scopeSelector,
  onQuote,
  onConsumed,
}: SelectionQuoteButtonProps) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;
  const onConsumedRef = useRef(onConsumed);
  onConsumedRef.current = onConsumed;

  // Track the boundary points of the currently-positioned selection so we
  // only re-position when the selection itself changed. Plain mouse movement
  // inside an already-finished selection doesn't fire `selectionchange` in
  // modern browsers, so once the button is positioned it stays put until the
  // user genuinely changes the selection boundaries or the viewport rect
  // shifts (scroll / resize — handled by the window listeners in the effect
  // below).
  const lastSelectionKeyRef = useRef<string>('');

  const recompute = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setPos(null);
      lastSelectionKeyRef.current = '';
      return;
    }
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    // Find the nearest element node (Text nodes don't have `.closest`).
    const anchorEl =
      anchor.nodeType === Node.ELEMENT_NODE
        ? (anchor as HTMLElement)
        : anchor.parentElement;
    if (!anchorEl) {
      setPos(null);
      lastSelectionKeyRef.current = '';
      return;
    }
    // Ignore selections inside editable controls.
    if (anchorEl.closest('input, textarea, [contenteditable="true"]')) {
      setPos(null);
      lastSelectionKeyRef.current = '';
      return;
    }
    // Only show for selections inside the chat scope.
    if (!anchorEl.closest(scopeSelector)) {
      setPos(null);
      lastSelectionKeyRef.current = '';
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setPos(null);
      lastSelectionKeyRef.current = '';
      return;
    }
    // Compute a stable key for the selection. Modern browsers don't fire
    // `selectionchange` for plain mouse movement inside an existing selection,
    // so once the button is positioned, it stays put until the user
    // genuinely changes the selection boundaries.
    const key = `${range.startOffset}:${range.endOffset}:${rect.left.toFixed(0)}:${rect.top.toFixed(0)}`;
    if (key === lastSelectionKeyRef.current) return;
    lastSelectionKeyRef.current = key;

    // Anchor to the top-left of the selection rect (not centered) so the
    // button sits flush above the start of the selection and doesn't "chase"
    // the cursor as the user extends the selection to the right.
    setPos({
      top: rect.top - 28,
      left: rect.left,
    });
  }, [scopeSelector]);

  useEffect(() => {
    const onSelectionChange = () => {
      // `recompute()` reads `window.getSelection()` fresh on every call, so
      // this listener only needs to forward the event. `recompute()` handles
      // empty / collapsed / out-of-scope selections internally by calling
      // `setPos(null)`. The scroll / resize listener below is the canonical
      // viewport-tracking path; this handler exists for the non-scroll
      // cases — user makes a new selection, browser clears selection on
      // Escape, etc.
      recompute();
    };
    const onMouseDown = (e: MouseEvent) => {
      // Hide when the user clicks outside the chat (e.g. on the input). The
      // button itself is rendered in a portal, so it must explicitly opt out
      // — see the data-quote-button attribute on the button below.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-quote-button]')) return;
      setPos(null);
      // Clear the rect-derived key so the next `recompute()` (e.g. when the
      // user makes a fresh selection) doesn't short-circuit on the previous
      // selection's key.
      lastSelectionKeyRef.current = '';
    };
    const repositionOnViewportChange = () => {
      // Re-anchor the button to the selection's CURRENT viewport rect on
      // every scroll / resize event. `recompute()` internally short-circuits
      // via `lastSelectionKeyRef` when the rect-derived key hasn't changed
      // (e.g. a scroll event fired without actual displacement, like
      // bubbling scroll from a child container that didn't move), so this
      // is essentially free for noise events. The button's className
      // overrides Shadcn's `transition-all` with `transition-colors`, so
      // `top` / `left` snap on the same frame as the scroll instead of
      // animating over 150 ms — that's what makes the button track the
      // selection smoothly through scroll instead of "lagging" or
      // "snapping" at scroll-end. `scroll` uses capture-phase so we catch
      // scroll events from any descendant container; `resize` doesn't
      // bubble and `window` is the only meaningful target, so the default
      // (bubble) phase is fine.
      recompute();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('scroll', repositionOnViewportChange, true);
    window.addEventListener('resize', repositionOnViewportChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('scroll', repositionOnViewportChange, true);
      window.removeEventListener('resize', repositionOnViewportChange);
    };
  }, [recompute]);

  if (!pos) return null;

  const handleClick = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const raw = sel.toString();
    if (!raw) return;
    const quoted = formatBlockquote(raw);
    if (!quoted) return;
    onQuoteRef.current(quoted);
    // Clear the selection so the same text isn't re-quoted on a second click.
    sel.removeAllRanges();
    onConsumedRef.current?.();
    setPos(null);
    lastSelectionKeyRef.current = '';
  };

  // Render into a portal at `document.body` so the button's nearest
  // ancestor in the DOM is `document.body` itself — no styled ancestor
  // in between can promote a containing block for `position: fixed`.
  // Without the portal, some transitive ancestor of the chat tree (a
  // Radix ScrollArea viewport, a Tailwind compiled utility class, a
  // Chrome-sidepanel-specific stylesheet, etc.) can establish a
  // containing block, which makes the button scroll along with content
  // even when its `top` / `left` haven't changed. Portal'ing to body
  // makes `position: fixed` unambiguously viewport-relative. React
  // events still bubble through the React tree, so the click handler,
  // `onMouseDown`, and the document-level `closest('[data-quote-button]')`
  // opt-out in the capture-phase `onMouseDown` listener all keep working.
  return createPortal(
    <Button
      data-quote-button
      size="sm"
      variant="default"
      onClick={handleClick}
      onMouseDown={(e) => {
        // Prevent mousedown from clearing the button before its click handler fires.
        e.preventDefault();
        e.stopPropagation();
      }}
      // Override Shadcn Button's default `transition-all` (which would
      // animate `top` / `left` over 150 ms and make the button "lag"
      // or "jump" through scroll) with `transition-colors` (the
      // `!` important prefix guarantees this wins the cascade over
      // Shadcn's `transition-all`). `transition-colors` only transitions
      // color-related properties — `top` / `left` snap on the same frame
      // as the scroll event, so the button tracks the selection's
      // viewport rect smoothly. Hover background-color still animates.
      className="fixed z-50 size-6 rounded-full shadow-lg border border-border/60 bg-white text-foreground hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 !transition-colors"
      style={{ top: pos.top, left: pos.left }}
      aria-label="Quote"
    >
      <Quote className="size-3" />
    </Button>,
    document.body,
  );
}
