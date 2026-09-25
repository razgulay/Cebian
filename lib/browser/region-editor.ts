// Region annotation editor——in-page 浮动窗口（content-script isolated world）。
// 裁剪捕获完成后不再把图直接塞进 chat，而是先弹这个窗口：用户在图上做
// 标注，然后决定图的去向——
//   ✓ → `cebian:picker-region-annotated` → sidepanel 把标注后的 PNG 作为
//       ImageAttachment 塞进 chat 输入框（Copilot 式流程）
//   Copy → 两层合成 PNG 写入系统剪贴板，然后走 `cebian:picker-cancel`
//       收尾（quiet cancel）——图不进 chat，用户去任意地方粘贴
//   ✕ / Esc → `cebian:picker-cancel` → sidepanel 视为用户取消
//
// 标注模型：stroke-list——每个动作（画笔 / 橡皮擦 / 文字）是一条记录，
// annotation canvas 由列表全量重绘。撤销 = pop；橡皮擦 = destination-out
// 的笔画（只擦标注层，不伤底图）。两层 canvas：base（捕获图）+ anno
// （标注层），✓ 导出时纵向叠合成一张 PNG。
//
// 与 createPickerInPage 同一约束：chrome.scripting.executeScript 只序列化
// 函数体——必须完全自包含，禁止闭包外层变量；样式 / 图标 / 状态全部在
// 函数内定义，i18n 文案经 args 传入。底图数据以 base64 传入（JPEG
// quality 85 一般几百 KB，args 序列化无压力）。

/** Region 标注编辑器 in-page 入口。
 *  - `imageBase64` / `mimeType`：stitch 完成后的底图（无 data: 前缀）
 *  - `rect`：裁剪 rect（document 坐标 CSS px），用于锚定窗口位置 + 推算 DPR
 *  - `labels`：按钮 tooltip 的 i18n 文案 */
export function createRegionEditorInPage(
  imageBase64: string,
  mimeType: string,
  rect: { x: number; y: number; width: number; height: number },
  labels: {
    insertToChat: string;
    cancel: string;
    draw: string;
    text: string;
    erase: string;
    undo: string;
    copy: string;
  },
) {
  // 防双注入：cleanup 钩子幂等，重复调用无害，但重复 DOM 会叠窗口。
  if (document.getElementById('cebian-editor-host')) return;

  // ── 布局计算 ──
  // 图按 CSS 尺寸展示：超出视口则等比缩小；窗口优先锚定在裁剪 rect
  // 下方 10px（Copilot 同款），放不下（贴视口底）就换到 rect 上方，
  // 最终 clamp 在视口内。min-width 保住工具栏不溢出（图很小时）。
  const MARGIN = 8;
  const TOOLBAR_H = 36;
  const maxW = window.innerWidth - MARGIN * 2;
  const maxH = window.innerHeight - MARGIN * 2 - TOOLBAR_H;
  const fit = Math.min(1, maxW / Math.max(1, rect.width), maxH / Math.max(1, rect.height));
  const dispW = Math.max(64, Math.round(rect.width * fit));
  const dispH = Math.max(48, Math.round(rect.height * fit));
  // 1px border × 2；窄图时保工具栏宽度。
  const winW = Math.max(dispW + 2, 320);
  const winH = dispH + TOOLBAR_H + 2;
  let vx = rect.x - window.scrollX + rect.width / 2 - winW / 2;
  let vy = rect.y - window.scrollY + rect.height + 10;
  if (vy + winH > window.innerHeight - MARGIN) {
    vy = rect.y - window.scrollY - winH - 10;
  }
  vx = Math.min(Math.max(vx, MARGIN), Math.max(MARGIN, window.innerWidth - winW - MARGIN));
  vy = Math.min(Math.max(vy, MARGIN), Math.max(MARGIN, window.innerHeight - winH - MARGIN));

  // ── Shadow DOM host ──
  // 与 picker host 同款：fixed、最高 z-index、all:initial 隔离页面样式。
  const host = document.createElement('div');
  host.id = 'cebian-editor-host';
  host.style.cssText =
    'all:initial !important;position:fixed !important;' +
    'left:0 !important;top:0 !important;width:0 !important;height:0 !important;' +
    'z-index:2147483647 !important;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .window {
      position: fixed;
      left: ${vx}px;
      top: ${vy}px;
      min-width: ${winW}px;
      background: #1c1d25;
      border: 1px solid rgba(232, 164, 58, 0.4);
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      height: ${TOOLBAR_H - 8}px;
      padding: 4px 6px;
      background: #1c1d25;
    }
    .spacer { flex: 1; }
    .btn {
      all: initial;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      cursor: pointer;
      color: #e8e4df;
      box-sizing: border-box;
    }
    .btn:hover { background: rgba(232, 164, 58, 0.15); }
    .btn.active { background: rgba(232, 164, 58, 0.3); color: #e8a43a; }
    .btn.primary { color: #e8a43a; }
    .btn.primary:hover { background: rgba(232, 164, 58, 0.25); }
    .btn.pending { opacity: 0.4; pointer-events: none; }
    .btn svg { width: 16px; height: 16px; display: block; }
    .swatches { display: flex; align-items: center; gap: 4px; padding: 0 4px; }
    .swatch {
      all: initial;
      display: block;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, 0.35);
      cursor: pointer;
    }
    .swatch.active { outline: 2px solid #e8a43a; outline-offset: 1px; }
    .canvas-wrap { position: relative; line-height: 0; background: #111; }
    .canvas-base { display: block; width: ${dispW}px; height: ${dispH}px; }
    .canvas-anno {
      position: absolute;
      left: 0;
      top: 0;
      width: ${dispW}px;
      height: ${dispH}px;
      touch-action: none;
    }
    .text-input {
      position: absolute;
      min-width: 40px;
      background: transparent;
      border: 1px dashed rgba(232, 164, 58, 0.7);
      outline: none;
      resize: none;
      overflow: hidden;
      padding: 0;
      margin: 0;
      line-height: 1.35;
      font-family: system-ui, 'Segoe UI', sans-serif;
      white-space: pre;
    }
  `;
  shadow.appendChild(style);

  const win = document.createElement('div');
  win.className = 'window';
  shadow.appendChild(win);

  // 屏蔽原生右键菜单：菜单里的「复制图片」拿到的永远是视口最上层的
  // canvas——即透明的标注层，粘贴出来是空白图（用户实测踩坑）。复制
  // 一律走工具栏 Copy 按钮（合成两层后的 PNG）。
  win.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  });

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  win.appendChild(toolbar);

  // lucide 24×24 path（与 picker cursor 同源，保持视觉一致）。
  const CHECK_SVG = '<polyline points="20 6 9 17 4 12"/>';
  const X_SVG = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';
  const PENCIL_SVG =
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>';
  const TYPE_SVG =
    '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>';
  const ERASER_SVG =
    '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>';
  const UNDO_SVG =
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>';
  const COPY_SVG =
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';

  function mkButton(svg: string, title: string, onClick: () => void): HTMLElement {
    const b = document.createElement('div');
    b.className = 'btn';
    b.setAttribute('role', 'button');
    b.title = title;
    b.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round">' + svg + '</svg>';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      onClick();
    });
    return b;
  }

  // ── 编辑状态 ──
  type Stroke =
    | { kind: 'stroke'; mode: 'draw' | 'erase'; color: string; size: number; points: { x: number; y: number }[] }
    | { kind: 'text'; color: string; x: number; y: number; text: string; size: number };
  type Tool = 'draw' | 'erase' | 'text';
  const COLORS = ['#ff3b30', '#ffcc00', '#3478f6', '#ffffff'];
  let tool: Tool = 'draw';
  let color = COLORS[0];
  const strokes: Stroke[] = [];
  // 底图解码后按 naturalWidth/rect.width 推算。
  let imgDpr = 1;
  let drawW = 3;
  let eraseW = 16;
  let textSize = 16;

  // ── 双层 canvas ──
  const wrap = document.createElement('div');
  wrap.className = 'canvas-wrap';
  win.appendChild(wrap);

  const canvas = document.createElement('canvas');
  canvas.className = 'canvas-base';
  wrap.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const anno = document.createElement('canvas');
  anno.className = 'canvas-anno';
  wrap.appendChild(anno);
  const annoCtx = anno.getContext('2d');

  /** 注释坐标 → 图像像素坐标（anno 内部分辨率 = 图像原始像素）。 */
  function evToImage(e: PointerEvent): { x: number; y: number } {
    const r = anno.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (anno.width / r.width),
      y: (e.clientY - r.top) * (anno.height / r.height),
    };
  }

  /** 增量画一段（pointermove 高频路径，避免全量重绘）。 */
  function drawSegment(stroke: Extract<Stroke, { kind: 'stroke' }>, from: { x: number; y: number } | null, to: { x: number; y: number }) {
    if (!annoCtx) return;
    annoCtx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over';
    annoCtx.strokeStyle = stroke.mode === 'erase' ? '#000' : stroke.color;
    annoCtx.lineWidth = stroke.size;
    annoCtx.lineCap = 'round';
    annoCtx.lineJoin = 'round';
    if (!from) {
      // 单点：round cap 的实心圆，落笔即有痕迹。
      annoCtx.fillStyle = stroke.mode === 'erase' ? '#000' : stroke.color;
      annoCtx.beginPath();
      annoCtx.arc(to.x, to.y, stroke.size / 2, 0, Math.PI * 2);
      annoCtx.fill();
      // 复位 composite op——别让 erase dot 留下 destination-out。
      annoCtx.globalCompositeOperation = 'source-over';
      return;
    }
    annoCtx.beginPath();
    annoCtx.moveTo(from.x, from.y);
    annoCtx.lineTo(to.x, to.y);
    annoCtx.stroke();
    annoCtx.globalCompositeOperation = 'source-over';
  }

  /** 全量重绘标注层（undo / commit text 后调用）。 */
  function renderAnno() {
    if (!annoCtx) return;
    annoCtx.clearRect(0, 0, anno.width, anno.height);
    for (const s of strokes) {
      if (s.kind === 'stroke') {
        annoCtx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
        annoCtx.strokeStyle = s.mode === 'erase' ? '#000' : s.color;
        annoCtx.lineWidth = s.size;
        annoCtx.lineCap = 'round';
        annoCtx.lineJoin = 'round';
        annoCtx.beginPath();
        s.points.forEach((p, i) => (i === 0 ? annoCtx!.moveTo(p.x, p.y) : annoCtx!.lineTo(p.x, p.y)));
        annoCtx.stroke();
        annoCtx.globalCompositeOperation = 'source-over';
      } else {
        annoCtx.globalCompositeOperation = 'source-over';
        annoCtx.fillStyle = s.color;
        annoCtx.font = `${s.size}px system-ui, 'Segoe UI', sans-serif`;
        annoCtx.textBaseline = 'top';
        const lines = s.text.split('\n');
        const lh = s.size * 1.35;
        lines.forEach((ln, i) => annoCtx!.fillText(ln, s.x, s.y + i * lh));
      }
    }
  }

  // ── 文字放置 ──
  // 点击画布出现 textarea（CSS px 定位在 wrap 里），Enter 提交、
  // Shift+Enter 换行、Esc 丢弃、blur 提交。提交时把 CSS 坐标换算回
  // 图像像素写入 strokes。
  let textEditor: HTMLTextAreaElement | null = null;

  function openTextEditor(p: { x: number; y: number }) {
    commitTextEditor();
    const ta = document.createElement('textarea');
    ta.className = 'text-input';
    ta.rows = 1;
    ta.spellcheck = false;
    ta.style.left = (p.x / anno.width * dispW) + 'px';
    ta.style.top = (p.y / anno.height * dispH) + 'px';
    ta.style.color = color;
    // WYSIWYG：画布显示被 fit 缩放过，textarea 预览字号乘回 fit 才和
    // 提交后在画布上看到的（textSize × fit / imgDpr CSS px）一致。
    ta.style.fontSize = (textSize / imgDpr) * fit + 'px';
    ta.addEventListener('keydown', (e) => {
      e.stopImmediatePropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitTextEditor();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        textEditor = null;
        ta.remove();
      }
    });
    ta.addEventListener('blur', () => commitTextEditor());
    wrap.appendChild(ta);
    textEditor = ta;
    ta.focus();
  }

  function commitTextEditor() {
    if (!textEditor) return;
    const ta = textEditor;
    // 先摘引用——remove() 触发的 blur 再进来直接 no-op。
    textEditor = null;
    const text = ta.value.replace(/\s+$/, '');
    const x = parseFloat(ta.style.left) / dispW * anno.width;
    const y = parseFloat(ta.style.top) / dispH * anno.height;
    const c = ta.style.color;
    ta.remove();
    if (text.trim()) {
      strokes.push({ kind: 'text', color: c, x, y, text, size: textSize });
      renderAnno();
    }
  }

  // ── 画笔 / 橡皮擦指针流 ──
  let activeStroke: Extract<Stroke, { kind: 'stroke' }> | null = null;

  anno.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !anno.width) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    commitTextEditor();
    const p = evToImage(e);
    if (tool === 'text') {
      openTextEditor(p);
      return;
    }
    activeStroke = {
      kind: 'stroke',
      mode: tool === 'erase' ? 'erase' : 'draw',
      color,
      size: tool === 'erase' ? eraseW : drawW,
      points: [p],
    };
    strokes.push(activeStroke);
    try { anno.setPointerCapture(e.pointerId); } catch { /* detached */ }
    drawSegment(activeStroke, null, p);
  });
  anno.addEventListener('pointermove', (e) => {
    if (!activeStroke) return;
    e.preventDefault();
    const p = evToImage(e);
    const last = activeStroke.points[activeStroke.points.length - 1];
    activeStroke.points.push(p);
    drawSegment(activeStroke, last, p);
  });
  const endStroke = () => { activeStroke = null; };
  anno.addEventListener('pointerup', endStroke);
  anno.addEventListener('pointercancel', endStroke);

  function undo() {
    commitTextEditor();
    if (!strokes.length) return;
    strokes.pop();
    renderAnno();
  }

  // ── 工具栏 ──
  function setTool(next: Tool) {
    tool = next;
    commitTextEditor();
    for (const [btn, t2] of [[drawBtn, 'draw'], [textBtn, 'text'], [eraseBtn, 'erase']] as const) {
      btn.classList.toggle('active', t2 === next);
    }
    anno.style.cursor = next === 'text' ? 'text' : 'crosshair';
  }

  const drawBtn = mkButton(PENCIL_SVG, labels.draw, () => setTool('draw'));
  const textBtn = mkButton(TYPE_SVG, labels.text, () => setTool('text'));
  const eraseBtn = mkButton(ERASER_SVG, labels.erase, () => setTool('erase'));
  const undoBtn = mkButton(UNDO_SVG, labels.undo, () => undo());
  toolbar.appendChild(drawBtn);
  toolbar.appendChild(textBtn);
  toolbar.appendChild(eraseBtn);

  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  const swatchEls = COLORS.map((c) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (c === color ? ' active' : '');
    sw.style.background = c;
    sw.title = c;
    sw.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      color = c;
      for (const [el, cc] of swatchEls.map((el, i) => [el, COLORS[i]] as const)) {
        el.classList.toggle('active', cc === c);
      }
    });
    swatches.appendChild(sw);
    return sw;
  });
  toolbar.appendChild(swatches);
  toolbar.appendChild(undoBtn);
  const copyBtn = mkButton(COPY_SVG, labels.copy, () => { void copyToClipboard(); });
  // 与 ✓ 同款 pending 门：底图没解码完点 Copy 会把空白 canvas 写进剪贴板
  // 且白白丢掉这次裁剪（canvas 默认 300×150，`!canvas.width` 拦不住）。
  copyBtn.classList.add('pending');
  toolbar.appendChild(copyBtn);

  const spacer = document.createElement('div');
  spacer.className = 'spacer';
  toolbar.appendChild(spacer);

  const insertBtn = mkButton(CHECK_SVG, labels.insertToChat, () => insertToChat());
  insertBtn.classList.add('primary');
  // 底图未解码完就点 ✓ 会导出空 canvas——onload 后才放行。
  insertBtn.classList.add('pending');
  toolbar.appendChild(insertBtn);

  const cancelBtn = mkButton(X_SVG, labels.cancel, () => cancelEditor());
  toolbar.appendChild(cancelBtn);

  setTool('draw');

  // ── 底图 ──
  // 内部分辨率 = 图像原始像素（stitch 时已按 DPR 缩放过），显示尺寸 =
  // 上面的 dispW/H。data: URL 不污染 canvas，toDataURL 可直接导出。
  const img = new Image();
  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    anno.width = img.naturalWidth;
    anno.height = img.naturalHeight;
    ctx?.drawImage(img, 0, 0);
    // 线宽 / 字号按图像 px 定标：3 / 16 / 16 个 CSS px 等效值 × 实际 DPR。
    imgDpr = Math.max(1, img.naturalWidth / Math.max(1, rect.width));
    drawW = Math.max(2, Math.round(3 * imgDpr));
    eraseW = Math.max(8, Math.round(16 * imgDpr));
    textSize = Math.max(12, Math.round(16 * imgDpr));
    insertBtn.classList.remove('pending');
    copyBtn.classList.remove('pending');
  };
  // 解码失败（理论不可达——图刚由 offscreen canvas 产出）不能把 ✓ 永久
  // 卡在 pending：自动走取消路径，用户至少拿回一个可用的 composer。
  img.onerror = () => cancelEditor();
  img.src = `data:${mimeType};base64,${imageBase64}`;

  // ── 导出：底图 + 标注层纵向叠合成 PNG ──
  function exportPng(): string {
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const octx = out.getContext('2d');
    octx?.drawImage(canvas, 0, 0);
    octx?.drawImage(anno, 0, 0);
    return out.toDataURL('image/png');
  }

  // ── 去向决策 ──
  function insertToChat() {
    if (!canvas.width) return;
    commitTextEditor();
    const dataUrl = exportPng();
    chrome.runtime.sendMessage({
      type: 'cebian:picker-region-annotated',
      base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
      mimeType: 'image/png',
    });
    cleanupEditor();
  }

  // Copy：合成 PNG 写系统剪贴板后关闭编辑器，图不进 chat——去任意
  // 应用 / 聊天框粘贴。按钮 click 自带 user gesture + 页面聚焦，
  // navigator.clipboard.write 在 content-script isolated world 可用。
  async function copyToClipboard() {
    if (!canvas.width) return;
    commitTextEditor();
    const dataUrl = exportPng();
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      // 复制成功 = 编辑器使命完成：走既有 cancel 通道收尾（quiet cancel，
      // composer 状态正常复位，图不进 chat）。
      chrome.runtime.sendMessage({ type: 'cebian:picker-cancel' });
      cleanupEditor();
    } catch (err) {
      // 剪贴板失败（罕见：页面失焦 / 权限被策略挡）——不静默吞图：保留
      // 编辑器让用户重试或改点 ✓，错误留在 console。
      console.error('[Region Editor] clipboard write failed:', err);
    }
  }

  function cancelEditor() {
    chrome.runtime.sendMessage({ type: 'cebian:picker-cancel' });
    cleanupEditor();
  }

  // ── 键盘：Esc = 丢弃文字编辑，否则取消整个编辑器；Ctrl/Cmd+Z = 撤销 ──
  // window capture 先于 textarea 自己的 handler 触发——文字编辑激活时
  // 必须放行给 textarea（它自己的 keydown 会 commit / discard）。
  function onKeyDown(e: KeyboardEvent) {
    if (textEditor) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelEditor();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopImmediatePropagation();
      undo();
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  function cleanupEditor() {
    try { delete (window as any).__cebianEditorCleanup; } catch { /* non-configurable */ }
    window.removeEventListener('keydown', onKeyDown, true);
    try { host.remove(); } catch { /* detached */ }
  }

  // 扩展侧外部取消（再按一次 composer 按钮 / 切 tab / 页面导航）经由
  // 这个钩子拆除编辑器；见 startElementPicker 的 currentCleanup。
  (window as any).__cebianEditorCleanup = cleanupEditor;
}
