// useScheduledTasks — React hook 包装 scheduler IPC CRUD（list / create /
// update / delete / run_now）。通过 `chrome.runtime.sendMessage` 走 IPC，
// BG 端 handlers 在 `entrypoints/background/scheduler/client-handlers.ts`。
//
// 返回的 `tasks` 是 ReactiveList —— mount 后立刻发 list 请求，结果回写后
// 触发 re-render。mutation 后 (create / update / delete) 也会回 list 拿到
// 最新数据再写回。`runNow` 不直接等结果（结果走 BG broadcast → useSchedulerNotifications
// hook 接 Sonner toast），但仍 await IPC reply 拿到发起端口的 ack。

import { useCallback, useEffect, useState } from 'react';
import type { ClientMessage, ServerMessage } from '@/lib/ipc/protocol';
import type { ScheduledTask } from '@/lib/scheduler/types';
import {
  isSchedulerCreateResult,
  isSchedulerListResult,
  sendAndReceive,
} from '@/lib/scheduler/scheduler-ipc';

interface UseScheduledTasks {
  tasks: ScheduledTask[];
  loading: boolean;
  error: string | null;
  createTask: (task: Omit<ScheduledTask, 'id' | 'lastRunAt' | 'lastResult'>) => Promise<{ ok: boolean; error?: string }>;
  updateTask: (id: string, patch: Partial<Pick<ScheduledTask, 'name' | 'schedule' | 'action' | 'notify' | 'enabled'>>) => Promise<{ ok: boolean; error?: string }>;
  deleteTask: (id: string) => Promise<{ ok: boolean; error?: string }>;
  runNow: (id: string) => Promise<{ ok: boolean; error?: string }>;
  refresh: () => Promise<void>;
}

export function useScheduledTasks(): UseScheduledTasks {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reply = await sendAndReceive({ type: 'scheduler_list' }, isSchedulerListResult);
      // wire 形态 tasks 是 unknown[] —— cast 回 ScheduledTask[]。BG 校验过了（ST-B4
      // validate.ts + handler 入口的 try/catch），这里相信 BG。
      setTasks(reply.tasks as unknown as ScheduledTask[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // mount 拉一次
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createTask = useCallback(
    async (task: Omit<ScheduledTask, 'id' | 'lastRunAt' | 'lastResult'>) => {
      try {
        const reply = await sendAndReceive(
          { type: 'scheduler_create', task } as ClientMessage,
          isSchedulerListResult,
        );
        setTasks(reply.tasks as unknown as ScheduledTask[]);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
    [],
  );

  const updateTask = useCallback(
    async (id: string, patch: Partial<Pick<ScheduledTask, 'name' | 'schedule' | 'action' | 'notify' | 'enabled'>>) => {
      try {
        const reply = await sendAndReceive(
          { type: 'scheduler_update', id, patch } as ClientMessage,
          isSchedulerListResult,
        );
        setTasks(reply.tasks as unknown as ScheduledTask[]);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
    [],
  );

  const deleteTask = useCallback(async (id: string) => {
    try {
      const reply = await sendAndReceive(
        { type: 'scheduler_delete', id } as ClientMessage,
        isSchedulerListResult,
      );
      setTasks(reply.tasks as unknown as ScheduledTask[]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }, []);

  const runNow = useCallback(async (id: string) => {
    try {
      // run_now 的 ack 是 list（即使失败也是 list——成功 → 完整列表，失败 → error）。
      // 实际结果通过 scheduler_result broadcast 推过来，由 useSchedulerNotifications 接住。
      await sendAndReceive(
        { type: 'scheduler_run_now', id } as ClientMessage,
        isSchedulerListResult,
      );
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }, []);

  return { tasks, loading, error, createTask, updateTask, deleteTask, runNow, refresh };
}
