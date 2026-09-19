// React hook: 订阅 BG 的 canvas 状态变化，返回当前活跃 session 的 `CanvasSnapshot`。
//
// 不需要 sessionId 参数——channel 自己用 `activeSessionId`（由 `useBackgroundAgent`
// 在 subscribe 时注入）过滤 `lastSnapshot`；本 hook 只关心「当前 channel 关心的那个」。
// 切换 session 时 `useBackgroundAgent` 会调 `setActiveSession(newId)`，
// 本 hook 下次 fanout 会自动跟着切；如果 setActiveSession 调到了 null（旧会话完结）
// snapshot 也会归 null。
//
// **Cross-session 防御：** channel 在 fanout 时不按 activeSessionId 过滤
// （BG 用 `broadcastAll` 跨所有连接的端口推 canvas 事件，channel 收到的事件
// 可能属于别的 session）。这里再做一次 `getActiveSessionId()` 比对——
// 不匹配就丢弃，保持 UI 始终渲染当前订阅 session 的内容。

import { useEffect, useState } from 'react';
import { canvasChannel } from '@/lib/canvas/sidepanel-channel';
import type { CanvasSnapshot } from '@/lib/canvas/types';

export function useCanvasChannel(): CanvasSnapshot | null {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(
    () => canvasChannel.getLastSnapshot(),
  );

  useEffect(() => {
    setSnapshot(canvasChannel.getLastSnapshot());

    const unsubscribe = canvasChannel.subscribeSnapshot((s) => {
      const active = canvasChannel.getActiveSessionId();
      // active === null → 「不锁」，订阅者收到任何 session 都接受（mount 期
      // 间 chat sessionId 还没到的情况）。active !== null 但 s.sessionId 不
      // 匹配 → 别的 session 的事件，丢弃。
      if (active !== null && s.sessionId !== active) return;
      setSnapshot(s);
    });

    return unsubscribe;
  }, []);

  return snapshot;
}
