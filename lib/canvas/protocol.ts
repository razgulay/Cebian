// Canvas 专用 ServerMessage 子集。
//
// 跨 context 的 ServerMessage 全集住在 `lib/ipc/protocol.ts`，那里有二十多种
// 消息混在一起；canvas channel 的消费方只想关心与自己相关的三种（`canvas_state`
// / `canvas_opened` / `canvas_file_changed`），所以本文件按 `Extract` 把它们切
// 出来再 re-export，让 `lib/canvas/sidepanel-channel.ts` 与未来的 hook / 组件
// 可以 `import type { CanvasStateMessage } from './protocol'`，不必每次都去
// 完整 ServerMessage 里挑。
//
// 与 `lib/mcp/sidepanel-channel.ts` 的 handler 形参（`handleResult(msg: Extract<ServerMessage, ...>)`）
// 同形——把 wire 切片成窄类型放在 channel 同目录，让消费方对 `lib/ipc/protocol`
// 的耦合降到「只 import `ServerMessage` 总类型用于本地 union 构造」这一处。

import type { ServerMessage } from '@/lib/ipc/protocol';

/** 订阅 / 重连时 BG 推送的 canvas 状态帧。`openPath === null` 表示当前
 *  session 没有任何 canvas 打开。 */
export type CanvasStateMessage = Extract<ServerMessage, { type: 'canvas_state' }>;

/** Agent 通过 `canvas_open` 工具打开一个文件时 BG 广播的「刚打开」事件。
 *  `content` 是文件在打开时刻的内容，UI 不必再走一次 fetch。 */
export type CanvasOpenedMessage = Extract<ServerMessage, { type: 'canvas_opened' }>;

/** VFS 写入命中一个正被某 viewer 打开着的路径时 BG 广播的热更新事件。载荷
 *  形态与 `CanvasOpenedMessage` 相同——sidepanel 用同一个 handler 渲染两者。 */
export type CanvasFileChangedMessage = Extract<ServerMessage, { type: 'canvas_file_changed' }>;

/** 上面三种的并集，channel `handleMessage` 的参数类型。 */
export type CanvasServerMessage =
  | CanvasStateMessage
  | CanvasOpenedMessage
  | CanvasFileChangedMessage;
