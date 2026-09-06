/**
 * VFS HTML 预览的沙箱代理页——外层 iframe。
 *
 * 为什么需要它：扩展页（vfs.html）的 CSP 是 `script-src 'self'`，srcdoc / blob iframe 都会
 * 继承这条策略，AI 生成的 HTML 里的内联 `<script>` 和 CDN 脚本全部会被拦。本页通过 WXT 的
 * `*.sandbox/` 约定进入 manifest `sandbox.pages`，拥有不透明 origin 与放宽的 sandbox CSP
 * （见 wxt.config.ts），拿不到 `chrome.*` 与扩展存储；用户文件在这里的内层 iframe 中渲染。
 *
 * 与 `mcp-app.sandbox` 的双层 iframe 模式相同，但协议只有两条消息、不做 JSON-RPC 透传：
 *   1. 本页加载完成 → 向宿主发 `{ type: 'vfs-preview-ready' }`；
 *   2. 宿主回 `{ type: 'vfs-preview-render', html }` → 本页创建 / 替换内层 srcdoc iframe。
 * 只接受 `event.source === window.parent` 的消息；内层 iframe 发来的任何消息都不转发。
 */

interface RenderMessage {
  type: 'vfs-preview-render';
  html: string;
}

/** 内层 iframe 的 sandbox 令牌固定不变（与 mcp-app.sandbox 同一组合）。
 *  注意 `allow-same-origin` 在这里并不能放宽任何东西：sandbox 标志沿 frame 树只能收紧——
 *  本页自身已被 manifest 的 sandbox CSP 与宿主 iframe 的 sandbox 属性剥掉 origin，所以内层
 *  拿到的是它自己的一个全新不透明 origin，`localStorage` / `document.cookie` 等存储 API 会抛
 *  SecurityError。保留该令牌只是为了与既有沙箱页保持同一形状。
 *  不给 `allow-top-navigation`，预览内容不能劫持整个标签页；`allow-popups`（不带
 *  `-to-escape-sandbox`）让 `<a target="_blank">` 与下面 `withNewTabLinks` 重写过的链接
 *  都能弹到新标签——新标签继承同样的沙箱限制。 */
const INNER_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups';

let inner: HTMLIFrameElement | null = null;

function render(html: string): void {
  // 每次渲染都换一个新 iframe：srcdoc 重新赋值在部分浏览器上不会重置内层脚本状态。
  inner?.remove();
  inner = document.createElement('iframe');
  inner.setAttribute('sandbox', INNER_SANDBOX);
  // `withNewTabLinks` 把每个 `<a>` 强行开到新标签：`<base target="_blank">` 设默认
  // target，覆盖层脚本再把 `<a target="_self">` / `<a target="_top">` 与无 target
  // 的链接全部改写成 `_blank` + `rel="noopener noreferrer"`。没有这一层，仅靠
  // `allow-popups` 仍会让 `target=_self` 在内层 iframe 内导航（很多外部站点拒被
  // frame，Chrome 会替它显示"This content is blocked"），`target=_top` 则会被
  // `allow-top-navigation` 缺失这一关静默吞掉。
  inner.srcdoc = withNewTabLinks(html);
  document.body.appendChild(inner);
}

/** 把用户 HTML 包进新的 `<!doctype html><html><head><base target="_blank"> +
 *  override <script></head><body>...</body></html>`。两层防御：
 *   1. `<base target="_blank">` 让所有未显式带 `target=` 的 `<a>` 默认开新标签。
 *   2. override 脚本在 DOMContentLoaded 上把所有 `<a[href]>` 的 `target` 改写为
 *      `_blank` 并补 `rel="noopener noreferrer"`，吞掉 `<a target="_self">` /
 *      `<a target="_top">` 这两种会逃出 `<base>` 默认值的链接。
 *  用"包一层"而不是 regex 注入用户既有 `<head>`：用户 HTML 里的 `<!-- <head> 模板
 *  --><head>真</head>` 这种 decoy 会让 regex 错位；HTML parser 会折叠重复的
 *  `<html>` / `<head>` / `<body>`，所以我们的注入永远先于用户内容、与 mcp-app.sandbox
 *  里的 `wrapWithCspDocument` 是同一形状。注入只活在内层 srcdoc 里，VFS 的源文件与
 *  切换"View source"看到的都是未修改的原文。 */
function withNewTabLinks(html: string): string {
  const baseTag = '<base target="_blank">';
  // override 脚本刻意小、无依赖，避免给解析增加成本。`querySelectorAll` 不会扫到作者
  // 脚本随后插入的 `<a>`，但那是作者脚本自己加的链接，已超出"预览不该自导航"的范围。
  const overrideScript =
    '<script>' +
    '(function(){' +
    'var f=function(){' +
    "var a=document.querySelectorAll('a[href]');" +
    'for(var i=0;i<a.length;i++){' +
    "a[i].setAttribute('target','_blank');" +
    "a[i].setAttribute('rel','noopener noreferrer');" +
    '}' +
    '};' +
    "if(document.readyState!=='loading'){f();}" +
    "else{document.addEventListener('DOMContentLoaded',f);}" +
    '})();' +
    '</script>';
  return `<!doctype html><html><head>${baseTag}${overrideScript}</head><body>${html}</body></html>`;
}

function isRenderMessage(data: unknown): data is RenderMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as RenderMessage).type === 'vfs-preview-render' &&
    typeof (data as RenderMessage).html === 'string'
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  // 不透明 origin 下 event.origin 恒为 'null'，无法用于鉴权；event.source 是不可伪造的窗口引用。
  if (event.source !== window.parent) return;
  if (isRenderMessage(event.data)) render(event.data.html);
});

// targetOrigin 只能用 '*'：本页拿不到 chrome.runtime，不知道宿主的 chrome-extension:// origin。
// 宿主侧会校验 event.source 是它自己创建的 iframe，这条 ready 通知本身不携带任何数据。
window.parent.postMessage({ type: 'vfs-preview-ready' }, '*');
