// Canvas Pick Element：用户在 Canvas 预览里点选的元素信息（纯逻辑侧）。
//
// 数据流：inspector bootstrap（由 `entrypoints/vfs-preview.sandbox/main.ts`
// 注入内层 srcdoc iframe）把被点元素序列化成 `RawCanvasPick`——内层只做 DOM
// 侧的机械工作（逐级收集 tag/id/class/nth-of-type、截断 outerHTML），selector
// 算法只存在于本文件的 `buildCssSelector`（host 侧、可单测）。sandbox 页原样
// 转发后，host 侧用 `normalizePick` 校验类型并裁剪长度（内层跑的是用户 HTML，
// payload 不可信），得到 `CanvasElementPick`。`buildCanvasElementAttachment`
// 再把 pick 包成一个合成的 `file` attachment——复用既有 chip / `<attached-file>`
// envelope 管线（与 PDF 同款先例），不为它新增 attachment 类型。
//
// broker 线上消息类型常量也放在这里（host 与 sandbox 两个 bundle 共用的唯一
// 出处，bootstrap 字符串里用模板插值引用同一批常量）。

import type { TextFileAttachment } from '@/lib/agent/attachments';

/** 宿主 → sandbox 页：开关拾取模式。sandbox 页记住状态并转发给内层。 */
export const CANVAS_TOGGLE_INSPECT_TYPE = 'canvas-toggle-inspect' as const;
/** sandbox 页 → 内层：同一条开关指令在内层侧的名字。 */
export const CANVAS_INSPECT_TYPE = 'canvas-inspect' as const;
/** 内层 → sandbox 页 → 宿主：拾取成功（自带 element 数据）。 */
export const CANVAS_PICKED_TYPE = 'canvas-element-picked' as const;
/** 内层 → sandbox 页 → 宿主：Escape 取消（无数据）。 */
export const CANVAS_CANCELLED_TYPE = 'canvas-inspect-cancelled' as const;

/** host 侧裁剪上限。内层可能被用户 HTML 伪造出任意大小的 payload，
 *  每个字符串字段都先在这里截断再进入 UI / LLM。 */
const LIMITS = {
  chainDepth: 6,
  snippet: 500,
  id: 120,
  className: 200,
  tagName: 50,
  attachmentName: 60,
};

/** CSS 路径上的一个节点（root-first）。`nthOfType` 是该节点在同级同 tag
 *  兄弟中的 1-based 位次——由内层在 DOM 上数出来，host 侧无法重算。 */
export interface SelectorNode {
  tagName: string;
  id: string | null;
  className: string;
  nthOfType: number;
}

/** 内层 iframe post 上来的原始拾取数据（未校验——只承诺形状近似，内容
 *  一律经过 `normalizePick` 才能使用）。 */
export interface RawCanvasPick {
  tagName: string;
  id: string | null;
  className: string;
  /** outerHTML 截断（内层已截到 500，host 侧再兜一次）。 */
  snippet: string;
  /** root-first 祖先链，最后一项是被拾取元素本身。 */
  chain: SelectorNode[];
}

/** 校验后的拾取结果——CanvasPane 通过 pick-channel 发布给 ChatInput。 */
export interface CanvasElementPick {
  tagName: string;
  id: string | null;
  className: string;
  selector: string;
  snippet: string;
}

/**
 * 由 root-first 祖先链拼一条 CSS 路径（供 agent / 用户定位，不保证是唯一
 * 查询选择器）。规则：
 *   - 遇到带 id 的节点 → 拼上 `#id` 后立即停止（id 是最强锚点）；
 *   - 有 class → 取前 2 个拼 `.c1.c2`，不再追加 nth-of-type（保持可读）；
 *   - 无 class → 拼内层数好的 `:nth-of-type(n)` 消歧；
 *   - 链最多往下取 5 段（不含 id 锚点段）。
 * 链是 root-first，从末端（被拾取元素）往回走、最后 reverse。
 */
export function buildCssSelector(chain: readonly SelectorNode[]): string {
  const segments: string[] = [];
  for (let i = chain.length - 1; i >= 0 && segments.length < 5; i--) {
    const node = chain[i];
    if (node.id) {
      segments.push(`${node.tagName}#${node.id}`);
      break;
    }
    const classes = node.className.split(/\s+/).filter(Boolean).slice(0, 2);
    const seg = classes.length > 0
      ? `${node.tagName}${classes.map((c) => `.${c}`).join('')}`
      : `${node.tagName}:nth-of-type(${node.nthOfType})`;
    segments.push(seg);
  }
  return segments.reverse().join(' > ');
}

/** tag 名必须长得像标签名——内层 payload 不可信，怪字符串直接丢。 */
function asTagName(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase().slice(0, LIMITS.tagName);
  return /^[a-z][a-z0-9-]*$/.test(s) ? s : '';
}

function asCappedString(v: unknown, cap: number): string {
  return typeof v === 'string' ? v.slice(0, cap) : '';
}

function asOptionalId(v: unknown): string | null {
  const s = asCappedString(v, LIMITS.id);
  return s.length > 0 ? s : null;
}

/** 单个 SelectorNode 的宽松解析：任何字段不合法都让整个 chain 作废
 *  （半条链拼出来的路径比没有更误导）。 */
function asSelectorNode(v: unknown): SelectorNode | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const tagName = asTagName(r.tagName);
  if (!tagName) return null;
  const nth = typeof r.nthOfType === 'number' && Number.isFinite(r.nthOfType)
    ? Math.max(1, Math.floor(r.nthOfType))
    : 1;
  return {
    tagName,
    id: asOptionalId(r.id),
    className: asCappedString(r.className, LIMITS.className),
    nthOfType: nth,
  };
}

/**
 * 校验内层 relay 上来的原始 payload。返回 null 表示 payload 不可用
 * （形状不对 / tagName 非法），调用方应直接丢弃而不是给 chip 挂垃圾数据。
 */
export function normalizePick(raw: unknown): CanvasElementPick | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const tagName = asTagName(r.tagName);
  if (!tagName) return null;

  // chain：从末尾（被拾取元素）取最近的 chainDepth 段；任何一段坏 → 整条弃用。
  const chain: SelectorNode[] = [];
  if (Array.isArray(r.chain)) {
    for (const item of r.chain.slice(-LIMITS.chainDepth)) {
      const node = asSelectorNode(item);
      if (!node) {
        chain.length = 0;
        break;
      }
      chain.push(node);
    }
  }
  // chain 缺失 / 坏：用 payload 顶层的元素字段兜一段，selector 退化成单段。
  const effectiveChain = chain.length > 0
    ? chain
    : [{ tagName, id: asOptionalId(r.id), className: asCappedString(r.className, LIMITS.className), nthOfType: 1 }];

  return {
    tagName,
    id: asOptionalId(r.id),
    className: asCappedString(r.className, LIMITS.className),
    selector: buildCssSelector(effectiveChain),
    snippet: asCappedString(r.snippet, LIMITS.snippet),
  };
}

/** chip 名（`button#submit`）：只留安全字符，防用户 HTML 里 id 夹怪字符。 */
function pickLabel(pick: CanvasElementPick): string {
  const base = `${pick.tagName}${pick.id ? `#${pick.id}` : ''}`;
  const cleaned = base.replace(/[^\w#.-]/g, '').slice(0, LIMITS.attachmentName);
  return cleaned.length > 0 ? cleaned : 'element';
}

/**
 * 拾取的去重键：attachment 正文的前两行注释（canvas 源文件 + selector）。
 * builder 用它拼正文、ChatInput 订阅方用它查重——格式只有这一处定义，
 * 改措辞时两边永远同步，不会出现「悄悄死掉的去重」。
 */
export function pickDedupeKey(pick: CanvasElementPick, canvasPath: string): string {
  return `<!-- Element picked from canvas: ${canvasPath} -->\n<!-- selector: ${pick.selector} -->`;
}

/**
 * 把 pick 包成合成 `file` attachment——名字即 `tag#id.html`（chip 直接显示
 * tag + selector 关键部分），正文以 `pickDedupeKey` 开头（去重契约见上），
 * 后接 outerHTML 片段。agent 拿到「在哪个 VFS 文件、找哪段标记」的全部线索，
 * 走既有 fs 工具文本定位即可，不需要任何新 attachment 类型或工具。
 */
export function buildCanvasElementAttachment(
  pick: CanvasElementPick,
  canvasPath: string,
): TextFileAttachment {
  const content = `${pickDedupeKey(pick, canvasPath)}\n${pick.snippet}\n`;
  return {
    type: 'file',
    name: `${pickLabel(pick)}.html`,
    mimeType: 'text/html',
    content,
    size: content.length,
  };
}
