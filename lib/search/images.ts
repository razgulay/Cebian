// 搜索结果缩略图的过滤决策（pure，无 IO）——把「哪些图片 URL 有资格进入对话上下文」
// 的全部启发式收敛在这一处，extract 归一化与单测共用。
//
// 设计立场：搜索结果页的 <img> 大部分是噪音——favicon（无图片扩展名 / data: URI）、
// 1x1 跟踪像素、低分辨率占位图、广告监测图。进入上下文的每一张图都可能被模型原样
// 输出成 Markdown（渲染时用户的浏览器会真实请求该 URL，泄露 IP），所以过滤宁紧勿松：
//   1. 只收绝对 http(s)（相对地址由调用方先按结果页 URL 解析）。
//   2. DuckDuckGo 的图片代理先解包出真实 URL（解包失败回落代理 URL 本身）。
//   3. 「直链」判定：有常见位图扩展名，或在已知引擎缩略图域上。两者都不满足的
//      URL 视为页面资源（favicon / 截图 / 追踪端点），丢弃。.svg 刻意排除。
//   4. 跟踪像素 / 低分辨率启发式：URL 特征词 + w/width/h/height 尺寸提示 < 100。
//   5. 按 url 去重，单条 result 上限 MAX_IMAGES_PER_RESULT。

import type { SearchResultImage } from './types';
import { oneLine, truncate } from '@/lib/utils';

/** 单条 result 最多进入上下文的图片数。 */
const MAX_IMAGES_PER_RESULT = 3;

/** alt 文本长度上限（与 TITLE_MAX 同量级）。 */
const ALT_MAX = 200;

/** 位图扩展名（pathname 尾部判定；URL 的 pathname 不含 `?` / `#`，无需边界集）。
 *  .svg 刻意不在列表——收益低且部分渲染器有外链请求行为，宁可丢掉。 */
const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif|avif)$/i;

/** 引擎缩略图 / 图片代理域：无扩展名但确实可作 <img src>。 */
const THUMB_HOST_RE =
  /(?:^|\.)(?:th\.bing\.com|tse\d*\.mm\.bing\.net|encrypted-tbn\d*\.gstatic\.com|imgs\.search\.brave\.com|external-content\.duckduckgo\.com)$/i;

/** DuckDuckGo 图片代理：真实图片地址在 `u` 查询参数里（percent-encoded）。 */
const DDG_PROXY_RE = /^https?:\/\/external-content\.duckduckgo\.com\/iu\/\?/i;

/** 已知跟踪 / 广告域（host 级判定，避免误伤路径里碰巧含这些词的正常图片）。 */
const TRACKING_HOST_RE =
  /(?:^|\.)(?:doubleclick\.net|googletagmanager\.com|google-analytics\.com|scorecardresearch\.com|quantserve\.com|hotjar\.com)(?:[/?#]|$)|(?:^|\.)facebook\.com\/tr(?:[/?#]|$)|adservice\.google\.[a-z.]+/i;

/** 跟踪端点路径形态：/collect、/pixel、/beacon、/tracking、/1x1 作为独立段
 *  （后随 . / 或结尾），或 1x1 位图文件名。`pixel-art.png` 这类正常名字不受
 *  影响（后随字符不在边界集里）。 */
const TRACKING_PATH_RE = /\/(?:collect|pixel|beacon|tracking|1x1)(?:[./]|$)|1x1\.(?:gif|png|jpe?g)$/i;

/** URL 里的显式尺寸提示；任一数值 < 100 视为低分辨率缩略图 / 占位图。带 /g 只
 *  供 matchAll 使用（matchAll 内部克隆正则，模块级常量不带 lastIndex 状态）。 */
const SIZE_HINT_RE = /[?&](?:w|width|h|height|sz|size|maxwidth|maxheight)=(\d{1,4})/gi;

/** DuckDuckGo 代理 URL 解包：取出 `u` 参数里的真实地址；失败返回 null。 */
function unwrapDdgProxy(url: URL): string | null {
  const real = url.searchParams.get('u');
  if (!real) return null;
  try {
    const parsed = new URL(real);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {
    // `u` 不是合法 URL → 返回 null，调用方回落用代理 URL 本身。
  }
  return null;
}

/** 单张图是否通过全部启发式。`url` 必须已是绝对地址（协议白名单在此判定）。 */
function isUsableImageUrl(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (TRACKING_HOST_RE.test(url.host + url.pathname)) return false;
  if (TRACKING_PATH_RE.test(url.pathname)) return false;
  for (const m of url.href.matchAll(SIZE_HINT_RE)) {
    if (Number(m[1]) < 100) return false;
  }
  if (IMAGE_EXT_RE.test(url.pathname)) return true;
  // 无扩展名：仅接受引擎缩略图域（favicon / 页面资源一律在此被挡）。
  return THUMB_HOST_RE.test(url.hostname);
}

/**
 * 过滤一条 result 的原始图片列表。`raw` 是 extract 脚本返回的未校验值；
 * `sourceUrl` 由调用方（normalize 层）用该 result 的 url 补齐——脚本无需关心。
 * 相对地址按 `baseUrl`（实际停留的结果页）解析，与 result url 的解析同一基准。
 * 返回 undefined = 没有可用的图（调用方保持 item 不带该字段）。
 */
function filterSearchImages(raw: unknown, sourceUrl: string, baseUrl: string): SearchResultImage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: SearchResultImage[] = [];
  for (const item of raw) {
    if (out.length >= MAX_IMAGES_PER_RESULT) break;
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.url !== 'string' || r.url === '') continue;
    let abs: URL;
    try {
      abs = new URL(r.url, baseUrl);
    } catch {
      continue;
    }
    // DuckDuckGo 代理先解包：真实 URL 有扩展名时走直链判定；解包失败回落代理
    // URL（THUMB_HOST_RE 会放行代理域）。
    let candidate = abs.href;
    if (DDG_PROXY_RE.test(abs.href)) {
      const real = unwrapDdgProxy(abs);
      if (real) candidate = real;
    }
    let usable: URL;
    try {
      usable = new URL(candidate);
    } catch {
      continue;
    }
    if (!isUsableImageUrl(usable)) continue;
    if (seen.has(usable.href)) continue;
    seen.add(usable.href);
    const alt = typeof r.alt === 'string' ? truncate(oneLine(r.alt), ALT_MAX) : '';
    out.push({ url: usable.href, sourceUrl, ...(alt ? { alt } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

export {
  MAX_IMAGES_PER_RESULT,
  filterSearchImages,
  // 仅供单测：把内部判定规则暴露给边界用例（不进生产路径）。
  isUsableImageUrl as _isUsableImageUrl,
};
