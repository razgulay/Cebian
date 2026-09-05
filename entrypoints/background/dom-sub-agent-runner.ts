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
import { acquireKeepAlive, releaseKeepAlive } from './lifecycle/keepalive';
import { createDomSubAgent } from './dom-sub-agent';
import { getAssistantText } from '@/lib/agent/message-helpers';
import { extractJsonOrRaw } from '@/lib/agent/json-extract';
import { parseExpectedSchema, checkSchema } from '@/lib/agent/schema-validate';
import { debugLog } from '@/lib/debug/log';

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
  let jsonParsed = false;
  let outputLen = 0;
  let thrownError: string | undefined;
  let promptLen = 0;
  let loggedComplexity: 'simple' | 'complex' = 'simple';
  // `effectiveComplexity` captures what the loop actually used on the LAST
  // attempt — which may differ from the caller's request when auto-escalation
  // fired on retry. Surfaced to the `:done` log so baseline readers can tell
  // "user asked simple, but retry escalated to complex" apart from "user
  // asked complex, loop stayed at complex".
  let effectiveComplexity: 'simple' | 'complex' = 'simple';
  let attemptCount = 0;
  // Caller-supplied `expected_schema` parsed once up front (outside the retry
  // loop) so we can validate every attempt's JSON without re-parsing. Stays
  // `undefined` when the caller didn't pass a schema — that branch is the
  // unvalidated legacy path, identical to pre-Subtask-3 behavior.
  let parsedSchema: unknown | undefined = undefined;
  try {
    const { task, expected_schema, complexity = 'simple', tabId, signal } = options;
    promptLen = task.length;
    loggedComplexity = complexity;

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
      requestedComplexity: complexity,
      expectedSchemaProvided: !!expected_schema,
    });

    const modelKey = `${model.provider}/${model.id}`;

    if (signal?.aborted) {
      return { text: '', modelKey, ok: false, error: 'Aborted before start', tabId: null };
    }

    let finalTask = task;
    if (expected_schema) {
      // Caller supplied a schema — first make sure it's valid JSON. Mirror
      // `worker-runner.ts:357-371`: malformed schema is a runner-level error,
      // not retryable (caller input is broken, retrying won't fix it). We
      // surface it before spending LLM tokens on the first attempt.
      const schema = parseExpectedSchema(expected_schema);
      if (schema === null) {
        return {
          text: '',
          modelKey,
          ok: false,
          error: 'Invalid expected_schema: not valid JSON',
          tabId: null,
        };
      }
      parsedSchema = schema;
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
        attemptCount = attempt;
        // Reset per-attempt error capture so a successful retry doesn't carry
        // the previous attempt's exception into the final `:done` log
        // (baseline measurement needs the success path to be noise-free).
        thrownError = undefined;
        // Auto-escalation: if attempt 1 used 'simple' (or no complexity),
        // attempt 2 (retry) always escalates to 'complex' so the LLM gets
        // thinking budget to handle hard cases (nested tables, Shadow DOM,
        // obfuscated selectors). If the caller already passed 'complex',
        // the retry stays at 'complex'. Effective complexity is what's passed
        // to createDomSubAgent — the caller's `complexity` option is read-only
        // for the first attempt but ignored for the retry.
        const attemptComplexity: 'simple' | 'complex' =
          attempt === 1 ? complexity : 'complex';
        effectiveComplexity = attemptComplexity;
        // 每次重试重新创建 agent（state 隔离，避免上一轮的 stale messages 干扰）
        const created = await createDomSubAgent(model, {
          complexity: attemptComplexity,
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
          thrownError = lastStopReason;
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
          // Schema validation (only when caller passed expected_schema):
          // parse the raw text as JSON and run TypeBox check. On failure with
          // retry budget remaining, escalate `simple → complex` and append
          // the schema error to the prompt so the next attempt sees what to
          // fix. On failure with no budget left, fall through to the
          // existing unhealthy-response path so the caller gets a clear
          // `Schema validation failed: ...` error instead of a silent pass.
          //
          // We re-parse JSON here (not after extractJsonOrRaw) because:
          // 1. Schema check needs a parsed value, not a string.
          // 2. extractJsonOrRaw tolerates ```json``` fences and bare {...}
          //    blocks — but when the caller passed a schema, the LLM was
          //    explicitly told to emit JSON, so a strict parse is the right
          //    contract.
          // 3. Putting the check inside the loop lets us reuse the retry
          //    budget + escalation path already wired below.
          //
          // —— 只有 caller 传了 expected_schema 才走 schema 校验分支：把
          // rawText 当 JSON 解析，跑 TypeBox check。失败且 retry budget 还有
          // → 把 simple 升级 complex、往 prompt 尾追 schema 错误反馈；失败
          // 且 budget 用完 → break 出去，让 caller 拿到清晰的
          // `Schema validation failed: ...` 而不是静默通过。
          // 这里直接 `JSON.parse(rawText)` 而不是先走 `extractJsonOrRaw`：
          // 1. checkSchema 要的是解析后的对象，不是字符串。
          // 2. extractJsonOrRaw 容错 ```json``` fence 和裸 {...}——但 caller
          //    既然传了 schema 就是明确要 JSON，严格 parse 才是正确的契约。
          // 3. 放在 loop 内可以直接复用下面已经接好的 retry budget + 升级路径。
          if (parsedSchema !== undefined) {
            let parsedJson: unknown;
            let parseOk = false;
            try {
              parsedJson = JSON.parse(rawText);
              parseOk = true;
            } catch {
              // Not parseable as JSON. Since the caller explicitly asked for
              // schema-conformant output, treat non-JSON prose as unhealthy
              // and fall through to the retry path below — same escalation
              // rule (attempt 2 → 'complex') as a schema mismatch.
              // —— caller 要 schema，LLM 却吐了散文，等价 unhealthy，落到下面
              // 同样的 retry 路径，复用 simple → complex 升级规则。
              parsedJson = undefined;
            }
            if (parseOk) {
              const schemaError = checkSchema(
                parsedSchema as Parameters<typeof checkSchema>[0],
                parsedJson,
              );
              if (schemaError !== null) {
                // Schema failed — treat as unhealthy, retry if budget left.
                // Same escalation rule as empty/unhealthy: attempt 2 always
                // uses 'complex' regardless of caller's request.
                // —— schema 不匹配：按 unhealthy 处理，budget 还在就重试；
                // 跟 empty/unhealthy 走同一套升级规则（attempt 2 永远 complex）。
                ok = false;
                lastStopReason = `schema:${schemaError}`;
                // eslint-disable-next-line no-console
                console.warn(
                  `[dom-sub-agent] attempt ${attempt} (${attemptComplexity}) returned unhealthy schema: ${schemaError}` +
                    (attempt >= MAX_RETRIES ? '' : ', escalating to complex…'),
                );
                if (attempt > MAX_RETRIES) {
                  break;
                }
                // Build retry feedback: append a `<retry-feedback>` block
                // telling the LLM exactly what to fix. The existing
                // `RETRY_REMINDER` is appended AFTER this feedback so the
                // LLM sees both "what went wrong" and "be concise, return
                // JSON" on the retry.
                // —— 拼 retry 反馈：往 prompt 尾追 `<retry-feedback>`，让
                // LLM 看到「上次哪里挂了」。下面循环里还会再拼一次 RETRY_REMINDER
                // （「be concise, return JSON」），所以 LLM 在 retry 时同时看
                // 到「具体错处」+「收紧输出」。
                finalTask +=
                  `\n\n<retry-feedback>` +
                  `\nYour previous response did not match the expected schema.` +
                  `\nSchema error: ${schemaError}` +
                  `\nFix the JSON to match the schema below.`;
                finalTask += `\n\nYou MUST return your final data strictly conforming to this schema/interface:\n${expected_schema}`;
                finalTask += `\n</retry-feedback>`;
                continue;
              }
              // Schema passed — keep `ok = true` and break out below.
              // —— schema 通过，落到 break。
            } else {
              // Schema was requested but output wasn't JSON. Same retry
              // path as a schema mismatch, with feedback pointing at the
              // parse failure rather than a TypeBox error.
              // —— 给了 schema 但 LLM 吐了非 JSON 文本。同一个 retry 机制，
              // 但反馈指向 parse 失败而非 TypeBox 错误。
              ok = false;
              lastStopReason = 'schema:response is not valid JSON';
              // eslint-disable-next-line no-console
              console.warn(
                `[dom-sub-agent] attempt ${attempt} (${attemptComplexity}) returned non-JSON while schema requested` +
                  (attempt >= MAX_RETRIES ? '' : ', escalating to complex…'),
              );
              if (attempt > MAX_RETRIES) {
                break;
              }
              finalTask +=
                `\n\n<retry-feedback>` +
                `\nYour previous response was not valid JSON.` +
                `\nThe caller requires JSON conforming to the schema below — no prose, no markdown fences.` +
                `\nFix the response to match the schema.`;
              finalTask += `\n\nYou MUST return your final data strictly conforming to this schema/interface:\n${expected_schema}`;
              finalTask += `\n</retry-feedback>`;
              continue;
            }
          }
          // 成功：跳出循环
          break;
        }
        // 空响应 / 错误：尝试重试
        // eslint-disable-next-line no-console
        console.warn(
          `[dom-sub-agent] attempt ${attempt} (${attemptComplexity}) returned ${rawText ? 'unhealthy' : 'empty'}` +
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
      // Detect schema-failure path: we tagged `lastStopReason` with a
      // `schema:` prefix inside the loop when checkSchema returned non-null
      // and the retry budget was exhausted. Surface it as a dedicated error
      // instead of the generic stopReason echo so the main agent's tool
      // card shows the actual schema mismatch.
      const schemaFailure =
        typeof lastStopReason === 'string' && lastStopReason.startsWith('schema:')
          ? lastStopReason.slice('schema:'.length)
          : null;
      return {
        text: rawText || '',
        modelKey,
        ok: false,
        error: schemaFailure
          ? `Schema validation failed: ${schemaFailure}`
          : rawText
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
    // 抽 JSON 逻辑提在 `lib/agent/json-extract.ts` 共享给 worker-runner。
    const { json } = extractJsonOrRaw(text);
    jsonParsed = json !== null;
    outputLen = rawText.length; // pre-truncate, để đo token cost thật
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
      promptLen,
      // Caller's requested complexity (read-only — may have been escalated
      // on retry by the loop).
      requestedComplexity: loggedComplexity,
      // What the loop actually used on its last attempt. With auto-escalation
      // (request 'simple' + retry), this can be 'complex' even though the
      // caller asked 'simple'. Baseline measurement needs both signals.
      effectiveComplexity,
      attemptCount,
      jsonParsed,
      outputLen,
      // `thrownError` carries raw `Error.message` text from pi-agent-core or
      // upstream provider SDKs. In normal operation this is just stack /
      // status text, but a crafted LLM response could surface SDK-rendered
      // fragments of attacker-controlled content. Treat as the same trust
      // boundary as the rest of the debug log — never display in a public UI
      // without sanitization.
      ...(thrownError ? { thrownError } : {}),
    });
  }
}
