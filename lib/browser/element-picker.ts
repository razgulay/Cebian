import type { ElementAttachment, ImageAttachment } from '@/lib/agent/attachments';
import { getActiveTabId } from '@/lib/browser/tab-actions';
import { t } from '@/lib/i18n';
import { ensureOffscreen } from '@/lib/tools/offscreen';
import type { OffscreenResponse } from '@/entrypoints/offscreen/main';

// ─── Injected picker script (self-contained, runs in content-script isolated world) ───
// IMPORTANT: This function must be fully self-contained — no closures over external variables.
// Translated strings must be passed via the executeScript `args` array.

/** Picker mode injected into the page:
 *  - 'click'  — hover highlights an element, click to capture it (original behavior).
 *  - 'region' — drag a rectangle; auto-scrolls when cursor nears viewport edges
 *               so the user can include content currently below the fold by
 *               dragging off-screen before releasing. The release fires a
 *               screenshot capture of the rectangle (extension side).
 *
 * The mode is passed via `args` (must be JSON-serializable) — extension-side
 * callers select it via `startElementPicker({ mode })`. */
type PickerMode = 'click' | 'region';

function createPickerInPage(iframeEnterHint: string, mode: PickerMode = 'click') {
  // Guard: prevent double injection. Also clean up any orphaned remnants from
  // a crashed previous session so we never end up with a stale cursor style.
  if (document.getElementById('cebian-picker-host')) return;
  document.getElementById('cebian-picker-cursor')?.remove();

  // ── Shadow DOM host ──
  // The host has pointer-events:auto with a full-viewport overlay inside the
  // shadow root. Hit-testing stops at the overlay so page element-level
  // handlers (on the underlying <a>, <img>, etc.) are never invoked — from
  // the page's perspective, event.target is the shadow host, not the page
  // element the user was aiming at. Truly target-agnostic window-level page
  // handlers (e.g. global analytics on window) can still fire; that is a
  // known limitation of any shadow-DOM-based inspector.
  const host = document.createElement('div');
  host.id = 'cebian-picker-host';
  host.style.cssText = 'all:initial !important;position:fixed !important;inset:0 !important;pointer-events:auto !important;z-index:2147483647 !important;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  // Inject crosshair cursor into page (removed on cleanup)
  const cursorStyle = document.createElement('style');
  cursorStyle.id = 'cebian-picker-cursor';
  cursorStyle.textContent = '*, *::before, *::after { cursor: crosshair !important; }';
  document.head.appendChild(cursorStyle);

  // ── Shadow DOM UI ──
  const style = document.createElement('style');
  style.textContent = `
    .overlay {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      z-index: 1;
      background: transparent;
    }
    .highlight {
      position: fixed;
      pointer-events: none;
      z-index: 2;
      border: 2px solid #e8a43a;
      background: rgba(232, 164, 58, 0.08);
      border-radius: 2px;
      transition: top .05s ease-out, left .05s ease-out, width .05s ease-out, height .05s ease-out;
    }
    .tooltip {
      position: fixed;
      pointer-events: none;
      z-index: 3;
      display: flex;
      align-items: baseline;
      gap: 6px;
      background: #1c1d25;
      color: #e8e4df;
      border: 1px solid rgba(232, 164, 58, 0.3);
      padding: 3px 8px;
      border-radius: 4px;
      font: 11px/1.4 'SF Mono', 'Cascadia Code', Consolas, monospace;
      max-width: 320px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .tooltip-dim { color: #8a8d9b; font-size: 10px; }
    /* Region mode: a single live-preview rectangle + an optional "size" badge.
     * Pure visual aid — actual capture happens via chrome.tabs.captureVisibleTab
     * on the extension side once the user releases the mouse. */
    .region-box {
      position: fixed;
      pointer-events: none;
      z-index: 2;
      border: 2px solid #e8a43a;
      background: rgba(232, 164, 58, 0.10);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.18);
      border-radius: 2px;
      display: none;
    }
    .region-size {
      position: fixed;
      pointer-events: none;
      z-index: 3;
      background: #1c1d25;
      color: #e8e4df;
      border: 1px solid rgba(232, 164, 58, 0.3);
      padding: 3px 8px;
      border-radius: 4px;
      font: 11px/1.4 'SF Mono', 'Cascadia Code', Consolas, monospace;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      display: none;
    }
  `;
  shadow.appendChild(style);

  // Full-viewport overlay that absorbs all pointer events before the page sees them.
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  shadow.appendChild(overlay);

  const highlightEl = document.createElement('div');
  highlightEl.className = 'highlight';
  highlightEl.style.display = 'none';
  shadow.appendChild(highlightEl);

  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'tooltip';
  tooltipEl.style.display = 'none';
  const tooltipLabel = document.createElement('span');
  const tooltipDims = document.createElement('span');
  tooltipDims.className = 'tooltip-dim';
  tooltipEl.appendChild(tooltipLabel);
  tooltipEl.appendChild(tooltipDims);
  shadow.appendChild(tooltipEl);

  let currentEl: Element | null = null;

  // ── Underlying element lookup ──
  // Temporarily disable hit-testing on BOTH the host and the overlay so
  // `elementFromPoint` returns the real page element. Toggling both is
  // belt-and-suspenders — `pointer-events` doesn't cascade to descendants, so
  // relying on host alone could miss edge cases where the overlay is hit-tested
  // independently. Restored synchronously, no repaint required.
  // NOTE: host's cssText sets `pointer-events:auto !important`, so we must use
  // setProperty with 'important' priority to override; assigning via `.style.x`
  // does not set the priority flag and may be beaten by the original !important.
  function getUnderlyingElement(x: number, y: number): Element | null {
    host.style.setProperty('pointer-events', 'none', 'important');
    overlay.style.setProperty('pointer-events', 'none', 'important');
    const el = document.elementFromPoint(x, y);
    host.style.setProperty('pointer-events', 'auto', 'important');
    overlay.style.setProperty('pointer-events', 'auto', 'important');
    if (!el || el === host || el === document.documentElement) return null;
    return el;
  }

  // ── Selector: minimal unique CSS selector ──
  function computeSelector(el: Element): string {
    // Try id (verify uniqueness — some pages have duplicate IDs)
    if (el.id) {
      const esc = CSS.escape(el.id);
      try { if (document.querySelectorAll('#' + esc).length === 1) return '#' + esc; } catch { /* invalid id */ }
    }

    const parts: string[] = [];
    let cur: Element | null = el;

    while (cur && cur !== document.body && cur !== document.documentElement) {
      // Shortcut: anchor to nearest unique-id ancestor
      if (cur !== el && cur.id) {
        const esc = CSS.escape(cur.id);
        try {
          if (document.querySelectorAll('#' + esc).length === 1) {
            parts.unshift('#' + esc);
            break;
          }
        } catch { /* skip */ }
      }

      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(tag); break; }

      const sameTag = Array.from(parent.children).filter((c: Element) => c.tagName === cur!.tagName);
      if (sameTag.length === 1) {
        parts.unshift(tag);
      } else {
        parts.unshift(tag + ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')');
      }
      cur = parent;
    }

    const sel = parts.join(' > ');
    // Verify uniqueness
    try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* fall through */ }

    // Fallback: absolute nth-child path from body
    const fb: string[] = [];
    cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const p: Element | null = cur.parentElement;
      if (!p) break;
      fb.unshift(cur.tagName.toLowerCase() + ':nth-child(' + (Array.from(p.children).indexOf(cur) + 1) + ')');
      cur = p;
    }
    return 'body > ' + fb.join(' > ');
  }

  // ── Path: full DOM path from <html> root ──
  function computePath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;

    while (cur) {
      const tag = cur.tagName.toLowerCase();
      let label = tag;

      if (cur.id) {
        label += '#' + cur.id;
      } else if (cur.classList.length > 0) {
        label += '.' + Array.from(cur.classList).slice(0, 2).join('.');
      } else if (cur.parentElement) {
        const sameTag = Array.from(cur.parentElement.children).filter(c => c.tagName === cur!.tagName);
        if (sameTag.length > 1) {
          label += ':nth-child(' + (Array.from(cur.parentElement.children).indexOf(cur) + 1) + ')';
        }
      }

      parts.unshift(label);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // ── Attributes ──
  function collectAttributes(el: Element): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const a of el.attributes) {
      const n = a.name;
      // Skip framework internals
      if (n.startsWith('data-v-') || n.startsWith('_ngcontent') || n.startsWith('__react')) continue;
      // Truncate excessively long values
      attrs[n] = a.value.length > 200 ? a.value.slice(0, 200) + '…' : a.value;
    }
    return attrs;
  }

  // ── Event: pointermove on overlay — track hovered element ──
  function onPointerMove(e: PointerEvent) {
    const target = getUnderlyingElement(e.clientX, e.clientY);
    if (!target) {
      highlightEl.style.display = 'none';
      tooltipEl.style.display = 'none';
      currentEl = null;
      return;
    }

    currentEl = target;
    const rect = target.getBoundingClientRect();

    // Highlight box
    highlightEl.style.display = 'block';
    highlightEl.style.left = rect.left + 'px';
    highlightEl.style.top = rect.top + 'px';
    highlightEl.style.width = rect.width + 'px';
    highlightEl.style.height = rect.height + 'px';

    // Tooltip content
    const tag = target.tagName.toLowerCase();
    const id = target.id ? '#' + target.id : '';
    const cls = target.classList.length > 0
      ? '.' + Array.from(target.classList).slice(0, 2).join('.')
      : '';

    let label = tag + id + cls;
    if (target.tagName === 'IFRAME') label += '  ' + iframeEnterHint;

    tooltipLabel.textContent = label;
    tooltipDims.textContent = Math.round(rect.width) + '×' + Math.round(rect.height);
    tooltipEl.style.display = 'flex';

    // Position tooltip near cursor, avoiding viewport edges
    let tx = e.clientX + 12;
    let ty = e.clientY - 30;
    if (tx + 320 > window.innerWidth) tx = e.clientX - 320;
    if (ty < 4) ty = e.clientY + 16;
    tooltipEl.style.left = tx + 'px';
    tooltipEl.style.top = ty + 'px';
  }

  // ── Event: click on overlay — resolve pick ──
  function onClick(e: MouseEvent) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!currentEl) return;

    // If clicking on an iframe, request iframe entry
    if (currentEl.tagName === 'IFRAME') {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      chrome.runtime.sendMessage({
        type: 'cebian:picker-enter-iframe',
        iframeSrc: (currentEl as HTMLIFrameElement).src || '',
        iframeIndex: iframes.indexOf(currentEl as HTMLIFrameElement),
      });
      cleanupPicker();
      return;
    }

    // Compute element info and send result
    const r = currentEl.getBoundingClientRect();
    chrome.runtime.sendMessage({
      type: 'cebian:picker-result',
      selector: computeSelector(currentEl),
      tagName: currentEl.tagName.toLowerCase(),
      path: computePath(currentEl),
      attributes: collectAttributes(currentEl),
      textContent: ((currentEl as HTMLElement).innerText || '').slice(0, 200) || undefined,
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    });
    cleanupPicker();
  }

  // Block scroll and right-click context menu while picker is active.
  function onBlockEvent(e: Event) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // ── Event: keydown — only intercept Escape ──
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      chrome.runtime.sendMessage({ type: 'cebian:picker-cancel' });
      cleanupPicker();
    }
  }

  // ── Region-mode state & handlers ──
  //
  // Document-coordinate space: the rectangle we send to the extension side
  // is measured in CSS pixels relative to the document, NOT the current
  // viewport. This is essential because the user can scroll the page while
  // dragging — auto-scroll at the viewport edges keeps extending the rect
  // past the original viewport. Document coordinates are stable across
  // scroll; viewport coordinates would not be.
  //
  // Mouse coordinates from PointerEvent / MouseEvent are in viewport (clientX/Y)
  // space, so we convert via `+ window.scrollX/Y` at every event handler.
  //
  // The shadow-root marquee is `position: fixed`, so its visible position
  // moves with the page as the user scrolls. We recompute its left/top/width/
  // height every frame from doc-coords so it stays anchored to the dragged
  // rectangle (anchored to the document, not the cursor — the cursor may
  // be off-screen after auto-scroll, but the rectangle is always fully
  // visible on screen via clamping).
  let dragStart: { x: number; y: number } | null = null;
  let dragEnd: { x: number; y: number } | null = null;
  let scrollRafId: number | null = null;
  let lastCursor: { x: number; y: number } | null = null;
  let regionBox: HTMLDivElement | null = null;
  let regionSize: HTMLDivElement | null = null;

  if (mode === 'region') {
    regionBox = document.createElement('div');
    regionBox.className = 'region-box';
    shadow.appendChild(regionBox);
    regionSize = document.createElement('div');
    regionSize.className = 'region-size';
    shadow.appendChild(regionSize);

    function docCoords(clientX: number, clientY: number): { x: number; y: number } {
      return { x: clientX + window.scrollX, y: clientY + window.scrollY };
    }

    /** Compute viewport-clamped visible rectangle from doc-coord rectangle.
     *  Returns null if there's no overlap with the current viewport. */
    function visibleViewportRect(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } | null {
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const vx0 = scrollX;
      const vy0 = scrollY;
      const vx1 = scrollX + window.innerWidth;
      const vy1 = scrollY + window.innerHeight;
      const rx0 = rect.x;
      const ry0 = rect.y;
      const rx1 = rect.x + rect.width;
      const ry1 = rect.y + rect.height;
      const cx0 = Math.max(rx0, vx0);
      const cy0 = Math.max(ry0, vy0);
      const cx1 = Math.min(rx1, vx1);
      const cy1 = Math.min(ry1, vy1);
      if (cx1 <= cx0 || cy1 <= cy0) return null;
      return {
        x: cx0 - scrollX,
        y: cy0 - scrollY,
        width: cx1 - cx0,
        height: cy1 - cy0,
      };
    }

    function renderRegionBox() {
      if (!regionBox || !dragStart || !dragEnd) return;
      const rect = {
        x: Math.min(dragStart.x, dragEnd.x),
        y: Math.min(dragStart.y, dragEnd.y),
        width: Math.abs(dragEnd.x - dragStart.x),
        height: Math.abs(dragEnd.y - dragStart.y),
      };
      const vis = visibleViewportRect(rect);
      if (!vis) {
        regionBox.style.display = 'none';
        if (regionSize) regionSize.style.display = 'none';
        return;
      }
      regionBox.style.display = 'block';
      regionBox.style.left = vis.x + 'px';
      regionBox.style.top = vis.y + 'px';
      regionBox.style.width = vis.width + 'px';
      regionBox.style.height = vis.height + 'px';
      if (regionSize) {
        regionSize.style.display = 'block';
        regionSize.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
        // Anchor the size badge to the bottom-right of the visible rect,
        // clamping to viewport edges so it stays on screen.
        let sx = vis.x + vis.width - regionSize.offsetWidth;
        let sy = vis.y + vis.height + 6;
        if (sx < 4) sx = 4;
        if (sy + 20 > window.innerHeight) sy = vis.y - 22;
        regionSize.style.left = sx + 'px';
        regionSize.style.top = sy + 'px';
      }
    }

    /** Auto-scroll loop: if the cursor is within EDGE_PX of any viewport
     *  edge, scroll the page in the corresponding direction until the
     *  cursor leaves the edge zone. Capped at ~30 fps via RAF. Lets the
     *  user extend the selection past the current viewport by dragging
     *  toward (and over) the edge. */
    const EDGE_PX = 30;
    function tickScroll() {
      scrollRafId = null;
      if (!dragStart || !lastCursor) return;
      let dx = 0, dy = 0;
      if (lastCursor.x < EDGE_PX) dx = -10;
      else if (lastCursor.x > window.innerWidth - EDGE_PX) dx = 10;
      if (lastCursor.y < EDGE_PX) dy = -10;
      else if (lastCursor.y > window.innerHeight - EDGE_PX) dy = 10;
      if (dx !== 0 || dy !== 0) {
        window.scrollBy(dx, dy);
        // The page scrolled — recompute dragEnd in *document* coords so
        // the marquee stays anchored to where the user is dragging.
        if (dragEnd) {
          dragEnd = { x: lastCursor.x + window.scrollX, y: lastCursor.y + window.scrollY };
        }
        renderRegionBox();
        scrollRafId = requestAnimationFrame(tickScroll);
      }
    }

    function ensureScrollLoop() {
      if (scrollRafId == null) scrollRafId = requestAnimationFrame(tickScroll);
    }

    function onRegionMouseDown(e: MouseEvent) {
      if (e.button !== 0) return; // left button only
      e.preventDefault();
      e.stopImmediatePropagation();
      dragStart = docCoords(e.clientX, e.clientY);
      dragEnd = { ...dragStart };
      lastCursor = { x: e.clientX, y: e.clientY };
      renderRegionBox();
    }

    function onRegionMouseMove(e: MouseEvent) {
      if (!dragStart) return;
      e.preventDefault();
      // Even when the cursor is well inside the viewport, we still want
      // to update dragEnd so the marquee follows the cursor live.
      lastCursor = { x: e.clientX, y: e.clientY };
      dragEnd = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
      renderRegionBox();
      ensureScrollLoop();
    }

    function onRegionMouseUp(e: MouseEvent) {
      if (!dragStart || !dragEnd) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const rect = {
        x: Math.min(dragStart.x, dragEnd.x),
        y: Math.min(dragStart.y, dragEnd.y),
        width: Math.abs(dragEnd.x - dragStart.x),
        height: Math.abs(dragEnd.y - dragStart.y),
      };
      // Reject zero-area drags (just a click, no real selection). Cancel cleanly.
      if (rect.width < 4 || rect.height < 4) {
        chrome.runtime.sendMessage({ type: 'cebian:picker-cancel' });
        cleanupPicker();
        return;
      }
      chrome.runtime.sendMessage({
        type: 'cebian:picker-region-result',
        rect,
      });
      cleanupPicker();
    }

    // Region mode uses mousedown/move/up instead of click. The overlay still
    // absorbs the events so page-level handlers don't see them. Wheel events
    // are NOT blocked here — the user needs the scroll wheel to extend the
    // selection past the current viewport.
    overlay.addEventListener('mousedown', onRegionMouseDown);
    overlay.addEventListener('mousemove', onRegionMouseMove);
    overlay.addEventListener('mouseup', onRegionMouseUp);
    overlay.addEventListener('contextmenu', onBlockEvent);
    overlay.addEventListener('touchmove', onBlockEvent, { passive: false });
    // Replace the click handler that's still attached from click mode setup.
    // (click mode never runs in region mode — the if/else below picks one.)
  }

  // ── Cleanup ──
  function cleanupPicker() {
    // Delete the global hook first so any racing external cancel falls through
    // to its DOM-removal fallback instead of calling a half-dismantled picker.
    try { delete (window as any).__cebianPickerCleanup; } catch { /* non-configurable */ }
    window.removeEventListener('keydown', onKeyDown, true);
    if (scrollRafId != null) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
    try { cursorStyle.remove(); } catch { /* detached */ }
    try { host.remove(); } catch { /* detached */ }
  }

  // Overlay listeners handle the actual picker UX. Events targeted at the
  // overlay are retargeted to the shadow host from the page's perspective,
  // so page handlers using e.target.closest(...) won't match any page element
  // — that's the core guarantee. Truly target-agnostic window-level page
  // handlers (e.g. global `window.onclick`) can still fire; this is a known
  // limitation of any shadow-DOM-based inspector.
  //
  // Click mode registers pointermove + click; region mode registers
  // mousedown/move/up instead. Region mode also leaves `wheel` unblocked
  // so the user can use the scroll wheel to extend the selection.
  if (mode === 'click') {
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('wheel', onBlockEvent, { passive: false });
  }
  // Both modes block right-click context menu and touchmove.
  overlay.addEventListener('contextmenu', onBlockEvent);

  // Keyboard events bypass hit-testing, so Escape must be registered on window.
  window.addEventListener('keydown', onKeyDown, true);

  // Expose cleanup so the extension side can tear down the picker on cancel
  // (e.g. user navigates tabs or calls startElementPicker again).
  (window as any).__cebianPickerCleanup = cleanupPicker;
}

// ─── Extension-side orchestration (runs in sidepanel) ───

let currentCleanup: (() => void) | null = null;
/** Generation counter — bumped on each picker session start; preflight bails if it changes. */
let pickerGeneration = 0;

/** Schemes / URL prefixes where the picker cannot be injected. */
const UNSUPPORTED_URL_PATTERNS: RegExp[] = [
  /^chrome:/i,
  /^chrome-extension:/i,
  /^edge:/i,
  /^about:/i,
  /^view-source:/i,
  /^file:/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/chromewebstore\.google\.com/i,
];

function isUnsupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return UNSUPPORTED_URL_PATTERNS.some(p => p.test(url));
}

/** Result of an element picker session. The caller distinguishes the three
 *  outcomes so failures (system pages, mid-pick navigation, injection errors)
 *  can be surfaced to the user via toast, while a quiet user-cancel stays silent.
 *  `attachment` is the union of all pickable attachment kinds — click mode
 *  yields an ElementAttachment, region mode yields an ImageAttachment. */
export type PickerResult =
  | { status: 'ok'; attachment: ElementAttachment | ImageAttachment }
  | { status: 'cancelled' }
  | { status: 'error'; reason: 'unsupported-page' | 'navigation' | 'injection-failed'; message?: string };

/** Query the captured tab's device pixel ratio so we can scale the CSS-pixel
 *  rect from the picker into the JPEG-pixel space that `captureVisibleTab`
 *  returns. Falls back to 1 (no scaling) if the tab is unreachable — typical
 *  for system pages that the pre-flight check already rejected. */
async function getTabDpr(tabId: number): Promise<number> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.devicePixelRatio || 1,
    });
    const dpr = result?.result;
    return typeof dpr === 'number' && dpr > 0 ? dpr : 1;
  } catch {
    return 1;
  }
}

export interface StartPickerOptions {
  /** Pick mode. Defaults to 'click' (single element).
   *  - 'click'  — hover highlights an element; click captures it.
   *  - 'region' — drag a rectangle; auto-scrolls at viewport edges; release
   *               captures the visible region as a screenshot attachment. */
  mode?: 'click' | 'region';
}

export async function startElementPicker(options: StartPickerOptions = {}): Promise<PickerResult> {
  const mode = options.mode ?? 'click';
  // Cancel any previous picker session
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  const myGeneration = ++pickerGeneration;

  const tabId = await getActiveTabId();
  if (myGeneration !== pickerGeneration) return { status: 'cancelled' };

  // Pre-flight: refuse on system pages where executeScript will be denied.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (myGeneration !== pickerGeneration) return { status: 'cancelled' };
    if (isUnsupportedUrl(tab.url)) {
      return { status: 'error', reason: 'unsupported-page' };
    }
  } catch {
    if (myGeneration !== pickerGeneration) return { status: 'cancelled' };
    // If we can't even read the tab, treat it as unsupported.
    return { status: 'error', reason: 'unsupported-page' };
  }

  return new Promise<PickerResult>((resolve) => {
    function cleanup() {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.tabs.onUpdated.removeListener(tabListener);
      currentCleanup = null;
    }

    // Handle page navigation while picker is active
    function tabListener(updatedTabId: number, info: { status?: string }) {
      if (updatedTabId === tabId && info.status === 'loading') {
        cleanup();
        resolve({ status: 'error', reason: 'navigation' });
      }
    }

    function messageListener(msg: any, sender: chrome.runtime.MessageSender) {
      if (sender.tab?.id !== tabId) return;

      switch (msg.type) {
        case 'cebian:picker-result': {
          const frameId = sender.frameId ?? 0;
          cleanup();
          resolve({
            status: 'ok',
            attachment: {
              type: 'element',
              selector: msg.selector,
              tagName: msg.tagName,
              path: msg.path,
              attributes: msg.attributes,
              textContent: msg.textContent || undefined,
              rect: msg.rect,
              tabId: sender.tab?.id,
              tabUrl: sender.tab?.url,
              windowId: sender.tab?.windowId,
              frameId: frameId || undefined,
              frameUrl: frameId ? (sender.url || undefined) : undefined,
            },
          });
          break;
        }

        case 'cebian:picker-region-result': {
          // Region mode: capture the visible viewport, crop to the rectangle,
          // and return an ImageAttachment. The whole sequence is async —
          // resolve() is called once the crop is back from the offscreen doc.
          const cssRect = msg.rect as { x: number; y: number; width: number; height: number };
          cleanup();
          // Fire-and-forget the capture/crop pipeline; resolve below.
          void (async () => {
            try {
              const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 85 });
              const base64 = dataUrl.split(',', 2)[1] ?? '';
              const dpr = await getTabDpr(tabId);
              await ensureOffscreen();
              const resp = (await chrome.runtime.sendMessage({
                type: 'crop-image',
                imageData: base64,
                crop: {
                  x: Math.round(cssRect.x * dpr),
                  y: Math.round(cssRect.y * dpr),
                  width: Math.round(cssRect.width * dpr),
                  height: Math.round(cssRect.height * dpr),
                },
              })) as OffscreenResponse;
              if (resp?.error || !resp?.result) {
                throw new Error(resp?.error ?? 'crop-image returned no result');
              }
              resolve({
                status: 'ok',
                attachment: {
                  type: 'image',
                  source: 'region-select',
                  data: resp.result,
                  mimeType: 'image/jpeg',
                },
              });
            } catch (err) {
              console.error('[Region Picker] capture/crop failed:', err);
              resolve({
                status: 'error',
                reason: 'injection-failed',
                message: (err as Error).message,
              });
            }
          })();
          break;
        }

        case 'cebian:picker-cancel':
          cleanup();
          resolve({ status: 'cancelled' });
          break;

        case 'cebian:picker-enter-iframe':
          enterIframe(tabId, msg, sender.frameId ?? 0).catch((err) => {
            console.warn('[Element Picker] Failed to enter iframe:', err);
          });
          break;
      }
    }

    // Setup: wire up cleanup so external callers can cancel
    currentCleanup = () => {
      cleanup();
      // Invoke the in-page cleanup hook in every frame so iframe pickers are
      // also torn down (the user may have entered an iframe before cancelling).
      // Fallback to removing the host/cursor directly in case the hook is
      // missing (e.g. previous session crashed before installing it).
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const w = window as any;
          if (typeof w.__cebianPickerCleanup === 'function') {
            w.__cebianPickerCleanup();
            return;
          }
          document.getElementById('cebian-picker-host')?.remove();
          document.getElementById('cebian-picker-cursor')?.remove();
        },
      }).catch(() => {});
      resolve({ status: 'cancelled' });
    };

    chrome.runtime.onMessage.addListener(messageListener);
    chrome.tabs.onUpdated.addListener(tabListener);

    // Inject picker into the top frame
    chrome.scripting.executeScript({
      target: { tabId },
      func: createPickerInPage,
      args: [t('chat.composer.iframeEnterHint'), mode],
    }).catch((err) => {
      console.error('[Element Picker] Injection failed:', err);
      cleanup();
      resolve({ status: 'error', reason: 'injection-failed', message: (err as Error).message });
    });
  });
}

/** Inject picker into a child iframe. Sends cancel message on failure. */
async function enterIframe(tabId: number, msg: { iframeSrc: string; iframeIndex: number }, parentFrameId: number) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames) throw new Error('getAllFrames returned null');

    // Filter to direct children of the parent frame
    const children = frames.filter(f => f.parentFrameId === parentFrameId);

    let target: chrome.webNavigation.GetAllFrameResultDetails | undefined;

    // Match by URL first
    if (msg.iframeSrc) {
      const urlMatches = children.filter(f => f.url === msg.iframeSrc);
      target = urlMatches[0];
    }

    // Fallback: match by ordering index
    if (!target && msg.iframeIndex >= 0 && msg.iframeIndex < children.length) {
      target = children[msg.iframeIndex];
    }

    if (!target) throw new Error('Could not resolve iframe frameId');

    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [target.frameId] },
      func: createPickerInPage,
      // iframe entry only happens from click mode (region-pick doesn't navigate
      // into iframes — there's no way to capture cross-origin iframe pixels
      // via chrome.tabs.captureVisibleTab), so we hardcode 'click' here.
      args: [t('chat.composer.iframeEnterHint'), 'click'],
    });
  } catch (err) {
    console.warn('[Element Picker] iframe entry failed:', err);
    // Notify sidepanel listener so the promise resolves instead of hanging
    currentCleanup?.();
  }
}

/** Cancel the active picker session (if any). */
export function cancelElementPicker() {
  currentCleanup?.();
}
