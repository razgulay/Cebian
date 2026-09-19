// Canvas 域 ↔ BG 之间的工具侧桥：lib/tools 调 `canvasToolChannel.getOpenCanvas()`
// 拿到 BG 域注入的 `openCanvas` 实现（注册在 `entrypoints/background/canvas/
// manager.ts#setupCanvas()`）。这是把 BG 能力暴露给 lib/ 工具的「lib-no-up-runtime」
// 守门入口：
//
//   - `lib/tools/*` 不能直接 import `entrypoints/background/*`（depcruise
//     `lib-no-up-runtime`）。
//   - `entrypoints/background/canvas/manager.ts` 启动时调
//     `canvasToolChannel.setOpenCanvas(openCanvas)` 把 BG 能力注入 lib 域。
//   - `lib/canvas/tool-canvas-open.ts` 的 execute 读 `getOpenCanvas()` 拿实现。
//
// 与 sidepanel-channel 的 `setPort` 是同一形（BG 启动时跨域注入 handle），
// 但本频道面向 lib/tools 调用而非 sidepanel pub/sub，所以叫 tool-channel。
//
// 失败路径：`getOpenCanvas()` 返回 null —— 通常意味着 BG 启动序列没跑完就
// 跑了工具调用（理论上不该发生）。execute 见到 null 直接抛「Canvas 域未
// 初始化」，让 pi-agent-core 把 isError=true 冒泡给 LLM——而不是吞掉。

import type { OpenCanvasFile } from './types';

type OpenCanvasFn = (sessionId: string, path: string) => Promise<OpenCanvasFile>;

let registered: OpenCanvasFn | null = null;

export const canvasToolChannel = {
  /** 由 BG `setupCanvas()` 在启动序列里调一次。把 BG 域的实现注入 lib 域。
   *  传 `null` 是清空——测试或 SW 重启场景才用，正常运行不会调。 */
  setOpenCanvas(fn: OpenCanvasFn | null): void {
    registered = fn;
  },

  /** 取当前注册的 openCanvas 实现。`null` 表示 BG 还没启动 / 域没注册，
   *  调用方应当把这种情况视为可抛出错误。 */
  getOpenCanvas(): OpenCanvasFn | null {
    return registered;
  },
};
