/**
 * 检测 textarea 当前光标位置是否落在 `@<token>` 上，token 由
 * `[a-zA-Z0-9_-]` 组成。Boundary 严格：@ 必须紧贴「行首」或「空白字符」——防止
 * `user@host.com` 这类 email 在光标前的 mid-word 位置误触发 worker-role
 * 选择器。函数纯、vitest 直接覆盖。
 *
 * 返回值描述光标（caret）前最近 `@<token>` 的边界：
 *   - `query`     caret 位置前 `@` 之后到 token 末尾的小写字符串，用于 popover 过滤
 *   - `start`     `@` 在 `value` 里的索引
 *   - `end`       caret 位置（或 token 末尾，取较小者——见下）
 *
 * token 字符集刻意限定为 `[a-zA-Z0-9_-]`：覆盖全部 4 个 worker role id（content_writer
 * / frontend_coder / reviewer / researcher），同时排除空格 / 换行 / 引号等
 * 会污染文本结构的字符。
 *
 * 若光标不在 @-token 上（@ 不紧贴行首 / 空白、@ 后无 token 字符、caret
 * 在非 token 字符之后）→ 返回 null，调用方据此不开启 popover。
 */
export function detectAtToken(
  value: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  if (caret <= 0 || caret > value.length) return null;
  let i = caret - 1;
  while (i > 0 && !/\s/.test(value[i - 1]!)) i--;
  // 此时 i==0（到头）或 value[i-1] 是空白。i 就是 token 起点（@ 所在位置）
  if (value[i] !== '@') return null;
  let end = i + 1;
  while (end < caret && /[a-zA-Z0-9_-]/.test(value[end]!)) end++;
  return { query: value.slice(i + 1, end).toLowerCase(), start: i, end };
}
