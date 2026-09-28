import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { groupToolRuns, indexToolRunGroups } from '@/components/chat/tool-run-groups';
import { uiToolRegistry } from '@/lib/tools/ui-registry';
import { isMcpAppResult } from '@/lib/tools/mcp-tool';

// ─── fixtures ───

let seq = 0;

function makeToolCall(name = 'fs_read_file'): ToolCall {
  return { type: 'toolCall', id: `tc-${++seq}`, name, arguments: {} };
}

/** 合法的空 usage（满足 pi-ai `Usage` 的必填字段）。 */
function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 只含一个 tool call 的 assistant 回合（模拟「每回合一个工具调用」的 provider）。 */
function toolTurn(name?: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [makeToolCall(name)],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: { ...zeroUsage(), input: 10, output: 5 },
    stopReason,
    timestamp: 0,
  } as AssistantMessage;
}

/** 只含正文（无 tool call）的收尾回复。 */
function textTurn(text = 'All done.'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: { ...zeroUsage(), input: 10, output: 5 },
    stopReason: 'stop',
    timestamp: 0,
  } as AssistantMessage;
}

/** 空 assistant（流式请求刚起播，尚无任何可渲染块）。 */
function emptyTurn(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: zeroUsage(),
    stopReason: 'pending',
    timestamp: 0,
  } as AssistantMessage;
}

function toolResult(toolCallId: string, toolName: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: 0,
    ...extra,
  };
}

function userTurn(text = 'hi'): AgentMessage {
  return { role: 'user', content: text, timestamp: 0 } as AgentMessage;
}

// 测试专用注册名（唯一，避免污染 / 与真实 registry 冲突）
const INTERACTIVE_TOOL = 'test_interactive_tool';
const BUBBLE_TOOL = 'test_bubble_tool';
uiToolRegistry.register({ name: INTERACTIVE_TOOL, Component: () => null });
uiToolRegistry.register({ name: BUBBLE_TOOL, Component: () => null, renderResultAsUserBubble: true });

/** 为消息流里每个 toolCall 补一条普通 toolResult（透明，不劈组）。 */
function withPlainResults(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    out.push(msg);
    if (msg.role === 'assistant') {
      for (const block of (msg as AssistantMessage).content) {
        if (block.type === 'toolCall') out.push(toolResult(block.id, block.name));
      }
    }
  }
  return out;
}

// ─── groupToolRuns ───

describe('groupToolRuns', () => {
  it('连续 tool-only assistant 回合归为一组，无视 stopReason=stop（本次要修的根因）', () => {
    // antigravity/gemini-3.8-flash：每回合一个 tool call，finish_reason "stop"
    const messages = withPlainResults([
      toolTurn('fs_save_url'),
      toolTurn('fs_read_file'),
      toolTurn('fs_delete'),
    ]);
    const groups = groupToolRuns(messages);
    expect(groups).toHaveLength(1);
    expect(groups[0].anchor).toBe(0);
    expect(groups[0].members).toEqual([0, 2, 4]);
  });

  it('stopReason=toolUse（标准 provider）同样归组', () => {
    const messages = withPlainResults([
      toolTurn('fs_read_file', 'toolUse'),
      toolTurn('fs_list', 'toolUse'),
    ]);
    expect(groupToolRuns(messages)).toEqual([{ anchor: 0, members: [0, 2] }]);
  });

  it('assistant 带正文即边界：组在其前结束，正文回合不入组', () => {
    const messages = withPlainResults([
      toolTurn('fs_read_file'),
      toolTurn('fs_delete'),
      textTurn(),
    ]);
    const groups = groupToolRuns(messages);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual([0, 2]);
    // 正文回合是最后一条消息，不属于任何组
    expect(messages[4].role).toBe('assistant');
    expect(groups[0].members).not.toContain(4);
  });

  it('同时含正文与 toolCall 的回合不入组（正文面向用户）', () => {
    const mixed: AssistantMessage = {
      ...toolTurn('fs_read_file'),
      content: [{ type: 'text', text: 'Đọc file này đã' }, makeToolCall('fs_read_file')],
    };
    const groups = groupToolRuns([toolTurn('fs_list'), mixed]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toEqual([0]);
  });

  it('同一回合混排普通与显眼工具（.some() 短路路径）也不入组', () => {
    const mixed: AssistantMessage = {
      ...toolTurn('fs_read_file'),
      content: [makeToolCall('fs_read_file'), makeToolCall(INTERACTIVE_TOOL)],
    };
    expect(groupToolRuns([toolTurn('fs_list'), mixed])).toEqual([{ anchor: 0, members: [0] }]);
  });

  it('user 消息是边界：user 两侧的各串工具各自成组', () => {
    const messages = withPlainResults([
      toolTurn('fs_read_file'),
      toolTurn('fs_delete'),
      userTurn(),
      toolTurn('fs_list'),
    ]);
    const groups = groupToolRuns(messages);
    expect(groups).toHaveLength(2);
    expect(groups[0].members).toEqual([0, 2]);
    expect(groups[1].anchor).toBe(5);
    expect(groups[1].members).toEqual([5]);
  });

  it('首条就是边界（user 开头）时不产生组、不影响后续', () => {
    const messages = withPlainResults([userTurn(), toolTurn('fs_read_file')]);
    // [user(0), A(1), TR(2)]
    expect(groupToolRuns(messages)).toEqual([{ anchor: 1, members: [1] }]);
  });

  it('compactionSummary 是边界', () => {
    const messages: AgentMessage[] = [
      toolTurn('fs_read_file'),
      { role: 'compactionSummary', summary: '…', tokensBefore: 100, timestamp: 0 } as AgentMessage,
      toolTurn('fs_list'),
    ];
    const groups = groupToolRuns(messages);
    expect(groups).toHaveLength(2);
  });

  it('permissionRequest 是边界（绝不收进折叠块）', () => {
    const messages: AgentMessage[] = [
      toolTurn('fs_read_file'),
      { role: 'permissionRequest', toolCallId: 'p1', toolName: 'fs_read_file', title: 'Allow?', permissions: [], decision: 'pending', timestamp: 0 } as AgentMessage,
      toolTurn('fs_delete'),
    ];
    const groups = groupToolRuns(messages);
    expect(groups).toHaveLength(2);
  });

  it('error / aborted 不入组且为边界', () => {
    const messages = withPlainResults([
      toolTurn('fs_read_file'),
      { ...toolTurn('fs_delete'), stopReason: 'error', errorMessage: 'boom' },
      { ...toolTurn('fs_list'), stopReason: 'aborted' },
      textTurn(),
    ]);
    const groups = groupToolRuns(messages);
    // 只有第一回合成组；error / aborted / 正文都独立在外
    expect(groups).toEqual([{ anchor: 0, members: [0] }]);
  });

  it('交互式工具 (uiToolRegistry) 不入组', () => {
    const messages: AgentMessage[] = [
      toolTurn('fs_read_file'),
      toolTurn(INTERACTIVE_TOOL),
      toolTurn('fs_delete'),
    ];
    const groups = groupToolRuns(messages);
    expect(groups).toEqual([{ anchor: 0, members: [0] }, { anchor: 2, members: [2] }]);
  });

  it('delegate_task 不入组（DelegationCard 必须始终可见）', () => {
    const messages: AgentMessage[] = [
      toolTurn('fs_read_file'),
      toolTurn('delegate_task'),
    ];
    expect(groupToolRuns(messages)).toEqual([{ anchor: 0, members: [0] }]);
  });

  it('toolResult 为 MCP App 的工具调用不入组', () => {
    const mcpDetails = {
      server: { id: 'srv', name: 'Srv' },
      tool: 'draw',
      mcpApp: { resourceUri: 'ui://x', toolInput: {} },
    };
    expect(isMcpAppResult(mcpDetails)).toBe(true);
    const tc = makeToolCall('mcp__drawio__draw');
    const messages: AgentMessage[] = [
      toolTurn('fs_read_file'),
      {
        role: 'assistant', content: [tc], api: 'openai-completions', provider: 'test',
        model: 'm', usage: zeroUsage(), stopReason: 'stop', timestamp: 0,
      } as AssistantMessage,
      toolResult(tc.id, tc.name, { details: mcpDetails }),
    ];
    expect(groupToolRuns(messages)).toEqual([{ anchor: 0, members: [0] }]);
  });

  it('mcp__ 前缀的工具在流式期（toolResult 还没回来）也不入组，避免结果一来从 ToolRunBlock 跳到 iframe 的闪屏', () => {
    // 没 toolResult → 旧的 isMcpAppResult 检查失效，但前缀应直接拦下
    const messages: AgentMessage[] = [
      toolTurn('fs_read_file'),
      toolTurn('mcp__drawio__draw'),
    ];
    expect(groupToolRuns(messages)).toEqual([{ anchor: 0, members: [0] }]);
  });

  it('toolResult 带普通 details（非 MCP App）不影响入组（negative case）', () => {
    const messages = withPlainResults([
      toolTurn('fs_read_file'),
    ]).map((m) =>
      m.role === 'toolResult' ? toolResult(m.toolCallId, m.toolName, { details: { some: 'data' } }) : m,
    );
    expect(groupToolRuns(messages)).toEqual([{ anchor: 0, members: [0] }]);
  });

  it('渲染成 user bubble 的 toolResult（未取消）是边界', () => {
    const tc = makeToolCall(BUBBLE_TOOL);
    const messages: AgentMessage[] = [
      toolTurn('fs_read_file'),
      { ...toolTurn(BUBBLE_TOOL), content: [tc] },
      toolResult(tc.id, BUBBLE_TOOL),
      toolTurn('fs_delete'),
    ];
    const groups = groupToolRuns(messages);
    expect(groups).toEqual([{ anchor: 0, members: [0] }, { anchor: 3, members: [3] }]);
  });

  // 无独立用例验证「bubble result 被取消」：携带 bubble tool 的 assistant 本身
  // 就是 prominent（已注册 registry），必然是边界——取消与否从不参与分组判定。

  it('空 assistant（起播等待块）为透明——组不会被闪断成两段', () => {
    const messages = withPlainResults([
      toolTurn('fs_read_file'),
      emptyTurn(),
      toolTurn('fs_delete'),
    ]);
    // [A(0), TR(1), empty(2), A(3), TR(4)] — 空 turn 不占 member 位
    expect(groupToolRuns(messages)).toEqual([{ anchor: 0, members: [0, 3] }]);
  });

  it('首条是空 assistant 时同样透明，组从首个工具回合起算', () => {
    const messages = withPlainResults([emptyTurn(), toolTurn('fs_read_file')]);
    // [empty(0), A(1), TR(2)]
    expect(groupToolRuns(messages)).toEqual([{ anchor: 1, members: [1] }]);
  });

  it('只含 thinking（无 toolCall）的 assistant 是边界，不入组', () => {
    const thinkingOnly: AssistantMessage = {
      ...emptyTurn(),
      content: [{ type: 'thinking', thinking: 'hmm' }],
      stopReason: 'stop',
    };
    const messages: AgentMessage[] = [toolTurn('fs_read_file'), thinkingOnly, toolTurn('fs_delete')];
    // [A(0), think(1), A(2)] — thinking 是边界，链条被切成两段
    expect(groupToolRuns(messages)).toEqual([{ anchor: 0, members: [0] }, { anchor: 2, members: [2] }]);
  });

  it('泄漏的 <think> 不影响 membership（strip 后正文为空）', () => {
    const leaked: AssistantMessage = {
      ...toolTurn('fs_read_file'),
      content: [{ type: 'text', text: '<think>reasoning</think>' }, makeToolCall('fs_read_file')],
    };
    expect(groupToolRuns([leaked, textTurn()])).toEqual([{ anchor: 0, members: [0] }]);
  });

  it('没有任何 tool call → 不产生组', () => {
    expect(groupToolRuns([userTurn(), textTurn()])).toEqual([]);
  });
});

describe('indexToolRunGroups', () => {
  it('把每个 member（含 anchor）映射到所属组', () => {
    const groups = [
      { anchor: 0, members: [0, 2] },
      { anchor: 5, members: [5] },
    ];
    const index = indexToolRunGroups(groups);
    expect(index.size).toBe(3);
    expect(index.get(0)).toBe(groups[0]);
    expect(index.get(2)).toBe(groups[0]);
    expect(index.get(5)).toBe(groups[1]);
    expect(index.get(1)).toBeUndefined();
  });
});
