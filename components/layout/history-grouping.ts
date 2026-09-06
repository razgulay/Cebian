// 历史列表的分组与排序规则（纯函数，与渲染无关）。
//
// 列表只有一层导航：置顶 → 时间分组 → 已归档，全部是同一个 Accordion 里的分组。
// 刻意不做「全部 / 已归档」两个 tab——那会在已有的时间分组之上再叠一层导航，让同一份
// 列表出现两套心智；归档做成默认折叠的最后一组，看得见、又不碍事。

import type { SessionMeta } from '@/lib/ipc/protocol';

/** 时间分组（仅普通会话参与）。 */
type RecencyBucket = 'today' | 'week' | 'month' | 'older';

/** 列表里可能出现的分组。i18n 键为 `common.historyGroup.<bucket>`。 */
export type HistoryBucket = 'pinned' | RecencyBucket | 'archived';

export interface SessionGroup {
  bucket: HistoryBucket;
  sessions: SessionMeta[];
}

/** 默认折叠的分组：已归档就是「拿走不碍事」的东西，展开它应当是一次主动动作。 */
export const COLLAPSED_BUCKETS: readonly HistoryBucket[] = ['archived'];

// 按 updatedAt 把已倒序的会话列表切成最多 4 段（今天 / 7 天内 / 30 天内 / 更早）。
// 边界用本地自然日 0 点，空段直接跳过。输入需已按 updatedAt 倒序。
function groupByRecency(sessions: SessionMeta[], now: number): SessionGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  // 用日历日做边界，避免固定 24h 偏移在夏令时切换日落到非 0 点。
  // 「7 天内」含今天往前共 7 个自然日，故下界是今天 0 点往前 6 天。
  const weekStartDate = new Date(startOfToday);
  weekStartDate.setDate(weekStartDate.getDate() - 6);
  const monthStartDate = new Date(startOfToday);
  monthStartDate.setDate(monthStartDate.getDate() - 29);
  const todayStart = startOfToday.getTime();
  const weekStart = weekStartDate.getTime();
  const monthStart = monthStartDate.getTime();

  const buckets: Record<RecencyBucket, SessionMeta[]> = {
    today: [],
    week: [],
    month: [],
    older: [],
  };

  for (const session of sessions) {
    if (session.updatedAt >= todayStart) buckets.today.push(session);
    else if (session.updatedAt >= weekStart) buckets.week.push(session);
    else if (session.updatedAt >= monthStart) buckets.month.push(session);
    else buckets.older.push(session);
  }

  const order: RecencyBucket[] = ['today', 'week', 'month', 'older'];
  return order
    .filter((bucket) => buckets[bucket].length > 0)
    .map((bucket) => ({ bucket, sessions: buckets[bucket] }));
}

/**
 * 把会话列表切成「置顶 → 时间分组 → 已归档」。输入需已按 `updatedAt` 倒序
 * （后台 `session_list` 就是这个顺序）。空分组直接跳过。
 *
 * 置顶组按 `pinnedAt` 倒序，同刻则退回 `updatedAt` 倒序——批量置顶时整批共用同一个
 * 时间戳，没有次级键的话组内顺序就是不确定的。
 *
 * 置顶与归档互斥（由 `updateSessionPlacement` 这个唯一写入点保证），这里仍按「置顶
 * 优先」判定，万一遇到脏数据也不会让一条会话同时出现在两个分组里。
 */
export function groupSessions(sessions: SessionMeta[], now: number): SessionGroup[] {
  const pinned: SessionMeta[] = [];
  const archived: SessionMeta[] = [];
  const normal: SessionMeta[] = [];
  for (const session of sessions) {
    if (session.pinnedAt != null) pinned.push(session);
    else if (session.archivedAt != null) archived.push(session);
    else normal.push(session);
  }
  pinned.sort((a, b) => (b.pinnedAt! - a.pinnedAt!) || (b.updatedAt - a.updatedAt));

  const groups: SessionGroup[] = [];
  if (pinned.length > 0) groups.push({ bucket: 'pinned', sessions: pinned });
  groups.push(...groupByRecency(normal, now));
  if (archived.length > 0) groups.push({ bucket: 'archived', sessions: archived });
  return groups;
}
