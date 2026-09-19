// Unit tests for lib/scheduler/runner.ts.
//
// runner 是纯函数 —— `fetch` 通过 deps 注入，所有网络 / 超时 / 解析路径都能
// 在单元测试里覆盖。计划 §「ST-B2 Review checkpoint」要求覆盖 success /
// failure / CORS / timeout；本套件外加 extract / contains_text / status_200 /
// missing-expected 等分支。
//
// mock fetch 用 `vi.fn()` 返回 `Response`-like stub（`{ ok, status, text }` 三件套
// 即可，runner 不读其它字段）。AbortError 用真实 `DOMException` 模拟——runner 通过
// `err.name === 'AbortError'` 区分 timeout 与 network。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTask, TASK_TIMEOUT_MS, _internal } from './runner';
import type { Action } from './types';

/** Build a `Response`-shaped stub from `init`. `text()` returns a Promise — runner awaits it. */
function stubResponse(init: { status?: number; ok?: boolean; body?: string }): Response {
  const status = init.status ?? 200;
  // ?? 不与 && 混用——加括号明确顺序
  const ok = init.ok ?? (status >= 200 && status < 300);
  const body = init.body ?? '';
  return {
    status,
    ok,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  } as unknown as Response;
}

const realFetch = globalThis.fetch;

describe('runTask — fetch action', () => {
  beforeEach(() => {
    // Default mock: never used; each test sets its own.
    vi.useRealTimers();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('plain GET → ok with status + body size in summary', async () => {
    const fetchMock = vi.fn(async () => stubResponse({ status: 200, body: '<html>hi</html>' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask({ action: { kind: 'fetch', url: 'https://x.test/' } }, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain('200');
      expect(result.summary).toContain('15 chars');
      expect(result.data).toBeUndefined();
    }
  });

  it('fetch + extract — happy path returns data', async () => {
    const fetchMock = vi.fn(async () =>
      stubResponse({ status: 200, body: JSON.stringify({ data: { name: 'M3' } }) }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask(
      { action: { kind: 'fetch', url: 'https://x.test/', extract: 'data.name' } },
      undefined,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('M3');
  });

  it('fetch + extract — path not found → ok: false with descriptive summary', async () => {
    const fetchMock = vi.fn(async () =>
      stubResponse({ status: 200, body: JSON.stringify({ foo: 1 }) }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask(
      { action: { kind: 'fetch', url: 'https://x.test/', extract: 'missing.path' } },
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain('missing.path');
      expect(result.summary).toContain('not found');
    }
  });

  it('fetch + extract — body not JSON → ok: false (no throw)', async () => {
    const fetchMock = vi.fn(async () => stubResponse({ status: 200, body: 'not json {' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask(
      { action: { kind: 'fetch', url: 'https://x.test/', extract: 'x.y' } },
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain('not JSON');
      expect(result.error).toBeTruthy();
    }
  });
});

describe('runTask — webcheck action', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('status_200 with 200 → ok', async () => {
    const fetchMock = vi.fn(async () => stubResponse({ status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask(
      { action: { kind: 'webcheck', url: 'https://x.test/', condition: 'status_200' } },
      undefined,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toContain('Status 200');
  });

  it('status_200 with non-200 → ok: false', async () => {
    const fetchMock = vi.fn(async () => stubResponse({ status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask(
      { action: { kind: 'webcheck', url: 'https://x.test/', condition: 'status_200' } },
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain('Status 500');
      expect(result.error).toContain('got 500');
    }
  });

  it('contains_text — substring present → ok', async () => {
    const fetchMock = vi.fn(async () =>
      stubResponse({ status: 200, body: 'service is healthy and accepting connections' }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask(
      { action: { kind: 'webcheck', url: 'https://x.test/', condition: 'contains_text', expected: 'healthy' } },
      undefined,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toContain('Body contains');
  });

  it('contains_text — substring absent → ok: false', async () => {
    const fetchMock = vi.fn(async () =>
      stubResponse({ status: 200, body: 'down for maintenance' }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask(
      { action: { kind: 'webcheck', url: 'https://x.test/', condition: 'contains_text', expected: 'healthy' } },
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not found');
  });

  it('contains_text — missing expected field → ok: false with explicit error', async () => {
    // 类型上 expected 是 optional（webcheck with status_200 不需要它），但运行时
    // 走 contains_text 分支时还没设 → runner 自己 fail 出来而不是崩溃。
    const fetchMock = vi.fn(async () => stubResponse({ status: 200, body: 'anything' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const action: Action = {
      kind: 'webcheck',
      url: 'https://x.test/',
      condition: 'contains_text',
      // expected 故意留空——模拟类型校验被绕过 / 旧数据缺字段
    };
    const result = await runTask({ action }, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain('requires');
    }
  });
});

describe('runTask — error paths', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('CORS / network failure → ok: false with fetch error (not a throw)', async () => {
    // 浏览器里 CORS block 与 DNS fail 都通过 TypeError("Failed to fetch") 冒出来
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask({ action: { kind: 'fetch', url: 'https://blocked.test/' } }, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain('Fetch failed');
      expect(result.error).toContain('Failed to fetch');
    }
  });

  it('timeout — AbortSignal.timeout fires before fetch resolves → ok: false with timeout marker', async () => {
    // 拿 deps.timeoutMs=10 让 abort 极快。fetch 模拟 200ms 才 resolve。
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }
        setTimeout(() => resolve(stubResponse({ status: 200, body: 'late' })), 200);
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runTask(
      { action: { kind: 'fetch', url: 'https://slow.test/' } },
      undefined,
      { timeoutMs: 20 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain('Timed out');
      expect(result.error).toContain('aborted');
    }
  });

  it('caller-provided AbortSignal — abort before fetch resolves → ok: false labeled "Aborted" (not "Timed out")', async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }
        // 不挂 timer —— 永远不 resolve，让 abort 唯一出口触发。
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = runTask(
      { action: { kind: 'fetch', url: 'https://slow.test/' } },
      ctrl.signal,
      { timeoutMs: 60_000 }, // 长到不会先超时
    );
    // 立刻 abort
    setTimeout(() => ctrl.abort(), 10);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain('Aborted');
      expect(result.summary).not.toContain('Timed out');
      expect(result.error).toContain('aborted');
    }
  });

  it('default TASK_TIMEOUT_MS is 30s (plan §Risk 5)', () => {
    expect(TASK_TIMEOUT_MS).toBe(30_000);
  });

  it('body read error after headers arrive → ok: false with read-failed summary', async () => {
    // 模拟服务端先 flush 200 headers 然后断流，text() reject。
    const fetchMock = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: () => Promise.reject(new Error('stream cut')),
      json: () => Promise.reject(new Error('not used')),
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask(
      { action: { kind: 'fetch', url: 'https://x.test/' } },
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain('Read body failed');
      expect(result.error).toContain('stream cut');
    }
  });
});

describe('runTask — summary trim (notification title safety)', () => {
  it('extremely long error message is trimmed to ≤ 80 chars', async () => {
    const longMsg = 'x'.repeat(500);
    const fetchMock = vi.fn(async () => {
      throw new Error(longMsg);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await runTask(
      { action: { kind: 'fetch', url: 'https://x.test/' } },
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary.length).toBeLessThanOrEqual(80);
      expect(result.error).toBe(longMsg); // error 不截断，只截 summary
    }
  });
});

describe('_internal helpers (white-box)', () => {
  it('extractPath walks nested objects', () => {
    expect(_internal.extractPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('extractPath returns undefined for missing paths', () => {
    expect(_internal.extractPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(_internal.extractPath(null, 'a')).toBeUndefined();
    expect(_internal.extractPath('not object', 'a.b')).toBeUndefined();
  });

  it('extractPath handles array index via numeric segment', () => {
    expect(_internal.extractPath({ list: [10, 20, 30] }, 'list.1')).toBe(20);
  });

  it('trimSummary trims and ellipsizes', () => {
    expect(_internal.trimSummary('a'.repeat(100))).toMatch(/^a+…$/);
    expect(_internal.trimSummary('a'.repeat(80))).toBe('a'.repeat(80));
    expect(_internal.trimSummary('short')).toBe('short');
  });
});
