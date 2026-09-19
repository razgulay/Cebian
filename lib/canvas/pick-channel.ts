// Canvas Pick Element 的 UI 侧 pub/sub：CanvasPane（预览半边）publish 用户
// 刚拾取的元素，ChatInput（输入半边）subscribe 后挂成附件 chip。
//
// 为什么不走 React props / context：两个组件分属 split-view 的两半
// （App.tsx 的两个 Panel），中间隔着 ChatPage——prop drilling 得穿过一个
// 与此无关的组件。模块级 channel 是本仓既定模式（recorderChannel /
// schedulerChannel / canvasToolChannel 同款）：发布方与订阅方互不持有引用，
// ChatInput 未挂载时 publish 是无害 no-op。
//
// 载荷在发布前已由 CanvasPane 用 `normalizePick` 清洗（见 element-inspect.ts，
// 内层跑的是用户 HTML、payload 不可信）——订阅方拿到即可信任的字段，不需要
// 重复校验。

import type { CanvasElementPick } from './element-inspect';

/** 一次拾取事件的载荷。`canvasPath` 是拾取时刻正在预览的 VFS 文件，在
 *  publish 那一刻定死；发送时文件内容可能已被 agent 改写——attachment
 *  描述的是「用户当时点中的东西」，这是有意的语义。 */
export interface CanvasPickEvent {
  pick: CanvasElementPick;
  canvasPath: string;
}

type PickListener = (event: CanvasPickEvent) => void;

const listeners = new Set<PickListener>();

export const canvasPickChannel = {
  /** CanvasPane 在收到 `canvas-element-picked` 并清洗通过后调用。 */
  publish(event: CanvasPickEvent): void {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        // 与 sidepanel-channel 的 fanoutSnapshot 同款守则：一个订阅者崩了
        // 不能拖垮其余订阅者，也不能把异常冒泡回 window message 处理器。
        console.warn('[canvas-pick] subscriber threw:', err);
      }
    }
  },

  /** ChatInput mount 时订阅；返回退订函数，React effect cleanup 直用。 */
  subscribe(fn: PickListener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
