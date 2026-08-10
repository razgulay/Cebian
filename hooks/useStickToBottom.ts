import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useStickToBottom — Gemini-style chat viewport scrolling.
 *
 * Instant Snap to Top:
 * 1. When a new user prompt is sent, `scrollToUserPrompt()` immediately SNAPS the user
 *    prompt to the top of the viewport (16px top offset) in 0ms (instant frame).
 * 2. Unsticks from bottom (`stickRef.current = false`), so subsequent AI streaming text
 *    generates below the prompt without any scrolling or movement.
 * 3. User manual scrolling (wheel / touchmove / scrollbar thumb drag) does not rearm anything.
 * 4. Clicking ArrowDown or switching idle sessions calls `scrollToBottom({ force: true })`.
 */

const BOTTOM_THRESHOLD_PX = 32;

function getViewport(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  return root.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
}

function isAtBottomNow(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX;
}

export function useStickToBottom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const isDraggingRef = useRef(false);
  const releaseDragRef = useRef<(() => void) | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((opts?: { force?: boolean }) => {
    const viewport = getViewport(scrollRef.current);
    if (!viewport) return;
    if (opts?.force) {
      stickRef.current = true;
      setIsAtBottom(true);
    } else if (!stickRef.current) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, []);

  /**
   * Externally set the auto-stick state. Used by the chat page to DISARM
   * auto-stick synchronously the moment a user sends a new message — BEFORE
   * React re-renders the new user bubble and the ResizeObserver fires.
   * Without this, the observer sees the content size change, checks
   * `stickRef.current` (still `true` at that moment), and scrolls the viewport
   * to the bottom of the (still-tiny) messages container — yanking the user
   * bubble off the top of the viewport and hiding it behind the chat header.
   */
  const setSticky = useCallback((sticky: boolean) => {
    stickRef.current = sticky;
    setIsAtBottom(sticky);
  }, []);

  /**
   * INSTANT SNAP TO TOP:
   * Instantly positions the user prompt bubble at the very top of the viewport (16px from top)
   * in a single frame. Disarms all auto-scrolling so streaming text generates below it.
   */
  const scrollToUserPrompt = useCallback((targetEl?: HTMLElement | null) => {
    const viewport = getViewport(scrollRef.current);
    if (!viewport) return;

    stickRef.current = false;
    setIsAtBottom(false);

    const el = targetEl ?? (viewport.querySelector('[data-user-message="last"]') as HTMLElement | null);
    if (!el) return;

    const viewportRect = viewport.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const desiredTopOffset = 16; // 16px padding from top of viewport

    // Instant snap
    const currentDiff = elRect.top - viewportRect.top;
    const targetScrollTop = viewport.scrollTop + (currentDiff - desiredTopOffset);
    viewport.scrollTop = Math.max(0, targetScrollTop);
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    const viewport = getViewport(root);
    if (!root || !viewport) return;

    const contentEl = viewport.firstElementChild as HTMLElement | null;

    const onUserInteraction = () => {
      const atBottom = isAtBottomNow(viewport);
      if (stickRef.current !== atBottom) {
        stickRef.current = atBottom;
        setIsAtBottom(atBottom);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        !target.closest(
          '[data-slot="scroll-area-scrollbar"], [data-slot="scroll-area-thumb"]',
        )
      ) {
        return;
      }
      onUserInteraction();
      releaseDragRef.current?.();
      isDraggingRef.current = true;
      const release = () => {
        isDraggingRef.current = false;
        window.removeEventListener('pointerup', release);
        window.removeEventListener('pointercancel', release);
        if (releaseDragRef.current === release) releaseDragRef.current = null;
      };
      releaseDragRef.current = release;
      window.addEventListener('pointerup', release);
      window.addEventListener('pointercancel', release);
    };

    const onWheel = () => {
      onUserInteraction();
    };

    const onTouchMove = () => {
      onUserInteraction();
    };

    let ro: ResizeObserver | null = null;
    if (contentEl) {
      ro = new ResizeObserver(() => {
        if (isDraggingRef.current) return;
        if (!stickRef.current) return;
        viewport.scrollTop = viewport.scrollHeight;
      });
      ro.observe(contentEl);
    }

    viewport.addEventListener('wheel', onWheel, { passive: true });
    viewport.addEventListener('touchmove', onTouchMove, { passive: true });
    root.addEventListener('pointerdown', onPointerDown, true);

    const initiallyAtBottom = isAtBottomNow(viewport);
    if (!initiallyAtBottom) {
      stickRef.current = false;
      setIsAtBottom(false);
    }

    return () => {
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('pointerdown', onPointerDown, true);
      ro?.disconnect();
      releaseDragRef.current?.();
    };
  }, []);

  return { scrollRef, isAtBottom, scrollToBottom, scrollToUserPrompt, setSticky };
}
