/**
 * Worker live-stream reducer / merge / throttle queue (pure, React-free).
 *
 * 数据链路里这块是高风险纯逻辑（50–100Hz token coalesce + 50ms throttle），
 * 且历史上出过两个静默 bug：
 *   - key 取错字段（所有事件落到 `_`）→ 已被「outer toolCallId 必填」语义消除；
 *   - first-flush guard 吞掉每个 toolCallId 的首批事件 → 已被「按需创建
 *     buffer entry」消除。
 *
 * 这里直接 pin 三个对外导出 (`reduceStreamEvents` / `mergeStreamBatch` /
 * `createStreamQueue`)，不渲染 React（项目无 DOM test env；card gating 属 UI
 * wiring，manual verify）。与 hooks 解耦后还能享受 hooks-no-up 之外的
 * 单元覆盖率。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createStreamQueue,
  mergeStreamBatch,
  reduceStreamEvents,
  type WorkerLiveStreamBuffer,
} from '@/lib/agent/worker-live-stream';
import type { WorkerLiveStreamEvent } from '@/lib/ipc/protocol';

const text = (delta: string): WorkerLiveStreamEvent => ({
  kind: 'text_delta',
  sessionId: 's',
  toolCallId: undefined,
  delta,
});
const think = (delta: string): WorkerLiveStreamEvent => ({
  kind: 'thinking_delta',
  sessionId: 's',
  toolCallId: undefined,
  delta,
});
const tool = (toolName: string, args?: unknown): WorkerLiveStreamEvent => ({
  kind: 'tool_start',
  sessionId: 's',
  toolCallId: undefined,
  toolName,
  args,
});
const EMPTY: WorkerLiveStreamBuffer = { current: null, lines: [] };

// ─── reduceStreamEvents ─────────────────────────────────────────────────────

describe('reduceStreamEvents — token coalesce / line-break / FIFO', () => {
  it('coalesces same-kind deltas into a single in-progress line', () => {
    const buf = reduceStreamEvents(EMPTY, [text('Hel'), text('lo'), text(' world')]);
    expect(buf.lines).toEqual([]);
    expect(buf.current).toEqual({ kind: 'text', text: 'Hello world' });
  });

  it('flushes at newline: prefix becomes a finished line, tail stays current', () => {
    const buf = reduceStreamEvents(EMPTY, [text('line one\nline two')]);
    expect(buf.lines).toEqual([{ kind: 'text', text: 'line one' }]);
    expect(buf.current).toEqual({ kind: 'text', text: 'line two' });
  });

  it('breaks over-long same-kind text at a word boundary ≤80 chars', () => {
    const input = 'word '.repeat(30); // 150 chars, all word boundaries
    const buf = reduceStreamEvents(EMPTY, [text(input)]);
    expect(buf.lines.length).toBe(1);
    const head = buf.lines[0].text;
    expect(head.length).toBeLessThanOrEqual(80);
    expect(head.endsWith(' ')).toBe(false);
    // head + ' ' + current reconstructs the input exactly (no char lost).
    expect(`${head} ${buf.current?.text ?? ''}`).toBe(input);
  });

  it('flushes the in-progress line when the delta kind switches', () => {
    const buf = reduceStreamEvents(EMPTY, [think('hmm'), text('hi')]);
    expect(buf.lines).toEqual([{ kind: 'thinking', text: 'hmm' }]);
    expect(buf.current).toEqual({ kind: 'text', text: 'hi' });
  });

  it('tool_start flushes in-progress text then emits a compact ● tool line', () => {
    const withPath = reduceStreamEvents(EMPTY, [
      text('partial'),
      tool('fs_read_file', { path: 'a/b.ts' }),
    ]);
    expect(withPath.lines).toEqual([
      { kind: 'text', text: 'partial' },
      { kind: 'tool', text: '● fs_read_file:a/b.ts' },
    ]);
    expect(withPath.current).toBeNull();
    // 无 path 的 tool（fs_list）退化成纯 toolName —— 不 JSON.stringify args。
    const noPath = reduceStreamEvents(EMPTY, [tool('fs_list')]);
    expect(noPath.lines).toEqual([{ kind: 'tool', text: '● fs_list' }]);
  });

  it('evicts oldest finished lines FIFO beyond the 4-line cap', () => {
    let buf = EMPTY;
    for (const n of ['1', '2', '3', '4', '5']) {
      buf = reduceStreamEvents(buf, [text(`${n}\n`)]);
    }
    expect(buf.lines.map(l => l.text)).toEqual(['2', '3', '4', '5']);
  });
});

// ─── mergeStreamBatch ───────────────────────────────────────────────────────

describe('mergeStreamBatch — throttle batch merge into liveLines', () => {
  it('creates the buffer entry on a toolCallId first batch (regression pin)', () => {
    // 旧实现的 `!next.has(id) → skip` guard 会吞掉每个 toolCallId 的首批
    // 事件且 entry 永远建不起来 → LiveStreamBox 全程不渲染。此 pin 锁死
    // 「缺失 entry = 正常首批，按需创建」语义。
    const prev = new Map<string, WorkerLiveStreamBuffer>();
    const next = mergeStreamBatch(prev, new Map([['tc1', [text('hi')] as const]]));
    expect(next.get('tc1')).toEqual({ current: { kind: 'text', text: 'hi' }, lines: [] });
    // prev 不被 mutate（给 React state 的不可变快照契约）。
    expect(prev.size).toBe(0);
  });

  it('accumulates onto an existing buffer without touching other ids', () => {
    const prev = new Map<string, WorkerLiveStreamBuffer>([
      ['tc1', { current: { kind: 'text', text: 'Hel' }, lines: [] }],
      ['tc2', { current: null, lines: [{ kind: 'tool', text: '● fs_list' }] }],
    ]);
    const next = mergeStreamBatch(prev, new Map([['tc1', [text('lo')] as const]]));
    expect(next.get('tc1')?.current).toEqual({ kind: 'text', text: 'Hello' });
    expect(next.get('tc2')).toEqual(prev.get('tc2'));
  });
});

// ─── createStreamQueue ──────────────────────────────────────────────────────

describe('createStreamQueue — 50ms trailing-edge throttle + race contracts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches all events in one window into a single flush', () => {
    vi.useFakeTimers();
    let live = new Map<string, WorkerLiveStreamBuffer>();
    const queue = createStreamQueue((pending) => {
      live = mergeStreamBatch(live, pending);
    });
    for (const d of ['a', 'b', 'c', 'd', 'e']) queue.enqueue('tc1', text(d));
    expect(live.size).toBe(0); // 窗口内零 render
    vi.advanceTimersByTime(49);
    expect(live.size).toBe(0);
    vi.advanceTimersByTime(1);
    expect(live.size).toBe(1); // 5 events → 1 render
    expect(live.get('tc1')?.current).toEqual({ kind: 'text', text: 'abcde' });
  });

  it('resolveTool drops pending events so a resolved worker never re-renders', () => {
    vi.useFakeTimers();
    let live = new Map<string, WorkerLiveStreamBuffer>();
    const queue = createStreamQueue((pending) => {
      live = mergeStreamBatch(live, pending);
    });
    queue.rememberTool('delegate_task', 'tc1');
    queue.enqueue('tc1', text('stale'));
    expect(queue.resolveTool('delegate_task')).toBe('tc1');
    expect(queue.resolveTool('delegate_task')).toBeUndefined(); // idempotent
    vi.advanceTimersByTime(50);
    expect(live.size).toBe(0); // 在途事件被丢，不再渲染旧文本
  });

  it('outer toolCallId wins over inner event toolCallId (key-field regression pin)', () => {
    // `ev.toolCallId` 在 worker-runner 永远是 undefined；wire message 顶层
    // 携带的 outer `toolCallId` 才是唯一权威 key。如果反过来用 `ev.toolCallId`
    // 作 key，事件全部落到 fallback `_`，ChatPage 的 `liveLines.get(tc.id)`
    // 永远拿不到 → LiveStreamBox 不渲染。模拟 outer key = 'outer-1'、inner
    // key = 'inner-x' 两条 event 共用同一个 outer toolCallId，断言它们最终进
    // 同一个 buffer。
    vi.useFakeTimers();
    let live = new Map<string, WorkerLiveStreamBuffer>();
    const queue = createStreamQueue((pending) => {
      live = mergeStreamBatch(live, pending);
    });
    const evWithInner: WorkerLiveStreamEvent = {
      kind: 'text_delta',
      sessionId: 's',
      toolCallId: 'inner-x', // runner 实际上不会发这个值 —— 仅作 regression 防护
      delta: 'hi',
    };
    queue.enqueue('outer-1', evWithInner);
    queue.enqueue('outer-1', text(' there'));
    vi.advanceTimersByTime(50);
    // 唯一 buffer 在 outer-1 上；不存在 fallback `_` 或 inner-x。
    expect(live.has('outer-1')).toBe(true);
    expect(live.has('_')).toBe(false);
    expect(live.has('inner-x')).toBe(false);
    expect(live.get('outer-1')?.current).toEqual({ kind: 'text', text: 'hi there' });
  });

  it('reset() cancels a pending flush timer so unmount does not setState', () => {
    // 组件卸载时如果还有 pending timer，会回调到已卸载 hook 的 setState
    // （StrictMode 双挂载尤其明显）。`reset()` 必须同时清 timer + pending，
    // 否则 advanceTimers 后还会触发一次 flush。
    vi.useFakeTimers();
    let flushCalls = 0;
    const queue = createStreamQueue(() => {
      flushCalls += 1;
    });
    queue.enqueue('tc1', text('partial'));
    queue.reset();
    vi.advanceTimersByTime(50);
    expect(flushCalls).toBe(0);
    // reset 后再入队能正常工作（新一轮 timer）。
    queue.enqueue('tc1', text('fresh'));
    vi.advanceTimersByTime(50);
    expect(flushCalls).toBe(1);
  });

  it('snapshots pending before flush so enqueues during apply go to the next window', () => {
    // 关键竞态：apply 期间（React commit 同步段）可能再 enqueue 新 event。这些
    // event 必须进新 Map，不能被本批 reset 吞掉、也不能和本批混在一起。
    vi.useFakeTimers();
    const calls: ReadonlyMap<string, readonly WorkerLiveStreamEvent[]>[] = [];
    const queue = createStreamQueue((pending) => {
      calls.push(pending);
      // 在 flush 回调里再 enqueue 一条 —— 验证 snapshot + reset 已发生，新
      // event 落到全新的 Map。
      if (calls.length === 1) queue.enqueue('tc1', text(' B'));
    });
    queue.enqueue('tc1', text('A'));
    vi.advanceTimersByTime(50); // 触发第 1 次 flush
    vi.advanceTimersByTime(50); // 触发第 2 次 flush
    expect(calls).toHaveLength(2);
    // 第 1 批只含 'A'；第 2 批只含 ' B'。没有混。
    expect(calls[0].get('tc1')?.map(e => (e as { delta: string }).delta)).toEqual(['A']);
    expect(calls[1].get('tc1')?.map(e => (e as { delta: string }).delta)).toEqual([' B']);
  });
});
