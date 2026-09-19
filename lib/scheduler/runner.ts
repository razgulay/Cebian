// Scheduled task 执行 runner：纯异步函数，被 BG manager tick 调用。
//
// 设计要点（AGENTS.md lib-no-up-runtime）：
//   - 不依赖 chrome.* —— `fetch` 由 deps 注入，默认用 globalThis.fetch；
//     `AbortSignal.timeout` 是 platform-standard。BG（`entrypoints/background/`）
//     在那里跑同样的 `globalThis.fetch`，无需任何特殊桥接。
//   - 不抛错返回 RunResult —— 任务失败（网络 / 解析 / 业务条件）都收敛到
//     `{ ok: false, summary, at, error }`，BG 把 lastResult 写回 storage，
//     UI 列表 / chrome.notifications 直接拿这个用。Programmer 错（被 TS 编译挡）
//     可以抛。
//
// Timeout：每个任务 30 秒硬上限（plan §「Concurrency & keep-alive」）。
// AbortSignal.timeout 是 Chrome 116+ / Node 18+，Cebian target Chrome MV3
// 已远超该底线——直接用平台 API，不自造 setTimeout race。

import type { Action, NotifyConfig, RunResult, ScheduledTask, WebCheckCondition } from './types';
import { truncate } from '@/lib/utils';

/** Per-task 硬上限。30s 来自 plan §「Risk 5」——5 分钟 SW cap 不踩，
 *  绝大多数 fetch + 简单解析 1–5 秒搞定。 */
export const TASK_TIMEOUT_MS = 30_000;

/** runner 的可注入依赖。生产路径用 `{}`（拿默认 fetch + 默认 timeout）；测试
 *  路径注入 mock fetch + 自定义 timeout。 */
export interface RunnerDeps {
  fetch?: typeof fetch;
  /** 覆盖默认超时（30s）。测试里常设 100ms 之类加速断言。 */
  timeoutMs?: number;
}

/** 一个 signal 包装，记录「超时是不是真的发生了」。
 *  - `signal`：传给 fetch 的 AbortSignal
 *  - `didTimeout()`：调用时若已经因 timeout 而 abort，返回 true（caller-cancel
 *    时仍为 false）
 *  实现要点：`AbortSignal.any` 把 caller 与 timeout 合并后没法区分谁先 abort——
 *  改用单独监听 timeoutSignal 的 abort 事件，闭包标记。caller-cancel 路径同样
 *  监听但不需要标记（区分语义只关心「超时 vs 取消」）。 */
interface ComposedSignal {
  signal: AbortSignal;
  didTimeout: () => boolean;
}

function composeSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): ComposedSignal {
  let timedOut = false;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  timeoutSignal.addEventListener('abort', () => { timedOut = true; }, { once: true });
  if (!callerSignal) {
    return { signal: timeoutSignal, didTimeout: () => timedOut };
  }
  return {
    signal: AbortSignal.any([callerSignal, timeoutSignal]),
    didTimeout: () => timedOut,
  };
}

/** 简版 jsonpath：按 `.` 切段走对象。遇 null / 非对象返回 undefined。
 *  v1 不支持 wildcard / filter / bracket 语法——满足「抽取响应字段塞进
 *  result.data」的最小需求；复杂查询需求 v2 拉真正的 jsonpath 库。数字段在数组
 *  对象上「碰巧」能走通（JS 数组即带数字 key 的对象），但这是 implementation
 *  detail，不要在用户文档里宣传。 */
function extractPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** runner 的 summary 会被 `chrome.notifications` title 直接用；截到 ≤ 80 字符是
 *  notification body 的舒适上限。复用 lib/utils.ts 的 truncate（≤ max+1 字符）——max=80
 *  时截后长度 ≤ 81 字符，仍在通知安全预算内，避免在 runner 里再写一份 near-identical
 *  helper（AGENTS.md「复用优先」）。 */
function trimSummary(raw: string, max = 80): string {
  return truncate(raw, max);
}

function ok(summary: string, at: number, data?: unknown): RunResult {
  return data === undefined
    ? { ok: true, summary: trimSummary(summary), at }
    : { ok: true, summary: trimSummary(summary), at, data };
}

function fail(summary: string, at: number, error: string): RunResult {
  return { ok: false, summary: trimSummary(summary), at, error };
}

/** Dispatch by action.kind。Public surface — BG manager 唯一入口。 */
export async function runTask(
  task: Pick<ScheduledTask, 'action'>,
  callerSignal: AbortSignal | undefined,
  deps: RunnerDeps = {},
): Promise<RunResult> {
  const at = Date.now();
  try {
    if (task.action.kind === 'fetch') {
      return await runFetch(task.action, callerSignal, deps, at);
    }
    return await runWebCheck(task.action, callerSignal, deps, at);
  } catch (err) {
    // 兜底：任何未被上面 handler 吃掉的 throw（理论上不应该有——每个分支
    // 已经 catch 自己的网络/解析错）。这里把异常转成 RunResult 而不是 rethrow，
    // 保证 BG manager 拿到的永远是 RunResult 形状。
    const message = err instanceof Error ? err.message : String(err);
    return fail('Runner crashed', at, message);
  }
}

async function runFetch(
  action: Extract<Action, { kind: 'fetch' }>,
  callerSignal: AbortSignal | undefined,
  deps: RunnerDeps,
  at: number,
): Promise<RunResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const composed = composeSignal(callerSignal, deps.timeoutMs ?? TASK_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(action.url, { signal: composed.signal });
  } catch (err) {
    return mapFetchError(action.url, err, at, composed.didTimeout);
  }

  // fetch 拿到 body 一次（getReader / text / json 互斥）。runner 需要 raw text 做
  // extract 后的 jsonparse，webcheck 需要 raw text 做 includes——统一走 text()。
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Read body failed: ${res.status}`, at, message);
  }

  if (!action.extract) {
    return ok(`Fetched (${text.length} chars, ${res.status})`, at);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Response not JSON`, at, message);
  }
  const value = extractPath(parsed, action.extract);
  if (value === undefined) {
    return fail(`Path '${action.extract}' not found`, at, 'extract path resolved to undefined');
  }
  return ok(`Extracted ${action.extract}`, at, value);
}

async function runWebCheck(
  action: Extract<Action, { kind: 'webcheck' }>,
  callerSignal: AbortSignal | undefined,
  deps: RunnerDeps,
  at: number,
): Promise<RunResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const composed = composeSignal(callerSignal, deps.timeoutMs ?? TASK_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(action.url, { signal: composed.signal });
  } catch (err) {
    return mapFetchError(action.url, err, at, composed.didTimeout);
  }

  const statusOk = res.status === 200;
  if (action.condition === 'status_200') {
    return statusOk
      ? ok(`Status 200 OK`, at)
      : fail(`Status ${res.status}`, at, `expected status 200, got ${res.status}`);
  }

  // contains_text —— 需要 body
  if (!action.expected) {
    return fail(`contains_text requires 'expected'`, at, 'missing expected field on webcheck');
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Read body failed: ${res.status}`, at, message);
  }
  if (statusOk && text.includes(action.expected)) {
    return ok(`Body contains expected text`, at);
  }
  return fail(
    statusOk ? `Body missing expected text` : `Status ${res.status} + missing text`,
    at,
    `expected substring not found in ${text.length} chars`,
  );
}

/** Map 一个 fetch-throw 到 RunResult。AbortError 区分 timeout vs caller-cancel：
 *  `didTimeout()` 让我们知道是 30s 硬上限触发还是用户主动 abort。其它 error
 *  （DNS / TLS / CORS）统一归 network。 */
function mapFetchError(url: string, err: unknown, at: number, didTimeout: () => boolean): RunResult {
  const message = err instanceof Error ? err.message : String(err);
  const isAbort =
    (err instanceof Error && err.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError');
  if (isAbort) {
    return didTimeout()
      ? fail(`Timed out fetching`, at, `fetch aborted: ${message}`)
      : fail(`Aborted fetching`, at, `fetch aborted: ${message}`);
  }
  return fail(`Fetch failed: ${url}`, at, message);
}

/** Re-export 暴露给测试 / 上层做白盒验证。 */
export const _internal = { extractPath, trimSummary, composeSignal, mapFetchError };

/** Re-export types 让 ST-B3 / ST-B4 看着更连贯（不必 import ./types 两次）。 */
export type { Action, NotifyConfig, RunResult, ScheduledTask, WebCheckCondition };
