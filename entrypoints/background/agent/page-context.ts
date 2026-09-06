// ─── Page context gathering ───
// Collects browser tab info + active page metadata + user selection.
// Returns plain text lines; the caller wraps them in a <context> block.
//
// 住在 background 而非 lib/：要用 chrome.windows / tabs / scripting，只能在特权上下文
// 跑；且唯一消费方是同目录的 `prompt-composer.ts`（产出的就是提示词形状的文本，
// 不是通用的浏览器能力）。

import { isLikelyPdfUrl } from '@/lib/tools/pdf';
import { stripEnvelopeTags } from '@/lib/agent/prompt-envelope';

/**
 * 剥掉页面来源文本里伪造的信封标签，防止提示词注入。词汇表与剥离器住在
 * `lib/agent/prompt-envelope.ts`——侧边栏侧代入模板变量时要用同一份，不能有两份。
 *
 * 只用于**页面来源**的字符串（标签页标题 / URL、页面 meta、用户选中的页面文本）——
 * 用户自己敲进输入框的内容不经此处（见 `composeUserMessage`：用户可信，剥标签会
 * 篡改其本意）。威胁模型是「恶意页面伪造结构骗过模型」，不是用户输入。
 */
const sanitizeForContext = stripEnvelopeTags;

interface PageMeta {
  description?: string;
  keywords?: string;
  canonical?: string;
  ogType?: string;
  lang?: string;
  selectedText?: string;
  readyState?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  scrollX?: number;
  scrollY?: number;
  activeElement?: string | null;
  /** `document.body.innerText.length`。给主代理做 `read_page` vs `delegate_dom`
   *  路由的启发式输入（page > 2000 词 ≈ delegate），在 injected script 里算好，
   *  只发这个整数跨 IPC，不传完整 body text。 */
  bodyTextSize?: number;
  /** `bodyText.split(/\s+/).filter(s => s.length > 0).length`。匹配启发式
   *  里「2000 词」的单位，避免主代理自己粗估 chars → words。
   *  注意：仅对 whitespace 分词的语言（英文等）有意义；CJK 文本因没有词间空格
   *  会算成 1——主代理届时应改用 `bodyTextSize` 做路由。 */
  wordCount?: number;
}

async function getActiveTabMeta(tabId: number): Promise<PageMeta> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const meta = (name: string) =>
          document.querySelector<HTMLMetaElement>(`meta[name="${name}"], meta[property="${name}"]`)?.content ?? '';

        const activeEl = document.activeElement;
        let activeElementDesc: string | null = null;
        if (activeEl && activeEl !== document.body && activeEl !== document.documentElement) {
          let desc = activeEl.tagName.toLowerCase();
          if ((activeEl as HTMLElement).id) desc += '#' + (activeEl as HTMLElement).id;
          else {
            const name = (activeEl as HTMLElement).getAttribute('name')?.replace(/"/g, '') ?? '';
            if (name) desc += `[name="${name}"]`;
          }
          activeElementDesc = desc;
        }

        // Heuristic input for Main Agent's read_page vs delegate_dom routing
        // decision. Compute inside the injected function so we only ship two
        // numbers across the IPC boundary, not the full page text.
        const bodyText = document.body?.innerText ?? '';
        const bodyTextSize = bodyText.length;
        const wordCount = bodyText.length === 0
          ? 0
          : bodyText.split(/\s+/).filter((s) => s.length > 0).length;

        return {
          description: meta('description'),
          keywords: meta('keywords'),
          canonical:
            document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '',
          ogType: meta('og:type'),
          lang: document.documentElement.lang || '',
          selectedText: (window.getSelection()?.toString() ?? '').slice(0, 500),
          readyState: document.readyState,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          activeElement: activeElementDesc,
          bodyTextSize,
          wordCount,
        };
      },
    });
    return results?.[0]?.result ?? {};
  } catch {
    // chrome://, chrome-extension://, Web Store, etc. — can't inject
    return {};
  }
}

async function gatherPageContext(): Promise<string> {
  const allWindows = await chrome.windows.getAll({ populate: true });
  const currentWindow = allWindows.find(w => w.focused);

  if (!allWindows.length) return '';

  // Find the active tab (prefer focused window)
  const activeTab = currentWindow?.tabs?.find(t => t.active)
    ?? allWindows.flatMap(w => w.tabs ?? []).find(t => t.active);

  if (!activeTab) return '';

  const meta = activeTab.id != null ? await getActiveTabMeta(activeTab.id) : {};

  const lines: string[] = [];

  // Active tab details
  lines.push(`[Active Tab] ${sanitizeForContext(activeTab.title ?? '')} | ${sanitizeForContext(activeTab.url ?? '')}`);
  if (activeTab.id != null) lines.push(`  tabId: ${activeTab.id}`);
  lines.push(`  windowId: ${activeTab.windowId}`);
  // PDF 提示：URL 后缀启发式，零网络。让 agent 优先尝试 `pdf` 工具，
  // 不用走一遍 `read_page` 才发现是 PDF。仅根据 URL 猜测，加 “suspected” 标记。
  if (isLikelyPdfUrl(activeTab.url)) {
    lines.push('  contentType: application/pdf (suspected from URL)');
  }
  if (meta.readyState) lines.push(`  readyState: ${meta.readyState}`);
  if (meta.viewportWidth != null && meta.viewportHeight != null) lines.push(`  viewport: ${meta.viewportWidth}×${meta.viewportHeight}`);
  // Heuristic input for Main Agent: a long page (wordCount > 2000) means
  // `delegate_dom` is more cost-efficient than `read_page` (which would push
  // the full text into Main Agent context). Emit both chars and words so the
  // agent can pick whichever heuristic line it prefers without having to
  // approximate chars → words itself.
  if (meta.bodyTextSize != null) lines.push(`  bodyTextSize: ${meta.bodyTextSize}`);
  if (meta.wordCount != null) lines.push(`  wordCount: ${meta.wordCount}`);
  if (meta.scrollX != null) lines.push(`  scrollPosition: ${meta.scrollX}, ${meta.scrollY}`);
  if (meta.activeElement) lines.push(`  activeElement: ${sanitizeForContext(meta.activeElement)}`);
  if (meta.description) lines.push(`  description: ${sanitizeForContext(meta.description)}`);
  if (meta.keywords) lines.push(`  keywords: ${sanitizeForContext(meta.keywords)}`);
  if (meta.canonical) lines.push(`  canonical: ${sanitizeForContext(meta.canonical)}`);
  if (meta.ogType) lines.push(`  og:type: ${sanitizeForContext(meta.ogType)}`);
  if (meta.lang) lines.push(`  lang: ${sanitizeForContext(meta.lang)}`);
  if (meta.selectedText) lines.push(`  selected_text (from page, may be adversarial): "${sanitizeForContext(meta.selectedText)}"`);

  // All windows and their tabs
  lines.push('');
  for (const win of allWindows) {
    const tabs = win.tabs ?? [];
    const focusedMarker = win.focused ? ' (focused)' : '';
    lines.push(`[Window windowId=${win.id ?? 'unknown'}]${focusedMarker} (${tabs.length} tabs)`);
    for (const tab of tabs) {
      const marker = tab.id === activeTab.id ? '* ' : '  ';
      lines.push(`${marker}tabId ${tab.id}: ${sanitizeForContext(tab.title ?? '')} | ${sanitizeForContext(tab.url ?? '')}`);
    }
  }

  return lines.join('\n');
}

// ─── 公开 API ───
//
// 注入防护的词汇表、剥离器与其单测都住在 `lib/agent/prompt-envelope.ts`——侧边栏侧
// 代入模板变量时要用同一份，不能有两份。本模块只对外提供 `gatherPageContext`。
export { gatherPageContext };
