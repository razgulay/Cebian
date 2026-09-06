// Hook: 历史面板的会话列表状态。
//
// 不持有端口——请求与广播都走 `sessionListChannel`，它复用 useBackgroundAgent 那一条
// 端口（见 lib/ipc/protocol.ts 顶部「一个 UI 实例只开一条端口」的约定）。
//
// 所有写操作都是批量形态（单条 = 长度 1 的数组），与后台 IPC 一致，UI 侧也就不必为
// 「单条」和「多选」各维护一套路径。

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { sessionListChannel } from '@/lib/agent/session-list-channel';
import type { SessionPlacement } from '@/lib/persistence/db';
import type { SessionMeta } from '@/lib/ipc/protocol';
import { t } from '@/lib/i18n';

/** 拉列表的兜底超时：后台没响应时也要把 loading 收掉，不能让面板一直转圈。 */
const LIST_TIMEOUT_MS = 5_000;

/** 把一批会话的位置字段就地改成 `placement` 描述的样子。规则的正主是 db.ts 的
 *  `updateSessionPlacement`（互斥 + 用「键不存在」而非 undefined 表示未设置），这里是它
 *  的乐观镜像；改那边的语义时这里要跟上。 */
function applyPlacement(
  sessions: SessionMeta[],
  ids: string[],
  placement: SessionPlacement,
  now: number,
): SessionMeta[] {
  const target = new Set(ids);
  return sessions.map((session) => {
    if (!target.has(session.id)) return session;
    const { pinnedAt: _pinnedAt, archivedAt: _archivedAt, ...rest } = session;
    if (placement === 'pinned') return { ...rest, pinnedAt: now };
    if (placement === 'archived') return { ...rest, archivedAt: now };
    return rest;
  });
}

interface SessionListApi {
  /** 会话列表，按 `updatedAt` 倒序（后台 `session_list` 的顺序，原样保留）。 */
  sessions: SessionMeta[];
  loading: boolean;
  /** 删除若干会话：本地先摘掉（乐观），再请后台做 VFS / DB / agent 的真正清理。
   *  返回请求是否真的发出去了——端口断着时返回 false，调用方据此决定要不要做
   *  跳转之类的后续动作。 */
  remove: (sessionIds: string[]) => boolean;
  /** 置顶 / 归档 / 恢复普通。同样先本地乐观更新，再发请求。 */
  setPlacement: (sessionIds: string[], placement: SessionPlacement) => boolean;
}

/** `active` 为 true 时订阅列表并拉取一次；转 false 时退订。 */
export function useSessionList(active: boolean): SessionListApi {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;

    setLoading(true);
    const timeout = setTimeout(() => {
      console.warn('[history] session_list timed out');
      setLoading(false);
    }, LIST_TIMEOUT_MS);

    // subscribeList 订阅当下就会请求一次；端口断线重连后 channel 也会自动补拉。
    const unsubscribeList = sessionListChannel.subscribeList((next) => {
      setSessions(next);
      clearTimeout(timeout);
      setLoading(false);
    });
    // 别的窗口删掉 / 改过位置的会话，本地也要跟上（后台是广播给所有端口的）。
    const unsubscribeDeleted = sessionListChannel.subscribeDeleted((ids) => {
      const gone = new Set(ids);
      setSessions((prev) => prev.filter((s) => !gone.has(s.id)));
    });
    // 写操作失败：本地已经乐观改过了，必须把权威列表拉回来，否则界面会永久停在一个
    // 库里并不存在的状态上（比如少掉几条其实还在的会话）。同时如实告诉用户没成。
    const unsubscribeWriteFailed = sessionListChannel.subscribeWriteFailed((op, ids, message) => {
      console.warn('[history] session write failed:', op, ids, message);
      toast.error(op === 'delete' ? t('common.session.deleteFailed') : t('common.session.placementFailed'));
      sessionListChannel.refresh();
    });
    const unsubscribePlacement = sessionListChannel.subscribePlacement((ids, placement) => {
      setSessions((prev) => applyPlacement(prev, ids, placement, Date.now()));
    });
    // 后台拉列表失败：立刻收掉 loading，不让面板干转到超时。
    const unsubscribeError = sessionListChannel.subscribeError((message) => {
      console.warn('[history] session list error:', message);
      clearTimeout(timeout);
      setLoading(false);
    });

    return () => {
      clearTimeout(timeout);
      unsubscribeList();
      unsubscribeDeleted();
      unsubscribeWriteFailed();
      unsubscribePlacement();
      unsubscribeError();
      setLoading(false);
    };
  }, [active]);

  const remove = useCallback((sessionIds: string[]) => {
    // 只有请求确实发出去了才乐观摘除；端口断着时保持列表原样，免得会话从界面上消失
    // 却根本没被删掉。
    if (sessionIds.length === 0 || !sessionListChannel.delete(sessionIds)) return false;
    const gone = new Set(sessionIds);
    setSessions((prev) => prev.filter((s) => !gone.has(s.id)));
    return true;
  }, []);

  const setPlacement = useCallback((sessionIds: string[], placement: SessionPlacement) => {
    if (sessionIds.length === 0 || !sessionListChannel.setPlacement(sessionIds, placement)) {
      return false;
    }
    // 本地时间戳只用于立刻重排；后台落库的是它自己的 now，随后的广播会覆盖过来。
    setSessions((prev) => applyPlacement(prev, sessionIds, placement, Date.now()));
    return true;
  }, []);

  return { sessions, loading, remove, setPlacement };
}
