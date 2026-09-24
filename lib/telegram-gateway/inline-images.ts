// 提取 + 剥离 assistant 回复里的 markdown 内联图片（Telegram 侧图片分发的前置步骤）。
//
// Pure、无 IO：manager 在 finalizeTurn 里先调用这里拿「图片列表 + 干净文本」，
// 再决定走 sendPhoto / sendMediaGroup / 纯文本块。只认 http(s) 绝对地址——VFS
// 内联图（`#/workspaces/...`）不匹配、原样留在 cleanText 里由既有文本路径处理。
// 提取是「宁缺勿滥」的：这批 URL 会交给 Telegram 服务端拉取（≤10MB / jpg/png/gif），
// 尺寸与可达性由 Telegram 侧判定，失败走 manager 的文本 fallback。

/** 提取出的内联图片。URL 已按字符串去重（保留首次出现顺序）。 */
export interface InlineImage {
  url: string;
  /** 剥离前的 alt 文本（原样 trim，未单行化——当前 dispatch 只用 URL，alt 保留
   *  给未来的 caption 增强）。 */
  alt: string;
}

export interface ExtractedInlineImages {
  images: InlineImage[];
  /** 剥掉图片 markdown 后的干净文本；段间 3+ 连换行收敛为 1 个空行、首尾 trim。
   *  可能为空串（回复本身就是纯图片）。 */
  cleanText: string;
}

/** markdown 内联图片：`![alt](http(s)://...)`。URL 段禁空白、惰性 alt；括号内侧
 *  容许空白（`![b]( https://… )` 也算——比 CommonMark 宽松一档）。URL 段支持
 *  **一层平衡括号**（Wikipedia 式 `/wiki/Code_(identifier)`）——否则 URL 被截断成
 *  不可拉取的残链、cleanText 还会留下 `)` 残渣。 */
const INLINE_IMAGE_RE = /!\[(.*?)\]\(\s*(https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\s*\)/g;

/**
 * 从回复文本提取全部 web 内联图片并从原文剥离。
 *
 * - 同一 URL 出现多次只保留首次（Telegram 重复发同图没有意义），但**每次出现都
 *   从文本剥离**——不留 `![...](...)` 残渣。
 * - 剥离后的段间空行收敛（`{3,}` → 1 个空行），避免「图片是独立段落」时留下大段
 *   空白、也让 cleanText 直接可作 Telegram caption / 文本块。
 */
export function extractInlineImages(text: string): ExtractedInlineImages {
  const images: InlineImage[] = [];
  const seen = new Set<string>();
  const clean = text.replace(INLINE_IMAGE_RE, (_match, alt: string, url: string) => {
    const trimmedUrl = url.trim();
    if (!seen.has(trimmedUrl)) {
      seen.add(trimmedUrl);
      images.push({ url: trimmedUrl, alt: alt.trim() });
    }
    return '';
  });
  return {
    images,
    cleanText: clean.replace(/\n{3,}/g, '\n\n').trim(),
  };
}
