// DOM 子代理工厂（背景层编排，住在 entrypoints/background/——createCebianAgent
// 是本目录的工厂，lib/ 不可反向 import 它）。即用即弃、不登记为 session。
//
// 设计目标：用一个便宜模型替主模型完成「读网页 / 提取结构」这种重活，省主模型
// token。子代理几乎只读，但允许 click 「Show more / Load more」展开按钮读取
// 隐藏内容；绝不写文件、不提交表单、不做任何破坏性操作。
//
// 安全：
// - 工具集最小化（read_page / inspect / execute_js / subagent_scroll / subagent_click）。
//   没有 interact / screenshot / fs_* / tab / pdf / chromeApi / run_skill / ask_user
//   / MCP / delegate_dom。
// - beforeToolCall 门禁：read_page 强制 maxLength ≤ 30_000 并禁止 outputPath，
//   execute_js 拒绝任何写入型调用（高风险动作都拦在子代理外）。subagent_click
//   仅限 click 动作（由 withDefaultTabId 透传 tabId），不进入门禁黑名单。
// - 不持久化：跑完即弃，不进 agentManager.sessions，session 列表对它不可见。
//
// tabId 自动注入：子代理的 read_page / inspect / execute_js / subagent_scroll
// 都要求 tabId，但子代理 LLM 经常拿不到 / 拿错（"Tab ID 9 does not exist"）。
// 我们在子代理创建时把当前活动 tab 的 id 抓下来，包成 wrapper 套在每个工具的
// execute 上 —— 子代理不传 tabId 时自动填进去，传了就尊重它的选择（advanced case
// 让主代理显式传非活动 tab id 时不会被覆盖）。

import type {
  Agent,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { createCebianAgent } from './agent';
import { readPageTool } from '@/lib/tools/read-page';
import { inspectTool } from '@/lib/tools/inspect';
import { executeJsTool } from '@/lib/tools/execute-js';
import { subagentScrollTool } from '@/lib/tools/subagent-scroll';
import { subagentClickTool } from '@/lib/tools/subagent-click';
import { debugLog, withSession } from '@/lib/debug/log';

/** 子代理专用工具集：只读 + scroll + click-to-expand。最小提权。 */
export const DOM_SUB_AGENT_TOOLS = [
  readPageTool,
  inspectTool,
  executeJsTool,
  subagentScrollTool,
  subagentClickTool,
];

/**
 * 子代理系统提示：精简到 ~250 tokens，兼容小模型（GPT-4o-mini, local Ollama 等）。
 * 关键四件事：(1) 只读 + 简单 (2) 必要时 scroll 后再读 (3) click "Show more" 展开隐藏内容
 * (4) 严格用 ```json``` 返回结构化数据。
 *
 * 注意：`tabId` 会被宿主自动注入到每个工具调用中（via `withDefaultTabId`），
 * 子代理 LLM 不需要自己寻找 tabId —— 也不应该！如果宿主漏了，它会拒绝调用任何
 * 工具并返回 "No active tab"，那也是正确的失败信号。
 */
export const DOM_SUB_AGENT_INSTRUCTIONS = `You are a DOM sub-agent. Read the page and return a single JSON block (no prose, no markdown wrapper outside of the JSON):
{"status": "success|partial|failed", "data": <answer>, "reason": "<empty if success>"}

Tools: read_page, inspect, execute_js, subagent_scroll, subagent_click.
- The host wraps every tool call with the active tabId automatically. You do NOT need to specify a tabId in your tool arguments — just call the tool with the args you want (no tabId). If a tool fails with "no active tab", return status="failed" with that reason.
- Read-only by default. NEVER type, submit forms, write files, or do anything destructive.
- execute_js must be a pure read query (querySelector, getAttribute, etc.) OR element.click() for expand/show-more buttons. Never call fetch / XHR / postMessage / localStorage / document.write.
- read_page: prefer mode "outline" first to map the page, then "markdown" or "article" for the section asked.
- subagent_scroll: if data is below the fold, scroll then re-read.
- subagent_click: for data hidden behind "Show more" / "Load more" / "Xem thêm" / "Read more" buttons. Specify textContains (preferred) or selector. Then read_page again.
- outputPath on read_page is forbidden — do not pass it.
- If the task asks for structured data, populate \`data\` with the matching shape.
- If blocked (login, captcha, no data found), set status="failed" and explain in reason.
- Be concise. The main agent pays for every token in \`data\`. Lead with the answer.`;

/** 子代理门禁：read_page maxLength 限额 + 禁 outputPath + execute_js 禁写入 API。 */
export function createDomReadOnlyGate(): (
  context: BeforeToolCallContext,
) => Promise<BeforeToolCallResult | undefined> {
  return async (context) => {
    const args = (context.args ?? {}) as Record<string, unknown>;
    if (context.toolCall.name === 'read_page') {
      const maxLength = args.maxLength;
      if (typeof maxLength === 'number' && maxLength > MAX_READ_LENGTH) {
        return { block: true, reason: `DOM sub-agent read_page maxLength capped at ${MAX_READ_LENGTH}; got ${maxLength}` };
      }
      if (typeof args.outputPath === 'string' && args.outputPath.length > 0) {
        return { block: true, reason: 'DOM sub-agent may not write to VFS via read_page.outputPath' };
      }
    }
    if (context.toolCall.name === 'execute_js') {
      const code = typeof args.code === 'string' ? args.code : '';
      // Heuristic: block common write/mutation APIs. Not bulletproof, but
      // raises the bar — a model that wants to mutate will need to be
      // creative, and a careful model is fine.
      const writePattern = /\b(fetch|XMLHttpRequest|WebSocket|postMessage|localStorage|sessionStorage|indexedDB|navigator\.send|alert|confirm|prompt|history\.(pushState|replaceState)|location\.(assign|replace|href)|document\.(write|writeln|cookie)|eval|new\s+Function)\b/i;
      if (writePattern.test(code)) {
        return { block: true, reason: 'DOM sub-agent execute_js must be read-only; this call uses a write/mutation API' };
      }
    }
    return undefined;
  };
}

const MAX_READ_LENGTH = 30_000;

/**
 * 获取当前活动 tab 的 id。Chrome 扩展的标准 API。
 * 如果扩展没运行在有 tab 的环境（例如 offscreen document），返回 null。
 */
export async function getActiveTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return typeof tab?.id === 'number' ? tab.id : null;
  } catch {
    return null;
  }
}

/**
 * 用 `defaultTabId` 给工具的 args 补一个 tabId。如果子代理 LLM 已经传了
 * tabId（advanced case：主代理显式指定了非活动 tab），尊重它的选择不覆盖。
 *
 * 用对象 spread 而不是 Object.assign 保持类型推断友好。
 * Exported so the unit test in dom-sub-agent.test.ts can exercise the
 * wrapper directly without spinning up a full Agent.
 */
export function withDefaultTabId<T extends AgentTool<any>>(tool: T, defaultTabId: number): T {
  return {
    ...tool,
    async execute(toolCallId, args, signal) {
      const merged = { ...(args ?? {}), tabId: (args as any)?.tabId ?? defaultTabId };
      return tool.execute(toolCallId, merged, signal);
    },
  };
}

export interface CreateDomSubAgentOptions {
  complexity?: 'simple' | 'complex';
  /** 显式指定要操作的 tabId。如果不传，自动用 chrome.tabs.query 拿当前活动 tab。 */
  tabId?: number;
}

export interface CreateDomSubAgentResult {
  agent: Agent;
  /** 实际注入到子代理工具里的 tabId。runner 用它来给主代理报告。 */
  tabId: number | null;
}

/**
 * 创建临时 DOM 子代理。
 * - `complexity='simple'` (默认) → thinkingLevel='off'（省钱快速）。
 * - `complexity='complex'` → thinkingLevel='low'（允许思考，处理复杂提取）。
 * - 如果 `options.tabId` 没传，自动用 `getActiveTabId()` 拿当前活动 tab，
 *   并通过 `withDefaultTabId` 包装每个工具的 execute，保证子代理 LLM 不传
 *   tabId 时也能跑起来。
 * - 当 tabId 已解析（无论来源），把它注入到 system prompt 顶端，让子代理
 *   LLM 知道当前在哪个 tab 上操作（替代它"自己找 tabId"的错误尝试）。
 */
export async function createDomSubAgent(
  model: Model<Api>,
  options: CreateDomSubAgentOptions = {},
): Promise<CreateDomSubAgentResult> {
  debugLog.info('sub_agent', 'sub_agent:dom:factory:create', {});
  const tabId = options.tabId ?? (await getActiveTabId());
  const tools = DOM_SUB_AGENT_TOOLS.map((t) =>
    tabId != null ? withDefaultTabId(t, tabId) : t,
  );
  // Inject the active tab context into the system prompt so the sub-agent
  // LLM knows the context (the main agent's context block) and doesn't try
  // to enumerate tabs to find one. Format mirrors the main agent's tool
  // context block so the pattern is familiar.
  const contextBlock = tabId != null
    ? `\n[Active Tab]\ntabId: ${tabId}\nurl: (auto-injected — query with execute_js if needed)\n`
    : '';
  const systemPrompt = DOM_SUB_AGENT_INSTRUCTIONS + contextBlock;
  const agent = createCebianAgent({
    model,
    systemPrompt,
    thinkingLevel: options.complexity === 'complex' ? 'low' : 'off',
    tools,
    beforeToolCall: createDomReadOnlyGate(),
  });
  return { agent, tabId };
}
