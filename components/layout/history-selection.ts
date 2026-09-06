// 历史列表多选模式的纯逻辑：可见顺序，以及 shift 区间选择。
//
// 「刚开的那一批临时会话」在时间上是连续的，所以区间选择比逐个勾选更贴合真实场景——
// 点第一条、shift 点最后一条，两次点击拿下一整段。

import type { SessionGroup } from '@/components/layout/history-grouping';

/**
 * 列表里**看得见**的会话 id，按渲染顺序排列。折叠起来的分组不计入——shift 区间跨过一个
 * 折叠分组时，把里面看不见的会话一并选中会是纯粹的意外。
 */
export function visibleOrder(groups: SessionGroup[], openBuckets: string[]): string[] {
  const open = new Set(openBuckets);
  return groups
    .filter((group) => open.has(group.bucket))
    .flatMap((group) => group.sessions.map((session) => session.id));
}

/**
 * `anchorId` 与 `targetId` 之间（含两端）的全部 id，按可见顺序。两者哪个在前都可以。
 *
 * 任一端不在可见列表里（锚点所在分组刚被折叠 / 该会话刚被别的窗口删掉）时返回 `null`
 * ——「这里没有有效区间」，而不是硬凑一段用户没看见的范围。调用方据此退化成单选，并
 * 顺手把锚点换成本次点击的那条；若这里返回 `[targetId]` 冒充成功，调用方就没有理由更新
 * 锚点，那个失效锚点会一直卡住，此后每次 shift 点击都只选中一条。
 */
export function rangeBetween(order: string[], anchorId: string, targetId: string): string[] | null {
  const anchor = order.indexOf(anchorId);
  const target = order.indexOf(targetId);
  if (anchor < 0 || target < 0) return null;
  const [from, to] = anchor <= target ? [anchor, target] : [target, anchor];
  return order.slice(from, to + 1);
}
