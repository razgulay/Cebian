import { describe, it, expect } from 'vitest';
import { groupSessions, type SessionGroup } from '@/components/layout/history-grouping';
import type { SessionMeta } from '@/lib/ipc/protocol';

/** 固定「现在」= 2026-06-15 12:00 本地时间，让自然日边界可预期。 */
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function session(id: string, updatedAt: number, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    model: 'm',
    provider: 'p',
    userInstructions: '',
    thinkingLevel: 'medium',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    ...extra,
  } as SessionMeta;
}

function shape(groups: SessionGroup[]): [string, string[]][] {
  return groups.map((g) => [g.bucket, g.sessions.map((s) => s.id)]);
}

describe('groupSessions', () => {
  it('置顶在最前、已归档在最后，普通会话按时间分组夹在中间', () => {
    const groups = groupSessions(
      [
        session('pin', NOW - 40 * DAY, { pinnedAt: 1 }),
        session('today', NOW - 60 * 1000),
        session('old', NOW - 40 * DAY),
        session('arch', NOW - 60 * 1000, { archivedAt: 1 }),
      ],
      NOW,
    );
    expect(shape(groups)).toEqual([
      ['pinned', ['pin']],
      ['today', ['today']],
      ['older', ['old']],
      ['archived', ['arch']],
    ]);
  });

  it('置顶的会话不再出现在时间分组里，哪怕它就是今天更新的', () => {
    const groups = groupSessions([session('a', NOW - 1000, { pinnedAt: 5 })], NOW);
    expect(shape(groups)).toEqual([['pinned', ['a']]]);
  });

  it('置顶组按 pinnedAt 倒序；同刻（批量置顶）退回 updatedAt 倒序', () => {
    const groups = groupSessions(
      [
        session('older-pin', NOW, { pinnedAt: 100 }),
        session('batch-b', NOW - 2000, { pinnedAt: 300 }),
        session('batch-a', NOW - 1000, { pinnedAt: 300 }),
      ],
      NOW,
    );
    expect(shape(groups)).toEqual([['pinned', ['batch-a', 'batch-b', 'older-pin']]]);
  });

  it('空分组不出现', () => {
    expect(shape(groupSessions([session('a', NOW)], NOW))).toEqual([['today', ['a']]]);
    expect(groupSessions([], NOW)).toEqual([]);
  });

  it('普通会话保持传入的 updatedAt 倒序，不重排', () => {
    const groups = groupSessions(
      [session('a', NOW - 1000), session('b', NOW - 2000), session('c', NOW - 3000)],
      NOW,
    );
    expect(shape(groups)).toEqual([['today', ['a', 'b', 'c']]]);
  });

  it('时间边界：今天 / 7 天内 / 30 天内 / 更早（按自然日切）', () => {
    const startOfToday = new Date(NOW).setHours(0, 0, 0, 0);
    const groups = groupSessions(
      [
        session('today', startOfToday),
        session('week', startOfToday - 1),
        session('week-edge', startOfToday - 6 * DAY),
        session('month', startOfToday - 6 * DAY - 1),
        session('month-edge', startOfToday - 29 * DAY),
        session('older', startOfToday - 29 * DAY - 1),
      ],
      NOW,
    );
    expect(shape(groups)).toEqual([
      ['today', ['today']],
      ['week', ['week', 'week-edge']],
      ['month', ['month', 'month-edge']],
      ['older', ['older']],
    ]);
  });

  // 互斥由后台唯一写入点保证；脏数据也不该让一条会话同时出现在两组里。
  it('两个标记都有的脏数据 → 只进置顶组', () => {
    const groups = groupSessions([session('a', NOW, { pinnedAt: 1, archivedAt: 2 })], NOW);
    expect(shape(groups)).toEqual([['pinned', ['a']]]);
  });
});
