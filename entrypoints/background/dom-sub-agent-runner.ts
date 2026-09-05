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

/** 注入到目标 tab 的 JSON-LD harvest 函数。无外部闭包依赖，能被
 *  `chrome.scripting.executeScript({ func })` 按引用序列化（mirror
 *  `getDocumentHtml` / `extractText` 的 self-contained 契约）。
 *
 *  返回：
 *  - `nodes`：DOM 出现顺序的所有顶层节点，bad block 由 spec 静默 skip
 *    （W3C JSON-LD 1.1 user-agent 处理）；
 *  - `mainEntity`：优先匹配 `WebPage.mainEntity`（embedded 或 `@id` 引用
 *    在同 block 内反查），fallback 到第一个非 `WebPage` / `WebSite` /
 *    `BreadcrumbList` 类型；
 *  - `rawCount`：原 `<script>` 元素数（含被 skip 的坏 block），用于 debug log。
 */
function harvestJsonLd(): {
  nodes: Array<Record<string, unknown>>;
  mainEntity: unknown | null;
  rawCount: number;
} {
  const scripts = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
  );
  const nodes: Array<Record<string, unknown>> = [];
  let rawCount = 0;
  for (const s of scripts) {
    rawCount++;
    if (!s.textContent) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.textContent);
    } catch {
      // W3C JSON-LD 1.1: 坏 block 静默 skip
      continue;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object') nodes.push(item as Record<string, unknown>);
      }
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      // 解开 `{ '@graph': [...] }` 包裹
      if (Array.isArray(obj['@graph'])) {
        for (const item of obj['@graph']) {
          if (item && typeof item === 'object') nodes.push(item as Record<string, unknown>);
        }
      } else {
        nodes.push(obj);
      }
    }
  }

  let mainEntity: unknown | null = null;
  const webPage = nodes.find(
    (n) => (n as any)['@type'] === 'WebPage',
  );
  if (webPage && (webPage as any).mainEntity) {
    const me = (webPage as any).mainEntity;
    if (typeof me === 'object' && me !== null) {
      if (typeof (me as any)['@id'] === 'string') {
        // `@id` 引用：本 block 内反查；跨 block 不追（research verdict：
        // naive parser 不解析 IRI，交给 LLM 处理更稳）。
        const ref = nodes.find((n) => (n as any)['@id'] === (me as any)['@id']);
        mainEntity = ref ?? null;
      } else {
        mainEntity = me;
      }
    }
  }

  if (!mainEntity) {
    const fallback = nodes.find((n) => {
      const t = (n as any)['@type'];
      return (
        typeof t === 'string' && t !== 'WebPage' && t !== 'WebSite' && t !== 'BreadcrumbList'
      );
    });
    mainEntity = fallback ?? null;
  }

  return { nodes, mainEntity, rawCount };
}

// Stage 3 / 顶部不再 import 时被外部代码引用，这里 export 一份给测试用——
// 测试用 `harvestJsonLd` 的稳定 function identity 在
// `executeInTabWithArgs` mock 里 dispatch（同 `getDocumentHtml` 模式）。
// `ForTest` 后缀显式标记「这仅是测试切面」，production caller 没有。
export const harvestJsonLdForTest = harvestJsonLd;


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
  /**
   * Stage 3 / fast-path 旁路信号：标记 fast path 走了哪条捷径。
   *  - `'json-ld'` → schema 直接拿 harvested mainEntity，0 tokens
   *  - `'vision'`  → screenshot 已 attach 到 user message
   *  - `undefined` → 走完整 LLM 流（无旁路）
   * callers（`delegate_dom` 工具）目前只读 `text / modelKey / ok / error /
   * tabId`，本字段**只**给 baseline 日志（`sub_agent:dom:done` log 的
   * `jsonLdBypassed` / `visionCaptured` 标记）使用，未来若主代理要看见
   * 再升级到 tool 返回字段。
   */
  fastShortcut?: 'json-ld' | 'vision';
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
  // Stage 3 / fast-path 旁路信号：JSON-LD harvest 直接命中 schema 走 return，
  // vision 截图被 attach 到 user message 也值得标记——这俩都不走 LLM（或
  // vision 的 LLM 输入不一样），baseline 日志需要分开。
  let jsonLdBypassed = false;
  let visionCaptured = false;
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
      // Stage 3 / fast-path 旁路标记：从 `fastResult.fastShortcut` 把信
      // 号搬出来，外层 finally :done 日志读 `jsonLdBypassed` / `visionCaptured`
      // 写到 IDB，便于 baseline 把「JSON-LD 命中 / vision 截图」和「正常
      // LLM 答」分开记账。
      if (fastResult.fastShortcut === 'json-ld') jsonLdBypassed = true;
      else if (fastResult.fastShortcut === 'vision') visionCaptured = true;
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
      // Stage 3 / fast-path 旁路标记：让 baseline 日志能区分「JSON-LD 直接
      // 命中」「vision 截图答」「正常 LLM 答」三种 fast-path 收尾方式。三者
      // 用户感知都叫 ok，但 token 成本天差地别——基线分析需要这个信号。
      ...(jsonLdBypassed ? { jsonLdBypassed: true } : {}),
      ...(visionCaptured ? { visionCaptured: true } : {}),
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

  // 原来这里有一个 early return：「articleBody 空就 fail」。Stage 3 推迟它
  // 之后——空 body 不一定是终态，canvas-only 页面（WebGL / 图表 / 图
  // 像密集）text extraction 返回空，但 Step 4.5 vision fallback 还能救起。
  // 这里**不**return，让代码继续流到 JSON-LD 旁路 → vision 尝试 → 再决定。

  // ─── Stage 3 / Step 4: structured-data bypass（JSON-LD）───
  // 当 caller 给了 `expected_schema` 时，先尝试 harvest `<script type=
  // "application/ld+json">` 块，定位 `mainEntity`，过 schema 校验——
  // 一致就**直接 return**，跳过 LLM。比 LLM call 便宜（0 tokens），对
  // ~85% 新闻 / ~80% 电商页面零开销命中。
  //
  // 失败模式：harvest 抛异常 / 无 JSON-LD / mainEntity 不存在 / schema 不匹配
  // 都安静地 fall through 到下方 LLM 流。
  let jsonLdText: string | undefined;
  if (expected_schema) {
    try {
      const harvested = await executeInTabWithArgs(resolvedTabId, harvestJsonLd, []);
      debugLog.info('sub_agent', 'sub_agent:dom:fast:jsonld_harvested', {
        tabId: resolvedTabId,
        rawCount: harvested.rawCount,
        nodeCount: harvested.nodes.length,
        hasMainEntity: harvested.mainEntity != null,
      });
      if (harvested.mainEntity) {
        const parsedSchema = parseExpectedSchema(expected_schema);
        if (parsedSchema !== null) {
          // `checkSchema` 要 TypeBox `TSchema`，但 `parseExpectedSchema`
          // 返回 `unknown`（避免 lib 层依赖 TypeBox 类型）。cast 同主循环
          // 那两条 call site（`:458` / `:1069`）一样用 `Parameters<typeof
          // checkSchema>[0]`。返回值 `string | null`：`null` = 匹配，
          // `string` = 人类可读错误（与 lib/agent/schema-validate.ts
          // :71-72 约定一致）。
          const schemaError = checkSchema(
            parsedSchema as Parameters<typeof checkSchema>[0],
            harvested.mainEntity,
          );
          if (schemaError === null) {
            jsonLdText = JSON.stringify({
              status: 'success',
              data: harvested.mainEntity,
              reason: '',
            });
            debugLog.info('sub_agent', 'sub_agent:dom:fast:jsonld_bypass', {
              tabId: resolvedTabId,
              type:
                typeof (harvested.mainEntity as any)['@type'] === 'string'
                  ? (harvested.mainEntity as any)['@type']
                  : 'Unknown',
              resultBytes: jsonLdText.length,
            });
          } else {
            debugLog.info('sub_agent', 'sub_agent:dom:fast:jsonld_schema_mismatch', {
              tabId: resolvedTabId,
              schemaError,
            });
          }
        }
      }
    } catch (err) {
      // Harvest 失败不能 block fast path——悄悄 fall through 到 LLM。
      debugLog.info('sub_agent', 'sub_agent:dom:fast:jsonld_harvest_failed', {
        tabId: resolvedTabId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (jsonLdText !== undefined) {
    // 与 LLM 那条路同一条 trunk：truncate → extractJsonOrRaw → return。
    let text = jsonLdText;
    if (text.length > MAX_RESULT_CHARS) {
      text =
        text.slice(0, MAX_RESULT_CHARS) +
        `\n\n...(truncated at ${MAX_RESULT_CHARS} chars; JSON-LD was ${jsonLdText.length} chars)`;
    }
    const { json } = extractJsonOrRaw(text);
    if (json) text = json;
    return {
      text,
      modelKey,
      ok: true,
      tabId: resolvedTabId,
      fastShortcut: 'json-ld',
    };
  }

  // ─── Stage 3 / Step 4.5: vision fallback ───
  // 触发条件（任一）：
  //  - canvas-only 空 body（Readability + raw-text fallback 都拿不到东西）；
  //  - Readability 已 fallback 到 raw text（usedReadabilityFallback=true）；
  //  - articleBody 太短（< 500 字），多半是图像密集或 SPA shell。
  // AND 模型的 pi-ai capability flag `model.input.includes('image')` 真。
  //
  // 捕获走 `chrome.tabs.captureVisibleTab`（viewport JPEG）。不切
  // chrome.debugger / CDP，避免 debugger bar flash。不 downscale——vision
  // 模型自己会下采样（Anthropic 1568 patch edge / OpenAI high detail）。
  let visionBase64: string | undefined;
  let visionTabSwitchedFromTabId: number | undefined;
  // 触发条件只看 `articleBody` 终态，不用 `usedReadabilityFallback` 自动
  // 触发：Readability 给不出 article 不一定意味着文本「不可用」——纯文本
  // 文章经 raw-text fallback 仍可能有 1-2 KB 的可读内容（spec 故意把这
  // 当作「能用」，不强推 vision 因为 vision 贵）。真正的判空信号是
  // articleBody 终态短小或全空：
  //  - 空 body（canvas / WebGL / SPA shell）
  //  - `< 500` 字符（多半是图像密集 / SPA 部分内容）
  const bodyEmpty = !articleBody || !articleBody.trim();
  const needsVision = bodyEmpty || (articleBody ? articleBody.trim().length < 500 : false);
  const modelSupportsVision =
    Array.isArray((model as any).input) && (model as any).input.includes('image');

  if (needsVision && modelSupportsVision && resolvedTabId != null) {
    try {
      const activeTabId = await getActiveTabId();
      if (activeTabId != null && activeTabId !== resolvedTabId) {
        // 目标 tab 不是当前 active——`captureVisibleTab` 只能抓当前可见
        // tab，需要临时切过去再切回。同款模式见 `lib/tools/screenshot.ts
        // :103-111`。`screenshot.ts` 用 300ms，我们用 250ms（fast path
        // // 对延迟更敏感，单 LLM 调用本身耗时长）。
        visionTabSwitchedFromTabId = activeTabId;
        await chrome.tabs.update(resolvedTabId, { active: true });
        await new Promise((r) => setTimeout(r, 250));
      }
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab({
          format: 'jpeg',
          quality: 75,
        });
        visionBase64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
        debugLog.info('sub_agent', 'sub_agent:dom:fast:vision_captured', {
          tabId: resolvedTabId,
          bytes: visionBase64.length,
          bodyEmpty,
        });
      } finally {
        // 恢复之前 active tab。`screenshot.ts:188-192` 同款 finally，
        // 关闭的 tab catch 吞掉。
        if (visionTabSwitchedFromTabId != null) {
          try {
            await chrome.tabs.update(visionTabSwitchedFromTabId, { active: true });
          } catch {
            /* tab may have been closed */
          }
        }
      }
    } catch (err) {
      // captureVisibleTab 失败（chrome://、权限、tab 不存在等）不动原流：
      // fall through 到纯文本 LLM call。模型若无 vision 能力，sub-agent
      // model 配置时早就在注册表拦掉了，不会走到这里。
      debugLog.info('sub_agent', 'sub_agent:dom:fast:vision_capture_failed', {
        tabId: resolvedTabId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── Step 4.7: 推迟到这里的 empty-body guard ───
  // Vision 已尽力，救不起才 reject。canvas-only + non-vision model 这条
  // 退化路径仍走老错误文案，向后兼容。
  if (!visionBase64 && (!articleBody || !articleBody.trim())) {
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
    // Stage 3 / image content block：vision 捕获成功时把 JPEG 当
    // `ImageContent` 块挂在 user 消息 content 数组里，跟 `text` 块并排。
    // pi-ai 接受的 shape：`{ type: 'image', data: <base64>, mimeType }`
    // （参见 `node_modules/@earendil-works/pi-ai/dist/types.d.ts:241-245`
    // 与 `lib/agent/attachments.ts:417-418`——同样的 content block 形
    // 状已经在用户贴图 / region-picker / MCP image result 三条路里用）。
    const userContent: string | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; data: string; mimeType: string }
    > = visionBase64
      ? [
          { type: 'text', text: promptBody },
          { type: 'image', data: visionBase64, mimeType: 'image/jpeg' },
        ]
      : promptBody;

    assistantMessage = await complete(
      model,
      {
        systemPrompt: FAST_DOM_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
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

  // Stage 3 / 标记 vision 旁路：success path 里如果 visionBase64 存在则
  // 说明这次 user message 带上了 image block，记到 fastShortcut；纯文本
  // 答则不设（外层 dispatch 把它当作「正常 LLM 答」）。
  return {
    text,
    modelKey,
    ok: true,
    tabId: resolvedTabId,
    ...(visionBase64 ? { fastShortcut: 'vision' as const } : {}),
  };
}
