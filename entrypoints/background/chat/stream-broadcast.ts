// 流式广播生产端：把 pi 的 delta 事件压缩成 StreamOp 增量帧，按时间窗合并后
// 广播（协议见 lib/ipc/protocol.ts 的 StreamOp / stream_ops，应用端见
// lib/agent/stream-replica.ts）。
//
// 为什么不直接广播整条消息：pi-agent-core 每收到一个 SSE delta（约十几个
// 字符）就 emit 一次 message_update，逐条对「整条已累积消息」做结构化克隆
// 的总字节数随回复长度**二次**增长。改成增量后总传输量退回线性：
// - text / thinking / toolcall 参数的 delta 直接作字符串增量（tail_append，
//   同块同字段的相邻增量在缓冲里就地拼接）；
// - 内容块结构变化（块开始/结束等低频事件）发整条快照（tail_replace），
//   它会吞掉缓冲里此前的所有增量——快照本身已包含它们。
//
// 工具参数的累计 JSON 由**本模块自己维护**（argsAccum，按块下标），并在每个
// 快照发出前注入 toolCall 块的 `partialJson` 字段：pi 各 provider 的累计
// scratch 字段并不统一（anthropic 用 partialJson、openai/mistral 用
// partialArgs、pi-messages 干脆存在消息外部），应用端的续写基底不能依赖
// 任何 provider 私有字段——协议字段协议自己填。
//
// 时间窗合并：空窗期的第一帧立即发（leading，首个 token 即时可见），窗口内
// 增量进缓冲，到期发一帧（trailing）并续窗；一个整窗都没有新增量才退出。
//
// 硬约束（为什么是「同步入队 + setTimeout」而不是别的形态）：
// - pi-agent-core 会 await 订阅回调——入队必须同步返回，任何 await 定时器
//   的写法都会反压整个 SSE 读取循环；
// - pi 事件里的 partial 是**同一个可变对象**（provider 边流边改），缓冲里的
//   tail_replace 必须 structuredClone 定格当时的内容，否则 80ms 后 flush 时
//   快照已包含后续增量，再叠加缓冲里的 append 就会重复；
// - MV3 service worker 的 setTimeout 会随 SW 回收而丢失，但流式期间
//   keep-alive 必然被持有（见 session-manager 的 updateKeepAlive），定时器安全；
// - 消息定稿/结束（message_end / agent_end / cancel）都会广播包含最终内容
//   的全量 transcript，此时必须 drop 待发帧——晚到的 trailing 帧会把已定稿
//   的消息改回过期的 partial。

import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { StreamOp } from '@/lib/ipc/protocol';
import { broadcastToViewers } from './viewers';

/** 合并窗口。12.5 帧/秒的打字机观感依然连贯，克隆/渲染次数比逐 delta 低一个量级。 */
const FLUSH_INTERVAL_MS = 80;

interface StreamState {
  /** 时间窗节流态；null = 空窗期（下一帧走 leading 立即发）。 */
  window: { ops: StreamOp[]; timer: ReturnType<typeof setTimeout> } | null;
  /** blockIndex → 当前消息里该 toolCall 块的累计参数 JSON（见文件头）。 */
  argsAccum: Map<number, string>;
  /** 当前正在流式的 assistant 消息的 messageId。每条新 assistant 消息
   *  （pi-agent-core 的 `'start'` 事件）bump +1；用于消费者的 cursor key，
   *  让上轮 (blockIndex, field) 的 cursor 不会吞掉新轮开头的 delta。 */
  messageId: number;
}

/** sessionId → 流式生产状态。 */
const streams = new Map<string, StreamState>();

function stateFor(sessionId: string): StreamState {
  let state = streams.get(sessionId);
  if (!state) {
    state = { window: null, argsAccum: new Map(), messageId: 0 };
    streams.set(sessionId, state);
  }
  return state;
}

/** 读取当前会话正在流式的 assistant 消息的 messageId（用于消费者在 seed cursor
 *  时锁定到正确的 key）。session 尚未产生过 'start' 事件时返回 0。 */
function getCurrentMessageId(sessionId: string): number {
  return streams.get(sessionId)?.messageId ?? 0;
}

/** 把本模块维护的累计参数 JSON 注入快照（快照须为本模块所有的克隆，会被原地改写）。
 *  AgentMessage 联合里的自定义消息可能没有 content 数组，结构守卫后跳过。 */
function injectArgsAccum(snapshot: AgentMessage, argsAccum: Map<number, string>): void {
  const content = (snapshot as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const [blockIndex, json] of argsAccum) {
    const block = content[blockIndex] as { type?: string; partialJson?: string } | undefined;
    if (block?.type === 'toolCall') block.partialJson = json;
  }
}

/** 取 partial 里指定 (contentIndex, field) 的当前字符串长度，作为 delta 应用后
 *  的「endOffset」。text / thinking 由 pi 同步改 partial.content[i].xxx；
 *  partialJson 不在 partial 上——由本模块自己的 argsAccum 持有累计 JSON。 */
function endOffsetOf(
  partial: AgentMessage,
  contentIndex: number,
  field: 'text' | 'thinking' | 'partialJson',
  argsAccum: Map<number, string>,
): number {
  if (field === 'partialJson') {
    return argsAccum.get(contentIndex)?.length ?? 0;
  }
  const content = (partial as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  const block = content[contentIndex] as Record<string, unknown> | undefined;
  if (!block) return 0;
  const value = block[field];
  return typeof value === 'string' ? value.length : 0;
}

/** 把 pi 的流式事件翻译成 StreamOp。delta 三兄弟走字符串增量，其余（块开始/
 *  结束等结构事件）走快照——structuredClone 定格内容并注入累计参数 JSON。
 *  每个 op 都带 `messageId` + `startOffset` + `endOffset`，供消费者按 cursor
 *  过滤已被快照覆盖的 delta。 */
function opForEvent(
  event: AssistantMessageEvent,
  argsAccum: Map<number, string>,
  messageId: number,
): StreamOp {
  switch (event.type) {
    case 'text_delta': {
      const endOffset = endOffsetOf(event.partial, event.contentIndex, 'text', argsAccum);
      const delta = event.delta;
      return {
        kind: 'tail_append',
        messageId,
        blockIndex: event.contentIndex,
        field: 'text',
        delta,
        startOffset: endOffset - delta.length,
        endOffset,
      };
    }
    case 'thinking_delta': {
      const endOffset = endOffsetOf(event.partial, event.contentIndex, 'thinking', argsAccum);
      const delta = event.delta;
      return {
        kind: 'tail_append',
        messageId,
        blockIndex: event.contentIndex,
        field: 'thinking',
        delta,
        startOffset: endOffset - delta.length,
        endOffset,
      };
    }
    case 'toolcall_delta': {
      const endOffset = endOffsetOf(event.partial, event.contentIndex, 'partialJson', argsAccum);
      const delta = event.delta;
      return {
        kind: 'tail_append',
        messageId,
        blockIndex: event.contentIndex,
        field: 'partialJson',
        delta,
        startOffset: endOffset - delta.length,
        endOffset,
      };
    }
    // done / error 不携带 partial。当前桥接层不会把它们转发进来（pi 直接
    // 走 message_end），这两个分支只为联合类型的完备性兜底
    case 'done':
      return { kind: 'tail_replace', message: structuredClone(event.message), messageId };
    case 'error':
      return { kind: 'tail_replace', message: structuredClone(event.error), messageId };
    default: {
      const snapshot = structuredClone(event.partial);
      injectArgsAccum(snapshot, argsAccum);
      return { kind: 'tail_replace', message: snapshot, messageId };
    }
  }
}

/** 操作入缓冲：快照吞掉此前全部增量；同块同字段的相邻增量就地拼接。
 *  相邻拼接时 startOffset / endOffset 需重算（拼接后的 startOffset 是
 *  前一段的 startOffset，endOffset 是后一段的 endOffset）。 */
function pushOp(ops: StreamOp[], op: StreamOp): void {
  if (op.kind === 'tail_replace') {
    ops.length = 0;
    ops.push(op);
    return;
  }
  const last = ops[ops.length - 1];
  if (
    last?.kind === 'tail_append' &&
    last.messageId === op.messageId &&
    last.blockIndex === op.blockIndex &&
    last.field === op.field
  ) {
    // 相邻 delta 的 endOffset 必然递增；拼接后保留前一段的 startOffset 与
    // 后一段的 endOffset（中间的 endOffset 不再被 op 链上记录，可由
    // startOffset + delta.length 推回）
    last.delta += op.delta;
    last.endOffset = op.endOffset;
    return;
  }
  ops.push(op);
}

/** 入队一帧流式事件。同步返回（pi 会 await 订阅回调，不能悬挂）。 */
function queueStreamEvent(sessionId: string, event: AssistantMessageEvent): void {
  const state = stateFor(sessionId);
  // 累计参数 JSON 的生命周期由消息边界的 dropStreamBroadcast 清零（每个
  // message_end / agent_end 都会走到）。start 分支是防御：当前桥接层不会把
  // start 转发进来（pi 把它转成 message_start，不产生 message_update），
  // 保留以防事件桥接演化
  if (event.type === 'start') {
    state.argsAccum.clear();
    state.messageId += 1;
  } else if (event.type === 'toolcall_delta') {
    state.argsAccum.set(
      event.contentIndex,
      (state.argsAccum.get(event.contentIndex) ?? '') + event.delta,
    );
  }
  const op = opForEvent(event, state.argsAccum, state.messageId);
  if (state.window) {
    pushOp(state.window.ops, op);
    return;
  }
  // 空窗期：立即发出（leading），并开窗收集后续增量
  broadcastToViewers(sessionId, { type: 'stream_ops', sessionId, ops: [op] });
  state.window = {
    ops: [],
    timer: setTimeout(() => flushWindow(sessionId), FLUSH_INTERVAL_MS),
  };
}

/** 窗口到期：有增量则发出并续窗，整窗安静则退出节流态。 */
function flushWindow(sessionId: string): void {
  const state = streams.get(sessionId);
  if (!state?.window) return;
  if (state.window.ops.length > 0) {
    broadcastToViewers(sessionId, { type: 'stream_ops', sessionId, ops: state.window.ops });
    state.window.ops = [];
    state.window.timer = setTimeout(() => flushWindow(sessionId), FLUSH_INTERVAL_MS);
  } else {
    state.window = null;
  }
}

/**
 * 立即把缓冲中的增量发给当前 viewers（窗口保持运转）。
 * subscribe 快照取样前必须调用：快照会包含缓冲里这些增量的内容，若不先
 * flush，快照后到期的 trailing 帧会把同一段增量对着快照再应用一遍。
 * 先 flush（老 viewers 正常前进），再取样，两步之间不得有 await。
 *
 * 注：消费者层（viewers.ts）按 cursor 端去重，快照后到期的 trailing 帧
 * 即使内容已存在于快照也会被按 (messageId, blockIndex, field, endOffset)
 * 丢弃，所以这里仍调用 flushStreamOps 是无害的（老 viewers 正常前进），
 * 而新 viewer 则会随后收到一个 cursor 已 seed 过的 session_state。
 */
function flushStreamOps(sessionId: string): void {
  const state = streams.get(sessionId);
  if (!state?.window || state.window.ops.length === 0) return;
  broadcastToViewers(sessionId, { type: 'stream_ops', sessionId, ops: state.window.ops });
  state.window.ops = [];
}

/**
 * 用流式尾消息生成可发给订阅方的快照：克隆 + 注入累计参数 JSON。
 * subscribe 的 session_state 必须经此出口——直接透传 pi 的对象，应用端就
 * 拿不到 provider 无关的续写基底（见文件头）。
 */
function snapshotStreamingTail(sessionId: string, streamingMessage: AgentMessage): AgentMessage {
  const snapshot = structuredClone(streamingMessage);
  const state = streams.get(sessionId);
  if (state) injectArgsAccum(snapshot, state.argsAccum);
  return snapshot;
}

/**
 * 丢弃该会话的待发帧与累计状态，退出节流态。
 * 消息定稿/会话结束（message_end / agent_end / cancel / destroySession）前
 * 必须调用——这些路径随后广播（或已无需广播）包含最终内容的全量
 * transcript，晚到的 trailing 帧会把它改回过期的 partial；累计参数 JSON
 * 属于当前消息，消息边界后必须清零。
 */
function dropStreamBroadcast(sessionId: string): void {
  const state = streams.get(sessionId);
  if (!state) return;
  if (state.window) clearTimeout(state.window.timer);
  streams.delete(sessionId);
}

export { queueStreamEvent, flushStreamOps, snapshotStreamingTail, dropStreamBroadcast, FLUSH_INTERVAL_MS, getCurrentMessageId };
