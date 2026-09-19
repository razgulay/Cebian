// Scheduler sidepanel channel — pub/sub bridge cho BG → sidepanel result push。
//
// Pattern mirror `lib/recorder/sidepanel-channel.ts` + `lib/mcp/sidepanel-channel.ts`：
//   - port 由 useBackgroundAgent 持有，channel 只接 setPort(p) / setPort(null)，
//     不直接 chrome.runtime.connect。
//   - subscribers 通过 subscribeSnapshot(l) 注册，l 收 `(taskId, result)` payload。
//   - fanout 总是全推（broadcastAll 已经在 BG manager 端做）；channel 只负责
//     fanout 到所有订阅者 + 保留 lastResult 给首次 mount 的订阅者做首帧同步。

import type { RunResult } from './types';

export interface SchedulerResultEvent {
  /** 触发本次 result 的 task id。订阅者据此把 result 落到 UI 上对应行。 */
  taskId: string;
  /** Task 在 BG 域 runTask 完出来的 RunResult（结构见 types.ts）。 */
  result: RunResult;
  /** 该 result 是来自 run_now 手动触发，还是 alarm tick 自动触发。 */
  source: 'manual' | 'tick';
}

type ResultListener = (event: SchedulerResultEvent) => void;

const resultListeners = new Set<ResultListener>();

/** Last result per task id. `setResult` 写、订阅者 mount 时读。 */
const lastResults = new Map<string, SchedulerResultEvent>();

let portRef: chrome.runtime.Port | null = null;

function fanout(event: SchedulerResultEvent): void {
  for (const l of resultListeners) {
    try {
      l(event);
    } catch (err) {
      console.warn('[schedulerChannel] result listener threw:', err);
    }
  }
}

/** Called by BG-side channel wiring after a task finishes. Idempotent — fanout
 *  把同一个 event 给所有订阅者；每个订阅者各自决定是否消费。
 *
 *  BG 端调用：BG `broadcastAll({type:'scheduler_result', ...})` 把 wire 形态推到所有
 *  sidepanel；UI 端 `useBackgroundAgent.handleMessage` 收到后直接调用本方法——
 *  跨 bundle 跨 context 的事件桥就是 BG 的 `broadcastAll` → sidepanel hook 这条线。
 *  之前想再加一层 `handleResult` indirection 让 wire shape 变化时只改一处，但 wire
 *  跟本地形状目前完全相同——抽象过早。 */
export function publishResult(event: SchedulerResultEvent): void {
  lastResults.set(event.taskId, event);
  fanout(event);
}

export const schedulerChannel = {
  /** Hook the BG port into the channel. Mirrors recorderChannel.setPort pattern. */
  setPort(p: chrome.runtime.Port | null): void {
    if (portRef === p) return;
    portRef = p;
    if (p == null) {
      // disconnect 清缓存——BG 重启后旧 lastResult 没意义，订阅者下次拿首帧应
      // 走 BG 的 fresh fetch（list 接口在重连时调一次）。
      lastResults.clear();
    }
  },

  isConnected(): boolean {
    return portRef != null;
  },

  /** 订阅 BG 推送的 task 结果事件。回调签名：`(event) => void`，event 字段
   *  见 `SchedulerResultEvent`。返回取消订阅函数。订阅时**不**自动 replay lastResults
   *  ——首帧同步由调用方（UI 组件）在 mount 时显式读 `getLastResults()`，与 canvas 通道
   *  同样的「per-session 状态不在 subscribe 里重放」约定。 */
  subscribeResult(l: ResultListener): () => void {
    resultListeners.add(l);
    return () => {
      resultListeners.delete(l);
    };
  },

  /** 列出当前缓存的所有 task 结果（按 taskId 索引）。订阅者 mount 时调一次
   *  做首帧同步，避免「订阅到空 → BG 又推一遍」的双重路径。 */
  getLastResults(): ReadonlyMap<string, SchedulerResultEvent> {
    return lastResults;
  },
};
