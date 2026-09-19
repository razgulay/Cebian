// Canvas 域 client message handlers —— `canvas_open`（chat 链接拦截）：
// sidepanel 的 MarkdownRenderer 把指向 VFS `.html` 的链接点击转成本消息，BG 调
// `openCanvas` 读文件并广播 `canvas_opened`，CanvasPane 即时渲染。BG 域在
// `entrypoints/background/index.ts` 启动序列里调 `setupCanvasClientHandlers()`
// 注册（必须在 `setupClientRouter()` 之前——路由器启动时校验全集覆盖）。
//
// 失败路径：`openCanvas` 抛错（ENOENT 等）由 client-router 的通用 catch 转成
// `error` ServerMessage 回发起端口——本文件不重复包装。空串守门是防御 wire 上
// 的坏载荷（类型标注是假设不是保证），错误信息走同一条 error 路径。

import { registerClientHandlers, type ClientHandlerMap } from '../ipc/client-router';
import { openCanvas } from './manager';

export const canvasClientHandlers: ClientHandlerMap = {
  canvas_open: async (_port, msg) => {
    if (typeof msg.sessionId !== 'string' || msg.sessionId.length === 0) {
      throw new Error('canvas_open: sessionId must be a non-empty string.');
    }
    if (typeof msg.path !== 'string' || msg.path.length === 0) {
      throw new Error('canvas_open: path must be a non-empty string.');
    }
    await openCanvas(msg.sessionId, msg.path);
  },
};

/** 注册 canvas 域的 client handlers。幂等性由 router 的重复注册检查兜底——
 *  正常启动序列只调一次。 */
export function setupCanvasClientHandlers(): void {
  registerClientHandlers(canvasClientHandlers);
}
