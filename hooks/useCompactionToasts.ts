// useCompactionToasts — sidepanel hook that surfaces BG `compaction_skipped`
// broadcasts as Sonner toasts.
//
// Module-level singleton: install the subscriber once regardless of how many
// components mount `useCompactionToasts()`. Without this, every consumer would
// register its own listener and a single `compaction_skipped` broadcast
// would fire N toasts. The channel lives for the sidepanel's lifetime so
// we never need to tear this down.
//
// Pattern cloned from `useRecorder.installRejectionToastsOnce` (hooks/useRecorder.ts:51-63).
// Distinct hook (not folded into useRecorder) because the surface owner is
// unrelated — recorder rejection is about the toolbar button, compaction
// skip is about the chat composer surface.

import { useEffect } from 'react';
import { toast } from 'sonner';
import { compactionChannel } from '@/lib/agent/compaction-sidepanel-channel';
import { t } from '@/lib/i18n';

let installed = false;

function installCompactionToastsOnce(): void {
  if (installed) return;
  installed = true;
  compactionChannel.subscribeSkipped(({ tokens, contextWindow }) => {
    // `contextWindow` 在极端情况下可能为 0（自定义模型尚未配齐），做一下守卫
    // 避免除零产生 NaN 写到 toast 文案里。
    const pct = contextWindow > 0 ? Math.round((tokens / contextWindow) * 100) : 0;
    toast.warning(t('chat.session.compactionSkipped.toast', [String(pct)]));
  });
}

/** 在挂载时把 compaction_skipped 的 toast 订阅装好；整个 sidepanel 只需装一次，
 *  重渲染安全（installed flag 守住）。调用方一般在 chat composer / 消息流
 *  等「会一直挂着」的组件里调一下即可。 */
export function useCompactionToasts(): void {
  useEffect(() => {
    installCompactionToastsOnce();
  }, []);
}
