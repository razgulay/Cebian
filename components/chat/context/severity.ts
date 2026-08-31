// 上下文使用率档位（绿 / 琥珀 / 红）的单一真相源。
//
// 四个组件共享这张阈值表——`ContextUsagePill`、`ContextUsagePopover`、
// `CompactNowButton` 的禁用态、`CompactionDivider` 的样式——任何阈值漂移
// 都会让 UI 在不同地方对同一数字显示不同颜色。集中在这里，三件事：
//
// 1. 阈值的字面值（USAGE_WARN_RATIO / USAGE_CRITICAL_RATIO）——便于测试与将来
//    把它接到 settings storage（届时只换 getter 不动消费方）。
// 2. 边界判定（>= / <）的语义集中表达——避免组件各写一份 `pct >= 0.8`。
// 3. 输入防御（NaN / 0 / 负数）——避免一条坏消息让整张 pill 显示 `NaN%`。
//
// 阈值理由：
// - 0.8 对齐 session-manager 的 `PROACTIVE_COMPACT_RATIO`：BG 在 80% 处触发主动
//   压缩，前端从这里切到琥珀色，让用户与后台在同一阈值上看到「该压缩了」。
// - 0.95 是「危险区」入口：clampedCompactionKeepRecent（contextWindow × 0.4）在
//   极小上下文上可能让保留区预算被压缩到比单条 user 消息还小，BG 的 80% 预检
//   找不到切点时进入此区；前端切红，与「即将 400」的语义对齐。
//
// i18n、颜色 class、DOM 都不在这里——色板映射由各组件的 Tailwind 类承担，
// 文案由 `chat.context.*` 字典承担，本文件只回答「这条数字属哪一档」。

/** Context-usage 档位。从轻到重：ok → warn → critical。三档而非四档——中
 *  间一档的颜色（琥珀）就足以表达「建议压缩」，不需要再细分；保留三档让阈值
 * 切换的视觉跳变更明显。 */
export type UsageSeverity = 'ok' | 'warn' | 'critical';

/** 「该压缩了」门。BG `PROACTIVE_COMPACT_RATIO` 同步值——切到此值前端发琥珀，
 *  后台开始 proactive 80% 预检；两者在同一阈值上对齐，用户看到同一信号。 */
export const USAGE_WARN_RATIO = 0.8;

/** 「危险区」门。再高 contextWindow 接近满，BG 的 keep-recent 滑窗可能已经
 *  无法找到切点；前端切红，向用户暗示「下一轮可能 400」。 */
export const USAGE_CRITICAL_RATIO = 0.95;

/** getUsageSeverity 的返回值。把 ratio 与 percent 都返回——percent 给 UI 显示
 *  （已 round），ratio 给想做插值动画（比如 SVG 弧长 transition）的组件。 */
export interface UsageAssessment {
  severity: UsageSeverity;
  /** 已 round 的 0-100 整数。直接用于「42%」这种展示。 */
  percent: number;
  /** Raw ratio，clamp01 后。组件想要 0-1 形式的比例（比如弧形进度）就用它。 */
  ratio: number;
}

/** 把 (已用 token, 总上下文窗口) 映射成 UI 档位。所有防御集中在这里：
 *  坏输入（NaN、0、负数）一律落到 `ok 0%`，与「未知」态的渲染共用一条路径。 */
export function getUsageSeverity(tokens: number, contextWindow: number): UsageAssessment {
  // 输入防御：极端值 / 坏值都不能让 UI 显示「NaN%」或「-12%」。Math.min/max
  // 对 NaN 都返回 NaN，必须先短路。
  if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { severity: 'ok', percent: 0, ratio: 0 };
  }
  // 负 token 也防御一下：理论上不会发生，但 v1 备份迁移过来的旧会话可能
  // 携带异常字段（参见 issue #43 的同款防御模式）。
  const safeTokens = Math.max(0, tokens);
  // clamp01 内联：上面的 `contextWindow > 0` 守门保证了分母 > 0，省一次 clamp。
  const ratio = Math.min(1, safeTokens / contextWindow);
  const percent = Math.round(ratio * 100);

  let severity: UsageSeverity;
  if (ratio >= USAGE_CRITICAL_RATIO) severity = 'critical';
  else if (ratio >= USAGE_WARN_RATIO) severity = 'warn';
  else severity = 'ok';

  return { severity, percent, ratio };
}