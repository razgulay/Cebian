// Worker live-stream 的纯逻辑（Phase 2 UI feedback）：token-coalesce reducer +
// 50ms trailing-edge throttle queue。从 `hooks/useBackgroundAgent.ts` 抽出——
// 这块不依赖 React / chrome，放 lib/agent（conversation runtime 概念文件夹，
// 与 stream-replica / compaction 同层），测试可直连而无需 import 整个 hook。
//
// 数据链路：worker-runner `onLiveStream` → delegate-task `liveStreamBroadcaster`
// （注入外层 toolCallId）→ `worker_stream` ServerMessage → hook 的
// `createStreamQueue` 节流 → `mergeStreamBatch` 进 `liveLines` → LiveStreamBox。

import type { WorkerLiveStreamEvent } from '@/lib/ipc/protocol';

// ─── Buffer 形状 ───

export interface WorkerLiveLine {
  kind: 'text' | 'thinking' | 'tool';
  text: string;
}

/** 单个 toolCallId 的 buffer，`<LiveStreamBox>` 直接消费：一条 in-progress
 *  行 + 最近若干条 finished 行（FIFO）。UI 读的是不可变快照；更新一律走
 *  `reduceStreamEvents` 回流。 */
export interface WorkerLiveStreamBuffer {
  current: WorkerLiveLine | null;
  lines: readonly WorkerLiveLine[];
}

// ─── 常量 ───

/** Finished 行上限：4 + 1 in-progress = box 再长的 worker 也有界。 */
const MAX_LINES = 4;
/** 同 kind 长文本的折行点：优先 ≤80 的最后一个词边界。 */
const LINE_BREAK_AT = 80;
/** 词边界折行的最小 head 长度：前 20 字符内没空格就硬折 80（长 URL 等
 *  pathological input 的 fallback）。 */
const MIN_HEAD_FOR_WORD_BREAK = 20;

/** Trailing-edge throttle window。Token rate 50–100Hz → 每 50ms 合批一次
 *  React render → ≤20 renders/s 不论上游多快。 */
const FLUSH_MS = 50;

// ─── 纯 helper ───

/** Tool 行的紧凑标签：`fs_read_file:src/foo.ts`（path 取 args.path 顶层
 *  string）；无 path 退化成纯 toolName。刻意不 JSON.stringify(args) ——
 *  fs_create_file 的 args 可达 25–135 KB 且可能含 circular refs。 */
function formatToolPath(toolName: string, args: unknown): string {
  if (args && typeof args === 'object' && 'path' in args) {
    const path = (args as { path?: unknown }).path;
    if (typeof path === 'string' && path.length > 0) {
      return `${toolName}:${path}`;
    }
  }
  return toolName;
}

/** 追加一行；超过 MAX_LINES 时 FIFO 淘汰最旧。Pure。 */
function appendLine(
  lines: readonly WorkerLiveLine[],
  line: WorkerLiveLine,
): readonly WorkerLiveLine[] {
  const next = [...lines, line];
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

/** 尝试把 `current` 折进 `lines`：换行 / 超长（词边界）触发时返回新的
 *  `{current, lines}`，否则 null。Pure。 */
function tryFlushCurrent(
  current: WorkerLiveLine,
  lines: readonly WorkerLiveLine[],
): { current: WorkerLiveLine | null; lines: readonly WorkerLiveLine[] } | null {
  // 1) 换行 → flush 前缀，尾巴作新 current。
  const nlIdx = current.text.indexOf('\n');
  if (nlIdx >= 0) {
    const head = current.text.slice(0, nlIdx);
    const tail = current.text.slice(nlIdx + 1);
    return {
      current: tail ? { kind: current.kind, text: tail } : null,
      lines: appendLine(lines, { kind: current.kind, text: head }),
    };
  }
  // 2) 超长 → ≤80 的最后一个词边界折行；前 20 字符无空格则硬折 80。
  if (current.text.length > LINE_BREAK_AT) {
    const slice = current.text.slice(0, LINE_BREAK_AT);
    const spaceIdx = slice.lastIndexOf(' ');
    const breakAt =
      spaceIdx > MIN_HEAD_FOR_WORD_BREAK ? spaceIdx : LINE_BREAK_AT;
    const tailStart =
      spaceIdx > MIN_HEAD_FOR_WORD_BREAK ? breakAt + 1 : breakAt;
    const head = current.text.slice(0, breakAt);
    const tail = current.text.slice(tailStart);
    return {
      current: tail ? { kind: current.kind, text: tail } : null,
      lines: appendLine(lines, { kind: current.kind, text: head }),
    };
  }
  return null;
}

// ─── Reducer ───

/** 纯 reducer：把一批 `WorkerLiveStreamEvent` delta 合进 per-toolCallId
 *  buffer。coalesce / 折行 / FIFO 语义的唯一 source of truth。
 *
 *  规则：
 *  1. Coalesce：同 `kind` 的 delta 拼进 `current`。
 *  2. `current` → `lines` 的 flush 时机：遇 `\n`、超 `LINE_BREAK_AT`
 *     （有词边界则按词折）、kind 切换（text ↔ thinking）、`tool_start`
 *     到达（先 flush 再 emit tool 行）。
 *  3. Finished 行 FIFO 上限 `MAX_LINES`。
 *
 *  空 `current.text`（0 长 delta）不 flush —— 保留 partial state 给同 kind
 *  的下一个 event。 */
export function reduceStreamEvents(
  prev: WorkerLiveStreamBuffer,
  events: readonly WorkerLiveStreamEvent[],
): WorkerLiveStreamBuffer {
  let { current, lines } = prev;
  for (const ev of events) {
    if (ev.kind === 'tool_start') {
      // 先 flush 在写的行（有内容才 flush），再 emit 独立 tool 行。
      if (current && current.text) {
        lines = appendLine(lines, current);
      }
      const toolLine: WorkerLiveLine = {
        kind: 'tool',
        text: '● ' + formatToolPath(ev.toolName, ev.args),
      };
      lines = appendLine(lines, toolLine);
      current = null;
      continue;
    }
    // text_delta / thinking_delta —— coalesce 进 `current`。
    const kind: WorkerLiveLine['kind'] =
      ev.kind === 'thinking_delta' ? 'thinking' : 'text';
    if (!current || current.kind !== kind) {
      // kind 切换 → flush 旧行（有内容才 flush），开新行。
      if (current && current.text) {
        lines = appendLine(lines, current);
      }
      current = { kind, text: ev.delta };
    } else {
      current = { kind, text: current.text + ev.delta };
    }
    const flushed = tryFlushCurrent(current, lines);
    if (flushed) {
      current = flushed.current;
      lines = flushed.lines;
    }
  }
  return { current, lines };
}

/** 把一个 throttle batch 合进 `liveLines`：每个有 pending events 的
 *  toolCallId 走 `reduceStreamEvents`；entry 不存在就新建（liveLines 不
 *  pre-seed —— 首批事件到达时按需创建）。Pure；不 mutate `prev`。 */
export function mergeStreamBatch(
  prev: Map<string, WorkerLiveStreamBuffer>,
  pending: ReadonlyMap<string, readonly WorkerLiveStreamEvent[]>,
): Map<string, WorkerLiveStreamBuffer> {
  const next = new Map(prev);
  for (const [id, events] of pending) {
    const base: WorkerLiveStreamBuffer = next.get(id) ?? { current: null, lines: [] };
    next.set(id, reduceStreamEvents(base, events));
  }
  return next;
}

// ─── Throttle queue ───

/** `worker_stream` 事件的 trailing-edge 节流队列。Events 按 toolCallId 入
 *  Map；首个 event 设 50ms timer，到点把整批 pending 快照交给构造时传入的
 *  `onFlush`（hook 接 `mergeStreamBatch` 进 state）——窗口内再多 event 也只
 *  触发一次 flush，故 ≤20 renders/s。
 *
 *  `toolNameToId` 解决 `tool_resolved`：wire message 只带 `toolName`，而
 *  liveLines 以 toolCallId 为键 —— `rememberTool` 在 `tool_pending` 时
 *  populate，`resolveTool` 反查并顺带 drop 该 id 的 pending events（worker
 *  已结束，不渲染旧文本）。`reset()` 清 timer + 全部缓冲（session boundary /
 *  unsubscribe / clearSession / 组件卸载）。
 *
 *  Module-level factory：测试用 `vi.useFakeTimers()` 直接验证节流与竞态，
 *  无需渲染 React。 */
export interface StreamQueue {
  enqueue: (toolCallId: string, ev: WorkerLiveStreamEvent) => void;
  rememberTool: (toolName: string, toolCallId: string) => void;
  resolveTool: (toolName: string) => string | undefined;
  reset: () => void;
}

export function createStreamQueue(
  onFlush: (pending: ReadonlyMap<string, readonly WorkerLiveStreamEvent[]>) => void,
): StreamQueue {
  let byToolCallId = new Map<string, WorkerLiveStreamEvent[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const toolNameToId = new Map<string, string>();

  return {
    enqueue: (toolCallId, ev) => {
      // 外层 delegate_task toolCallId 由 wire message 顶层携带（protocol
      // 必填）；`ev.toolCallId` 在 worker-runner 层永远是 undefined。落到
      // `_` 只可能是 BG 漂移（老版本未注入 id）——warn 出来而不是静默吞。
      const key = toolCallId || ev.toolCallId || '_';
      if (key === '_') {
        console.warn('[worker-live-stream] worker_stream missing toolCallId, events fell back to "_" key');
      }
      let buf = byToolCallId.get(key);
      if (!buf) {
        buf = [];
        byToolCallId.set(key, buf);
      }
      buf.push(ev);
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        // 先 snapshot + reset 再 flush：flush 期间（React commit 同步段）
        // 新到的 event 进新 Map，不与本批混、也不会被本批的 reset 吞掉。
        const pending = byToolCallId;
        byToolCallId = new Map();
        onFlush(pending);
      }, FLUSH_MS);
    },
    rememberTool: (toolName, toolCallId) => {
      toolNameToId.set(toolName, toolCallId);
    },
    resolveTool: (toolName) => {
      const id = toolNameToId.get(toolName);
      toolNameToId.delete(toolName);
      if (id) byToolCallId.delete(id);
      return id;
    },
    reset: () => {
      byToolCallId = new Map();
      toolNameToId.clear();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    },
  };
}
