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
 *  `predicate` 让调用方拿到窄化的 wire shape；其余形状视为协议漂移抛错。
 *
 *  ## Routing
 *
 *  `chrome.runtime.sendMessage` from a MV3 SW to its own onMessage
 *  listener is unreliable: the channel often closes before the async
 *  reply fires ("The message port closed before a response was
 *  received"). The extension-page → SW path works fine, so the sidepanel
 *  and settings UI go through `sendMessage` directly. In-BG callers
 *  (tools running inside the SW) instead use a `SchedulerDirectPlugin`
 *  installed by `setupSchedulerClientHandlers()`, which routes the
 *  message to the same handler map without a port round-trip. */
export function sendAndReceive<T extends ServerMessage>(
  msg: ClientMessage,
  predicate: (m: ServerMessage) => m is T,
): Promise<T> {
  // Direct dispatch: only present when running inside BG after
  // setupSchedulerClientHandlers() has installed the plugin. Sidepanel
  // falls through to the sendMessage path below.
  const plugin = (globalThis as { __schedulerDirectPlugin?: SchedulerDirectPlugin })
    .__schedulerDirectPlugin;
  if (plugin) {
    return plugin(msg, predicate as (m: ServerMessage) => boolean).then((m) => {
      if (predicate(m)) return m;
      if (isError(m)) throw new Error(m.error);
      throw new Error(`IPC returned unexpected ${m.type}`);
    });
  }
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

/** Plugin type: BG installs a dispatcher that walks the registered
 *  handler map, calls the matching port-style handler with a synthetic
 *  port, and returns the captured reply. Sidepanel never installs a
 *  plugin — `sendAndReceive` falls through to `chrome.runtime.sendMessage`. */
export type SchedulerDirectPlugin = (
  msg: ClientMessage,
  predicate: (m: ServerMessage) => boolean,
) => Promise<ServerMessage>;

/** BG-side: register the direct-dispatch plugin so tools running in the
 *  SW can hit the same handler map without the message-port round trip.
 *  Called from `setupSchedulerClientHandlers()`. The plugin reads the same
 *  `schedulerClientHandlers` map the port router uses, so behavior is
 *  identical — we just skip the message-port loop-back. */
export function installSchedulerDirectPlugin(
  plugin: SchedulerDirectPlugin,
): void {
  (globalThis as { __schedulerDirectPlugin?: SchedulerDirectPlugin }).__schedulerDirectPlugin = plugin;
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
