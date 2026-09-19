// VFS 标签页 → BG 的 canvas 打开请求发送端（「Open in Canvas」按钮）。
//
// vfs.html 是独立扩展页，没有 sidepanel 那条常驻 CLIENT_PORT；这里懒连接一条
// 同名端口——BG 的 port-registry / client-router 对所有 CLIENT_PORT 一视同仁，
// `canvas_open` handler（entrypoints/background/canvas/client-handlers.ts）
// 直接复用，零新增 BG 代码。端口在首次点击时建立、随页面生命周期存续
// （用户点完即切回 sidepanel，无需主动断开；tab 关闭端口自灭）。
//
// 失败路径：`canvas_open` 是 fire-and-forget（与 sidepanel 侧同一契约）——BG
// 失败经路由层回 `error` ServerMessage，本页没有 chat 错误面板可承接，调用方
// 在点击时乐观 toast；失败（罕见：文件被并发删除）静默。

import { CLIENT_PORT, type ClientMessage } from '@/lib/ipc/protocol';

let port: chrome.runtime.Port | null = null;

function lazyPort(): chrome.runtime.Port {
  if (port == null) {
    port = chrome.runtime.connect({ name: CLIENT_PORT });
    port.onDisconnect.addListener(() => {
      port = null;
    });
  }
  return port;
}

/** 请求 BG 把文件打开到 sidepanel 的 canvas pane。调用方负责先弹
 *  `canvasPanelOpen.setValue(true)`（面板开合状态，App 侧 watch 实时跟上）
 *  与成功 toast——本函数只管投递消息。 */
export function requestOpenInCanvas(sessionId: string, path: string): void {
  lazyPort().postMessage({
    type: 'canvas_open',
    sessionId,
    path,
  } satisfies ClientMessage);
}
