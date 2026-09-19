// Sidepanel-side channel for Canvas Live Artifacts.
//
// Pattern mirrors `lib/recorder/sidepanel-channel.ts`: the port itself is
// owned by `useBackgroundAgent`; this module is a small bridge so the
// CanvasPane component can subscribe to canvas events without coupling
// to the agent hook's internals, plus one outbound fire-and-forget command
// （`openFile`——chat 链接拦截的打开请求）. (mcp's channel is different — it
// serves request/response round-trips, not pub/sub snapshots — so it's the
// right shape for one domain and not the other.)
//
// Per-instance identity (used by BG to scope broadcasts) lives in
// `lib/ipc/instance-id.ts` — global app-wide concern, not specific to
// canvas.
//
// Message flow:
//   BG → sidepanel:
//   1. `canvas_state`        —— 订阅 / 重连时 BG 推的初始帧（也用于「画布关闭」）
//   2. `canvas_opened`       —— agent `canvas_open` 工具触发，广播给本 session 的 viewer
//   3. `canvas_file_changed` —— VFS 写入命中正被打开的路径，广播给本 session 的 viewer
//   sidepanel → BG:
//   4. `canvas_open`         —— `openFile`：chat 链接指向 VFS `.html` 时的打开请求
//
// 三种消息在 channel 内部统一收敛成 `CanvasSnapshot`（见 `./types.ts`），
// 订阅者只关心一个状态形状——不必自己判别是哪一种 wire 消息。原始 wire 消息
// 类型在 `./protocol.ts`，跨 context 的全集在 `lib/ipc/protocol.ts`。
//
// **Active session 与 broadcastAll 的协作。** BG canvas manager 用
// `broadcastAll` 而非 `broadcastToViewers`（避免跨 capability import chat/
// viewers.ts，详见 `entrypoints/background/canvas/manager.ts` 文件头注释）。
// 这意味着 wire 上可能捎来「别的 session」的事件——channel 不知道自己当前
// 关心哪个 session 时会把它直接写进 `lastSnapshot`，造成缓存污染。
// 解法：调用方在 chat session 切换时调 `setActiveSession(sessionId)` 显式
// 声明「我现在关心这个 session」；channel 仅缓存匹配该 sessionId 的事件。
// `setActiveSession(null)` 进入「不锁」模式——任何 session 都缓存（用于
// 还没拿到 chat sessionId 的早期 mount 阶段）。

import type { ClientMessage } from '@/lib/ipc/protocol';
import type { CanvasServerMessage } from './protocol';
import type { CanvasSnapshot, OpenCanvasFile } from './types';

type SnapshotListener = (snapshot: CanvasSnapshot) => void;

// ─── 状态 ───

const snapshotListeners = new Set<SnapshotListener>();

/** 调用方声明的「当前关心的 session」。`null` = 不锁，缓存任何 session 的事件。
 *  ST-A5 / `useBackgroundAgent` 在 chat sessionId 变化时同步更新此值。 */
let activeSessionId: string | null = null;

/** 最近一次匹配 `activeSessionId`（或 `activeSessionId === null` 时任何 session）
 *  的快照——`setActiveSession` 时清空（旧 session 的快照对新区无意义）。 */
let lastSnapshot: CanvasSnapshot | null = null;

let portRef: chrome.runtime.Port | null = null;

// ─── helpers ───

/** 当前 wire 事件是否应该被 channel 缓存：要么 activeSessionId 未锁，要么匹配。 */
function matchesActive(sessionId: string): boolean {
  return activeSessionId === null || activeSessionId === sessionId;
}

/** 从 wire message 还原 `OpenCanvasFile`。`updatedAt` 用本地时钟打点——wire
 *  上没必要带这个，sidepanel 之间不同步时间戳。 */
function toOpenFile(path: string, content: string): OpenCanvasFile {
  return { path, content, updatedAt: Date.now() };
}

function fanoutSnapshot(snapshot: CanvasSnapshot): void {
  for (const l of snapshotListeners) {
    try {
      l(snapshot);
    } catch (err) {
      console.warn('[canvasChannel] snapshot listener threw:', err);
    }
  }
}

// ─── 公开 API ───

export const canvasChannel = {
  /** 由 `useBackgroundAgent` 在 `connect()` / `handleDisconnect` 时调用——
   *  把当前 port 交给 channel，让它能跟 BG 对话。传 `null` 表示连接已断，
   *  channel 清空最近快照 + activeSessionId——但不推 disconnect fanout，订阅者
   *  自己通过 `isConnected()` 判断。React 思维下让订阅者合并「连接态 + 上一次的
   *  快照」比推一个混淆「正常关闭」与「连接断开」的 magic sentinel 更直观。
   *
   *  null 路径每次调用都重置状态（不早 return）——保证「portRef 已 null 但
   *  activeSessionId 仍残留」的边界（测试可重现；生产上 useBackgroundAgent 不会
   *  触发，但每次 disconnect 是干净重置更安全）。非 null 同 portRef 重复调用仍是
   *  no-op，仅赋值。 */
  setPort(p: chrome.runtime.Port | null): void {
    portRef = p;
    if (p == null) {
      lastSnapshot = null;
      activeSessionId = null;
    }
  },

  /** 当前是否连着 BG。CanvasPane 在断线时降级到「等连接恢复」态。 */
  isConnected(): boolean {
    return portRef != null;
  },

  /** 声明 channel 当前关心的 session（由 `useBackgroundAgent` 在 chat sessionId
   *  变化时调）。`null` 表示「不锁」，channel 缓存任何 session 的事件。
   *
   *  切到新 session 时清空旧 lastSnapshot——旧 session 的 openFile 对新区没
   *  意义，让 UI 重新走「先订阅再收到首帧」的常规路径。 */
  setActiveSession(sessionId: string | null): void {
    if (activeSessionId === sessionId) return;
    activeSessionId = sessionId;
    lastSnapshot = null;
  },

  /**
   * UI 主动请求把 VFS 文件打开到 canvas（chat 里 `#/…html` 链接的点击拦截）。
   * fire-and-forget：BG 失败由路由层统一回 `error` ServerMessage（useBackgroundAgent
   * 的错误路径兜底），本方法不等待、不回传结果。port 未连接或 session 未锁定
   * （早期 mount / 非 chat 语境）时静默 no-op——调用方应在此之前用
   * `getActiveSessionId()` 自查并回落默认导航行为。
   */
  openFile(path: string): void {
    if (portRef == null || activeSessionId === null) return;
    portRef.postMessage({
      type: 'canvas_open',
      sessionId: activeSessionId,
      path,
    } satisfies ClientMessage);
  },

  /** 当前关心的 session id（由 setActiveSession 写入）。订阅者用来 fanout 时
   *  做 cross-session 过滤（见 `useCanvasChannel` 注释）。 */
  getActiveSessionId(): string | null {
    return activeSessionId;
  },

  /** 取最近一次的 canvas 快照。空着查「当前 channel 关心的 session 的快照」——
   *  activeSessionId 由 useBackgroundAgent 在 subscribe 时注入；其他 session 的
   *  快照不应该出现在这里（详见文件头 session-scope 与 `setActiveSession`）。 */
  getLastSnapshot(): CanvasSnapshot | null {
    if (!lastSnapshot) return null;
    if (activeSessionId === null) return null;
    if (lastSnapshot.sessionId !== activeSessionId) return null;
    return lastSnapshot;
  },

  /** 订阅 canvas 快照变化。回调签名：`{ sessionId, openFile }`。
   *  - `openFile === null` 表示 canvas 关闭；
   *  - `openFile` 非空时包含 path + 最新内容。
   *  返回取消订阅函数。
   *
   *  订阅时**不**自动重放历史快照——首帧同步走 `getLastSnapshot(sessionId)`。
   *
   *  这里把过滤职责留给订阅者：fanout 会推到所有 listener，listener 自己
   *  比对 `snapshot.sessionId` 与自己的 sessionId 决定是否消费。这与 BG
   *  `broadcastAll` 把事件捎给所有 sidepanel 的事实对齐。 */
  subscribeSnapshot(l: SnapshotListener): () => void {
    snapshotListeners.add(l);
    return () => {
      snapshotListeners.delete(l);
    };
  },

  /** 由 `useBackgroundAgent.handleMessage` 在 switch 窄化之后调用——
   *  BG 推来的 canvas wire 消息统一收敛成 snapshot，再 fanout 给订阅者。
   *  参数类型 `CanvasServerMessage`（见 `./protocol.ts`）让 switch 天然窄
   *  化，不用 cast。 */
  handleMessage(msg: CanvasServerMessage): void {
    switch (msg.type) {
      case 'canvas_state': {
        // canvas_state 是「初始 / 重连帧」，BG 权威描述当前 canvas 状态。
        // `openPath === null` 或缺 `content` 都视为 canvas 对此 session 关闭
        // —— 类型上 `content` 是 nullable，但 BG 的 wire 契约保证
        // `openPath` 非空时 `content` 也非空；这里双字段防御，以防 BG 实现
        // 后续回退或外部 mock 出不一致载荷。
        const snapshot: CanvasSnapshot = {
          sessionId: msg.sessionId,
          openFile:
            msg.openPath != null && msg.content != null
              ? toOpenFile(msg.openPath, msg.content)
              : null,
        };
        if (matchesActive(msg.sessionId)) {
          lastSnapshot = snapshot;
        }
        fanoutSnapshot(snapshot);
        return;
      }
      case 'canvas_opened': {
        // 工具触发的「打开」。缓存条件：与 active session 匹配（或未锁）。
        // 跨 session 的事件仍 fanout 给订阅者，让它们自己 filter。
        const snapshot: CanvasSnapshot = {
          sessionId: msg.sessionId,
          openFile: toOpenFile(msg.path, msg.content),
        };
        if (matchesActive(msg.sessionId)) {
          lastSnapshot = snapshot;
        }
        fanoutSnapshot(snapshot);
        return;
      }
      case 'canvas_file_changed': {
        // VFS 写入命中正被打开的路径的热更新。缓存条件同 canvas_opened——
        // 只有 active session 的更新才覆盖 lastSnapshot；其它 session 的
        // 热更新仅 fanout，不污染 cache。
        const snapshot: CanvasSnapshot = {
          sessionId: msg.sessionId,
          openFile: toOpenFile(msg.path, msg.content),
        };
        if (matchesActive(msg.sessionId)) {
          lastSnapshot = snapshot;
        }
        fanoutSnapshot(snapshot);
        return;
      }
    }
  },
};
