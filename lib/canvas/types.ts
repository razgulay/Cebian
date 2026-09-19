// Canvas Live Artifacts — 域内类型（与 `lib/canvas/protocol.ts` 配套使用）。
//
// `types.ts` 放业务侧类型（订阅者持有的快照形状、文件内容载荷）。
// 跨上下文的 wire 契约在 `lib/ipc/protocol.ts`，按消息类型切片出来的窄类型
// 在 `protocol.ts` —— 三层职责分明：
//   1. `lib/ipc/protocol.ts`   —— ServerMessage / ClientMessage 全集（跨 context 必读）
//   2. `lib/canvas/protocol.ts`—— 仅 canvas 的窄类型导出（channel 消费用）
//   3. `lib/canvas/types.ts`   —— 域内快照 / 内容载荷（订阅者持有的形状）

/** 一份在 canvas 中打开的文件载荷：路径 + 内容 + 最近更新时间。
 *
 *  `updatedAt` 由 sidepanel-channel 在收到推送时打点（`Date.now()`），用于去重
 *  极快连发的「打开 + 立即修改」场景——同一个路径在毫秒级内收到 `canvas_opened`
 *  和 `canvas_file_changed` 时，UI 可用 `updatedAt` 判断哪个更新，避免覆盖更
 *  晚到达的版本。 */
export interface OpenCanvasFile {
  /** VFS 路径（workspace 相对，以 `/` 开头）。 */
  path: string;
  /** 文件原始内容字符串。HTML 直接渲染；jsx/tsx/md 在 v1 走降级路径（横幅提示
   *  + 源码展示），jsx/tsx 的运行时转译留到 v2。 */
  content: string;
  /** 收到此载荷时 sidepanel 端的本地时钟戳（毫秒）。 */
  updatedAt: number;
}

/** 订阅 / 重连时 BG 推送的初始快照：当前 session 的 canvas 是否处于打开状态，
 *  打开的话是哪一个文件。`openFile === null` 表示 canvas 对此 session 关闭。
 *
 *  注意 BG → sidepanel 推送的 `canvas_state` / `canvas_opened` /
 *  `canvas_file_changed` 三种消息形态各异，但 channel 内部统一收敛成这个
 *  `CanvasSnapshot` 给订阅者，UI 只关心一个状态形状。 */
export interface CanvasSnapshot {
  sessionId: string;
  openFile: OpenCanvasFile | null;
}
