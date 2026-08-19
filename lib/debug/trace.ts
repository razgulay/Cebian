/**
 * 跨 context phase tracer —— send→reply 流水线的临时诊断工具。
 *
 * 为何独立成文件、不直接走 `debugLog.*`：
 *
 * - `debugLog` 走 IndexedDB + 实时订阅，已经把原生 console 镜像进了存储，
 *   适合"原始事件"；但每条 entry 的形状由调用方各自决定，已有的条目不会
 *   自带可比的 `t0` / `Δt`。
 * - Phase marker 永远是 `{ t0, Δt, …extra }` 这种 tuple 形状。把形状集中起
 *   来，导出的 log 才是自描述的——LLM 读 JSON dump 时按 `t0` + `Δt` 排序
 *   即可重建时间轴，不用解析千变万化的 payload。
 *
 * `t0` 由本次 `startTrace()` 在**该会话第一次调用时**捕获的
 * `performance.now()` 锚点；后续 `mark()` 全部复用，让 Δt 在同一 context
 * 内单调可比。跨 context（renderer → SW）的可比性靠 IPC：`prompt` 客户端
 * 消息多了一个可选 `t0?: number` 字段，把 renderer 的锚点原样 ship 到 BG。
 * BG 收到后用 `startTrace('bg', sessionId, t0)` 接续——BG 与 renderer 的
 * `performance.now()` 起点不同，**不能**各自起锚。
 *
 * Per-token `bg:token_n` / `bg:first_token` / `hook:first_token` 这几个
 * marker 的前缀不属于 `debugLog` 的 `NOISY_PREFIXES`（那条规则只过滤
 * `event:message_update` 和 `recv:message_update`），所以 verbose 关闭时
 * 也会落盘。设计取舍：首 token latency 是用户感知「LLM 在不在响应」的
 * 最直接指标，永远不该被过滤；中间采样是每 10 个 token 一次，总量可控。
 */
import { debugLog, withSession, type DebugLogEntry } from './log';

/**
 * 单条 phase marker 的 payload 形状。`t0` 是该会话第一次 `startTrace()` 时
 * 记录的 `performance.now()` 锚点；`Δt`（= `deltaMs`）是当前 marker 距 t0
 * 的毫秒数（同一 context 内单调递增，跨 context 时 `t0` 由发起方注入以
 * 保持可比）。
 *
 * `name` 不进 payload——它就是 `debugLog` 的第二个参数（message 字段），
 * 不重复字面量也方便 grep / 过滤。`extra` 是该 marker 想带的补充信息。
 */
export interface PhaseMarker extends Record<string, unknown> {
  t0: number;
  deltaMs: number;
  [key: string]: unknown;
}

/**
 * `startTrace()` 返回的句柄。持有捕获到的 `t0` 锚点，让同一会话的所有
 * `mark()` 共享同一时间原点（renderer 与 BG 之间通过 `t0` 透传保持可比）。
 */
export interface TraceHandle {
  /** Marker 锚点：`performance.now()` at the moment of `startTrace()`. */
  readonly t0: number;
  /**
   * Session id 绑定。每次 `mark()` 调用都会把这个 id 通过 `withSession`
   * 提升到 entry 顶层——调用方在 `chat/index.tsx` 处用的是真实 id（已有
   * 会话）或占位 `'new'`（新会话）；BG 端日志通过 sessionId 索引关联
   * 时可能撞上歧义，调用方负责把占位 id 在拿到真 id 后通过 `setSessionId`
   * 替换。
   */
  sessionId: string;
  /** `debugLog` 用的 source 字段（`'ui'` / `'hook'` / `'bg'`）。 */
  readonly source: DebugLogEntry['source'] | string;
  /** Emit a phase marker. `name` becomes the `message` field on the log entry;
   *  `extra` is merged into the structured payload alongside `t0`/`Δt`.
   *  No-op when t0 is unavailable (test runner without `performance`) — keeps
   *  callers free of `typeof performance` guards. */
  mark(name: string, extra?: Record<string, unknown>): void;
  /**
   * 替换 `sessionId` 绑定。新会话首次发送时 renderer 拿到的是占位 id，
   * 真 id 在 hook `dispatchPrompt` 里生成；让 hook 调一次 `setSessionId`
   * 即可让后续 `hook:recv_*` marker 的顶层 sessionId 与 BG 对齐。
   */
  setSessionId(sessionId: string): void;
}

/**
 * Capture a trace anchor for a session and return a handle that emits
 * comparable `t0` / `Δt` markers.
 *
 * Pass an existing `t0` to **resume** an anchor from another context (the
 * IPC layer carries `t0` from renderer → background for this purpose).
 * Pass `undefined` to start a fresh anchor at the current `performance.now()`
 * — the typical case for the renderer's `handleSend` and for any background
 * code path that doesn't have a cross-context anchor (e.g. graceful retries).
 *
 * Returns a noop handle (`mark` is a silent `void`) if `performance` is
 * unavailable (test runner without `performance`). Keeps callers free of
 * `typeof performance` guards.
 */
export function startTrace(
  source: DebugLogEntry['source'] | string,
  sessionId: string,
  initialT0?: number,
): TraceHandle {
  // Defensive: `performance` exists on every browser/WXT runtime but may not
  // on bare-Node test setups. Fall back to a 0-anchor so `Δt` is always 0
  // and entries still land in the log (just without timing signal).
  const probePerf = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function';
  const hasPerf = probePerf();
  // `initialT0 === undefined` = caller 没有传锚点 → 自己起新锚。传 `0`
  // 也是合法锚点（罕见，但语义上 ≠ undefined），所以这里用 `=== undefined`
  // 而不是 `!initialT0` 来区分「没传」和「传了 0」。
  const t0 = initialT0 !== undefined ? initialT0 : hasPerf ? performance.now() : 0;
  let currentSessionId = sessionId;

  const mark = (name: string, extra?: Record<string, unknown>): void => {
    // 没拿到 `performance` 且 caller 也没传锚点 → noop handle（bare-Node 测试）。
    if (!hasPerf && initialT0 === undefined) return;
    const now = probePerf() ? performance.now() : 0;
    // 防止 `extra` 误覆盖 `t0` / `deltaMs` 破坏时间线。`t0` 必须始终是本句柄
    // 创建时的锚点，`deltaMs` 是 `now - t0`，二者都不能被 caller 注入。
    const { t0: _t0, deltaMs: _d, ...rest } = extra ?? {};
    const payload: PhaseMarker = {
      t0,
      deltaMs: Math.round((now - t0) * 100) / 100, // 0.01 ms precision; avoids JSON float noise
      ...rest,
    };
    debugLog.info(source, name, withSession(payload, currentSessionId));
  };

  const setSessionId = (next: string): void => {
    currentSessionId = next;
  };

  return { t0, sessionId, source, mark, setSessionId };
}