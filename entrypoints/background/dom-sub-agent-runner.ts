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
import { complete } from '@earendil-works/pi-ai/compat';
import {
  domSubAgentModel,
  providerCredentials,
  customProviders,
} from '@/lib/persistence/storage';
import { resolveModel } from '@/lib/providers/resolve-model';
import { acquireKeepAlive, releaseKeepAlive } from './lifecycle/keepalive';
import { createDomSubAgent, getActiveTabId } from './dom-sub-agent';
import { getAssistantText } from '@/lib/agent/message-helpers';
import { extractJsonOrRaw } from '@/lib/agent/json-extract';
import { parseExpectedSchema, checkSchema } from '@/lib/agent/schema-validate';
import { resolveProviderApiKey } from './providers/credentials';
import { getDocumentHtml, convertArticleToMarkdown } from '@/lib/tools/read-page';
import { executeInTabWithArgs } from '@/lib/browser/tab-actions';
import { debugLog } from '@/lib/debug/log';

/** 子代理返回给主代理的文本上限（~10 KB）。超出则截断并标注。 */
const MAX_RESULT_CHARS = 10_000;

/** 第一次空响应后追加到 prompt 尾部的"返 JSON"催促，避免沉默失败。 */
const RETRY_REMINDER =
  '\n\nReturn a JSON object wrapped in exactly one ```json``` block. Be concise — the main agent pays for every token.';

/** 最大重试次数（不算首次）。DeepSeek v4 Flash Free 之类的小模型用得上。 */
const MAX_RETRIES = 1;

/**
 * System prompt cho fast-path 子代理：单次 LLM call，no tools，no retry。
 * 极性：caller 要什么就给什么（caller 自己跑 schema 校验做兜底）。
 * 风格 mirror `worker-roles.ts:PREAMBLE`——直接、prescriptive、不堆术语。
 */
const FAST_DOM_SYSTEM_PROMPT =
  'You are a fast DOM extraction agent. You receive (1) a task, ' +
  '(2) an article body in Markdown, and optionally (3) a JSON schema the caller wants back. ' +
  '\n\n' +
  'Return a JSON object that strictly conforms to the schema (when provided). ' +
  'When no schema is provided, return a JSON object in a ```json``` code block. ' +
  'Be concise — the main agent pays for every token. ' +
  'No prose, no preamble, no explanation outside the JSON.';

export interface RunDomSubAgentOptions {
  /** 主代理交给子代理的任务描述（自然语言）。 */
  task: string;
  /** 可选的 JSON schema（给子代理参考）。 */
  expected_schema?: string;
  /** 任务复杂度：决定是否开启子代理的 reasoning (thinking) 能力。
   *  - 'simple' (default): ReAct loop, thinking off.
   *  - 'complex': ReAct loop + thinking low. 自动重试 / escalate 在 retry 时。
   *  - 'fast': single-shot schema-validated call, 0 tools, 0 retry. Stage 2 引入；
   *    只读 `read_page` 的 article 提取，再走一次 LLM call 出 JSON。 */
  complexity?: 'simple' | 'complex' | 'fast';
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
  let loggedComplexity: 'simple' | 'complex' | 'fast' = 'simple';
  // `effectiveComplexity` 记主循环最后一次 attempt 实际用的复杂度（caller
  // 要 simple 但 retry 升级到 complex 时就不同了）。:done 日志里有这个，
  // baseline 才能区分「caller 要 simple，retry 升级 complex」vs
  // 「caller 要 complex，循环一直 complex」。
  //
  // Fast-path：下方 `if (complexity === 'fast')` 分支在返回前会把这两个
  // local 改成固定值（'fast' / 1），外层 finally-block 就能发带
  // `effectiveComplexity: 'fast'` + `attemptCount: 1` 的忠实 :done 日志。
  // 下面的默认值只走 ReAct 循环。
  let effectiveComplexity: 'simple' | 'complex' | 'fast' = 'simple';
  let attemptCount = 0;
  // Fast-path 专用返回状态捕获。外层 finally-block 给 ReAct 循环写
  // `ok: !caught`，但 `runFastDomSubAgent` 的失败模式（injection 失败、
  // schema 不匹配、LLM stopReason error）走「return `{ ok: false, error
  // }`」**不 throw**。没有这个 local，那些失败会被记成 `ok: true`。
  // fast 分支在返回前根据返回结果设 `completedOk`，外层 finally 读它。
  let completedOk: boolean | undefined = undefined;
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

    // Fast-path dispatch（Stage 2）：完全绕开 ReAct loop。
    // 单次 schema-校验 LLM call，吃 cleaned article body（复用 `read_page`
    // 的 `article` 提取：`getDocumentHtml` + `convertArticleToMarkdown`）；
    // 0 tools、0 retry。
    //
    // 外层 `runDomSubAgent` 的 finally-block 读 `effectiveComplexity` +
    // `attemptCount` + `thrownError` 写 `sub_agent:dom:done`。我们在
    // 返回前改这三个 local，让 single-shot 路径也能发出带
    // `effectiveComplexity: 'fast'` + `attemptCount: 1` 的忠实日志
    // entry——不在 `runFastDomSubAgent` 内重复日志脚手架。如果 fast
    // 调用抛了，外层 catch 会接住 `caught = e`、rethrow，最终日志保持
    // `ok: false`。
    //
    // `completedOk` 是 fast-path 专用的：fast 的失败模式（injection 失败、
    // schema 不匹配、stopReason error）走的是「return `{ ok: false,
    // error }`」而不是 throw，光靠 `!caught` 会把所有失败都误记成
    // `ok: true`。fast dispatch 把返回值的 `ok` 写到 `completedOk`，
    // 外层 finally 用它作为日志 `ok` 字段的来源。
    if (complexity === 'fast') {
      const fastResult = await runFastDomSubAgent({
        model,
        modelKey,
        task,
        expected_schema,
        tabId,
        signal,
      });
      // 镜像主循环的 per-attempt 写入——:done 日志形状跨复杂度对齐。
      effectiveComplexity = 'fast';
      attemptCount = 1;
      completedOk = fastResult.ok;
      if (!fastResult.ok && fastResult.error) {
        // 把失败原因写到 :done 日志，让 baseline 能区分「fast path
        // schema-failed」、「fast path aborted」、「fast path LLM 抛了」。
        thrownError = fastResult.error;
      }
      return fastResult;
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
        //
        // Note: the `complexity === 'fast'` case is unreachable here — the
        // fast branch returns BEFORE the ReAct loop starts. TypeScript
        // narrows `complexity` to `'simple' | 'complex'` from this point
        // on, so no runtime guard needed.
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
      // `ok` 取值：
      // - ReAct 循环：`!caught`（抛了 = 失败；其他情况算 ok）。循环内部
      //   unhealthy 路径通过 `lastStopReason` + `!rawText` 早返设了
      //   `ok = false`，但那个 ok 不会反映到这里——这是改之前就有的行为；
      //   工具结果里的 `ok: false` 来自 `RunDomSubAgentResult.ok`，跟
      //   日志这一字段无关。
      // - Fast path：`runFastDomSubAgent` 的失败模式（injection、schema、
      //   stopReason error）走「return `{ ok: false, error }`」**不 throw**。
      //   `!caught` 对那些情况是 `true`——会把失败错记成 ok，污染 baseline
      //   日志。上面的 fast dispatch 写了 `completedOk`，这里用它，三种
      //   复杂度模式的 :done 日志形状才能对齐。
      ok: completedOk !== undefined ? completedOk : !caught,
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

// ─── Fast-path runner ───
//
// 完全绕过 ReAct loop：单次 schema-校验 LLM 调用，吃 cleaned article body。
// 0 tools、0 retry。目标是长文章页（`<context>` 显示 `wordCount > 2000`）——
// 主代理只需一次性结构化抽取，把整页喂给主模型会污染它的 context。
//
// 为什么不写成主循环里的分支：
// - 主循环自带 stateful retry、agent 创建、signal-listener 清理和每次
//   attempt 的 keepalive。Fast path 是单发，复制这些脚手架只增体积没好处。
// - 单发也意味着**不需要** keepalive：一次 LLM call 不会触发 SW 被回收，
//   `acquireKeepAlive` 还得配 release 路径——为了一次调用不值。
//
// 选 `complete`（不选 `streamSimple`）的原因：`complete` 直接返回最终
// `AssistantMessage`，不用消费 event stream。一次 LLM call、一次 await、
// 完事。`streamSimple` 是流式渲染场景的正确答案；主代理工具结果只是一个
// 字符串，做流式是浪费。参考 `lib/agent/title-generation.ts` 同款选择。
//
// Schema 校验：caller 给了 `expected_schema` 就 parse + check raw text。
// 不匹配 → 立刻返回 `Schema validation failed: ...`。**不 retry、不 escalate**——
// single-shot 是 system prompt 教给主代理的契约。
interface RunFastDomSubAgentParams {
  model: Model<Api>;
  modelKey: string;
  task: string;
  expected_schema?: string;
  tabId?: number;
  signal?: AbortSignal;
}

/**
 * 跑一次 single-shot fast-path 子代理。返回完整的 `RunDomSubAgentResult`，
 * 让 `runDomSubAgent` 的 `if (complexity === 'fast')` 分支直接 return；
 * 外层 finally-block 复用 `startedAt` / 日志脚手架。
 *
 * 所有失败都 surface 成 `ok: false` + 一句 `error`，**不走**主代理的
 * retry / escalate 路径：
 *
 * - 没有 active tab → "No active tab found for fast-path injection"
 * - `chrome.scripting.executeScript` 被拒（chrome://、PDF viewer、权限）→
 *   "Fast-path injection failed: <message>"
 * - Readability 失败（offscreen 返回 `error: 'readability-failed'` 即 `null`）→
 *   回退到 inline `extractText` 注入函数（原始文本，未经 Readability 清洗），
 *   与 `read_page` 自家的回退链一致（`lib/tools/read-page.ts:987-991`）
 * - `convertArticleToMarkdown` 抛异常（非 Readability 失败，是基础设施错）→
 *   终止（不走回退）—— 见下方 contract 注释
 * - `complete()` 抛异常 → "Fast-path LLM call threw: ..."
 * - `complete()` resolve 出 `Error`（provider 侧失败）→
 *   "Fast-path LLM call failed: ..."
 * - `stopReason === 'error' | 'aborted'` → "Fast-path LLM ended with stopReason '...'"
 * - Schema 不匹配 → "Schema validation failed: ..."
 * - 非 JSON 输出 + schema 已传 → "Schema validation failed: response is not valid JSON"
 */
async function runFastDomSubAgent(
  params: RunFastDomSubAgentParams,
): Promise<RunDomSubAgentResult> {
  const { model, modelKey, task, expected_schema, tabId, signal } = params;

  // 1. 解析 tabId（mirror `createDomSubAgent` 的 `getActiveTabId` 回退）。
  //    caller 传了就尊重（advanced case：主代理读非活动 tab）；否则查活动
  //    tab。`null` 是硬失败——没 tab 就没法注入。
  const resolvedTabId = tabId ?? (await getActiveTabId());
  if (resolvedTabId == null) {
    return {
      text: '',
      modelKey,
      ok: false,
      error: 'No active tab found for fast-path injection',
      tabId: null,
    };
  }

  if (signal?.aborted) {
    return { text: '', modelKey, ok: false, error: 'Aborted before start', tabId: resolvedTabId };
  }

  // 2. 从 tab 拿 HTML+URL。`getDocumentHtml` 就是 `read_page` 的 `article`
  //    模式用的同一个 helper；复用保证两边语义一致（selector 语义、没有
  //    `<article>` 时的回退）。
  let html: string;
  let url: string;
  try {
    const result = await executeInTabWithArgs(resolvedTabId, getDocumentHtml, [null]);
    html = result.html;
    url = result.url;
  } catch (err) {
    return {
      text: '',
      modelKey,
      ok: false,
      error: `Fast-path injection failed: ${err instanceof Error ? err.message : String(err)}`,
      tabId: resolvedTabId,
    };
  }

  if (!html) {
    return {
      text: '',
      modelKey,
      ok: false,
      error: 'Fast-path injection returned empty HTML',
      tabId: resolvedTabId,
    };
  }

  // 3. 走 offscreen document 的 Readability + turndown。失败分两种契约：
  //    - 返回 `null`（offscreen 把 Readability 失败标成
  //      `error: 'readability-failed'`）→ 走下方 raw-text 回退
  //    - 抛异常（基础设施错：offscreen document 挂掉、`sendMessage` 拒收等）
  //      → 终止。`convertArticleToMarkdown` 只把「Readability 识别不出
  //      article」映射成 `null`，其他错一律 throw，所以 catch 块可以安全
  //      当作不可恢复错（见 `lib/tools/read-page.ts:866-867`）。
  let articleBody: string | null = null;
  let usedReadabilityFallback = false;
  try {
    articleBody = await convertArticleToMarkdown(html, url);
  } catch (err) {
    return {
      text: '',
      modelKey,
      ok: false,
      error: `Fast-path article extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      tabId: resolvedTabId,
    };
  }
  if (articleBody === null) {
    // Readability 识别不出 article。回退到注入一个 plain-text 提取函数——
    // 跟 `read_page` 自家 fallback chain 行为一致。
    try {
      const rawText = await executeInTabWithArgs(
        resolvedTabId,
        // inline closure：用 `document.body.innerText` 拿可见文本。完全
        // 自包含（不闭包外部 scope），`executeScript` 可以按引用序列化。
        function extractText(): string {
          return document.body ? document.body.innerText : '';
        },
        [],
      );
      articleBody = `(Readability extraction failed, falling back to plain text)\n\n${rawText}`;
      usedReadabilityFallback = true;
    } catch (err) {
      return {
        text: '',
        modelKey,
        ok: false,
        error: `Fast-path plain-text fallback failed: ${err instanceof Error ? err.message : String(err)}`,
        tabId: resolvedTabId,
      };
    }
  }

  if (!articleBody || !articleBody.trim()) {
    return {
      text: '',
      modelKey,
      ok: false,
      error: 'Fast-path extracted article body is empty',
      tabId: resolvedTabId,
    };
  }

  // 4. 拼 prompt。caller 给 schema 时显式告诉 LLM 要符合；没给就只指 body
  //    + task。**不**在前面再贴一遍「你必须返 JSON」——`FAST_DOM_SYSTEM_PROMPT`
  //    已经压过了，重复只会涨 token。
  const promptBody = expected_schema
    ? `${task}\n\n${articleBody}\n\nYou MUST return your final data strictly conforming to this schema/interface:\n${expected_schema}`
    : `${task}\n\n${articleBody}\n\nReturn your final answer as JSON wrapped in a \`\`\`json\`\`\` block.`;

  // 5. 解析 API key，跟主 agent factory 同一套（oauth token 走
  //    `getValidOAuthToken` 自动刷新）。
  const apiKey = await resolveProviderApiKey(model.provider);

  // 6. 单次 LLM 调用。`complete()` resolve 出最终 `AssistantMessage`，
  //    真正异常才 reject；provider 侧失败 resolve 出 `Error`（按
  //    `title-generation.ts:168-177` 已建立的契约）。两条分支下面都处理。
  if (signal?.aborted) {
    return { text: '', modelKey, ok: false, error: 'Aborted before LLM call', tabId: resolvedTabId };
  }
  let assistantMessage: AssistantMessage;
  try {
    assistantMessage = await complete(
      model,
      {
        systemPrompt: FAST_DOM_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: promptBody, timestamp: Date.now() }],
        // 不传 `tools`——fast path 明确不提供工具。
      },
      // apiKey: undefined 也行——pi-ai 自己从 env / provider registry 解析
      // builtin；custom provider 由 caller 传（`resolveProviderApiKey` 上方
      // 已处理）。
      { ...(apiKey ? { apiKey } : {}), ...(signal ? { signal } : {}) },
    );
  } catch (err) {
    return {
      text: '',
      modelKey,
      ok: false,
      error: `Fast-path LLM call threw: ${err instanceof Error ? err.message : String(err)}`,
      tabId: resolvedTabId,
    };
  }
  // `complete()` resolves (not rejects) với Error khi provider fail — same
  // shape as the legacy compat surface (mirror `title-generation.ts:168-177`).
  if (assistantMessage instanceof Error) {
    return {
      text: '',
      modelKey,
      ok: false,
      error: `Fast-path LLM call failed: ${assistantMessage.message}`,
      tabId: resolvedTabId,
    };
  }
  if (assistantMessage.stopReason === 'error' || assistantMessage.stopReason === 'aborted') {
    return {
      text: assistantMessage.errorMessage ?? '',
      modelKey,
      ok: false,
      error: `Fast-path LLM ended with stopReason '${assistantMessage.stopReason}'`,
      tabId: resolvedTabId,
    };
  }

  // 7. 从 content blocks 抽 raw text。同款 flatten 模式
  //    (`title-generation.ts:193-196`，跳过非 text block)。
  const rawText = assistantMessage.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  if (!rawText) {
    return {
      text: '',
      modelKey,
      ok: false,
      error: 'Fast-path LLM returned no text content',
      tabId: resolvedTabId,
    };
  }

  // 8. Schema 校验（仅 caller 传了 `expected_schema` 时）。不匹配 → 立刻
  //    返回；single-shot 是契约。**不** retry、**不** escalate——那会重新
  //    引入 fast path 明确要避开的 ReAct-loop 模式。
  if (expected_schema) {
    const parsedSchema = parseExpectedSchema(expected_schema);
    if (parsedSchema === null) {
      // 理论上到不了：主 `runDomSubAgent` 在 fast 分支前就拒掉了非法
      // schema。这里是防御性兜底，contract 真改了也不会漏。
      return {
        text: '',
        modelKey,
        ok: false,
        error: 'Invalid expected_schema: not valid JSON',
        tabId: resolvedTabId,
      };
    }
    let parsedJson: unknown;
    let parseOk = false;
    try {
      parsedJson = JSON.parse(rawText);
      parseOk = true;
    } catch {
      return {
        text: rawText,
        modelKey,
        ok: false,
        error: 'Schema validation failed: response is not valid JSON',
        tabId: resolvedTabId,
      };
    }
    if (parseOk) {
      const schemaError = checkSchema(
        parsedSchema as Parameters<typeof checkSchema>[0],
        parsedJson,
      );
      if (schemaError !== null) {
        return {
          text: rawText,
          modelKey,
          ok: false,
          error: `Schema validation failed: ${schemaError}`,
          tabId: resolvedTabId,
        };
      }
    }
  }

  // 9. 截断 + JSON 抽取（mirror 主 runner 的 post-loop 路径——主代理
  //    拿到的形状跟 ReAct 路径完全一致）。
  let text =
    rawText.length > MAX_RESULT_CHARS
      ? rawText.slice(0, MAX_RESULT_CHARS) +
        `\n\n...(truncated at ${MAX_RESULT_CHARS} chars; fast-path output was ${rawText.length} chars)`
      : rawText;
  const { json } = extractJsonOrRaw(text);
  if (json) text = json;

  // `usedReadabilityFallback` 当前不直接 surface 给 caller——只在 baseline
  // 日志里记一笔（让后续能从 IDB 看到 Readability 在真实页面上失败多频繁）。
  // 哪天主代理需要这个信号，再升级到 `RunDomSubAgentResult` 字段。
  if (usedReadabilityFallback) {
    debugLog.info('sub_agent', 'sub_agent:dom:fast:readability_fallback', {
      tabId: resolvedTabId,
      model: model.id,
    });
  }

  return { text, modelKey, ok: true, tabId: resolvedTabId };
}
