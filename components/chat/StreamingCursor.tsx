/**
 * 流式输出等待指示器（Copilot 风格：两个实心圆点沿同一条轨道对转）。
 *
 * 历史形状：原本是 `w-1.5 h-4 animate-pulse` 的橙色方块，贴在文末。问题：
 *   - `animate-pulse` 是 opacity 脉冲，整块闪一下淡一下，节奏和 token 流
 *     的"逐字落地"对不齐，读起来像 UI 卡顿。
 *   - 方块是字符高度的矩形（16px 高），和正文基线对不齐。
 *
 * 现在改成 2 个填充大圆点（filled discs），直径 9px（gấp 3 lần bản
 * 16×16 trước），对称地放在 24×24 SVG 中心左右各 6.5px 处（`cx=5.5` /
 * `cx=18.5`，`cy=12`），整组包在 `<g>` 里施加 `animate-spin` —— 这是
 * **orbital rotation**：两个圆点保持自身朝向不变、围绕共同圆心做轨道运
 * 动（Copilot 在 AI 回复末尾就是这种）。`stroke` 改 `fill`、dasharray 全
 * 部去掉、颜色继承 `currentColor` 跟 `text-primary` 走——主题换色不用动
 * 它。
 *
 * Wrapper DOM 16×16 → 24×24（`w-6 h-6`），因为 2 disc 9px diameter 要
 * 走完 quỹ đạo 12px diameter 而不重叠：distance giữa 2 disc khi đối
 * diện = 13px, > 9px diameter → 永远不 chồng nhau. viewBox 24×24 + orbit
 * radius 6.5 让 disc 距 viewBox edge 1px（`5.5 - 4.5 = 1`, `18.5 + 4.5
 * = 23`）——clip margin 足够不 sát mép.
 *
 * SVG 故意内联而不抽成 `<Spinner />` 公共组件：当下只有这一处用，单独
 * 文件抽公共组件属于过度设计；如果以后 sidepanel / history panel 也要
 * 用，再升级到 `components/ui/spinner.tsx`。
 */
export function StreamingCursor() {
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center w-6 h-6 align-middle ml-0.5 text-primary opacity-70"
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Orbital group: 2 filled discs rotate together around the SVG center.
            1.2s per cycle — fast enough to read as motion, slow enough not to feel jittery. */}
        <g
          className="animate-spin origin-center"
          style={{ animationDuration: '1.2s' }}
        >
          {/* Right disc: starts at 3 o'clock (cx=18.5, cy=12), orbit radius = 6.5 */}
          <circle cx="18.5" cy="12" r="4.5" fill="currentColor" />
          {/* Left disc: starts at 9 o'clock (cx=5.5, cy=12), same orbit, 180° opposite */}
          <circle cx="5.5" cy="12" r="4.5" fill="currentColor" />
        </g>
      </svg>
    </span>
  );
}
