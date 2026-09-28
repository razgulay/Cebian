import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { findToolResult, getAssistantText, getLeakedThinking, getThinkingBlocks, getToolCalls } from '@/lib/agent/message-helpers';
import { isCompactionSummary } from '@/lib/agent/compaction-summary';
import { isPermissionRequest } from '@/lib/agent/tool-permissions';
import { uiToolRegistry } from '@/lib/tools/ui-registry';
import { isMcpAppResult } from '@/lib/tools/mcp-tool';
import { TOOL_DELEGATE_TASK } from '@/lib/tools/names';

// ─── 内部判定 ───

/**
 * 「显眼」工具调用：交互式 UI（ask_user 等）、delegate_task（DelegationCard 带
 * worker 实时流）、MCP App（iframe 内嵌视图）、以及所有 `mcp__*` 工具（保守起见
 * 一律 standalone——结果若含 UI 资源，渲染路径会从 ToolCard 跳到 ToolCardWithUI，
 * 收进可折叠块会触发"Used 1 tool"→iframe 的闪屏）。这些卡片自身就是完整可见内容，
 * 被收进可折叠块会藏起正在等待用户输入 / 正在直播的界面——含它们的 assistant
 * 回合一律不分组，保持独立的既有渲染。
 */
function hasProminentToolCall(msg: AssistantMessage, messages: AgentMessage[]): boolean {
  return getToolCalls(msg).some((tc) => {
    if (uiToolRegistry.get(tc.name)) return true;
    if (tc.name === TOOL_DELEGATE_TASK) return true;
    // 所有 mcp__ 工具先按显眼处理——避免流式期间 toolResult 还没回来时被收进
    // group、toolResult 一到又因 isMcpAppResult 跳出去造成的可视闪屏。
    if (tc.name.startsWith('mcp__')) return true;
    const result = findToolResult(messages, tc.id);
    return !!(result?.details && isMcpAppResult(result.details));
  });
}

/**
 * 分组成员资格按**内容形态**判断，不信任 stopReason：部分 provider / 网关在带
 * tool call 的回合上返回 `stop`（而非 `toolUse`），按 stopReason 分组会把每个
 * 中间回合都误判成收尾回复。一条 assistant 消息是成员，当且仅当：
 * 只含 tool call / thinking（无面向用户的正文）、非 error / aborted、不含显眼工具。
 */
function isToolRunMember(msg: AgentMessage, messages: AgentMessage[]): msg is AssistantMessage {
  if (msg.role !== 'assistant') return false;
  const am = msg as AssistantMessage;
  if (am.stopReason === 'error' || am.stopReason === 'aborted') return false;
  if (getToolCalls(am).length === 0) return false;
  // 正文（剥掉 <think> 后）非空 = 有面向用户的输出 = 组边界（见需求规格）
  if (getAssistantText(am).trim() !== '') return false;
  return !hasProminentToolCall(am, messages);
}

/**
 * 空 assistant：刚起播、还没有任何可渲染块（text / thinking / toolCall 全无）。
 * 视为透明——流式请求刚发出时消息先以空壳入列，此刻若当边界会把本来连续的
 * 工具链劈成两组；等 toolCall 块一到它自然成为成员并回并进同一组。
 */
export function isEmptyAssistant(msg: AssistantMessage): boolean {
  return (
    getToolCalls(msg).length === 0 &&
    getAssistantText(msg).trim() === '' &&
    getThinkingBlocks(msg).length === 0 &&
    getLeakedThinking(msg).length === 0
  );
}

/**
 * 在「扫描前向找组边界」时哪些消息算透明（不影响 group 是否收尾本轮）。
 * 与 `isRunBoundary` 互补：runBoundary=true → 组在此处收尾；transparent → 跳过。
 * 用于 ChatPage 的 footer eligibility 扫描，避免 footer 在流式中闪烁。
 */
export function isMessageTransparentToGroup(msg: AgentMessage, messages: AgentMessage[]): boolean {
  if (msg.role === 'toolResult') {
    const tr = msg as ToolResultMessage;
    const info = uiToolRegistry.get(tr.toolName);
    // 渲染成 user bubble 的非取消结果本身是边界，不算透明
    return !(info?.renderResultAsUserBubble && !tr.details?.cancelled);
  }
  if (msg.role === 'assistant') {
    return isEmptyAssistant(msg as AssistantMessage);
  }
  return false;
}

/**
 * 组边界：遇到即结束当前组。user / 压缩摘要 / 权限卡片 / 渲染成用户气泡的
 * 交互式工具结果都是用户看得见的对话内容，绝不能被收进折叠块；非成员的
 * assistant（带正文 / error / aborted / 显眼工具）同样自成一块。
 */
function isRunBoundary(msg: AgentMessage, messages: AgentMessage[]): boolean {
  if (msg.role === 'user') return true;
  if (isCompactionSummary(msg)) return true;
  if (isPermissionRequest(msg)) return true;
  if (msg.role === 'toolResult') {
    const tr = msg as ToolResultMessage;
    const info = uiToolRegistry.get(tr.toolName);
    // 被取消的交互式结果渲染为 null（与 ChatPage 的口径一致），对分组透明
    return !!(info?.renderResultAsUserBubble && !tr.details?.cancelled);
  }
  if (msg.role === 'assistant') {
    if (isToolRunMember(msg, messages)) return false;
    return !isEmptyAssistant(msg as AssistantMessage);
  }
  // 未知角色 → 保守起见当作边界
  return true;
}

// ─── 公开 API ───

/** 一组连续的「只含 tool call」assistant 回合，由 ToolRunBlock 渲染成一个块。 */
export interface ToolRunGroup {
  /** 组内第一条消息在 messages[] 里的下标（渲染锚点，key / 定位都用它）。 */
  anchor: number;
  /** 组内全部 assistant 消息的下标（按时间序，members[0] === anchor）。 */
  members: number[];
}

/**
 * 把消息流切成 ToolRunGroup 列表：连续的分组成员归为一组，边界消息终止当前组，
 * 透明消息（普通 toolResult、空 assistant）让组延续。纯函数，每次渲染全量重算——
 * 流式过程中组成员逐渐增多、新文本回复入列即自然封组，无需维护增量状态。
 */
export function groupToolRuns(messages: AgentMessage[]): ToolRunGroup[] {
  const groups: ToolRunGroup[] = [];
  let current: ToolRunGroup | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (isToolRunMember(msg, messages)) {
      if (!current) {
        current = { anchor: i, members: [i] };
        groups.push(current);
      } else {
        current.members.push(i);
      }
    } else if (isRunBoundary(msg, messages)) {
      current = null;
    }
  }
  return groups;
}

/**
 * 给 ChatPage 用的下标索引：member 下标（含 anchor）→ 所属组。渲染时
 * `idx === group.anchor` 渲染 ToolRunBlock，其余成员返回 null 隐藏单块渲染。
 */
export function indexToolRunGroups(groups: ToolRunGroup[]): Map<number, ToolRunGroup> {
  const index = new Map<number, ToolRunGroup>();
  for (const group of groups) {
    for (const member of group.members) index.set(member, group);
  }
  return index;
}
