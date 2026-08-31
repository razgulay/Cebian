// Cebian 的 Agent 工厂：把 pi-agent-core 的 `Agent` 按本项目的约定配好（LLM 消息
// 转换、上下文窗口折叠、stream 函数、凭证解析、工具执行前门禁）并实例化。
//
// 契约：本工厂是**agentic loop 的唯一入口**，而不是「所有 LLM 调用的入口」。
// 判据是是否需要「模型 → 工具 → 模型」的自主循环：
//   - 需要循环 → 走这里。工具集、消息状态、事件订阅、取消语义、上下文窗口管理
//     五样东西会一并跟来，绕过就意味着复制它们（主对话、记忆整理属此类）。
//   - 一次性文本变换（总结、翻译、解释）→ 直接调 pi 的 `stream` / `generateSummary`，
//     不要套 Agent：那要造空工具数组、订阅事件、管 state.messages、等 agent_end
//     才拿得到结果，纯负担（压缩、划词动作属此类，现状正确）。
//
// 不负责提示词拼接：成形的 systemPrompt 由同目录 `prompt-composer.ts` 产出后传入。
// 谁在用：会话（chat）与临时整理 agent（memory）——本文件对两者都不知情。

import { Agent, type AgentOptions, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, Model, Message } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { ThinkingLevel } from '@/lib/persistence/storage';
import { resolveProviderApiKey } from '../providers/credentials';
import {
  clampedCompactionReserve,
  findCompactionCutPoint,
  getRetainedTail,
  isCompactionSummary,
  type CompactionSummaryMessage,
} from '@/lib/agent/compaction';
import { sanitizeAgentMessages } from '@/lib/agent/message-helpers';

// ─── Agent factory ───

interface CreateAgentOptions {
  model: Model<Api>;
  /**
   * 完整成形的 systemPrompt（base + skills + user-instructions 已拼好）。由调用方
   * 经同目录 `prompt-composer.ts` 导出的 `composeSystemPrompt`（其内委托纯函数
   * `buildSystemPrompt`）组装后传入——本工厂不再自行拼接，避免「先拼一版、马上
   * 被含 skills 的版本覆盖」的双读双设。
   */
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  messages?: AgentMessage[];
  /** Session-specific tools array (includes per-session ask_user). */
  tools: AgentTool<any>[];
  /**
   * Optional pre-execution gate. pi-agent-core calls it after a tool's args
   * are validated and before `execute()`; returning `{ block: true, reason }`
   * blocks the call and emits an error tool result. Used to require user
   * authorization before certain tools run (see `lib/agent/tool-permissions.ts`).
   */
  beforeToolCall?: AgentOptions['beforeToolCall'];
}

function createCebianAgent(options: CreateAgentOptions): Agent {
  const {
    model,
    systemPrompt,
    thinkingLevel,
    messages = [],
    tools: agentTools,
    beforeToolCall,
  } = options;

  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools: agentTools,
      messages,
    },

    // 把 AgentMessage 转换为发给 LLM 的 Message。compactionSummary 降级成一条
    // user 消息（用 <summary> 包裹 + 一句「仅供参考、勿直接回应」），其余自定义
    // 类型一律过滤掉，只保留 user / assistant / toolResult。
    convertToLlm: (msgs: AgentMessage[]): Message[] => {
      const out: Message[] = [];
      // 送入 pi 前把消息整形回类型契约（null text/thinking/name → ''）。否则 pi 的 token
      // 估算器（clampMaxTokensToContext）对 assistant 块无保护地取 .length，一旦历史里有
      // 这类坏消息就会整轮抛「reading 'length'」（issue #43）
      for (const m of sanitizeAgentMessages(msgs)) {
        if (isCompactionSummary(m)) {
          out.push({
            role: 'user',
            content:
              `<summary>\n${m.summary}\n</summary>\n\n` +
              'The block above is a compressed summary of earlier conversation, ' +
              'provided for context only. Do not respond to it directly; ' +
              'continue with the messages that follow.',
            timestamp: m.timestamp,
          });
          continue;
        }
        if (['user', 'assistant', 'toolResult'].includes((m as Message).role)) {
          out.push(m as Message);
        }
      }
      return out;
    },

    // 上下文窗口管理：两步流水线，都只是 LLM 视图变换、不写回 state.messages
    // （agent.d.ts 的契约：返回数组只用于 LLM call，state 由主循环独立维护）。
    //
    // Step 1 — 压缩摘要视角展开：若存在压缩摘要，LLM 视图 = 最后一条摘要 +
    // 其保留区副本（retainedTail）+ 其后的全部消息——摘要之前的历史已被摘要
    // 覆盖，无需再发。两种摘要形态由同一条公式统一处理：
    //  - 新压缩（树化后）：摘要尾部追加，保留区原文在摘要**之前**、副本挂在
    //    retainedTail 上 → 公式展开副本；
    //  - v1 迁移来的旧摘要：无 retainedTail（保留区本就在摘要之后）→ 公式
    //    退化为原来的「从摘要起切片」。
    //
    // Step 2 — sliding-window 硬上限（Subtask 3）：在 Step 1 的基础上按
    // `contextWindow - reserveTokens - systemPrompt footprint` 算出消息预算，
    // 超出时从最早丢弃、沿用 `findCompactionCutPoint` 的 turn-start 对齐，
    // 复用 issue #9 修过的 tool_call/toolResult 配对安全。摘要钉在 head
    // 不丢。`state.messages` 仍保留完整历史（无损），此处只是 LLM 边界
    // 的视图变换，不写回 state。
    //
    // 闭包里的 `model.contextWindow` 是 agent 创建时的值；若
    // session-manager 在中途换 model（见 session-manager.ts 的 model
    // 切换点），本预算会迟到一刷新——Subtask 2 的 400 恢复兜底捕获。
    transformContext: async (msgs: AgentMessage[]): Promise<AgentMessage[]> => {
      let lastSummaryIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (isCompactionSummary(msgs[i])) {
          lastSummaryIdx = i;
          break;
        }
      }
      const summary =
        lastSummaryIdx >= 0 ? (msgs[lastSummaryIdx] as CompactionSummaryMessage) : undefined;
      const baseMsgs: AgentMessage[] = summary
        ? [summary, ...getRetainedTail(summary), ...msgs.slice(lastSummaryIdx + 1)]
        : msgs;

      const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
      const reserveTokens = clampedCompactionReserve(model.contextWindow);
      const budget = Math.max(
        1024,
        model.contextWindow - reserveTokens - systemPromptTokens,
      );
      // DIAG (Subtask 3)：每轮 transformContext 记录一次预算数学，便于现场
      // 核对 sliding-window 是否在该转窗口的模型上如期触发。
      console.warn(
        `[diag:slidingWindow] model=${model.id} contextWindow=${model.contextWindow} systemPromptTokens=${systemPromptTokens} budget=${budget} baseLen=${baseMsgs.length}`,
      );

      // 太短就不动：与 `autoRecoverFromOverflow` 同口径（< 4 条消息没有压缩
      // 与裁剪的必要）。
      if (baseMsgs.length < 4) return baseMsgs;

      // 摘要钉在 head 不丢；预算扣减仅作用于摘要之后的「真实」消息。
      const pinnedHead: AgentMessage[] = summary ? [summary] : [];
      const tail: AgentMessage[] = summary
        ? [...getRetainedTail(summary), ...msgs.slice(lastSummaryIdx + 1)]
        : msgs;
      const summaryTokens = summary
        ? Math.ceil((summary.summary?.length ?? 0) / 4)
        : 0;
      const tailBudget = Math.max(0, budget - summaryTokens);

      // findCompactionCutPoint 语义是「第一条 token 累计 ≥ 预算的 user 消息
      // 下标」——与 sliding-window 的 turn-start 对齐目标一致。
      // 返回 <= 0 时整段 tail 已经装得下（或没有 user 可对齐），无需裁剪。
      const cutInTail = findCompactionCutPoint(tail, tailBudget);
      if (cutInTail <= 0) return baseMsgs;
      const pruned = [...pinnedHead, ...tail.slice(cutInTail)];
      // DIAG：只有真正发生裁剪时才打「pruned」行，便于从日志区分「无 op」。
      if (pruned.length !== baseMsgs.length) {
        console.warn(
          `[diag:slidingWindow] pruned from=${baseMsgs.length} to=${pruned.length}`,
        );
      }
      return pruned;
    },

    // 发送 LLM 请求的 stream 函数。pi 0.81 起 streamFn 必填（内置默认回退被移除），
    // 复用 compat 的 streamSimple：按 model.api 解析内置 provider，行为等价旧默认，
    // apiKey 仍由下面的 getApiKey 动态解析
    streamFn: streamSimple,

    // Dynamic API key resolution (handles OAuth token refresh)
    getApiKey: (provider: string): Promise<string | undefined> =>
      resolveProviderApiKey(provider),

    // 工具执行前授权门禁（可选）。permissionRequest 自定义消息无需在
    // convertToLlm 里特判——上面的 user/assistant/toolResult 白名单已把它
    // 连同其它自定义类型一并过滤，不会发给 provider。
    beforeToolCall,
  };

  return new Agent(agentOptions);
}

// ─── 公开 API ───

export { createCebianAgent, type CreateAgentOptions };
