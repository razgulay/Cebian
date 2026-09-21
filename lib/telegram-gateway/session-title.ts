// lib/telegram-gateway/session-title.ts — Telegram session 的标题约定与识别。
// 全仓的识别口径：标题以「Telegram · 」开头（manager 建行时写入）。UI 据此隐藏
// 对 Telegram session 不适用的控件（team chip / thinking selector——BG 侧 prompt
// 的模型与思考档来自会话行，页头选择器已提供唯一入口）。manager 与 UI 共用本
// 常量，避免两处硬编码漂移。

/** Telegram 专用 session 的标题前缀。 */
export const TELEGRAM_TITLE_PREFIX = 'Telegram · ';

/** 该标题是否为 Telegram 专用 session（页头 / 输入框按此隐藏不适用的控件）。 */
export function isTelegramSessionTitle(title: string | null | undefined): boolean {
  return !!title?.startsWith(TELEGRAM_TITLE_PREFIX);
}
