// Sidepanel-side channel for compaction notices.
//
// The port itself is owned by `useBackgroundAgent`; we don't open a second
// port just for compaction. This module is a tiny pub/sub bridge so the
// chat surface can subscribe to `compaction_skipped` broadcasts without
// coupling to the agent hook's internals.
//
// Module placement (AGENTS.md §"lib/ internal organization"): compaction
// is a concept folder under `lib/agent/` that already holds the BG-side
// pure helpers (`compaction.ts`). The sidepanel-side bridge lives here too
// because it's the channel companion of `compaction.ts`. The execution
// context is encoded in the filename (`-sidepanel-channel`), not in a
// folder split.

/** 通知 UI 用的最小负载——只需足以计算「已用百分比」与构造 toast 文案。
 *  IPC payload 里有更完整的元数据（reason / keepRecentTokens / messagesCount），
 *  留给将来可能要的遥测 / 调试；UI 通道只透出前端真用得到的两个数字，
 *  避免无意义地把内部细节扩散到视图层。 */
export interface CompactionSkippedNotice {
  tokens: number;
  contextWindow: number;
}

type SkippedListener = (n: CompactionSkippedNotice) => void;

const skippedListeners = new Set<SkippedListener>();

export const compactionChannel = {
  /** 后台广播 compaction_skipped 时调用，把通知扇出给所有订阅者。
   *  单个 listener 抛错被吞掉，避免一个坏的订阅者打断兄弟 listener
   *  （对齐 recorderChannel 的同款纪律）。 */
  publishSkipped(n: CompactionSkippedNotice): void {
    for (const l of skippedListeners) {
      try {
        l(n);
      } catch (err) {
        console.warn('[compactionChannel] skipped listener threw:', err);
      }
    }
  },

  /** 订阅 compaction_skipped。返回 unsubscribe；调用方一般不需要
   *  （chat 表面挂载即等于 sidepanel 整个生命周期，单例 installed
   *  flag 由 useCompactionToasts 内部管理）。 */
  subscribeSkipped(l: SkippedListener): () => void {
    skippedListeners.add(l);
    return () => {
      skippedListeners.delete(l);
    };
  },
};
