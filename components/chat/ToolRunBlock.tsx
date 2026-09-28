import { useState } from 'react';
import { ChevronRight, Wrench, Loader2 } from 'lucide-react';
import { GenericToolResultCard } from '@/components/chat/ToolCard';
import { ThinkingBlock, BranchSwitcher } from '@/components/chat/Message';
import { MessageMetaRow, type MessageMetaProps } from '@/components/chat/MessageMetaRow';
import type { ToolRunGroup } from '@/components/chat/tool-run-groups';
import { getLeakedThinking, getThinkingBlocks, getToolCalls, findToolResult } from '@/lib/agent/message-helpers';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { t } from '@/lib/i18n';

interface ToolRunBlockProps {
  /** 待渲染的消息流（整段，用于 toolResult 查找）。 */
  messages: AgentMessage[];
  /** 本次渲染聚焦的 group。 */
  group: ToolRunGroup;
  /** 最后一个 member 是否正在流式（决定光标 + 默认展开）。 */
  isStreaming?: boolean;
  /** 是否渲染 end-of-turn 的元信息行（仅当该 group 收尾本轮）。 */
  showFooter?: boolean;
  /** 重试入口（与 ChatPage 非分组路径同款：找不到对应 user 消息时不提供）。 */
  onRetry?: () => void;
  /** 分支切换器配置（由父组件按 lastMember 的 entryId 算出，内含 onPrev/onNext）。 */
  branch?: {
    index: number;
    count: number;
    onPrev?: () => void;
    onNext?: () => void;
    disabled?: boolean;
  };
}

/**
 * 折叠渲染一组连续的 tool-only assistant 回合。
 *
 * 背景：某些 provider 每个 assistant 回合只发一个 tool call 且 stopReason 报 'stop'，
 * 导致一串工具链被渲染成 N 个独立消息块、每块各带一行 footer。此组件把整组
 * 收成单一可折叠卡片：header 行显示工具调用总数，body 默认展开、按时间顺序
 * 渲染每回合的 thinking 块 + 工具卡（用户可点 header 收起）。仅影响 presentation，
 * 不改流式 / 状态机 / 工具执行。
 */
export function ToolRunBlock({ messages, group, isStreaming, showFooter, onRetry, branch }: ToolRunBlockProps) {
  const memberMessages = group.members
    .map((i) => messages[i])
    .filter((m): m is AssistantMessage => m?.role === 'assistant');

  const toolCallCount = memberMessages.reduce(
    (n, m) => n + getToolCalls(m).length,
    0,
  );

  // ─── 展开/折叠 ───
  // 默认展开（用户希望看到每一项工具用了哪个）；header 行点击可手动收起。
  // 不同 group 是独立 React 实例（key 用 anchor entryId / idx），状态不互通——
  // 新一轮的 group 总是默认展开。
  const [collapsed, setCollapsed] = useState(false);
  const isOpen = !collapsed;

  // ─── Footer：end-of-turn 元信息 ───
  // 整组只渲染一次 footer（且仅当该 group 是本轮最后一块）。
  // token 统计聚合组内所有 assistant 回合的 usage；modelLabel 取最后一条。
  // 不走 ChatPage 的"回溯到 user 消息"聚合逻辑，避免与紧随其后的 text 回合
  // 的 footer 重复计数。
  let meta: MessageMetaProps | undefined;
  if (showFooter) {
    const lastMember = memberMessages[memberMessages.length - 1];
    if (lastMember) {
      let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
      for (const m of memberMessages) {
        input += m.usage?.input ?? 0;
        output += m.usage?.output ?? 0;
        cacheRead += m.usage?.cacheRead ?? 0;
        cacheWrite += m.usage?.cacheWrite ?? 0;
      }
      meta = {
        modelLabel: lastMember.model,
        inputTokens: input || undefined,
        outputTokens: output || undefined,
        cacheReadTokens: cacheRead || undefined,
        cacheWriteTokens: cacheWrite || undefined,
        onRetry,
        branchSwitcher: branch ? <BranchSwitcher {...branch} /> : undefined,
      };
    }
  }


  return (
    <div className="self-start w-full -mt-1">
      {/* Header row: click to expand/collapse */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={isOpen}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none"
      >
        <ChevronRight
          className={`size-3 transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-90' : ''}`}
        />
        {isStreaming ? (
          <Loader2 className="size-3.5 text-primary animate-spin shrink-0" />
        ) : (
          <Wrench className="size-3 text-muted-foreground/70 shrink-0" />
        )}
        <span className="text-[length:var(--chat-font-size)] font-medium">
          {t('chat.toolRun.summary', toolCallCount)}
        </span>
      </button>

      {/* Body: timeline (per-turn thinking + tool cards, in message order) */}
      {isOpen && (
        <div className="mt-2 space-y-2 pl-4 border-l border-border/50">
          {memberMessages.map((m, mi) => {
            const thinkingBlocks = getThinkingBlocks(m);
            const leakedThinking = getLeakedThinking(m);
            const toolCalls = getToolCalls(m);
            const isAborted = m.stopReason === 'aborted';
            const memberLive = !!isStreaming && mi === memberMessages.length - 1;
            return (
              <div key={`g${group.members[mi]}`} className="space-y-2">
                {thinkingBlocks.map((block, i) => (
                  <ThinkingBlock key={`t${i}`} content={block.thinking} isLive={memberLive} />
                ))}
                {leakedThinking.map((reasoning, i) => (
                  <ThinkingBlock key={`tl${i}`} content={reasoning} isLive={memberLive} />
                ))}
                {toolCalls.map((tc) => (
                  <GenericToolResultCard
                    key={`tool-${tc.id}`}
                    tc={tc}
                    toolResult={findToolResult(messages, tc.id)}
                    isAborted={isAborted}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer: end-of-turn meta (rendered once, model + token stats) */}
      {meta && (
        <div className="mt-2">
          <MessageMetaRow {...meta} />
        </div>
      )}
    </div>
  );
}
