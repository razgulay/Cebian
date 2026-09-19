// chat 域的会话路由：哪个 UI 窗口正在看哪个会话。
//
// 这是 **chat 的业务状态**，不是传输概念 —— `ipc/port-registry.ts` 只认识「一条连接」，
// 不该存一个它不理解的 sessionId。两个问题都由这张表回答：
//   - 广播该发给谁（只发给正在显示这个会话的窗口，避免每个流式帧乘以窗口数）
//   - 最后一个窗口走了没有（没人看着 → agent 吐的字没有落脚处）
//
// 本模块只放状态与投递，**不 import `session-manager`** —— 否则
// session-manager → viewers → session-manager 成运行时环，depcruise 会红。因此
// 「最后一个 viewer 断连后 grace-cancel」这条策略住在 handler 层
// （`chat/client-handlers.ts`），由它调 `stopViewing(port)` 拿到该窗口原本在看的会话
// 再决定。注意只有**断连**会触发 grace-cancel；`unsubscribe` 消息同样调
// `stopViewing`，但忽略返回值（用户还在，只是换了页面）。
//
// ─── 流式 cursor（取代 commit 0822474 的 210ms 时间豁免窗）───
//
// pi-agent-core 把同一段文本先同步写进 partial.content 再 await emit；那条
// microtask 如果排在 subscribe 末尾 await 之后才调度，对应事件就只进了
// session_state 快照、还没进缓冲，trailing 帧到期后把同一段 delta 又投一遍，
// UI 端因此显示 ABCC。旧 fix 用一个 210ms 的豁免窗挡掉这段时间内的 stream_ops，
// 但这只在「trailing 帧在 210ms 内 fire」时有效——一旦 leading 帧刚好赶在
// 窗口快过期时到达、对应 trailing 帧落在窗外，泄漏就复现。
//
// 现在改成内容去重：每个 `tail_append` 自带 (messageId, blockIndex, field,
// startOffset, endOffset)，消费者记下每个端口已经消费的 endOffset；
//   - endOffset ≤ cursor → 已被快照覆盖，整段丢弃
//   - startOffset < cursor < endOffset → 部分重叠，裁掉重叠前缀再下发
//   - 其它 → 原样下发，并把 cursor 推到 endOffset
// 跨轮（cross-turn）隔离实际上是靠 `tail_replace` 在每个新块起始时 reseed
// cursor 实现的：`text_start` / `thinking_start` / `toolcall_start` 都走
// pi-agent-core 的 `message_update` 路径，到达消费者后 `reseedFromReplace`
// 把 fresh partial 对应块的字段长度（通常是 0）写回 cursor，覆盖上一轮同 key
// 的旧值；新块的第一条 delta 因此 cursor=0、原样下发、不会与快照重复。
// `messageId` 在 cursor key 里被保留作未来桥接演化的防御位：当前
// session-manager 只把 `message_update` 事件转发给 `queueStreamEvent`，
// pi-agent-core 把 `'start'`（AssistantMessageEvent）转成 AgentEvent 的
// `message_start` 并不入这条 path——所以 `state.messageId` 在 production
// 整个生命周期内都保持初始值 0，`messageId` 实际并未起跨轮隔离作用；
// 但 key 加上它对未来 bridge 直接 forward `'start'` 是 zero-cost 的准备。

import type { ServerMessage, BroadcastMessage, StreamOp } from '@/lib/ipc/protocol';
import { post } from '../ipc/port-registry';
import { getCurrentMessageId } from './stream-broadcast';

// ─── Broadcast tap（会话广播观察者）───
//
// telegram-gateway 的 UX 生命周期（typing keepalive / tool 状态 / 流式文本编辑）
// 需要观察 agent 事件流，但不该为此 import chat 域的其它模块。这里暴露一个
// 极简 tap：所有经 `broadcastToViewers` 的会话广播（无论该会话有没有 viewer）
// 都会通知观察者。tap 抛错不影响正常投递。
const broadcastTaps = new Set<(msg: ServerMessage) => void>();

/** 订阅会话广播流。返回退订函数。 */
export function onBroadcastTap(cb: (msg: ServerMessage) => void): () => void {
  broadcastTaps.add(cb);
  return () => {
    broadcastTaps.delete(cb);
  };
}

/** port → 它当前正在看的 sessionId。模块级状态，生命周期 = service worker 生命周期 */
const viewers = new Map<chrome.runtime.Port, string>();

/** 流式 cursor：port → (messageId/blockIndex/field) → 该端口已消费的字段长度。
 *  WeakMap 键让 port GC 时 cursor 表项随之回收，无需手动清理。 */
const cursorByPort = new WeakMap<chrome.runtime.Port, Map<string, number>>();

type CursorKey = `${number}/${number}/${'text'|'thinking'|'partialJson'}`;

function makeCursorKey(
  messageId: number,
  blockIndex: number,
  field: 'text' | 'thinking' | 'partialJson',
): CursorKey {
  return `${messageId}/${blockIndex}/${field}` as CursorKey;
}

function getOrInitCursor(port: chrome.runtime.Port): Map<string, number> {
  let map = cursorByPort.get(port);
  if (!map) {
    map = new Map();
    cursorByPort.set(port, map);
  }
  return map;
}

/**
 * 记下某窗口正在看的会话。`subscribe` / `prompt` / `retry` 都会调 —— 后两者是因为
 * 「发起一轮对话」本身就意味着这个窗口正在看它
 */
function setViewing(port: chrome.runtime.Port, sessionId: string): void {
  viewers.set(port, sessionId);
}

/**
 * 该窗口不再看任何会话（`unsubscribe` / 断连）。
 *
 * 返回它此前在看的会话（没有则 null）—— 断连编排据此判断要不要 grace-cancel，
 * `unsubscribe` 则忽略返回值。表项在返回前已删除，因此紧接着调用 `hasViewer` 不会数到
 * 刚走的这一条
 */
function stopViewing(port: chrome.runtime.Port): string | null {
  const previous = viewers.get(port) ?? null;
  viewers.delete(port);
  return previous;
}

/** 是否还有窗口正在看这个会话 */
function hasViewer(sessionId: string): boolean {
  for (const id of viewers.values()) {
    if (id === sessionId) return true;
  }
  return false;
}

/**
 * 从快照里提取「最后一条 assistant 消息」每个 (blockIndex, field) 的当前
 * 长度，写入 port 的 cursor map（按 `messageId`）。
 *
 * 为什么只 seed 最后一条 assistant：每条 assistant 消息在 producer 那里自
 * 成一个 messageId（'start' 事件 bump），历史消息的 cursor 永远不会
 * 被未来的 op 引用（旧 messageId 不会再出现）；新轮 'start' 之后，新
 * messageId 在 cursor map 里是全新的 key，从 0 起步——所以只 seed 最后
 * 一条就够了。
 */
function seedPortCursor(
  port: chrome.runtime.Port,
  messages: BroadcastMessage[],
  messageId: number,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== 'assistant') continue;
    if (!Array.isArray(m.content)) return;
    const cursor = getOrInitCursor(port);
    for (let blockIndex = 0; blockIndex < m.content.length; blockIndex++) {
      const block = m.content[blockIndex] as Record<string, unknown> | undefined;
      if (!block) continue;
      const text = block.text;
      if (typeof text === 'string') {
        cursor.set(makeCursorKey(messageId, blockIndex, 'text'), text.length);
      }
      const thinking = block.thinking;
      if (typeof thinking === 'string') {
        cursor.set(makeCursorKey(messageId, blockIndex, 'thinking'), thinking.length);
      }
      if (block.type === 'toolCall') {
        const partialJson = (block as { partialJson?: unknown }).partialJson;
        if (typeof partialJson === 'string') {
          cursor.set(makeCursorKey(messageId, blockIndex, 'partialJson'), partialJson.length);
        }
      }
    }
    return;
  }
}

/** 重置 cursor：把 `message` 的每个块按当前长度写入 cursor。`tail_replace` 用。 */
function reseedFromReplace(
  port: chrome.runtime.Port,
  message: BroadcastMessage,
  messageId: number,
): void {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  const cursor = getOrInitCursor(port);
  for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
    const block = content[blockIndex] as Record<string, unknown> | undefined;
    if (!block) continue;
    const text = block.text;
    if (typeof text === 'string') {
      cursor.set(makeCursorKey(messageId, blockIndex, 'text'), text.length);
    }
    const thinking = block.thinking;
    if (typeof thinking === 'string') {
      cursor.set(makeCursorKey(messageId, blockIndex, 'thinking'), thinking.length);
    }
    if (block.type === 'toolCall') {
      const partialJson = (block as { partialJson?: unknown }).partialJson;
      if (typeof partialJson === 'string') {
        cursor.set(makeCursorKey(messageId, blockIndex, 'partialJson'), partialJson.length);
      }
    }
  }
}

/**
 * 在 `broadcastToViewers` 命中 stream_ops 时按 cursor 过滤一组 op：
 *   - tail_replace：按 `op.messageId`（缺省回退到当前 messageId）reseed 该
 *     消息各块的 cursor；始终保留。
 *   - tail_append：cursor ≥ endOffset → 整段丢弃（已被快照覆盖）；
 *     startOffset < cursor < endOffset → 裁掉重叠前缀；否则原样。
 *     cursor 推到 endOffset。
 * 返回该端口真正应收到（已过滤 / 已裁剪）的 op 列表。空列表意味着全部
 * 冗余——调用方按此跳过 post。
 */
function applyPortCursor(
  port: chrome.runtime.Port,
  ops: readonly StreamOp[],
  sessionId: string,
): StreamOp[] {
  const cursor = getOrInitCursor(port);
  const out: StreamOp[] = [];
  for (const op of ops) {
    if (op.kind === 'tail_replace') {
      const messageId = op.messageId ?? getCurrentMessageId(sessionId);
      reseedFromReplace(port, op.message, messageId);
      out.push(op);
      continue;
    }
    const key = makeCursorKey(op.messageId, op.blockIndex, op.field);
    const c = cursor.get(key) ?? 0;
    if (op.endOffset <= c) {
      // 整段已被快照覆盖
      continue;
    }
    if (op.startOffset < c) {
      // 部分重叠：裁掉前缀，下发的是真正新增的后缀
      const skip = c - op.startOffset;
      out.push({
        ...op,
        delta: op.delta.slice(skip),
        startOffset: c,
        endOffset: op.endOffset,
      });
    } else {
      out.push(op);
    }
    cursor.set(key, op.endOffset);
  }
  return out;
}

/** 投给所有正在看这个会话的窗口（对比传输层的 `broadcastAll` = 所有连接）。
 *  `stream_ops` 帧按端口 cursor 过滤 + 裁剪；其它帧照发。 */
function broadcastToViewers(sessionId: string, msg: ServerMessage): void {
  // Broadcast tap：会话广播的观察者（telegram-gateway 的 UX 生命周期需要观察
  // agent 事件流：typing keepalive / tool 状态 / 流式文本）。tap 在 viewer
  // 投递之前触发——无论该会话有没有 viewer，观察者都能收到。
  for (const tap of broadcastTaps) {
    // tap 抛错不影响正常投递
    try { tap(msg); } catch { /* ignore */ }
  }
  if (msg.type === 'stream_ops') {
    for (const [port, id] of viewers) {
      if (id !== sessionId) continue;
      const filtered = applyPortCursor(port, msg.ops, sessionId);
      if (filtered.length === 0) continue;
      post(port, { type: 'stream_ops', sessionId, ops: filtered });
    }
    return;
  }
  for (const [port, id] of viewers) {
    if (id === sessionId) post(port, msg);
  }
}

/**
 * 给所有看这个会话的端口发 `session_state`：每个端口先按快照 seed 自己的
 * cursor（保证紧随其后的 stream_ops 能正确去重），再 post。所有调用
 * `session_state` 的代码路径**必须**走这里，不能再直接 `broadcastToViewers`
 * 一个裸的 `{ type: 'session_state', … }`——那会让 cursor 漏 seed、下一个
 * trailing 帧被错误地下发到新 viewer 上。 */
function sendSessionStateToAllViewers(
  sessionId: string,
  payload: Extract<ServerMessage, { type: 'session_state' }>,
): void {
  const messageId = getCurrentMessageId(sessionId);
  for (const [port, id] of viewers) {
    if (id !== sessionId) continue;
    seedPortCursor(port, payload.messages, messageId);
    post(port, payload);
  }
}

/** 单端口版 `session_state`：subscribe 路径用——给唯一一个新 viewer seed
 *  cursor + post。 */
function sendSessionStateToPort(
  port: chrome.runtime.Port,
  payload: Extract<ServerMessage, { type: 'session_state' }>,
): void {
  const messageId = getCurrentMessageId(payload.sessionId);
  seedPortCursor(port, payload.messages, messageId);
  post(port, payload);
}

// ─── 公开 API ───

export {
  setViewing,
  stopViewing,
  hasViewer,
  broadcastToViewers,
  sendSessionStateToAllViewers,
  sendSessionStateToPort,
};
