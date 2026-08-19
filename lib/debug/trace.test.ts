/**
 * Unit tests for the cross-context phase tracer.
 *
 * Verifies shape + behaviour contract:
 *   - `startTrace()` captures a `performance.now()` anchor (or 0 if no perf).
 *   - `mark()` emits via `debugLog` with `t0`/`Δt` and merges `extra`.
 *   - `withSession` is wired so the entry's top-level `sessionId` is set.
 *   - `initialT0` resumes an anchor: marker carries the caller's t0.
 *   - `initialT0 = 0` is honoured (not mis-classified as "not passed").
 *   - No-`performance` environments degrade to a noop handle (mark is silent).
 *   - `extra` cannot override `t0` / `deltaMs` (timeline integrity).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./log', () => {
  return {
    debugLog: {
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    withSession: <T extends object>(payload: T, sid: string): T & { sessionId: string } =>
      ({ ...payload, sessionId: sid }),
  };
});

import { debugLog, withSession } from './log';
import { startTrace } from './trace';

describe('startTrace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // vi.stubGlobal auto-restores — never leaks across test files.
    vi.unstubAllGlobals();
  });

  it('emits markers with t0 and Δt from a fresh anchor', () => {
    // performance.now() returns 1000 here, then 1023 after a tick — Δt ≈ 23.
    let now = 1000;
    vi.stubGlobal('performance', { now: () => now });

    const trace = startTrace('ui', 'sess-1');
    now = 1023;
    trace.mark('chat:t0', { textLen: 5 });

    expect(debugLog.info).toHaveBeenCalledTimes(1);
    const [source, message, payload] = (debugLog.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(source).toBe('ui');
    expect(message).toBe('chat:t0');
    // Δt is rounded to 0.01 ms — `23.00`
    expect(payload).toMatchObject({
      t0: 1000,
      deltaMs: 23,
      textLen: 5,
      sessionId: 'sess-1',
    });
    // withSession wiring: top-level sessionId present.
    expect(payload.sessionId).toBe('sess-1');
    expect(typeof withSession).toBe('function');
  });

  it('resumes an existing anchor via initialT0 (cross-context resume)', () => {
    // Renderer captured 500ms ago; BG sees the same t0, so Δt matches the
    // wall-clock gap the renderer would have computed.
    let now = 600;
    vi.stubGlobal('performance', { now: () => now });
    const trace = startTrace('bg', 'sess-2', /* initialT0 */ 500);
    trace.mark('bg:prompt_received');
    const [, , payload] = (debugLog.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.t0).toBe(500);
    expect(payload.deltaMs).toBe(100);
    expect(payload.sessionId).toBe('sess-2');
  });

  it('merges arbitrary `extra` into the payload', () => {
    let now = 200;
    vi.stubGlobal('performance', { now: () => now });
    const trace = startTrace('bg', 'sess-3');
    now = 215;
    trace.mark('bg:prompt_composed', { textLen: 12, imgCount: 2, foo: 'bar' });
    const [, , payload] = (debugLog.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toMatchObject({ textLen: 12, imgCount: 2, foo: 'bar' });
    expect(payload.t0).toBe(200);
    expect(payload.deltaMs).toBe(15);
  });

  it('noop handle (no performance) is silent — keeps callers free of env guards', () => {
    // Save and remove performance; trace.mark must be a noop (no throw,
    // no debugLog call). This is the bare-Node / test runner case.
    vi.stubGlobal('performance', undefined);

    const trace = startTrace('bg', 'sess-4');
    expect(() => trace.mark('bg:something', { x: 1 })).not.toThrow();
    expect(debugLog.info).not.toHaveBeenCalled();
  });

  it('treats initialT0 = 0 as a real anchor (not "not passed")', () => {
    // 0 is a legal anchor — distinct from the noop case where `undefined`
    // means "caller didn't provide one". Using `!initialT0` would silently
    // drop legitimate zero anchors; the === undefined guard avoids that.
    let now = 100;
    vi.stubGlobal('performance', { now: () => now });
    const trace = startTrace('bg', 'sess-6', /* initialT0 */ 0);
    trace.mark('bg:from_zero_anchor');
    expect(debugLog.info).toHaveBeenCalledTimes(1);
    const [, , payload] = (debugLog.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.t0).toBe(0);
    expect(payload.sessionId).toBe('sess-6');
  });

  it('handle.t0 reflects the captured anchor', () => {
    vi.stubGlobal('performance', { now: () => 42 });
    const trace = startTrace('bg', 'sess-5');
    expect(trace.t0).toBe(42);
    expect(trace.sessionId).toBe('sess-5');
  });

  it('`extra` cannot override `t0` / `deltaMs` (timeline integrity)', () => {
    // A caller passing `t0` or `deltaMs` in `extra` would silently corrupt
    // the phase trace. mark() strips both fields before merging, so the
    // payload's timeline fields always reflect the captured anchor.
    let now = 50;
    vi.stubGlobal('performance', { now: () => now });
    const trace = startTrace('bg', 'sess-7', /* initialT0 */ 50);
    now = 75;
    trace.mark('bg:tamper_attempt', {
      t0: -1, // would reset the anchor
      deltaMs: 0, // would freeze the clock
      benign: 'kept',
    });
    const [, , payload] = (debugLog.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.t0).toBe(50);
    expect(payload.deltaMs).toBe(25);
    expect(payload.benign).toBe('kept');
  });
});