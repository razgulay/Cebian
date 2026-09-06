import { describe, it, expect } from 'vitest';
import { rangeBetween, visibleOrder } from '@/components/layout/history-selection';
import type { SessionGroup } from '@/components/layout/history-grouping';
import type { SessionMeta } from '@/lib/ipc/protocol';

function group(bucket: SessionGroup['bucket'], ids: string[]): SessionGroup {
  return { bucket, sessions: ids.map((id) => ({ id }) as SessionMeta) };
}

const GROUPS: SessionGroup[] = [
  group('pinned', ['p1', 'p2']),
  group('today', ['t1', 't2', 't3']),
  group('archived', ['a1']),
];

describe('visibleOrder', () => {
  it('按渲染顺序拼接展开分组的 id', () => {
    expect(visibleOrder(GROUPS, ['pinned', 'today', 'archived'])).toEqual([
      'p1', 'p2', 't1', 't2', 't3', 'a1',
    ]);
  });

  // 折叠分组里的会话用户根本看不见，区间跨过去时不能把它们捎上。
  it('折叠的分组整个不计入', () => {
    expect(visibleOrder(GROUPS, ['pinned', 'today'])).toEqual(['p1', 'p2', 't1', 't2', 't3']);
    expect(visibleOrder(GROUPS, ['today'])).toEqual(['t1', 't2', 't3']);
    expect(visibleOrder(GROUPS, [])).toEqual([]);
  });
});

describe('rangeBetween', () => {
  const ORDER = ['a', 'b', 'c', 'd', 'e'];

  it('含两端，正序 / 逆序结果一致', () => {
    expect(rangeBetween(ORDER, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(ORDER, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('两端相同 → 只有它自己', () => {
    expect(rangeBetween(ORDER, 'c', 'c')).toEqual(['c']);
  });

  it('整段', () => {
    expect(rangeBetween(ORDER, 'a', 'e')).toEqual(ORDER);
  });

  // 锚点失效（分组刚被折叠 / 会话刚被别的窗口删掉）时必须返回 null 而非硬凑一段：
  // 调用方靠这个 null 判断「该换锚点了」，否则失效锚点会一直卡住后续所有区间选择。
  it('任一端不在可见列表里 → null', () => {
    expect(rangeBetween(ORDER, 'zzz', 'c')).toBeNull();
    expect(rangeBetween(ORDER, 'a', 'zzz')).toBeNull();
    expect(rangeBetween([], 'a', 'b')).toBeNull();
  });
});
