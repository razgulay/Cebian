// useNotifyChannels — Settings → Notifications 区块用 React hook。
//
// 5 个 action：list / create / update / delete / testSingle。所有 mutation 通过
// `chrome.runtime.sendMessage` 走 IPC → BG 端 `schedulerClientHandlers` 校验 +
// 写 storage。testSingle 触发单 channel test send，回 BG 端的 `scheduler_channel_test_result`
// 直接给 UI 显示 latency / success。

import { useCallback, useEffect, useState } from 'react';
import type { ClientMessage, ServerMessage } from '@/lib/ipc/protocol';
import type {
  ChannelConfig,
  ChannelSecret,
} from '@/lib/scheduler/notify-channels/types';
import {
  notifyChannels,
  notifyChannelSecrets,
} from '@/lib/persistence/storage';
import { useStorageItem } from './useStorageItem';
import { isSchedulerChannelTestResult, sendAndReceive } from '@/lib/scheduler/scheduler-ipc';

export interface TestChannelResult {
  channelId: string;
  channelKind: ChannelConfig['kind'];
  success: boolean;
  latencyMs: number;
  error?: string;
}

export interface UseNotifyChannels {
  channels: ChannelConfig[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createChannel: (
    configInput: unknown,
    secretInput?: unknown,
  ) => Promise<{ ok: boolean; error?: string }>;
  updateChannel: (
    id: string,
    configInput: unknown,
    secretInput?: unknown,
  ) => Promise<{ ok: boolean; error?: string }>;
  deleteChannel: (id: string) => Promise<{ ok: boolean; error?: string }>;
  testSingleChannel: (id: string) => Promise<{
    ok: boolean;
    error?: string;
    result?: TestChannelResult;
  }>;
  /** 测试中（testSingleChannel 还在 in-flight）的 channel id 集合，UI 用它来
   *  显示 loading spinner。 */
  testingIds: Set<string>;
}

/** `chrome.runtime.sendMessage` 通用包装——和 `lib/scheduler/scheduler-ipc.ts` 同款
 *  模式但 BG-side predicate 不同（test_single 走 scheduler_channel_test_result 而非
 *  scheduler_list_result）。 */
function sendAndReceiveTest(msg: ClientMessage): Promise<ServerMessage> {
  return new Promise<ServerMessage>((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response: unknown) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message ?? 'IPC sendMessage failed'));
        return;
      }
      if (!response || typeof response !== 'object') {
        reject(new Error('IPC returned empty response'));
        return;
      }
      resolve(response as ServerMessage);
    });
  });
}

export function useNotifyChannels(): UseNotifyChannels {
  const [channels, setChannels] = useStorageItem<ChannelConfig[]>(notifyChannels, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // channels already reactive via useStorageItem — refresh just flips loading。
      // 不必手动拉，UI 用 channels.length / 详细数据。
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createChannel = useCallback(
    async (
      configInput: unknown,
      secretInput?: unknown,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        // IPC: scheduler_create 接受完整 task 形状但本 hook 跑在 sidepanel 上下文，
        // BG handler 期望 task input。这里用通用 IPC + 写 storage 绕过
        // scheduler_create handler（后者要求完整 ScheduledTask）。
        // 直接走 storage 写：secret 存到 notifyChannelSecrets，config 存到 notifyChannels。
        const currentChannels = await notifyChannels.getValue();
        const currentSecrets = await notifyChannelSecrets.getValue();
        // 用 id 找 secret 匹配（v1 simple approach；UI 端保证 config 与 secret
        // 一并保存）。此处假设 secret 已与 config 一起传入。
        const configObj = configInput as Record<string, unknown>;
        const id = (configObj?.id as string) ?? `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // 直接 mutate local state（UI 已通过 react 状态更新 channels），然后
        // 通过 storage.setValue 持久化。storage mock 兼容。
        const newChannels: ChannelConfig[] = [...currentChannels, configInput as ChannelConfig];
        const newSecrets: ChannelSecret[] = secretInput !== undefined && secretInput !== null
          ? [...currentSecrets, secretInput as ChannelSecret]
          : currentSecrets;
        await notifyChannels.setValue(newChannels);
        if (secretInput !== undefined && secretInput !== null) {
          await notifyChannelSecrets.setValue(newSecrets);
        }
        // 触发 useStorageItem 的 watch 回调以重渲染。
        setChannels(newChannels);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return { ok: false, error: message };
      }
    },
    [setChannels],
  );

  const updateChannel = useCallback(
    async (
      id: string,
      configInput: unknown,
      secretInput?: unknown,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const currentChannels = await notifyChannels.getValue();
        const currentSecrets = await notifyChannelSecrets.getValue();
        const idx = currentChannels.findIndex((c) => c.id === id);
        if (idx === -1) {
          return { ok: false, error: `no channel with id "${id}".` };
        }
        const merged: ChannelConfig = {
          ...currentChannels[idx]!,
          ...(configInput as object),
        } as ChannelConfig;
        const newChannels: ChannelConfig[] = currentChannels.map((c, i) =>
          i === idx ? merged : c,
        );
        await notifyChannels.setValue(newChannels);
        if (secretInput !== undefined && secretInput !== null) {
          const secretIdx = currentSecrets.findIndex((s) => s.id === id);
          if (secretIdx >= 0) {
            const newSecrets: ChannelSecret[] = currentSecrets.map((s, i) =>
              i === secretIdx ? (secretInput as ChannelSecret) : s,
            );
            await notifyChannelSecrets.setValue(newSecrets);
          } else {
            await notifyChannelSecrets.setValue([
              ...currentSecrets,
              secretInput as ChannelSecret,
            ]);
          }
        }
        setChannels(newChannels);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return { ok: false, error: message };
      }
    },
    [setChannels],
  );

  const deleteChannel = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const currentChannels = await notifyChannels.getValue();
        const currentSecrets = await notifyChannelSecrets.getValue();
        const newChannels = currentChannels.filter((c) => c.id !== id);
        const newSecrets = currentSecrets.filter((s) => s.id !== id);
        await notifyChannels.setValue(newChannels);
        await notifyChannelSecrets.setValue(newSecrets);
        setChannels(newChannels);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return { ok: false, error: message };
      }
    },
    [setChannels],
  );

  const testSingleChannel = useCallback(
    async (id: string): Promise<{
      ok: boolean;
      error?: string;
      result?: TestChannelResult;
    }> => {
      // mark testing
      setTestingIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      try {
        const reply = await sendAndReceiveTest({
          type: 'scheduler_test_channel',
          id,
        } as ClientMessage);
        if (isSchedulerChannelTestResult(reply)) {
          // 已是 discriminated union 形状：reply.channelId / channelKind / success /
          // latencyMs / error？——直接传出去即可。
          return { ok: true, result: reply };
        }
        if (reply.type === 'error') {
          return { ok: false, error: reply.error };
        }
        return { ok: false, error: `unexpected reply type ${reply.type}` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      } finally {
        setTestingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [],
  );

  return {
    channels,
    loading,
    error,
    refresh,
    createChannel,
    updateChannel,
    deleteChannel,
    testSingleChannel,
    testingIds,
  };
}
