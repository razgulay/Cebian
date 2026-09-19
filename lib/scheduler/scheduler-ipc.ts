// Scheduler 域跨 context IPC helper —— `lib/scheduler/` 与 `hooks/useScheduledTasks.ts`
// 共享的 `chrome.runtime.sendMessage` 包装。
//
// 原先在 `lib/scheduler/tool-scheduler.ts` (ST-B7) 和 `hooks/useScheduledTasks.ts`
// (ST-B5) 两处各有一份 byte-equivalent 实现 —— ST-B8 提取到此文件，consumer 改成
// import，避免「lib → hooks」边界无法 import 的限制反过来被复制绕过。

import type { ClientMessage, ServerMessage } from '@/lib/ipc/protocol';

function isError(msg: ServerMessage): msg is Extract<ServerMessage, { type: 'error' }> {
  return msg.type === 'error';
}

/** Send a scheduler_* IPC message and await the matching reply.
 *  BG handlers in `entrypoints/background/scheduler/client-handlers.ts` reply with
 *  one of:
 *    - `scheduler_list_result` (list / create / update / delete / run_now 路径)
 *    - `scheduler_create_result` (create 路径，新任务 id + 镜像 task)
 *    - `error` (validation fail / task not found / runtime fail)
 *
 *  `predicate` 让调用方拿到窄化的 wire shape；其余形状视为协议漂移抛错。 */
export function sendAndReceive<T extends ServerMessage>(
  msg: ClientMessage,
  predicate: (m: ServerMessage) => m is T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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
      const m = response as ServerMessage;
      if (predicate(m)) resolve(m);
      else if (isError(m)) reject(new Error(m.error));
      else reject(new Error(`IPC returned unexpected ${m.type}`));
    });
  });
}

/** Type predicate for `scheduler_list_result` (reply to list / create / update / delete / run_now). */
export function isSchedulerListResult(msg: ServerMessage): msg is Extract<ServerMessage, { type: 'scheduler_list_result' }> {
  return msg.type === 'scheduler_list_result';
}

/** Type predicate for `scheduler_channel_test_result` (reply to scheduler_test_channel). */
export function isSchedulerChannelTestResult(
  msg: ServerMessage,
): msg is Extract<ServerMessage, { type: 'scheduler_channel_test_result' }> {
  return msg.type === 'scheduler_channel_test_result';
}

/** Type predicate for `scheduler_create_result` (BG 直接告知新 task 的 id + 镜像 task 形状)。 */
export function isSchedulerCreateResult(msg: ServerMessage): msg is Extract<ServerMessage, { type: 'scheduler_create_result' }> {
  return msg.type === 'scheduler_create_result';
}
