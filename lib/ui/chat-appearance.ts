// 对话区外观 → CSS 变量的换算（渲染边界）。
//
// 只产出两个局部 CSS 变量，由侧边栏根节点（及设置页预览）挂上，对话组件经
// assets/tailwind.css 里的 `chat-text-*` / `chat-font` 工具类消费：
// - `--chat-text-scale`：字号倍率。消费方写成 `calc(<原始 rem> * var(--chat-text-scale, 1))`，
//   没挂变量的上下文（如 VFS 预览复用 MarkdownRenderer）按 1 渲染、保持原样。
// - `--chat-font-family`：字体栈。默认预设写成 `initial`（无效值），消费方回退 `inherit`——
//   必须显式写而不是省略：省略时会从外层继承（如设置页预览嵌在侧边栏根节点里，会拿到已保存的字体）。

import type { CSSProperties } from 'react';
import type { ChatAppearance } from '@/lib/persistence/storage';

/** 衬线预设：优先系统衬线，再给中文宋体 / 思源宋体兜底，避免中文落回无衬线。 */
const SERIF_STACK =
  "ui-serif, Georgia, 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', SimSun, serif";

/**
 * 把任意字符串编码成 CSS 字符串字面量（双引号包裹）。
 * 反斜杠与引号转义；控制字符（含换行）直接丢弃——字体名里不会有，留着只会让声明失效
 * （未转义换行会截断字符串，尾部反斜杠会吃掉闭引号）。
 */
function toCssString(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '');
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 预设 → font-family 值；默认预设（或自定义名为空）返回 undefined，表示不覆盖界面字体。 */
function chatFontFamily(appearance: ChatAppearance): string | undefined {
  switch (appearance.fontPreset) {
    case 'default':
      return undefined;
    case 'serif':
      return SERIF_STACK;
    case 'mono':
      return 'var(--font-mono)';
    case 'custom':
      // 找不到该字体时浏览器按列表往后回退到界面默认字体
      return appearance.customFontName
        ? `${toCssString(appearance.customFontName)}, var(--font-sans)`
        : undefined;
  }
}

/** 对话区外观 → 挂在容器上的 style（CSS 变量）。入参应已经过 resolveChatAppearance。 */
function chatAppearanceStyle(appearance: ChatAppearance): CSSProperties {
  return {
    '--chat-text-scale': String(appearance.fontScalePercent / 100),
    '--chat-font-family': chatFontFamily(appearance) ?? 'initial',
  } as CSSProperties;
}

// ─── 旧版外观设置的迁移（fork 的 chatFontSize / chatFontFamily → chatAppearance）───
//
// fork 曾用两个独立 key 存外观：`local:chatFontSize`（15–18 px 绝对值）与
// `local:chatFontFamily`（geist / inter / roboto / system）。1.8.0 起统一为单个
// `local:chatAppearance`（百分比倍率 + 字体预设），后者参与备份。本函数把旧值
// 换算成新 schema，让升级用户的外观设置不丢。

/** 旧 key 的原始值；缺省 / 非法时为 undefined。 */
interface LegacyChatAppearance {
  /** `local:chatFontSize`：15–18 的 px 值。 */
  fontSize?: number | null;
  /** `local:chatFontFamily`：'geist' | 'inter' | 'roboto' | 'system'。 */
  fontFamily?: string | null;
}

/** 旧版字号基准：`--chat-font-size` 的默认值，用来把绝对值换算成倍率。 */
const LEGACY_BASE_FONT_PX = 15;

/**
 * 把旧版外观设置换算成 1.8.0 的 {@link ChatAppearance}。
 *
 * - 字号：旧值是 px 绝对值（15–18，基准 15），新值是百分比倍率。`15px → 100%`、
 *   `18px → 120%`，再按 5 的步长取整并夹到 80–150。
 * - 字体：旧 id 里 `geist`（旧默认）与 `system` 都落到新预设 `default`（界面默认字体
 *   栈）；`inter` / `roboto` 新预设里没有对应项，改用 `custom` + `customFontName`
 *   保留用户实际选的那款字体（CSS 侧写 `"Inter", var(--font-sans)`，找不到时自动回退）。
 *
 * 两个旧值都缺失时返回 null，表示「没有可迁移的内容」——调用方应保持新 key 原样，
 * 避免把用户的既有 chatAppearance 覆盖成默认值。
 */
function migrateLegacyChatAppearance(legacy: LegacyChatAppearance): ChatAppearance | null {
  const hasFontSize = typeof legacy.fontSize === 'number' && Number.isFinite(legacy.fontSize);
  const hasFontFamily = typeof legacy.fontFamily === 'string' && legacy.fontFamily !== '';
  if (!hasFontSize && !hasFontFamily) return null;

  const rawPercent = hasFontSize
    ? Math.round((legacy.fontSize! / LEGACY_BASE_FONT_PX) * 100)
    : 100;
  const stepped = Math.round(rawPercent / 5) * 5;
  const fontScalePercent = Math.min(150, Math.max(80, stepped));

  // 旧 id → 新预设 + 本机字体名。geist / system 是界面默认栈，直接落 default；
  // inter / roboto 用 custom 带上字体名，避免把用户选过的字体悄悄换掉。
  const fontMap: Record<string, { preset: ChatAppearance['fontPreset']; name: string }> = {
    geist: { preset: 'default', name: '' },
    system: { preset: 'default', name: '' },
    inter: { preset: 'custom', name: 'Inter' },
    roboto: { preset: 'custom', name: 'Roboto' },
  };
  const mapped = hasFontFamily ? fontMap[legacy.fontFamily!] : undefined;

  return {
    fontScalePercent,
    fontPreset: mapped?.preset ?? 'default',
    customFontName: mapped?.name ?? '',
  };
}

export { chatAppearanceStyle, toCssString, migrateLegacyChatAppearance };
export type { LegacyChatAppearance };
