// DOM 子代理运行器：把「解析模型 → 造 agent → 跑到结束 → 取最终文本 → 截断」
// 这条链收拢在此，供 delegate_dom 工具的 execute() 调用。
//
// 与 organize-manager 不同，这里不订阅 agent 事件向外广播——子代理是静默的，
// 主代理只等一个字符串结果。keepalive 仍然 acquire/release，防止 SW 在子代理
// 跑长任务（读大页）期间被 Chrome 回收。
//
// 关键修复（2026-08）：
// 1. 工具 tabId 自动注入：createDomSubAgent 现在接受 tabId 选项（或自动用
//    chrome.tabs.query 拿当前活动 tab），并用 withDefaultTabId 包装每个工具的
//    execute——子代理 LLM 不用再自己拿 tabId，也就不会再报 "Tab ID 9 does not
//    exist" 错误。
// 2. 空响应重试：某些小模型（DeepSeek v4 Flash Free、GPT-4o-mini 等）偶尔会返
//    回空 assistant 消息。我们加一层重试：第一次空就追加一段更强制的 "return
//    JSON" 提示重跑一次。如果还是空就报 failed，不再 silent pass。
// 3. JSON 解析降级：先尝试 ```json``` 代码块，再尝试裸 {...} 块，最后原样返回
//    （并标记 status）。尽量保证主代理能 parse 到 JSON。

import type { Api, Model, AssistantMessage } from '@earendil-works/pi-ai';
import {
  domSubAgentModel,
  providerCredentials,
  customProviders,
} from '@/lib/persistence/storage';
import { resolveModel } from '@/lib/providers/resolve-model';
import { acquireKeepAlive, releaseKeepAlive } from './sw-keepalive';
import { createDomSubAgent } from './dom-sub-agent';
import { getAssistantText } from '@/lib/agent/message-helpers';
import { debugLog, withSession } from '@/lib/debug/log';

/** 子代理返回给主代理的文本上限（~10 KB）。超出则截断并标注。 */
const MAX_RESULT_CHARS = 10_000;

/** 第一次空响应后追加到 prompt 尾部的"返 JSON"催促，避免沉默失败。 */
const RETRY_REMINDER =
  '\n\nReturn a JSON object wrapped in exactly one ```json``` block. Be concise — the main agent pays for every token.';

/** 最大重试次数（不算首次）。DeepSeek v4 Flash Free 之类的小模型用得上。 */
const MAX_RETRIES = 1;

export interface RunDomSubAgentOptions {
  /** 主代理交给子代理的任务描述（自然语言）。 */
  task: string;
  /** 可选的 JSON schema（给子代理参考）。 */
  expected_schema?: string;
  /** 任务复杂度：决定是否开启子代理的 reasoning (thinking) 能力。 */
  complexity?: 'simple' | 'complex';
  /** 显式指定 tabId（advanced case：主代理想读非活动 tab 时传）。不传就自动取当前活动 tab。 */
  tabId?: number;
  /** 可选 AbortSignal —— 主代理取消时传进来，子代理也会中断。 */
  signal?: AbortSignal;
}

export interface RunDomSubAgentResult {
  /** 子代理最终回答的文本（已截断至 MAX_RESULT_CHARS）。 */
  text: string;
  /** 子代理用的模型 key（provider/modelId），供主代理工具卡展示。 */
  modelKey: string;
  /** 子代理是否正常结束（最后一条 assistant 的 stopReason 非 error/aborted）。 */
  ok: boolean;
  /** 失败时的一句话原因（ok=false 时有值）。 */
  error?: string;
  /** 注入到子代理工具里的 tabId。 */
  tabId?: number | null;
}

/**
 * 解析子代理模型：读 domSubAgentModel 存储项，用 resolveModel 解析成 pi-ai Model。
 * null = 用户没配子代理模型 → 调用方应提前判断并拒绝（工具不暴露给主代理）。
 */
export async function resolveDomSubAgentModel(): Promise<Model<Api> | null> {
  const [modelCfg, creds, customProvs] = await Promise.all([
    domSubAgentModel.getValue(),
    providerCredentials.getValue(),
    customProviders.getValue(),
  ]);
  if (!modelCfg) {
    debugLog.info('sub_agent', 'sub_agent:dom:model:resolved', { modelId: null });
    return null;
  }
  const resolved = resolveModel(modelCfg, creds, customProvs ?? []) ?? null;
  debugLog.info('sub_agent', 'sub_agent:dom:model:resolved', { modelId: resolved?.id ?? null });
  return resolved;
}

/**
 * 从子代理的输出文本中尽量提取 JSON：
 * 1. 优先匹配 ```json``` 代码块。
 * 2. 其次匹配裸的 { ... } 对象。
 * 3. 都失败就返回原文（让主代理的 LLM 自己处理）。
 */
function extractJsonOrRaw(rawText: string): { json: string | null; raw: string } {
  const codeBlock = rawText.match(/```json\s*([\s\S]+?)\s*```/i);
  if (codeBlock && codeBlock[1]) {
    return { json: codeBlock[1].trim(), raw: rawText };
  }
  const bare = rawText.match(/(\{[\s\S]*\})/);
  if (bare && bare[1]) {
    return { json: bare[1].trim(), raw: rawText };
  }
  return { json: null, raw: rawText };
}

/**
 * 跑 DOM 子代理到结束，返回最终 assistant 文本（截断至 10 KB）。
 * 自动注入 tabId、空响应自动重试一次、JSON 提取带降级。
 *
 * 调用方（delegate_dom 工具）在主代理的工具执行上下文里 await 此函数——
 * 从主代理视角是同步阻塞，pi-agent-core 会等工具结果回来再继续。
 */
export async function runDomSubAgent(
  options: RunDomSubAgentOptions,
): Promise<RunDomSubAgentResult> {
  const startedAt = performance.now();
  let caught: unknown = undefined;
  try {
    const { task, expected_schema, complexity = 'simple', tabId, signal } = options;

    const model = await resolveDomSubAgentModel();
    if (!model) {
      return {
        text: '',
        modelKey: '',
        ok: false,
        error: 'No DOM sub-agent model configured. Set one in Settings → Advanced.',
      };
    }

    debugLog.info('sub_agent', 'sub_agent:dom:start', {
      promptLen: task.length,
      model: model.id,
      tabId,
    });

    const modelKey = `${model.provider}/${model.id}`;

    if (signal?.aborted) {
      return { text: '', modelKey, ok: false, error: 'Aborted before start', tabId: null };
    }

    let finalTask = task;
    if (expected_schema) {
      finalTask += `\n\nYou MUST return your final data strictly conforming to this schema/interface:\n${expected_schema}`;
    }

    // 重试循环：第一次空响应 → 在 prompt 尾追加 RETRY_REMINDER 再跑一次。
    // 第一次正常 → 跳出循环。
    let attempt = 0;
    let agent: import('@earendil-works/pi-agent-core').Agent | null = null;
    let rawText = '';
    let ok = false;
    let lastStopReason: string | undefined;
    let resolvedTabId: number | null = null;

    acquireKeepAlive();
    try {
      while (attempt <= MAX_RETRIES) {
        attempt++;
        // Auto-escalation: if attempt 1 used 'simple' (or no complexity),
        // attempt 2 (retry) always escalates to 'complex' so the LLM gets
        // thinking budget to handle hard cases (nested tables, Shadow DOM,
        // obfuscated selectors). If the caller already passed 'complex',
        // the retry stays at 'complex'. Effective complexity is what's passed
        // to createDomSubAgent — the caller's `complexity` option is read-only
        // for the first attempt but ignored for the retry.
        const effectiveComplexity: 'simple' | 'complex' =
          attempt === 1 ? complexity : 'complex';
        // 每次重试重新创建 agent（state 隔离，避免上一轮的 stale messages 干扰）
        const created = await createDomSubAgent(model, {
          complexity: effectiveComplexity,
          tabId,
        });
        agent = created.agent;
        resolvedTabId = created.tabId;
        // 重试时把 reminder 拼到 prompt 尾
        const taskToRun = attempt === 1 ? finalTask : finalTask + RETRY_REMINDER;

        // Handle signal cancellation: if the main agent cancels, abort the sub-agent
        const onAbort = () => {
          try { agent?.abort(); } catch { /* ignore */ }
        };
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          await agent.prompt(taskToRun);
        } catch (err) {
          // 异常（非 abort）也当作一次空响应，再走一次重试。
          lastStopReason = (err as Error)?.message ?? String(err);
          rawText = '';
          ok = false;
        } finally {
          if (signal) signal.removeEventListener('abort', onAbort);
        }

        // 取最后一条 assistant 消息的纯文本
        const msgs = agent.state.messages;
        rawText = '';
        ok = false;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') {
            const m = msgs[i] as AssistantMessage;
            rawText = getAssistantText(m);
            ok = m.stopReason !== 'error' && m.stopReason !== 'aborted';
            lastStopReason = m.stopReason;
            break;
          }
        }

        if (ok && rawText) {
          // 成功：跳出循环
          break;
        }
        // 空响应 / 错误：尝试重试
        // eslint-disable-next-line no-console
        console.warn(
          `[dom-sub-agent] attempt ${attempt} (${effectiveComplexity}) returned ${rawText ? 'unhealthy' : 'empty'}` +
            (lastStopReason ? ` (stopReason=${lastStopReason})` : '') +
            (attempt >= MAX_RETRIES ? '' : ', escalating to complex…'),
        );
        if (attempt > MAX_RETRIES) {
          break;
        }
      }
    } finally {
      releaseKeepAlive();
    }

    if (!ok || !rawText) {
      return {
        text: rawText || '',
        modelKey,
        ok: false,
        error: rawText
          ? `Sub-agent ended with stopReason '${lastStopReason}'.`
          : 'Sub-agent produced no assistant message after retry.',
        tabId: resolvedTabId,
      };
    }

    // 截断至 MAX_RESULT_CHARS，超出则标注
    let text =
      rawText.length > MAX_RESULT_CHARS
        ? rawText.slice(0, MAX_RESULT_CHARS) +
          `\n\n...(truncated at ${MAX_RESULT_CHARS} chars; sub-agent output was ${rawText.length} chars)`
        : rawText;

    // 尝试从 rawText 提取 JSON（```json``` 块或裸 {...} ），保证主代理拿到的是
    // 可 parse 的 JSON。失败则原样返回（主代理的 LLM 自己处理）。
    const { json } = extractJsonOrRaw(text);
    if (json) {
      text = json;
    }

    return { text, modelKey, ok: true, tabId: resolvedTabId };
  } catch (e) {
    caught = e;
    throw e;
  } finally {
    debugLog.info('sub_agent', 'sub_agent:dom:done', {
      ok: !caught,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }
}
