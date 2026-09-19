// Client ↔ background 的端口通信协议。
// Client = 一个 UI 实例（侧边栏，或独立标签页里打开的同一套界面）。
//
// ─── 什么走端口、什么走 sendMessage ───
//
// 端口（Port）≈ WebSocket：需要 background 主动推送 / 实时同步时用。
// sendMessage ≈ HTTP：一次性问答用。
//
// 约定：一个 UI 实例只开一条端口，同一上下文里的其它域走 channel shim 复用它
// （见 lib/mcp/sidepanel-channel.ts、lib/recorder/sidepanel-channel.ts）。
//
// 注意 `chrome.runtime.sendMessage` 不是寻址投递：它送达发送方之外的所有扩展上下文
// （background 与已打开的扩展页面；要定向到内容脚本得用 chrome.tabs.sendMessage）。
// 所有监听器都会被调用，只有第一个应答的算数——所以每个 handler 必须先判别消息是不是
// 自己的，不是就既不应答也不返回 promise，把机会让给别人。单条消息另有 ~64MiB 上限：
// 备份的恢复因此改成分块传输，采集则改为页面侧直读 Dexie、消息只发一个无 payload 的
// flush 信号（issue #14）。

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionPlacement, SessionRecord } from '@/lib/persistence/db';
import type { ModelIdentity, ThinkingLevel } from '@/lib/persistence/storage';
import type { Attachment } from '@/lib/agent/attachments';
import type { SlashPrompt } from '@/lib/ai-config/slash-prompt';
import type { RecordedSession } from '@/lib/recorder/types';
import type { MCPResourceContents } from '@/lib/mcp/client';
import type { PermissionRequest } from '@/lib/agent/tool-permissions';
import type { BranchEntryInfo } from '@/lib/agent/session-projection';
import type { DebugLogEntry } from '@/lib/debug/log';
import type { RunResult } from '@/lib/scheduler/types';
import type { ChannelKind } from '@/lib/scheduler/notify-channels/types';

// ─── Port name ───

/**
 * UI 实例 ↔ background 的长连接端口名。
 *
 * 按**端点**命名而非按载荷命名：这条连接同时承载会话、录制、记忆整理、MCP
 * 资源四个域，叫 "agent" 只说中其中一个。与同文件的 ClientMessage / ServerMessage
 * 共用一套词汇。
 *
 * 同名不等于同一条：`chrome.runtime.connect` 每次调用都新建一个 Port，name 仅供
 * 接收端辨认。复用靠调用方自己共享同一个 Port 对象。
 */
export const CLIENT_PORT = 'cebian-client';

/**
 * 一次发送 / 重试所携带的「本轮要用的模型 + 思考档」。属于该会话的选择，由发起的
 * sidepanel 随 prompt / retry 消息带给后台（而非后台读全局）。两字段都可选：缺省时
 * 后台回退到会话行 / 全局种子（向后兼容）。prompt / retry 协议消息与 session-manager
 * 的 override 参数、hook 的 turn 参数共用此形状，避免一个概念多份近似类型。
 */
export interface TurnSettings {
  model?: ModelIdentity;
  thinkingLevel?: ThinkingLevel;
}

// ─── Client → Background (requests) ───

export type ClientMessage =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe' }
  /** 发送一条用户消息。`model` / `thinkingLevel`（见 TurnSettings）是「本次发送所用的
   *  模型 / 思考档」，由发起的 sidepanel 随消息携带（而非后台读全局），属于该会话的
   *  选择。新会话据此建行；已有会话据此就地刷新活 agent 并落库到会话行（会话行是真相）。
   *  缺省时后台回退到全局 lastSelectedModel 充当「新对话默认种子」（向后兼容）。
   *
   *  `slashPrompt`（可选）：本轮携带的斜杠提示词（`/` 菜单选中的模板，模板变量
   *  已在页面侧展开）。正文由 UI 传而非后台按名字回读文件：模板变量要
   *  chrome.tabs / scripting / 剪贴板，是侧边栏专有能力，后台引不得
   *  （见 lib/ai-config/template-vars-sidepanel.ts）。
   *
   *  `t0`（可选）：发起侧捕获的 `performance.now()` 锚点，由「send→reply 流水
   *  线临时诊断」用——后台读取后用同一个锚点算 `Δt`，保证跨 context 时间线可
   *  比（renderer 与 SW 的 `performance.now()` 起点不同）。不影响行为，缺省
   *  即退化到本地锚点（旧客户端也无副作用）。 */
  | ({
      type: 'prompt';
      sessionId: string | null;
      text: string;
      attachments?: Attachment[];
      slashPrompt?: SlashPrompt;
      t0?: number;
    } & TurnSettings)
  | { type: 'cancel'; sessionId: string }
  /** Re-run the last user turn for `sessionId`. The background drops any
   *  trailing assistant / toolResult messages (typically a failed turn or
   *  one the user is unhappy with) and resumes the agent loop from the most
   *  recent user message. No-op if no user message exists, or if the agent
   *  is currently running.
   *
   *  `model` / `thinkingLevel`（见 TurnSettings）同 prompt：携带「重试这一轮要用的
   *  模型 / 思考档」，支持「换个更强的模型再重试」。缺省时保持会话当前选择不变。
   *
   *  `entryId`（可选）：要重试的那一轮的 **user 消息** entry id——支持从历史任意
   *  一轮重新生成（旧回复留在分支上）。缺省时沿用旧语义：重试最后一轮。 */
  | ({ type: 'retry'; sessionId: string; entryId?: string } & TurnSettings)
  /** 编辑一条已发送的 user 消息并从该点重新生成（issue #44）。`entryId` 是目标
   *  消息的树 entry id（随广播的 BroadcastMessage 下发；未落树的乐观消息没有，
   *  UI 不给它显示编辑入口）。语义 = 回卷到该消息之前 + 以新文案重发：原分支
   *  完整保留为 sibling。`model` / `thinkingLevel` 同 prompt / retry。 */
  | ({ type: 'edit_message'; sessionId: string; entryId: string; text: string } & TurnSettings)
  /** 切换到某个分支：`targetEntryId` 是分支点上的目标兄弟 entry（取自
   *  `branchInfo[...].siblings`）。后台把 main lane 移到该兄弟子树的最深叶并
   *  重投影广播。仅 agent 空闲时受理。 */
  | { type: 'switch_branch'; sessionId: string; targetEntryId: string }
  | { type: 'resolve_tool'; sessionId: string; toolName: string; response: any }
  | { type: 'cancel_tool'; sessionId: string; toolName: string }
  /** User's decision on a tool's pre-execution permission prompt, keyed by
   *  `toolCallId`. Only the three explicit allow/deny choices travel here;
   *  an implicit "dismissed" (the user sent a new message instead) is handled
   *  by the existing steer/cancel path, not this message. */
  | { type: 'resolve_permission'; sessionId: string; toolCallId: string; decision: 'once' | 'always' | 'denied' }
  /** User response to a 400-context-overflow recovery card. The agent already
   *  auto-retried twice internally; the third strike hands control back. The
   *  sidepanel renders the card (driven by `context_overflow` ServerMessage) and
   *  posts this message when the user clicks Retry or Stop. */
  | { type: 'context_overflow_response'; sessionId: string; action: 'retry' | 'stop' }
  /** Sidepanel-initiated manual context compaction. The BG runs the
   *  same cut-point / summarization pipeline as the proactive 80 %
   *  pre-check, but skips the threshold gate — the user asked.
   *
   *  Session must be idle (`phase === 'idle'`); BG throws otherwise
   *  and the handler converts the rejection to an `error` ServerMessage.
   *  When `findCompactionCutPoint` returns `<= 0` (no usable cut), the
   *  BG broadcasts `compaction_skipped` and returns silently — no summary
   *  inserted. On success the BG enters `compacting` (broadcast via
   *  `session_state.isCompacting`) and appends a `compactionSummary`
   *  message; the next prompt proceeds normally. */
  | { type: 'compact_now'; sessionId: string }
  | { type: 'session_list' }
  /** 删除会话。天生批量——单条就是长度 1 的数组，不为它单开一条消息。后台逐个清理
   *  （工作区 / DB / 活 agent），成功的那些统一由一条 `session_deleted` 广播回来；
   *  有失败的则向发起端口回一条 `session_write_failed`。 */
  | { type: 'session_delete'; sessionIds: string[] }
  /** 设置会话在历史列表里的位置：置顶 / 归档 / 普通（null）。三态互斥，故一条消息
   *  就覆盖了置顶、取消置顶、归档、取消归档四个动作。同样天生批量。 */
  | { type: 'session_set_placement'; sessionIds: string[]; placement: SessionPlacement }
  /** Pin / unpin a session in the sidebar (legacy single-id form, kept for
   *  older clients). New code should use session_set_placement above. */
  | { type: 'session_pin'; sessionId: string }
  /** Rename a session (sidebar "Rename" action). Bg updates the row and
   *  broadcasts `session_changed`. */
  | { type: 'session_rename'; sessionId: string; title: string }
  | { type: 'recorder_start' }
  | { type: 'recorder_stop' }
  /** Sent by a sidepanel right after it opens a port, declaring a unique
   *  per-instance id (generated client-side at module load via
   *  `crypto.randomUUID`). Used by the recorder to gate which port may
   *  stop the active recording and to detect that the initiator instance
   *  has gone away (port disconnect). Robust across window drag (tab
   *  detach/attach) because the id travels with the runtime, not the
   *  window. */
  | { type: 'hello'; instanceId: string }
  /** Read an MCP `ui://...` resource for rendering an MCP App iframe.
   *  Returns via `mcp_resource_result` matched on `requestId`. The reply
   *  is sent only to the requesting port, not broadcast — each chat
   *  message renders its own iframe and tracks its own pending read. */
  | { type: 'mcp_read_resource'; requestId: string; serverId: string; uri: string }
  /** 手动触发一次跨对话记忆整理。后台跨同时只跑一个（单飞行）；进度由
   *  `memory_organize_state` 广播，结果（diff/摘要）写入 memoryOrganizeState 供 UI 响应式读取。 */
  | { type: 'memory_organize' }
  /** 查当前是否正在整理（供设置页重新挂载时恢复「整理中」指示——切 tab 再切回不丢状态）。
   *  后台仅向发起端口回一条 `memory_organize_state`（不带 outcome，不触发 toast）。 */
  | { type: 'memory_organize_query' }
  /** Subscribe to the BG's debug-log broadcast stream. Pair with
   *  `debug_log_unsubscribe` on unmount. Sidepanel useLiveLog uses this. */
  | { type: 'debug_log_subscribe' }
  | { type: 'debug_log_unsubscribe' }
  // ─── Scheduled tasks (BG automation scheduler) ───
  /** Sidepanel (Settings → Scheduler 列表) 拉当前所有 tasks。BG 回一条
   *  `scheduler_list_result` 给发起端口（不广播）。 */
  | { type: 'scheduler_list' }
  /** 创建新 task。`task` 是 Omit<ScheduledTask, 'id' | 'lastRunAt' | 'lastResult'>——
   *  id 由 BG 生成（crypto.randomUUID），lastRunAt / lastResult 强制 null。BG 写完
   *  后回一条 `scheduler_list_result` 给发起端口，让 UI 即时刷新。validation 在 BG
   *  端做（共享 lib/scheduler/validate.ts），失败回 `error` ServerMessage。 */
  | { type: 'scheduler_create'; task: unknown }
  /** 局部更新一个 task。`id` 必填；`patch` 是 Partial<name/schedule/action/notify/enabled>，
   *  至少一个字段必须 present。BG 写完后回 `scheduler_list_result`。lastRunAt /
   *  lastResult 不在 patch 里——保留历史结果。 */
  | { type: 'scheduler_update'; id: string; patch: unknown }
  /** 删除 task。BG 写完后回 `scheduler_list_result`。 */
  | { type: 'scheduler_delete'; id: string }
  /** 手动触发一个 task 立刻跑一次（不等到 alarm tick）。BG 走 `runTask` 并发一条
   *  `scheduler_result`（source: 'manual'）——结果 push 给所有订阅者，让多窗口看到
   *  手动触发的进展。失败回 `error`。 */
  | { type: 'scheduler_run_now'; id: string }
  /** 触发单 channel 的「test send」（Settings UI 的「Send test notification」按钮）。
   *  BG 读 channel + 对应 secret，调 `dispatchSingleChannelTest`，回
   *  `scheduler_channel_test_result`——包含 success / latencyMs / error？字段
   *  供 UI 即时显示。失败也回同形状的 wire，让 UI 区分是「fail」而不是「无响应」。 */
  | { type: 'scheduler_test_channel'; id: string }
  | { type: 'telegram_gateway_config_get' }
  | { type: 'telegram_gateway_config_set'; config: unknown; secrets: unknown }
  /** UI 主动发送一条 Telegram 回复（BG 转交给 bootstrap 持有的 WS 客户端）。
   *  跨 context 桥：sidepanel 的 channel 实例不持有 outbound sender，必须经
   *  port 走 BG 侧真正的客户端。fire-and-forget——失败经路由层回 `error`。 */
  | { type: 'telegram_gateway_send'; action: unknown }
  /** UI 请求把一个 VFS 文件打开到 canvas（chat 里 `#/…html` 链接的点击拦截）。
   *  BG 调 openCanvas → 广播 `canvas_opened`，CanvasPane 即时显示。fire-and-forget
   *  ——失败由路由层统一回 `error` ServerMessage，UI 不等待。 */
  | { type: 'canvas_open'; sessionId: string; path: string };

/**
 * `ClientMessage['type']` 的值级清单，供运行期穷尽性检查用（类型在编译后被擦除，
 * background 的 client-router 穷尽性测试需要一份可枚举的值）。
 *
 * 与联合类型的双向同步由编译期保证：多写 / 写错由 `satisfies` 报错，漏写由下方
 * `_AssertClientMessageTypesComplete` 报错（报错信息里会直接列出漏掉的类型名）。
 */
export const CLIENT_MESSAGE_TYPES = [
  'subscribe',
  'unsubscribe',
  'prompt',
  'cancel',
  'retry',
  'edit_message',
  'resolve_tool',
  'cancel_tool',
  'resolve_permission',
  'context_overflow_response',
  'compact_now',
  'switch_branch',
  'session_list',
  'session_delete',
  'session_set_placement',
  'recorder_start',
  'recorder_stop',
  'hello',
  'mcp_read_resource',
  'memory_organize',
  'memory_organize_query',
  'debug_log_subscribe',
  'debug_log_unsubscribe',
  'session_pin',
  'session_rename',
  'scheduler_list',
  'scheduler_create',
  'scheduler_update',
  'scheduler_delete',
  'scheduler_run_now',
  'scheduler_test_channel',
  'telegram_gateway_config_get',
  'telegram_gateway_config_set',
  'telegram_gateway_send',
  'canvas_open',
] as const satisfies readonly ClientMessage['type'][];

type _ExpectNever<T extends never> = T;
// ClientMessage 新增类型而清单没跟上时，这行 tsc 红，报错里直接列出漏掉的类型名。
// 纯类型层，无运行时代码。
type _AssertClientMessageTypesComplete = _ExpectNever<
  Exclude<ClientMessage['type'], (typeof CLIENT_MESSAGE_TYPES)[number]>
>;

// ─── Background → Client (events) ───

/** 广播的消息形态：AgentMessage + 其树 entry id。id 供「按消息定位树操作」
 *  （消息编辑、将来的分支导航）使用；未落树的消息（乐观插入 / 流式中）没有 id，
 *  UI 据此隐藏编辑入口。注意 id 只存在于 IPC 副本上——background 的
 *  `agent.state.messages` 保持干净，否则 id 会被 syncTail 冻进树里。 */
export type BroadcastMessage = AgentMessage & { entryId?: string };

/** 流式复制操作：`stream_ops` 帧的最小增量单元，tail 指正在流式生成的
 *  assistant 尾消息。生产端见 entrypoints/background/chat/stream-broadcast.ts
 *  （从 pi 的 delta 事件构造并按时间窗合并），应用端见
 *  lib/agent/stream-replica.ts。副本的任何漂移都会在 message_end / agent_end
 *  的全量 transcript 边界被校正，本操作流只需覆盖两个边界之间的增量。 */
export type StreamOp =
  /** 内容块结构变化（块开始/结束等低频事件）：用快照整体替换（或追加）尾消息。
   *  `messageId` 可选——携带时消费者用对应 key 重置 cursor；缺省则整条消息的
   *  cursor 全部按 0 重新种子（snapshot 本身是权威）。 */
  | { kind: 'tail_replace'; message: AgentMessage; messageId?: number }
  /** 向尾消息第 blockIndex 个内容块的字段追加文本增量。text / thinking 直接
   *  追加；partialJson 追加后由应用端重新解析出 toolCall 的 arguments。
   *
   *  `messageId` 是同一会话内的单调递增计数器——producer 每遇到一次 pi-agent-core
   *  的 `'start'` 事件（新 assistant 消息开始流式）就 +1；消费者把 cursor 限定在
   *  该 messageId 下，避免上一轮 (0, text) 的 cursor 把新轮开头的 delta 吞掉。
   *
   *  `startOffset` / `endOffset` 是该字段在应用此 delta **之前 / 之后** 的字符
   *  长度（endOffset == startOffset + delta.length）。消费者据此丢弃已被快照
   *  覆盖的整段 delta，并对部分重叠场景裁掉重叠前缀。 */
  | {
      kind: 'tail_append';
      messageId: number;
      blockIndex: number;
      field: 'text' | 'thinking' | 'partialJson';
      delta: string;
      startOffset: number;
      endOffset: number;
    };

/** 一个分支点的信息（定义与构建见 lib/agent/session-projection.ts 的
 *  buildBranchInfo）。键是当前分支上 entry 的 id，仅含兄弟数 ≥2 的分支点（稀疏）。 */
export type { BranchEntryInfo } from '@/lib/agent/session-projection';

/** `session_loaded` 携带的会话快照：会话行字段 + 带 entryId 标注的 transcript +
 *  分支点信息。 */
export type SessionSnapshot = Omit<SessionRecord, 'messages'> & {
  messages: BroadcastMessage[];
  branchInfo?: Record<string, BranchEntryInfo>;
};

/** Session metadata without messages, for listing. */
export type SessionMeta = Omit<SessionRecord, 'messages'> & {
  /** True iff the agent is currently running for this session in the
   * background. Populated by the background's `session_list` handler;
   * undefined when reading SessionRecord directly from Dexie. */
  isRunning?: boolean;
  /** True iff the user pinned this session in the sidebar. Backed by the
   *  Dexie row but exposed on the listing projection so the sidebar can
   *  sort pinned groups to the top without a second round-trip. */
  isPinned?: boolean;
};

/** Worker-runner → 广播层的实时事件（`worker_stream` 的载荷）。
 *  `AgentEvent` delta 类型的精简子集——只保留「能渲染成一行的内容」：
 *  text / thinking delta + tool name。Args 原样透传给消费端（UI 走
 *  `formatToolPath` 只读 `args.path` 顶层 string，不会把 25–135 KB 的
 *  fs_create_file 参数序列化进 React）。
 *
 *  `toolCallId` 在 worker-runner 这一层永远是 `undefined`（runner 不知道外层
 *  `delegate_task` 的 toolCallId），由 `lib/tools/delegate-task.ts` 闭包注入到
 *  消息顶层的 `toolCallId`。放在 protocol 而非 worker-runner：这是跨上下文
 *  的线上契约，UI 侧（hooks / components）只准依赖 `lib/`。 */
export type WorkerLiveStreamEvent =
  | {
      kind: 'text_delta';
      sessionId: string;
      toolCallId: string | undefined;
      delta: string;
    }
  | {
      kind: 'thinking_delta';
      sessionId: string;
      toolCallId: string | undefined;
      delta: string;
    }
  | {
      kind: 'tool_start';
      sessionId: string;
      toolCallId: string | undefined;
      toolName: string;
      args: unknown;
    };

export type ServerMessage =
  | { type: 'connected' }
  | {
      type: 'session_state';
      sessionId: string;
      title?: string;
      /** 会话所用的 provider / model / 思考档。与 `title` 同语义：仅在首次订阅时
       *  （从 DB 行读出）携带，供 sidepanel 回填本地的 turn 草稿；mid-stream 的
       *  rebuild 广播一律省略，避免覆盖用户在途切换的选择。 */
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      messages: BroadcastMessage[];
      isRunning: boolean;
      /** 是否正处于发送前的上下文压缩步骤（状态层正在生成并插入摘要）。
       *  为 true 时 sidepanel 显示「压缩中」指示，区别于普通的思考态。
       *  其余广播一律缺省 / false；hook 在 `agent_start` / `agent_end` /
       *  `error` 时清掉它。 */
      isCompacting?: boolean;
      pendingTools?: { toolName: string; toolCallId: string; args: any }[];
      /** Snapshot of in-flight permission prompts (a tool is paused in its
       *  `beforeToolCall` gate awaiting the user). Drives reconnect/restore
       *  of the prompt card, and lets the UI mark a persisted permissionRequest
       *  message as "expired" when its toolCallId is absent here. */
      pendingPermissions?: PermissionRequest[];
      /** 分支点信息（稀疏，仅兄弟数 ≥2 的 entry）。只在「分支结构可能变化」的
       *  帧携带（订阅快照 / 切换分支后）；缺省表示「维持上一帧的值」，前端不清空。 */
      branchInfo?: Record<string, BranchEntryInfo>;
    }
  | { type: 'agent_start'; sessionId: string }
  /** 两个全量边界（session_state / message_end / agent_end）之间的流式增量帧
   *  （一次合并窗内的操作序列，按序应用）。应用失败说明副本漂移，订阅方应
   *  重发 subscribe 拉取权威快照；对着过期副本应用产生的短暂错乱也会被下一
   *  个全量边界整体校正。 */
  | { type: 'stream_ops'; sessionId: string; ops: StreamOp[] }
  | { type: 'message_end'; sessionId: string; messages: BroadcastMessage[] }
  | {
      type: 'agent_end';
      sessionId: string;
      messages: BroadcastMessage[];
      /** 同 session_state.branchInfo：一轮结束（retry / 编辑可能刚造出新分支）时
       *  携带最新分支结构。 */
      branchInfo?: Record<string, BranchEntryInfo>;
    }
  | { type: 'error'; sessionId: string | null; error: string }
  /** 400 context-overflow recovery: agent already auto-retried twice, now asks
   *  the user. UI surfaces a card with Retry (truncate 50% + continue) and
   *  Stop (set phase=idle so the user can start a new turn). Bg ignores
   *  `lastError`; it's only there so the card can show *why*. */
  | {
      type: 'context_overflow';
      sessionId: string;
      attempts: number;
      lastError: string;
    }
  | { type: 'tool_pending'; sessionId: string; toolName: string; toolCallId: string; args: any }
  | { type: 'tool_resolved'; sessionId: string; toolName: string }
  /** Worker 子代理的实时输出流（`delegate_task` 的 Phase 2 UI 反馈）：
   *  `WorkerLiveStreamEvent`（text_delta / thinking_delta / tool_start）经
   *  `broadcastToViewers` 扇出。sidepanel 按 toolCallId 累积——token 合并 +
   *  50ms 节流见 `lib/agent/worker-live-stream.ts`。
   *  `toolCallId` 是 outer `delegate_task` 的 toolCallId —— worker-runner 这层
   *  不知道，由 `lib/tools/delegate-task.ts` 闭包注入。Session-scoped：
   *  走 `broadcastToViewers`。 */
  | {
      type: 'worker_stream';
      sessionId: string;
      toolCallId: string;
      ev: WorkerLiveStreamEvent;
    }
  | { type: 'session_loaded'; sessionId: string; session: SessionSnapshot | null }
  | { type: 'session_list_result'; sessions: SessionMeta[] }
  /** `session_list` 失败。刻意不复用通用 `error`：那条会被聊天视图当成本轮对话出错，
   *  清掉运行态并弹错误条，而拉列表失败与正在进行的对话毫无关系。 */
  | { type: 'session_list_error'; error: string }
  /** 这批会话已被删除。与 `session_delete` 同为批量形态；只列真正删成功的。 */
  | { type: 'session_deleted'; sessionIds: string[] }
  /** 一次会话写操作失败了（删除 / 改位置）。只回发起端口——客户端是乐观更新的：它已经
   *  把这些会话摘掉或改了位置，收到这条必须把权威列表拉回来，否则界面会永久停在一个
   *  库里并不存在的状态上。刻意不复用通用 `error`：那条会被聊天视图当成本轮对话出错。 */
  | { type: 'session_write_failed'; op: 'delete' | 'placement'; sessionIds: string[]; error: string }
  /** 会话的列表位置变了。广播给所有端口，让其它窗口已打开的历史面板同步，
   *  与 `session_deleted` 同款。 */
  | { type: 'session_placement_changed'; sessionIds: string[]; placement: SessionPlacement }
  | { type: 'session_created'; sessionId: string; title: string }
  /** Broadcast when a session's metadata (pin / rename / title) changes.
   *  Carries the full updated `SessionMeta` so any open sidepanel can
   *  reconcile the affected row in its local list without re-fetching. */
  | { type: 'session_changed'; session: SessionMeta }
  | { type: 'recorder_status'; isRecording: boolean; startedAt: number | null; eventCount: number; truncated?: 'event_limit' | 'time_limit'; initiatorInstanceId: string | null; activeWindowId: number | null }
  | { type: 'recorder_session'; session: RecordedSession }
  /** Sent in reply to `recorder_start` when the BG refuses to start a
   *  recording. `busy` = another sidepanel instance currently owns the
   *  recorder; `before_hello` = the requesting port never sent its
   *  `instanceId`. The sidepanel toasts this rather than disabling the
   *  button up front, so the click is never confusingly silent. */
  | { type: 'recorder_start_rejected'; reason: 'busy' | 'before_hello' }
  /** Fired by the BG proactive 80% pre-check (Subtask 2) when it wanted to
   *  compact but `findCompactionCutPoint` returned `cut <= 0` — typically
   *  because a single user message alone exceeds `keepRecentTokens`. The
   *  agent proceeds without compaction and the next request is at high
   *  risk of 400. UI surfaces a transient Sonner toast (no card, no
   *  response message). Session-scoped via `broadcastToViewers`. The
   *  payload fields beyond what the toast needs are kept here so future
   *  telemetry / debugging can subscribe without changing the wire. */
  | {
      type: 'compaction_skipped';
      sessionId: string;
      reason: 'cut_no_op';
      tokens: number;
      contextWindow: number;
      keepRecentTokens: number;
      messagesCount: number;
    }
  /** Response to `mcp_read_resource`. `result` carries the full resource
   *  payload including `_meta.ui` (CSP / permissions for sandboxing).
   *  Error codes:
   *  - `server_unavailable`: MCP server not registered or user-disabled —
   *    surface a "this diagram can't be loaded" UI with a hint to re-enable.
   *  - `fetch_failed`: connection, throttle, parse, or any other runtime
   *    failure — surface the message and offer a retry. */
  | {
      type: 'mcp_resource_result';
      requestId: string;
      result?: MCPResourceContents;
      error?: { code: 'server_unavailable' | 'fetch_failed'; message: string };
    }
  /** 记忆整理的运行态（全局、非会话维度）。running 驱动设置页「整理中…」指示；
   *  结束时携 outcome 供 UI toast 反馈（空转/冲突/失败等）；error 在出错时携一句话说明。
   *  结果详情（diff/摘要）走 memoryOrganizeState。 */
  | {
      type: 'memory_organize_state';
      running: boolean;
      outcome?: 'ok' | 'empty' | 'conflict' | 'rejected' | 'failed' | 'no-model';
      error?: string;
    }
  /** Live debug-log stream. Sent to any port that issued
   *  `debug_log_subscribe`. BG throttles / drops its own internal queue
   *  per subscriber; the consumer caps the in-memory buffer (see
   *  useLiveLog). */
  | { type: 'debug_log_entry'; entry: DebugLogEntry }
  | { type: 'debug_log_cleared' }
  // ─── Canvas Live Artifacts ───
  /** 订阅 / 重连时 BG 推送的 canvas 状态帧：`openPath === null` 表示 canvas
   *  对此 session 关闭（无文件打开）。`content` 是该文件当前内容——push 而不是
   *  让 sidepanel 再走一次 fetch，避免额外 round-trip；文件通常 ≤100KB，
   *  在 64MiB 单消息上限之下非常宽裕。Session-scoped：随 `subscribe` /
   *  重连触发。 */
  | {
      type: 'canvas_state';
      sessionId: string;
      openPath: string | null;
      content: string | null;
    }
  /** Agent 通过 `canvas_open` 工具打开一个 VFS 文件时 BG 广播的「刚打开」事件。
   *  走 `broadcastToViewers(sessionId, ...)`，本 session 的所有 viewer 都会
   *  收到；其他 session 的 sidepanel 看不到。 */
  | {
      type: 'canvas_opened';
      sessionId: string;
      path: string;
      content: string;
    }
  /** VFS 写入命中「正被本 session 的某个 viewer 打开着」的路径时 BG 广播的热
   *  更新事件。载荷形态与 `canvas_opened` 同——sidepanel 用同一 handler 渲染。 */
  | {
      type: 'canvas_file_changed';
      sessionId: string;
      path: string;
      content: string;
    }
  // ─── Scheduled tasks (BG automation scheduler) ───
  /** `scheduler_list` / `scheduler_create` / `scheduler_update` /
   *  `scheduler_delete` 的回复。BG 仅回给发起端口（不广播），UI 拿 `tasks`
   *  整体替换当前列表。 */
  | { type: 'scheduler_list_result'; tasks: unknown[] }
  /** `scheduler_create` 的「带 id」回复。BG 仅回发起端口。`id` 是新任务的
   *  crypto.randomUUID()——tool 据此写回 details 与后续 run_now / delete 用同
   *  一 id。`task` 镜像 BG 写完后的完整 ScheduledTask（带 createdAt），让 LLM
   *  能立即看到落库后的样子，无需再发一次 list。 */
  | { type: 'scheduler_create_result'; id: string; task: unknown }
  /** 单 task 跑完结果（alarm tick 自动跑 OR `scheduler_run_now` 手动跑）。
   *  BG 通过 `schedulerChannel.publishResult` fanout 给所有订阅者——多窗口场景下
   *  每个 sidepanel 都会收到这条结果。`source` 让 UI 区分「自动 tick」与「用户手动
   *  触发」（后者通常显示成 loading → done 的更明显动画）。 */
  | {
      type: 'scheduler_result';
      taskId: string;
      result: RunResult;
      source: 'manual' | 'tick';
    }
  /** `scheduler_test_channel` 的回复——BG 端只回发起端口（不广播）。
   *  `latencyMs` 给 UI 即时反馈；`error` 只在 success=false 时存在（union 强约束）。
   *  UI 把 success=false 当作「test 失败」展示，让用户立即看到是网络/凭证问题
   *  而不是「没反应」。 */
  | {
      type: 'scheduler_channel_test_result';
      channelId: string;
      channelKind: ChannelKind;
      success: true;
      latencyMs: number;
    }
  | {
      type: 'scheduler_channel_test_result';
      channelId: string;
      channelKind: ChannelKind;
      success: false;
      latencyMs: number;
      error: string;
    }
  /** Telegram Gateway — BG 端回给发起端口的配置结果（get / set 后都回这个）。 */
  | {
      type: 'telegram_gateway_config_get_result';
      config: unknown;
      secrets: unknown;
    }
  /** Telegram Gateway 实时状态推送（BG → sidepanel 跨 context 桥）。bootstrap 在
   *  WS 状态变化时 broadcastAll；sidepanel 经 useBackgroundAgent.handleMessage 把
   *  这条消息喂回本侧 channel 驱动 Header 徽章。 */
  | { type: 'telegram_gateway_status'; status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' }
  /** Telegram Gateway 收到的入站消息（BG → sidepanel）。bootstrap 在
   *  worker-client.onMessage 回调里 broadcastAll；sidepanel 喂回 channel 推到
   *  useBackgroundAgent 的订阅 effect，触发 dispatchPrompt。 */
  | { type: 'telegram_gateway_inbound'; message: unknown };
