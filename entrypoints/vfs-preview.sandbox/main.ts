/**
 * VFS HTML 预览的沙箱代理页——外层 iframe。
 *
 * 为什么需要它：扩展页（vfs.html）的 CSP 是 `script-src 'self'`，srcdoc / blob iframe 都会
 * 继承这条策略，AI 生成的 HTML 里的内联 `<script>` 和 CDN 脚本全部会被拦。本页通过 WXT 的
 * `*.sandbox/` 约定进入 manifest `sandbox.pages`，拥有不透明 origin 与放宽的 sandbox CSP
 * （见 wxt.config.ts），拿不到 `chrome.*` 与扩展存储；用户文件在这里的内层 iframe 中渲染。
 *
 * 协议（宿主 ↔ 本页 ↔ 内层 iframe）：
 *   1. 本页加载完成 → 向宿主发 `{ type: 'vfs-preview-ready' }`；
 *   2. 宿主回 `{ type: 'vfs-preview-render', html }` → 本页创建 / 替换内层 srcdoc iframe；
 *   3. Canvas Pick Element（面板上的拾取模式）：
 *        - 宿主 → 本页：`{ type: 'canvas-toggle-inspect', enabled }`；本页记住状态并
 *          转发 `{ type: 'canvas-inspect', enabled }` 给内层。状态存本页变量，热更新
 *          换新内层后由 load 事件重放，拾取模式跨渲染不丢。
 *        - 内层 → 本页 → 宿主：`{ type: 'canvas-element-picked', element }`（拾取成功）
 *          或 `{ type: 'canvas-inspect-cancelled' }`（Escape 取消）。这是「内层消息一律
 *          不转发」规则的唯一例外，只认 `event.source === 内层窗口` 且类型在白名单内；
 *          payload 的校验 / 截断在宿主侧 `normalizePick`（lib/canvas/element-inspect.ts）
 *          做，本页只把关来源与类型。
 *
 * 与 `mcp-app.sandbox` 的双层 iframe 模式相同，但 render 协议只有两条消息、不做 JSON-RPC
 * 透传。只接受 `event.source === window.parent` 的宿主消息。
 */

import {
  CANVAS_TOGGLE_INSPECT_TYPE,
  CANVAS_INSPECT_TYPE,
  CANVAS_PICKED_TYPE,
  CANVAS_CANCELLED_TYPE,
} from '@/lib/canvas/element-inspect';

interface RenderMessage {
  type: 'vfs-preview-render';
  html: string;
}

interface ToggleInspectMessage {
  type: typeof CANVAS_TOGGLE_INSPECT_TYPE;
  enabled: boolean;
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
/** 当前拾取模式开关。存本页（而非宿主）是因为热更新重建内层后要由本页重放。 */
let inspectEnabled = false;

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
  // srcdoc 的解析是独立任务：宿主 toggle 或本页在这里直接 post 的 inspect 状态
  // 可能早于内层 bootstrap 脚本注册监听器而丢失。load 事件触发时文档已完整解析，
  // 此时若拾取模式还开着就补发一次——bootstrap 的 start 幂等，重复收到无害。
  inner.addEventListener('load', () => {
    if (inspectEnabled) {
      inner?.contentWindow?.postMessage({ type: CANVAS_INSPECT_TYPE, enabled: true }, '*');
    }
  });
  document.body.appendChild(inner);
}

/** 把用户 HTML 包进新的 `<!doctype html><html><head>…</head><body>...</body></html>`。
 *  head 里按序注入三件事：
 *   1. `<base target="_blank">` 让所有未显式带 `target=` 的 `<a>` 默认开新标签。
 *   2. override 脚本在 DOMContentLoaded 上把所有 `<a[href]>` 的 `target` 改写为
 *      `_blank` 并补 `rel="noopener noreferrer"`，吞掉 `<a target="_self">` /
 *      `<a target="_top">` 这两种会逃出 `<base>` 默认值的链接。
 *   3. 拾取模式 bootstrap（`inspectBootstrapScript`）：常驻、默认休眠，收到
 *      `canvas-inspect` 才激活（见 inspectBootstrapScript 注释）。
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
  return `<!doctype html><html><head>${baseTag}${overrideScript}${inspectBootstrapScript()}</head><body>${html}</body></html>`;
}

/**
 * Canvas Pick Element 的内层 bootstrap 脚本。全部逻辑跑在被拾取的预览文档里，
 * 只做 DOM 侧的机械工作；消息类型常量经模板插值与本文件 / host 共用同一出处：
 *   - mousemove（capture）：在 hover 元素上叠一个固定定位高亮框 + tooltip
 *     （`tag#id.c1.c2`）。overlay `pointer-events:none`，不碰作者样式，也永远不会
 *     成为事件目标。
 *   - click（capture）：`preventDefault` + `stopPropagation` 拦掉默认行为与作者
 *     处理器，把结构数据序列化后 post 给本页（本页再转发宿主）。序列化只送
 *     tag/id/class、内层数好的 nth-of-type 祖先链与截断的 outerHTML——selector
 *     算法在 host 侧 `buildCssSelector` 单一实现，内层不拼路径字符串。
 *   - Escape（capture）：取消并回报，宿主据此弹起按钮。
 *   - pick / 取消后自关（stop：摘监听、拆 overlay）。
 * 消息只认 `event.source === window.parent`（本页）；本页只能拿到 '*' 作
 * targetOrigin——不透明 origin 下没有更准的值，host 侧以 event.source 鉴权。
 */
function inspectBootstrapScript(): string {
  return '<script>' +
    '(function(){' +
    'var state=false,box=null,tip=null,cur=null;' +
    'function label(el){' +
    'var t=el.tagName.toLowerCase();' +
    'if(el.id)t+="#"+el.id;' +
    'var c=(el.getAttribute("class")||"").trim();' +
    'if(c)t+="."+c.split(/\\s+/).slice(0,2).join(".");' +
    'return t;' +
    '}' +
    'function ensure(){' +
    'if(box)return;' +
    'box=document.createElement("div");' +
    'box.style.cssText="position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:rgba(59,130,246,.12);border-radius:2px;";' +
    'tip=document.createElement("div");' +
    'tip.style.cssText="position:fixed;pointer-events:none;z-index:2147483647;background:#1e293b;color:#fff;font:11px/1.4 system-ui,sans-serif;padding:2px 6px;border-radius:4px;white-space:nowrap;left:0;top:0;";' +
    'document.documentElement.appendChild(box);' +
    'document.documentElement.appendChild(tip);' +
    '}' +
    'function move(e){' +
    'if(!state)return;' +
    'var t=e.target;' +
    'if(!t||t.nodeType!==1)return;' +
    'cur=t;ensure();' +
    'var r=t.getBoundingClientRect();' +
    'box.style.display="block";' +
    'box.style.left=r.left+"px";box.style.top=r.top+"px";' +
    'box.style.width=r.width+"px";box.style.height=r.height+"px";' +
    'tip.style.display="block";' +
    'tip.textContent=label(t);' +
    'tip.style.left=Math.max(0,Math.min(r.left,window.innerWidth-tip.offsetWidth))+"px";' +
    'tip.style.top=(r.top>24?r.top-20:r.bottom+4)+"px";' +
    '}' +
    'function hide(){if(box){box.style.display="none";tip.style.display="none";}}' +
    'function spec(el){' +
    'var chain=[],n=el,d=0;' +
    'while(n&&n.nodeType===1&&d<6){' +
    'var k=1,s=n.previousElementSibling;' +
    'while(s){if(s.tagName===n.tagName)k++;s=s.previousElementSibling;}' +
    'chain.push({tagName:n.tagName.toLowerCase(),id:n.id||null,className:n.getAttribute("class")||"",nthOfType:k});' +
    'n=n.parentElement;d++;' +
    '}' +
    'var sn=el.outerHTML||"";' +
    'if(sn.length>500)sn=sn.slice(0,500);' +
    'return {tagName:el.tagName.toLowerCase(),id:el.id||null,className:el.getAttribute("class")||"",snippet:sn,chain:chain};' +
    '}' +
    'function post(msg){window.parent.postMessage(msg,"*");}' +
    'function click(e){' +
    'if(!state)return;' +
    'e.preventDefault();e.stopPropagation();' +
    'var el=cur||e.target;' +
    'if(el&&el.nodeType===1)post({type:"' + CANVAS_PICKED_TYPE + '",element:spec(el)});' +
    'stop();' +
    '}' +
    'function key(e){' +
    'if(!state||e.key!=="Escape")return;' +
    'e.preventDefault();e.stopPropagation();' +
    'post({type:"' + CANVAS_CANCELLED_TYPE + '"});' +
    'stop();' +
    '}' +
    'function start(){' +
    'if(state)return;state=true;' +
    'document.addEventListener("mousemove",move,true);' +
    'document.addEventListener("click",click,true);' +
    'document.addEventListener("keydown",key,true);' +
    'document.addEventListener("scroll",hide,true);' +
    '}' +
    'function stop(){' +
    'if(!state)return;state=false;cur=null;' +
    'document.removeEventListener("mousemove",move,true);' +
    'document.removeEventListener("click",click,true);' +
    'document.removeEventListener("keydown",key,true);' +
    'document.removeEventListener("scroll",hide,true);' +
    'if(box){box.remove();box=null;tip=null;}' +
    '}' +
    'window.addEventListener("message",function(ev){' +
    'if(ev.source!==window.parent)return;' +
    'var d=ev.data;' +
    'if(d&&d.type==="' + CANVAS_INSPECT_TYPE + '"){d.enabled?start():stop();}' +
    '});' +
    '})();' +
    '</script>';
}

function isRenderMessage(data: unknown): data is RenderMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as RenderMessage).type === 'vfs-preview-render' &&
    typeof (data as RenderMessage).html === 'string'
  );
}

function isToggleInspectMessage(data: unknown): data is ToggleInspectMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as ToggleInspectMessage).type === CANVAS_TOGGLE_INSPECT_TYPE &&
    typeof (data as ToggleInspectMessage).enabled === 'boolean'
  );
}

/** 内层 → 宿主的转发白名单：拾取成功 / Escape 取消两类。宿主侧的
 *  `normalizePick` 负责 payload 校验，这里只挡来源与类型。 */
function isCanvasRelayMessage(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const type = (data as { type?: unknown }).type;
  return type === CANVAS_PICKED_TYPE || type === CANVAS_CANCELLED_TYPE;
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) {
    // 内层 canvas 消息是唯一的转发例外（见文件头协议第 3 条），其余一律丢弃——
    // 用户 HTML 里任何脚本 post 的东西都不能借本页过桥。
    if (event.source === inner?.contentWindow && isCanvasRelayMessage(event.data)) {
      window.parent.postMessage(event.data, '*');
    }
    return;
  }
  if (isRenderMessage(event.data)) {
    render(event.data.html);
    return;
  }
  if (isToggleInspectMessage(event.data)) {
    inspectEnabled = event.data.enabled;
    // toggle 时机内层早已 load（有文件才有点按钮），直接发即可；render 路径
    // 的重放由上面 inner 的 load 监听负责。
    inner?.contentWindow?.postMessage(
      { type: CANVAS_INSPECT_TYPE, enabled: inspectEnabled },
      '*',
    );
  }
});

// targetOrigin 只能用 '*'：本页拿不到 chrome.runtime，不知道宿主的 chrome-extension:// origin。
// 宿主侧会校验 event.source 是它自己创建的 iframe，这条 ready 通知本身不携带任何数据。
window.parent.postMessage({ type: 'vfs-preview-ready' }, '*');
