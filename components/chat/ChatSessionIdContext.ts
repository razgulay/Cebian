// 当前正在查看的 chat session id（React context）。
//
// 由 ChatPage 提供（新会话未落 id / 非 chat 语境时为 null）。目前唯一的消费方
// 是 MarkdownRenderer 的 canvas 链接拦截——MarkdownRenderer 深埋在 Message 树
// 里，prop drilling 要穿多层组件，context 是最小穿线方式。渲染方不在 chat
// 语境（独立 VFS 标签页自己渲染 markdown）时拿到的恒为 null，据此退回默认
// 链接行为。

import { createContext } from 'react';

export const ChatSessionIdContext = createContext<string | null>(null);
