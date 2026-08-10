// Cebian Dev Picker — internal dev-only UI feedback tool.
//
// Hold Alt + hover an element to outline it; Alt+click to open a tiny prompt
// popup. Type what you want changed, hit Cmd/Ctrl+Enter (or click Copy), and
// a formatted markdown blob with selector + HTML + React component name +
// source location is written to your clipboard — ready to paste into Claude
// Code / Cursor / Windsurf as a precise edit request.
//
// Mounted only from dev builds (`import.meta.env.DEV`); production bundles
// don't import this file (tree-shaken by the `if (DEV)` guard at call sites).
//
// Design notes:
// - Lives outside React's render tree: listeners attach to `window`/`document`,
//   highlight + modal are plain DOM nodes, so React 19 StrictMode double-mount
//   is harmless. `installDevPicker` is idempotent — second call no-ops.
// - Highlight is a single `outline` mutation, restored on next hover or on
//   uninstall, so it never leaks state into the React tree.
// - React Fiber walk is best-effort: dev build only (production strips Fiber
//   internals), and `_debugSource` is only present when source maps loaded.
//   Falls back to a "?" marker rather than throwing.
// - Modal is a single root `<div id="cebian-dev-modal">`; replace-not-stack
//   so two clicks in a row never accumulate state.

interface ReactFiber {
  type?: unknown;
  _debugSource?: { fileName: string; lineNumber: number; columnNumber: number };
  return?: ReactFiber | null;
  child?: ReactFiber | null;
  sibling?: ReactFiber | null;
  stateNode?: unknown;
}

function isReactFiber(value: unknown): value is ReactFiber {
  return typeof value === 'object' && value !== null;
}

function findReactFiber(el: HTMLElement): ReactFiber | null {
  // React 19 attaches `__reactFiber$<random>` to every host element.
  // Walk the element's own keys once and pick the first fiber-like value.
  for (const key of Object.keys(el) as Array<keyof HTMLElement>) {
    const name = String(key);
    if (!name.startsWith('__reactFiber$')) continue;
    const fiber = (el as unknown as Record<string, unknown>)[name];
    if (isReactFiber(fiber)) return fiber;
  }
  return null;
}

/** Walk up the fiber tree until we hit a node whose `type` is a function
 *  component (named function or `forwardRef` / `memo` wrapper). Host nodes
 *  (DOM elements) have `type` as a string like `'div'`, which we skip. */
function findOwnerComponent(fiber: ReactFiber | null): ReactFiber | null {
  let current = fiber;
  let hops = 0;
  // Cap at 50 hops — depth-bounded in case of accidental cycles (paranoid;
  // React trees are always finite + acyclic, but cap keeps a bug from
  // hanging the picker).
  while (current && hops < 50) {
    hops++;
    const t = current.type;
    if (typeof t === 'function') {
      return current;
    }
    if (typeof t === 'object' && t !== null && '$$typeof' in t) {
      // forwardRef / memo wrapper — the actual component is one level deeper
      // (`type.render` for forwardRef, `type.type` for memo). But its name
      // and debug source are usually on the wrapper itself, so return here.
      return current;
    }
    current = current.return ?? null;
  }
  return null;
}

function componentName(fiber: ReactFiber): string {
  const t = fiber.type as { displayName?: string; name?: string; type?: { name?: string } } | undefined;
  if (!t) return '?';
  return t.displayName ?? t.name ?? t.type?.name ?? 'Anonymous';
}

function sourceLocation(fiber: ReactFiber): string | null {
  const src = fiber._debugSource;
  if (!src || !src.fileName) return null;
  // Strip absolute prefix; keep last 3 path segments so the prompt reads well.
  const parts = src.fileName.replace(/\\/g, '/').split('/');
  const short = parts.slice(Math.max(0, parts.length - 3)).join('/');
  return `${short}:${src.lineNumber}:${src.columnNumber}`;
}

// ─── Unique selector ────────────────────────────────────────────────────────

/**
 * Build a CSS selector targeting exactly `el`. Prefer stable hooks first:
 * data-component / data-testid (Cebian already uses `data-user-message`,
 * `data-component`, etc.) > id > nth-child path. Falls back to a structural
 * selector that may not survive re-renders but is always non-empty.
 */
export function getUniqueSelector(el: HTMLElement): string {
  const root = el.getRootNode();
  if (root !== document) {
    // Inside a shadow root or iframe — selectors won't reach. Tag-only with a
    // note so the human operator knows to disambiguate manually.
    return `${el.tagName.toLowerCase()} (outside main document)`;
  }

  const dataHook = el.getAttribute('data-component') ?? el.getAttribute('data-testid');
  if (dataHook) return `${el.tagName.toLowerCase()}[data-component="${dataHook}"], ${el.tagName.toLowerCase()}[data-testid="${dataHook}"]`;

  if (el.id) return `#${el.id}`;

  const segments: string[] = [];
  let current: HTMLElement | null = el;
  let depth = 0;
  while (current && current !== document.body && depth < 6) {
    let segment = current.tagName.toLowerCase();
    const parent: HTMLElement | null = current.parentElement;
    if (parent) {
      const siblingTag = current.tagName;
      const sameTag = Array.from(parent.children).filter(
        (c: Element) => c.tagName === siblingTag,
      );
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(current) + 1;
        segment += `:nth-of-type(${idx})`;
      }
    }
    segments.unshift(segment);
    current = parent;
    depth++;
  }
  return segments.join(' > ');
}

// ─── Install / uninstall ────────────────────────────────────────────────────

const MODAL_ID = 'cebian-dev-modal';
const PICKER_MARK = 'data-cebian-dev-picker-installed';
/** Per-element marker so clearHover() can tell which outline was set by us
 *  (to revert) vs already on the element (to leave alone). Without this,
 *  re-hovering the same element before mousemove fired a clear would snapshot
 *  our own dashed outline as "original" and never restore the real value. */
const MARK = 'data-cebian-dev-highlighted';

let installed = false;
let cleanup: (() => void) | null = null;

export function installDevPicker(): void {
  if (installed) return;
  installed = true;

  let hovered: HTMLElement | null = null;
  // 保存 element 被 picker 高亮**之前**的真实 inline outline（不是上一次 picker
  // 设置的虚线——否则 clear 后会把虚线当 original 保留下来，污染 React 树）。
  // 用 `MARK` 属性标记哪些 outline 是 picker 自己设的；snapshot 时跳过带标记的。
  let hoveredOriginalOutline: string | null = null;
  let hoveredOriginalOffset: string | null = null;
  let modalEl: HTMLDivElement | null = null;

  function clearHover(): void {
    if (hovered) {
      // 只在 outline 仍是 picker 设置的虚线时才还原——防止 clear 期间 picker 又
      // 重写到自己头上的 outline。带 MARK 的 = picker 写的；不带 = 用户的。
      if (hovered.getAttribute(MARK) === '1') {
        hovered.style.outline = hoveredOriginalOutline ?? '';
        hovered.style.outlineOffset = hoveredOriginalOffset ?? '';
        hovered.removeAttribute(MARK);
      }
    }
    hovered = null;
    hoveredOriginalOutline = null;
    hoveredOriginalOffset = null;
  }

  function applyHover(target: HTMLElement): void {
    if (hovered === target) return;
    clearHover();
    // 如果 target 之前已经带 picker outline（例如从子元素 hover 到父元素，中
    // 间 mousemove 触发多次 applyHover），把它的 outline 当作"上一次 picker
    // 设的"——也就是说，原始 outline 已经被前一次 clearHover 还原了，现在
    // 看到的是 stale value。读 inline style 前先剥掉 MARK。
    const wasPickerOwned = target.getAttribute(MARK) === '1';
    hovered = target;
    if (wasPickerOwned) {
      // 父元素可能未被独立 clear 过；保守读 inline（picker 设置的）当 original。
      // 这种情况极少见（target 是同一元素再次 hover），此时直接当成"清空原值"。
      hoveredOriginalOutline = '';
      hoveredOriginalOffset = '';
    } else {
      hoveredOriginalOutline = target.style.outline;
      hoveredOriginalOffset = target.style.outlineOffset;
    }
    target.style.outline = '2px dashed #3b82f6';
    target.style.outlineOffset = '-1px';
    target.setAttribute(MARK, '1');
  }

  function onMouseMove(e: MouseEvent): void {
    if (modalEl) return; // Modal open — don't fight focus
    if (!e.altKey) {
      clearHover();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (!target || target === document.body || target === document.documentElement) {
      clearHover();
      return;
    }
    // Don't highlight inside our own modal — would fight user selection.
    if (target.closest(`#${MODAL_ID}`)) {
      clearHover();
      return;
    }
    applyHover(target);
  }

  function onMouseLeave(): void {
    if (modalEl) return;
    clearHover();
  }

  function onClick(e: MouseEvent): void {
    if (!e.altKey || !hovered) return;
    e.preventDefault();
    e.stopPropagation();
    const target = hovered;
    showPromptModal(target, e.clientX, e.clientY, () => {
      // On close: clear hover state so the outline doesn't linger.
      clearHover();
    });
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Escape closes modal; releasing Alt clears highlight immediately even
    // if the cursor hasn't moved (mousemove only fires on motion).
    if (e.key === 'Escape' && modalEl) {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key === 'Alt' && modalEl == null) {
      // No-op; outline is updated on mousemove. We only react on release.
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Alt' && modalEl == null) {
      clearHover();
    }
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseleave', onMouseLeave, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);

  function closeModal(): void {
    modalEl?.remove();
    modalEl = null;
  }

  function showPromptModal(target: HTMLElement, x: number, y: number, onClose: () => void): void {
    // Replace any existing modal.
    closeModal();

    const selector = getUniqueSelector(target);
    const htmlSnippet = target.outerHTML.length > 800
      ? target.outerHTML.slice(0, 800) + '\n<!-- …truncated… -->'
      : target.outerHTML;

    const fiber = findReactFiber(target);
    const ownerFiber = findOwnerComponent(fiber);
    const component = ownerFiber ? componentName(ownerFiber) : null;
    const source = ownerFiber ? sourceLocation(ownerFiber) : null;

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.style.cssText = [
      'position: fixed',
      `left: ${Math.max(8, Math.min(x, window.innerWidth - 360))}px`,
      `top: ${Math.max(8, Math.min(y, window.innerHeight - 240))}px`,
      'z-index: 2147483647',
      'width: 340px',
      'padding: 12px',
      'background: #1e1e2e',
      'color: #cdd6f4',
      'border: 1px solid #45475a',
      'border-radius: 8px',
      'box-shadow: 0 12px 32px rgba(0,0,0,0.45)',
      'font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif',
    ].join(';');

    const tag = target.tagName.toLowerCase();
    const cls = typeof target.className === 'string' && target.className
      ? '.' + target.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      : '';

    const infoRows: string[] = [
      `<div style="font-size:11px;color:#89b4fa;font-weight:600;margin-bottom:4px">🎯 &lt;${escapeHtml(tag)}${escapeHtml(cls)}&gt;</div>`,
    ];
    infoRows.push(
      `<div style="font-size:10.5px;color:#a6adc8;margin-bottom:2px"><span style="color:#7f849c">Selector:</span> <code style="color:#f9e2af">${escapeHtml(selector)}</code></div>`,
    );
    if (component) {
      infoRows.push(
        `<div style="font-size:10.5px;color:#a6adc8;margin-bottom:2px"><span style="color:#7f849c">Component:</span> <code style="color:#f9e2af">${escapeHtml(component)}</code></div>`,
      );
    }
    if (source) {
      infoRows.push(
        `<div style="font-size:10.5px;color:#a6adc8;margin-bottom:6px"><span style="color:#7f849c">Source:</span> <code style="color:#f9e2af">${escapeHtml(source)}</code></div>`,
      );
    } else {
      infoRows.push(`<div style="height:4px"></div>`);
    }

    modal.innerHTML = `
      ${infoRows.join('')}
      <textarea
        data-cebian-dev-prompt
        rows="3"
        placeholder="Mô tả chỉnh sửa (VD: 'padding 12px, thêm icon search bên trái')…"
        style="width:100%;box-sizing:border-box;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;padding:6px;font:inherit;outline:none;resize:vertical"
      ></textarea>
      <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px">
        <button data-cebian-dev-cancel style="background:transparent;color:#a6adc8;border:none;padding:4px 8px;cursor:pointer;font:inherit">Huỷ</button>
        <button data-cebian-dev-copy style="background:#89b4fa;color:#11111b;font-weight:600;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font:inherit">Copy Prompt</button>
      </div>
    `;

    document.body.appendChild(modal);
    modalEl = modal;

    const textarea = modal.querySelector<HTMLTextAreaElement>('textarea[data-cebian-dev-prompt]')!;
    textarea.focus();

    function buildPrompt(instruction: string): string {
      const componentLine = component ? `- Component: \`${component}\`` : null;
      const sourceLine = source ? `- Source: \`${source}\`` : null;
      const block = [
        '[UI Edit Request — Cebian]',
        `- Element: \`<${tag}${cls}>\``,
        `- Selector: \`${selector}\``,
        componentLine,
        sourceLine,
        '',
        '- HTML Snippet:',
        '```html',
        htmlSnippet,
        '```',
        '',
        '--- YÊU CẦU CHỈNH SỬA ---',
        instruction,
      ].filter((l) => l !== null) as string[];
      return block.join('\n');
    }

    function doCopy(): void {
      const instruction = textarea.value.trim();
      if (!instruction) {
        textarea.focus();
        textarea.placeholder = 'Cần nhập mô tả trước khi copy…';
        return;
      }
      const prompt = buildPrompt(instruction);
      void copyToClipboard(prompt).then((ok) => {
        if (ok) {
          modal.innerHTML = `<div style="color:#a6e3a1;text-align:center;padding:14px 8px;font-size:12px">✅ Đã copy — paste vào Claude Code / Cursor ngay.</div>`;
          setTimeout(() => {
            closeModal();
            onClose();
          }, 1100);
        } else {
          modal.innerHTML = `<div style="color:#f38ba8;text-align:center;padding:14px 8px;font-size:12px">⚠ Clipboard API bị chặn — copy thủ công:<br><textarea readonly style="margin-top:6px;width:100%;height:90px">${escapeHtml(prompt)}</textarea></div>`;
        }
      });
    }

    modal.querySelector<HTMLButtonElement>('button[data-cebian-dev-copy]')!.addEventListener('click', doCopy);
    modal.querySelector<HTMLButtonElement>('button[data-cebian-dev-cancel]')!.addEventListener('click', () => {
      closeModal();
      onClose();
    });
    textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        doCopy();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        closeModal();
        onClose();
      }
    });
    // Prevent the outer click handler from re-opening the modal if user
    // clicks inside the textarea.
    modal.addEventListener('click', (ev) => ev.stopPropagation());
  }

  cleanup = () => {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseleave', onMouseLeave, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    clearHover();
    modalEl?.remove();
    modalEl = null;
    // HMR safety net: nếu module bị reload giữa chừng (ví dụ đang modal), quét
    // sạch mọi outline picker đã gắn lên DOM mà chưa kịp clear. Không có cost
    // đáng kể (querySelectorAll chỉ trúng tối đa vài phần tử cùng lúc).
    document.querySelectorAll(`[${MARK}="1"]`).forEach((el) => {
      const node = el as HTMLElement;
      node.style.outline = '';
      node.style.outlineOffset = '';
      node.removeAttribute(MARK);
    });
  };
  // Mark on documentElement so a stray second import (e.g. HMR) is a no-op
  // without a console warning.
  document.documentElement.setAttribute(PICKER_MARK, '1');
}

export function uninstallDevPicker(): void {
  cleanup?.();
  cleanup = null;
  installed = false;
  document.documentElement.removeAttribute(PICKER_MARK);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  // Fallback: hidden textarea + execCommand. Extension contexts can run
  // outside a focused document; in those `navigator.clipboard` rejects with
  // NotAllowedError and we still want to surface the prompt.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
