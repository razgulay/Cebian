import type { ElementAttachment, ImageAttachment } from '@/lib/agent/attachments';
import { executeInTabWithArgs, getActiveTabId } from '@/lib/browser/tab-actions';
import { ensureOffscreen } from '@/lib/tools/offscreen';
import type { OffscreenResponse } from '@/entrypoints/offscreen/main';
import { t } from '@/lib/i18n';

/** crop-image / composite-vertical offscreen responses share the same
 *  `{ result?: string; error?: string }` shape — the picker only cares
 *  about a base64 string back, so this alias keeps the call sites terse. */
type OffscreenCropResponse = OffscreenResponse;

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

// Cursor for the picker overlay. Uses the EXACT `MousePointer2` SVG path from
// `lucide-react` (the same icon rendered by the "Pick element" button in the
// composer) — single-path arrow with tail, no custom re-drawing. Visual
// identity stays in sync with the toolbar trigger so the picker reads as
// "the same tool, now active in the page".
//   * 16x16 display with the lucide-native 24x24 viewBox: the browser scales
//     the path down 2/3, giving a cursor 1/3 smaller than the native lucide
//     size while keeping the path's proportions and stroke quality.
//   * Outline-only — `fill="none"`, `stroke="#f97316"` (Cebian brand orange
//     from assets/tailwind.css `--primary`). Matches lucide's stroke-first
//     aesthetic and reads as a clean line drawing, not a chunky stamp.
//   * Hotspot (3, 3) ≈ the path's start point (4.037, 4.688) projected from
//     24x24 → 16x16, ≈ the actual tip of the arrow.
//   * `crosshair` is the fallback if the data: URL fails.
//   * The full declaration is `cursor:<value>`; we keep it as a constant
//     INSIDE `createPickerInPage` because `chrome.scripting.executeScript`
//     only serializes the function body — outer constants are not in scope
//     at the injection site.
function createPickerInPage(iframeEnterHint: string, mode: PickerMode = 'click') {
  const PICKER_CURSOR_VALUE =
    'url("data:image/svg+xml;base64,' +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
        'fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        // Exact lucide-react MousePointer2 path (lucide v0.x source).
        '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>' +
      '</svg>',
    ) +
    '") 3 3, crosshair';
  const PICKER_CURSOR_DECL = `cursor:${PICKER_CURSOR_VALUE}`;

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
  host.style.cssText =
    'all:initial !important;position:fixed !important;inset:0 !important;' +
    'pointer-events:auto !important;z-index:2147483647 !important;' +
    PICKER_CURSOR_DECL + ' !important;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  // Inject picker cursor into the page (removed on cleanup).
  //
  // CSS cascade priority, from weakest to strongest:
  //   1. stylesheet rule (e.g. `*, html * { cursor: <X> !important }`)
  //   2. inline style
  //   3. inline style with !important
  //   4. inline style with !important on document.documentElement
  //
  // Some pages set cursor via inline `style="cursor: ... !important"` on
  // body or html, which beats descendant selectors in (1). And pages that
  // use `cursor: url(...)` with `!important` win by specificity alone in (1).
  // To bypass both, we apply inline `cursor: <X> !important` directly
  // on `documentElement` — this is the strongest cursor override the page
  // allows short of OS-level scheme overrides.
  const cursorStyle = document.createElement('style');
  cursorStyle.id = 'cebian-picker-cursor';
  cursorStyle.textContent = `html, html *, html *::before, html *::after { ${PICKER_CURSOR_DECL} !important; }`;
  document.head.appendChild(cursorStyle);
  // Belt-and-suspenders: also set inline on the root.
  document.documentElement.style.setProperty('cursor', PICKER_CURSOR_VALUE, 'important');

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
     *  toward (and over) the edge.
     *
     *  Speed scales with how deep into the edge zone the cursor is: at
     *  the zone boundary it scrolls slowly (MIN_PX_PER_FRAME ≈ 840 px/s),
     *  ramping up to MAX_PX_PER_FRAME ≈ 3600 px/s as the cursor pushes
     *  right against the viewport edge — gives the user tactile control
     *  instead of a single fixed speed. */
    // 鼠标靠近视口边缘时按方向自动滚：顶部/左侧 → 负方向（向上/向左），
    // 底部/右侧 → 正方向（向下/向右）。速度随深度线性 ramp，贴边最快、
    // 进缓冲带时最慢——给用户一个既能甩手快速滚、也能精细微调的手感。
    const EDGE_PX = 50;
    const MIN_PX_PER_FRAME = 14;
    const MAX_PX_PER_FRAME = 60;
    function edgeSpeed(cursor: number, edgeMax: number): number {
      // 先算 factor（0..1）：0 在死区中央（不滚），1 在贴边（最猛）。
      // 用 factor 而不是 ramp 来判死区——`ramp = MIN + (MAX-MIN)*factor`
      // 永远 ≥ MIN，死区检查 `ramp === 0` 永远不成立，会让中部永远
      // 慢速漂移（之前出 bug 的就是这条）。
      let factor: number;
      let sign: number;
      if (cursor < EDGE_PX) {
        factor = (EDGE_PX - cursor) / EDGE_PX;
        sign = -1;
      } else if (cursor > edgeMax - EDGE_PX) {
        factor = (cursor - (edgeMax - EDGE_PX)) / EDGE_PX;
        sign = +1;
      } else {
        return 0;
      }
      const ramp = MIN_PX_PER_FRAME + (MAX_PX_PER_FRAME - MIN_PX_PER_FRAME) * factor;
      // 顶部/左侧 → 负方向；底部/右侧 → 正方向。
      // 之前两个分支都返回正数，结果 top/left 自动滚根本滚不动——
      // 只能往下/右滚，鼠标一进缓冲带就被钉死。
      return sign * Math.min(MAX_PX_PER_FRAME, ramp);
    }
    function tickScroll() {
      scrollRafId = null;
      if (!dragStart || !lastCursor) return;
      const dx = edgeSpeed(lastCursor.x, window.innerWidth);
      const dy = edgeSpeed(lastCursor.y, window.innerHeight);
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
      const rawRect = {
        x: Math.min(dragStart.x, dragEnd.x),
        y: Math.min(dragStart.y, dragEnd.y),
        width: Math.abs(dragEnd.x - dragStart.x),
        height: Math.abs(dragEnd.y - dragStart.y),
      };
      // Clamp to the actual document bounds. CDP's `Page.captureScreenshot`
      // with `captureBeyondViewport: true` honours the clip rectangle, but
      // for areas beyond the document's own `scrollHeight`/`scrollWidth` it
      // has a long-standing quirk: it pads the missing region by repeating
      // the current viewport contents. On a typical page the user sees the
      // page header / top section stacked vertically — a captured image
      // that's bigger than the document but shows the same top content
      // repeated. Clamping here keeps the captured image honest: it shows
      // exactly the document pixels under the drag, nothing more.
      const maxX = Math.max(0, document.documentElement.scrollWidth);
      const maxY = Math.max(0, document.documentElement.scrollHeight);
      const x0 = Math.max(0, Math.min(rawRect.x, maxX));
      const y0 = Math.max(0, Math.min(rawRect.y, maxY));
      const x1 = Math.max(0, Math.min(rawRect.x + rawRect.width, maxX));
      const y1 = Math.max(0, Math.min(rawRect.y + rawRect.height, maxY));
      const rect = {
        x: x0,
        y: y0,
        width: Math.max(0, x1 - x0),
        height: Math.max(0, y1 - y0),
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

    /** Wheel handler — drives page scroll programmatically during drag.
     *  We intentionally do NOT rely on the browser's default wheel → scroll
     *  behavior because:
     *  1. Pages that registered wheel listeners with `passive: false` and
     *     called `preventDefault()` (e.g. maps, scroll-jacking sites) will
     *     eat the scroll entirely — auto-scroll at the viewport edges becomes
     *     the only way to drag past the fold on those pages.
     *  2. The marquee overlay sits at z-index above all page content, so
     *     wheel events would normally be captured before reaching the page
     *     anyway. Calling scrollBy ourselves keeps the behavior identical
     *     across pages, regardless of their wheel handler strategy.
     *  deltaMode 0 = pixels, 1 = lines, 2 = pages. We normalize to pixels
     *  using a sensible default line height (~16px). */
    function onRegionWheel(e: WheelEvent) {
      if (!dragStart) return; // only intercept during drag
      e.preventDefault();
      e.stopImmediatePropagation();
      let dy = e.deltaY;
      let dx = e.deltaX;
      const LINE_PX = 16;
      const PAGE_PX = window.innerHeight * 0.9;
      if (e.deltaMode === 1) { dy *= LINE_PX; dx *= LINE_PX; }
      else if (e.deltaMode === 2) { dy *= PAGE_PX; dx *= PAGE_PX; }
      if (dx !== 0 || dy !== 0) {
        window.scrollBy(dx, dy);
        // Update marquee to reflect the new viewport position.
        if (lastCursor) {
          dragEnd = { x: lastCursor.x + window.scrollX, y: lastCursor.y + window.scrollY };
        }
        renderRegionBox();
      }
    }

    // Region mode uses mousedown/move/up instead of click. The overlay still
    // absorbs the events so page-level handlers don't see them.
    //
    // Wheel events: during an active drag we drive scroll programmatically
    // (onRegionWheel) so the user can extend the selection past the fold
    // even on pages that block native scroll. Outside a drag, wheel passes
    // through naturally (no listener attached) so the user can scroll freely
    // before starting a selection.
    overlay.addEventListener('mousedown', onRegionMouseDown);
    overlay.addEventListener('mousemove', onRegionMouseMove);
    overlay.addEventListener('mouseup', onRegionMouseUp);
    overlay.addEventListener('wheel', onRegionWheel, { passive: false });
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
    try { document.documentElement.style.removeProperty('cursor'); } catch { /* detached */ }
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
          // Region mode：通过 scroll-and-stitch 抓取文档坐标系下的矩形。
          // picker 内部用 document 坐标记录 rect（跨滚轮不漂），但
          // `chrome.tabs.captureVisibleTab` 只能拍当前视口——拖到折叠线以下的部分
          // 会被裁掉。之前试过 CDP `Page.captureScreenshot` + `captureBeyondViewport: true`
          // + `clip`，但 Chrome 会把超出 `scrollHeight` 的区域用当前视口内容
          // 重复填充——矮页面的高截图会把页头叠两三次。scroll-and-stitch 完全
          // 绕开这个坑：始终拍视口，再在 offscreen 里把 viewport-sized 的
          // 条按顺序纵向粘起来。
          //
          // 流程：
          // 1. 从 tab 探测 viewport 尺寸 + DPR。
          // 2. 记住当前 scroll。
          // 3. 对 rect 的每个 viewport-sized 条：滚到该条的文档 y、
          //    等布局稳定、拍当前视口、裁出该条里 rect 可见的那部分。
          // 4. 通过 `composite-vertical` 在 offscreen 里把条纵向粘起来。
          // 5. 还原原始 scroll。
          const cssRect = msg.rect as { x: number; y: number; width: number; height: number };
          cleanup();
          void (async () => {
            try {
              const probe = await executeInTabWithArgs<[], { viewportWidth: number; viewportHeight: number; dpr: number; scrollX: number; scrollY: number }>(
                tabId,
                () => ({
                  viewportWidth: window.innerWidth,
                  viewportHeight: window.innerHeight,
                  dpr: window.devicePixelRatio ?? 1,
                  scrollX: window.scrollX,
                  scrollY: window.scrollY,
                }),
                [],
              );
              const viewportHeight = Math.max(1, Math.round(probe.viewportHeight));
              const dpr = probe.dpr;

              // 进入循环前先把 offscreen 文档拉起来。`crop-image`（每条一次）
              // 和 `composite-vertical`（末尾一次）都在那边处理；
              // `chrome.runtime.sendMessage` 在没监听器时会静默 resolve 成
              // `undefined`——而新会话里如果之前没跑过 `screenshot` /
              // `read-page`，offscreen 还没建过，第一次 region pick 就会撞上
              // 这条路径，`cropResp.error` 抛出
              // "Cannot read properties of undefined (reading 'error')"。
              await ensureOffscreen();

              // 滚动-拼接：每个条从顶向下抓一个 viewport 高度的切片，
              // 不重叠、不留缝（页面按精确的 CSS px 滚动，渲染器会照办）。
              //
              // 水平 scroll 在整个循环里钉死在 `origScrollX`。最早的做法是
              // 横向 `scrollTo(cssRect.x, y)`，但多数页面无法横向滚动——
              // `scrollTo` 会被静默 clamp、`scrollX` 保持原值，但裁切仍用
              // `x=0`，结果拖到视口右侧却截到左侧。把 `scrollX` 锁住、
              // 每条按 rect↔viewport 交集来裁，简单又鲁棒——
              // **前提**是 rect 横向能塞进视口。如果页面能横向滚动且
              // rect 比 viewport 还宽，超出 `origScrollX + viewportWidth`
              // 那段就抓不到（绝大多数页面横向不滚动，所以这条是
              // 已知的、暂时接受的小限制）。
              const strips: { base64: string }[] = [];
              const viewportWidth = Math.max(1, Math.round(probe.viewportWidth));
              const origScrollX = probe.scrollX;
              const origScrollY = probe.scrollY;
              try {
                // Chrome 对同一 tab 的 `chrome.tabs.captureVisibleTab`
                // 限速 2 次/秒（MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND）。
                // scroll-and-stitch 每条 strip 调一次，3+ 条的高 rect
                // 不节流就会撞 quota，Chrome 抛
                // "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."
                // 上一条距今不到 550ms 就等到满再拍。
                const CAPTURE_MIN_INTERVAL_MS = 550;
                let lastCaptureAt = 0;
                let y = cssRect.y;
                while (y < cssRect.y + cssRect.height) {
                  // 节流：上一条 capture 距今不足 550ms 就等到满再往下走。
                  // 第一条 lastCaptureAt=0，跳过。
                  if (lastCaptureAt > 0) {
                    const elapsed = Date.now() - lastCaptureAt;
                    if (elapsed < CAPTURE_MIN_INTERVAL_MS) {
                      await new Promise<void>((r) => setTimeout(r, CAPTURE_MIN_INTERVAL_MS - elapsed));
                    }
                  }
                  const remaining = cssRect.y + cssRect.height - y;
                  const stripHeight = Math.min(viewportHeight, remaining);
                  // 只滚竖向。横向保持在用户松手时的 scrollX，rect 在
                  // viewport 里的左缘从那里算起。
                  await executeInTabWithArgs<[number, number], void>(
                    tabId,
                    (sx, sy) => window.scrollTo(sx, sy),
                    [origScrollX, Math.max(0, y)],
                  );
                  // 等一帧 + 一个小的 idle 窗口让布局稳定（sticky header、
                  // 懒加载图、scroll snap）。
                  await new Promise<void>((r) => requestAnimationFrame(() => r()));
                  await new Promise<void>((r) => setTimeout(r, 40));

                  // `chrome.tabs.captureVisibleTab` 的第一个参数是 `windowId`、
                  // 不是 `tabId`——传 tabId 进去 Chrome 去找一个不存在的 window，
                  // 每次都静默失败。picker 在用户当前 active tab 里，松手时
                  // 也在 active tab，省掉第一个参数就直接拍到正确 viewport。
                  // 万一从 mouseup 到这条消息到达扩展侧之间用户切了 tab，
                  // `screenshot.ts` 的 activate-target-tab 模式可以兜底——
                  // 当前常见的「picker 仍在前台」场景用不上。
                  const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 85 });
                  const fullBase64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
                  lastCaptureAt = Date.now();

                  // 按本条的 rect↔viewport 交集裁。捕获出来的图像锚定在
                  // 文档坐标 (origScrollX, y)，尺寸 viewportWidth × stripHeight
                  // （CSS px），发给 offscreen 的 crop-image 要 IMAGE px，
                  // 所以乘 DPR。`Math.max(0, ...)` / `Math.max(1, ...)` 是
                  // 浮点噪声 + 未来重构的安全网，按构造实际上不可达。
                  const ix0 = Math.max(cssRect.x, origScrollX);
                  const ix1 = Math.min(cssRect.x + cssRect.width, origScrollX + viewportWidth);
                  const cropWidthCss = Math.max(0, ix1 - ix0);
                  if (cropWidthCss <= 0) {
                    // 本条 rect 横向不与 viewport 相交（`scrollX` 锁住后
                    // 实际不应发生，保守兜底，避免发一个 0 宽的 crop）。
                    y += stripHeight;
                    continue;
                  }
                  const cropResp = (await chrome.runtime.sendMessage({
                    type: 'crop-image',
                    imageData: fullBase64,
                    crop: {
                      x: Math.max(0, Math.round((ix0 - origScrollX) * dpr)),
                      y: 0,
                      width: Math.max(1, Math.round(cropWidthCss * dpr)),
                      height: Math.max(1, Math.round(stripHeight * dpr)),
                    },
                  })) as OffscreenCropResponse | undefined;
                  if (!cropResp) throw new Error('crop-image: no response from offscreen (document missing or shutting down)');
                  if (cropResp.error) throw new Error(`Crop failed: ${cropResp.error}`);
                  if (!cropResp.result) throw new Error('crop-image: offscreen returned an empty image');
                  strips.push({ base64: cropResp.result });

                  y += stripHeight;
                }
              } finally {
                // 不论成功失败都要还原原始 scroll（tab 可能已经导航走了，catch 一下）。
                await executeInTabWithArgs<[number, number], void>(
                  tabId,
                  (sx, sy) => window.scrollTo(sx, sy),
                  [origScrollX, origScrollY],
                ).catch(() => { /* tab may have navigated away */ });
              }

              if (strips.length === 0) {
                throw new Error('No strips produced for region capture');
              }

              // 单条时直接用，跳过 composite；多条才走 offscreen 的纵向 stacker。
              const finalBase64 = strips.length === 1
                ? strips[0].base64
                : (await (async () => {
                    const resp = (await chrome.runtime.sendMessage({
                      type: 'composite-vertical',
                      chunks: strips,
                      mimeType: 'image/jpeg',
                    })) as OffscreenCropResponse | undefined;
                    if (!resp) throw new Error('composite-vertical: no response from offscreen (document missing or shutting down)');
                    if (resp.error) throw new Error(`Composite failed: ${resp.error}`);
                    if (!resp.result) throw new Error('composite-vertical: offscreen returned an empty image');
                    return resp.result;
                  })());

              resolve({
                status: 'ok',
                attachment: {
                  type: 'image',
                  source: 'region-select',
                  data: finalBase64,
                  mimeType: 'image/jpeg',
                },
              });
            } catch (err) {
              console.error('[Region Picker] capture failed:', err);
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
