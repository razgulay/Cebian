import { useEffect, useState, useCallback, useRef } from 'react';
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
  // only re-position when the selection itself changed (e.g. user dragged
  // from a different start). Plain mouse movement inside an already-finished
  // selection doesn't fire `selectionchange` in modern browsers, so this
  // gate is mostly defensive — but it makes the contract explicit.
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
    const onSelectionChange = () => recompute();
    const onScroll = () => {
      setPos(null);
      lastSelectionKeyRef.current = '';
    };
    const onMouseDown = (e: MouseEvent) => {
      // Hide when the user clicks outside the chat (e.g. on the input). The
      // button itself is rendered in a portal, so it must explicitly opt out
      // — see the data-quote-button attribute on the button below.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-quote-button]')) return;
      setPos(null);
      lastSelectionKeyRef.current = '';
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
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

  return (
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
      className="fixed z-50 size-6 rounded-full shadow-lg border border-border/60 bg-white text-foreground hover:bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
      style={{ top: pos.top, left: pos.left }}
      aria-label="Quote"
    >
      <Quote className="size-3" />
    </Button>
  );
}
