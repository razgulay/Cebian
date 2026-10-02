import { describe, it, expect, vi } from 'vitest';
import {
  asString,
  isValidSessionId,
  assertNever,
  formatCompactCount,
  formatBytes,
  oneLine,
  truncate,
  omitUndefinedDeep,
  retryAsync,
  withTimeout,
} from '@/lib/utils';

describe('asString', () => {
  it('是字符串 → 原样返回（含空串）', () => {
    expect(asString('hi', 'fb')).toBe('hi');
    expect(asString('', 'fb')).toBe('');
  });

  it('非字符串 → 回退到 fallback', () => {
    expect(asString(123, 'fb')).toBe('fb');
    expect(asString(null, 'fb')).toBe('fb');
    expect(asString(undefined, 'fb')).toBe('fb');
    expect(asString({}, 'fb')).toBe('fb');
    expect(asString(['a'], 'fb')).toBe('fb');
    expect(asString(true, 'fb')).toBe('fb');
  });
});

describe('isValidSessionId', () => {
  const UUID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

  it('合法 UUID 形态 → true（大小写均可）', () => {
    expect(isValidSessionId(UUID)).toBe(true);
    expect(isValidSessionId(UUID.toUpperCase())).toBe(true);
  });

  it('非 UUID / 空 / 非字符串 → false', () => {
    expect(isValidSessionId('not-a-uuid')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId(`${UUID}/..`)).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(123)).toBe(false);
  });
});

describe('assertNever', () => {
  it('运行期被调用 → 抛错并带上越界值', () => {
    // 绕过类型检查模拟外部传入的越界数据。
    expect(() => assertNever('oops' as never)).toThrow('Unexpected value: oops');
  });
});

describe('formatCompactCount', () => {
  it('< 1000 → 原样整数', () => {
    expect(formatCompactCount(0)).toBe('0');
    expect(formatCompactCount(999)).toBe('999');
  });

  it('K / M 分档，丢掉末尾 .0', () => {
    expect(formatCompactCount(1000)).toBe('1K');
    expect(formatCompactCount(1200)).toBe('1.2K');
    expect(formatCompactCount(200000)).toBe('200K');
    expect(formatCompactCount(1_000_000)).toBe('1M');
    expect(formatCompactCount(1_500_000)).toBe('1.5M');
  });

  it('负数夹到 0、小数先向下取整', () => {
    expect(formatCompactCount(-5)).toBe('0');
    expect(formatCompactCount(1499.9)).toBe('1.5K');
  });
});

describe('formatBytes', () => {
  it('按二进制单位分档，保留一位小数', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(30 * 1024 * 1024)).toBe('30.0 MB');
  });
});

describe('oneLine', () => {
  it('连续空白折叠成单个空格并去掉首尾', () => {
    expect(oneLine('  a\n\n  b\tc  ')).toBe('a b c');
  });

  it('全是空白 → 空串（调用方据此回落）', () => {
    expect(oneLine(' \n\t ')).toBe('');
  });
});

describe('truncate', () => {
  it('不超长原样返回', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('超长则截断并以省略号结尾', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
  });

  it('不折叠空白——那是 oneLine 的事，组合使用', () => {
    expect(truncate('a  b', 4)).toBe('a  b');
    expect(truncate(oneLine('a  b'), 4)).toBe('a b');
  });
});

describe('omitUndefinedDeep', () => {
  const toolResult = {
    role: 'toolResult',
    toolCallId: 't',
    toolName: 'mcp__edgeone__deploy-html',
    content: [{ type: 'text', text: 'deployed', annotations: undefined }],
    details: {
      server: { id: 'srv', name: 'edgeone' },
      tool: 'deploy-html',
      structured: undefined,
      nested: [{ keep: 1, drop: undefined }],
    },
    isError: false,
    timestamp: 1,
  };

  it('递归移除 details / content 里的 undefined 字段（issue #74），不改动入参', () => {
    const out = omitUndefinedDeep(toolResult);
    expect(Object.hasOwn(out.details, 'structured')).toBe(false);
    expect(Object.hasOwn(out.details.nested[0], 'drop')).toBe(false);
    expect(out.details.nested[0].keep).toBe(1);
    expect(Object.hasOwn(out.content[0], 'annotations')).toBe(false);
    expect(Object.hasOwn(toolResult.details, 'structured')).toBe(true);
    expect(Object.hasOwn(toolResult.content[0], 'annotations')).toBe(true);
  });

  it('对所有角色生效：compactionSummary 的 retainedTail 里的 toolResult 同样被处理', () => {
    const summary = { role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: 1, retainedTail: [toolResult] };
    const out = omitUndefinedDeep(summary);
    expect(Object.hasOwn(out.retainedTail[0].details, 'structured')).toBe(false);
  });

  it('无需矫正的子树返回同一引用；共享（非环）子树不被误判', () => {
    const shared = { a: 1 };
    const value = { x: shared, y: shared, z: [shared] };
    expect(omitUndefinedDeep(value)).toBe(value);
    const mixed = { x: shared, bad: { drop: undefined } };
    const out = omitUndefinedDeep(mixed);
    expect(out).not.toBe(mixed);
    expect(out.x).toBe(shared);
  });

  it('数组元素里的 undefined 不删（避免挤位），交给写入方的 JSON 兜底', () => {
    const value = { list: [1, undefined, 3] };
    expect(omitUndefinedDeep(value)).toBe(value);
  });

  it('循环引用原样返回而不栈溢出', () => {
    const cyclic: Record<string, unknown> = { drop: undefined };
    cyclic.self = cyclic;
    const out = omitUndefinedDeep(cyclic);
    expect(Object.hasOwn(out, 'drop')).toBe(false);
    expect(out.self).toBe(cyclic);
  });
});

describe('withTimeout', () => {
  it('无外部 signal 时返回一个会超时的 signal', async () => {
    const s = withTimeout(10);
    expect(s.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.aborted).toBe(true);
  });

  it('外部 signal 中止时，合成 signal 也中止', () => {
    const outer = new AbortController();
    const s = withTimeout(60_000, outer.signal);
    expect(s.aborted).toBe(false);
    outer.abort();
    expect(s.aborted).toBe(true);
  });

  it('外部 signal 已中止时，合成 signal 立即是中止态', () => {
    const outer = new AbortController();
    outer.abort();
    expect(withTimeout(60_000, outer.signal).aborted).toBe(true);
  });
});

describe('retryAsync', () => {
  /** 记录退避序列、跳过真实延时。 */
  function spySleep() {
    const waits: number[] = [];
    return {
      waits,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
  }

  it('首次成功时不重试', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const { sleep, waits } = spySleep();
    await expect(retryAsync(fn, { attempts: 3, baseDelayMs: 10, sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('失败后重试，直到成功', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');
    const { sleep, waits } = spySleep();
    await expect(retryAsync(fn, { attempts: 5, baseDelayMs: 10, sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(waits).toHaveLength(2);
  });

  it('尝试次数用尽后抛出最后一次的错误', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValue(new Error('last'));
    const { sleep } = spySleep();
    await expect(retryAsync(fn, { attempts: 3, baseDelayMs: 10, sleep })).rejects.toThrow('last');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('attempts: 1 表示不重试', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('once'));
    const { sleep, waits } = spySleep();
    await expect(retryAsync(fn, { attempts: 1, baseDelayMs: 10, sleep })).rejects.toThrow('once');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('shouldRetry 返回 false → 立即抛出，不消耗剩余尝试', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    const { sleep, waits } = spySleep();
    const shouldRetry = vi.fn().mockReturnValue(false);
    await expect(
      retryAsync(fn, { attempts: 5, baseDelayMs: 10, shouldRetry, sleep }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('shouldRetry 收到错误与尝试序号', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('e'));
    const { sleep } = spySleep();
    const shouldRetry = vi.fn().mockReturnValue(true);
    await expect(
      retryAsync(fn, { attempts: 3, baseDelayMs: 10, shouldRetry, sleep }),
    ).rejects.toThrow();
    expect(shouldRetry.mock.calls.map((c) => c[1])).toEqual([1, 2]);
  });

  it('signal 已中止时不再重试', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('aborted'));
    const { sleep, waits } = spySleep();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      retryAsync(fn, { attempts: 5, baseDelayMs: 10, signal: ctrl.signal, sleep }),
    ).rejects.toThrow('aborted');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('退避按指数增长（含 jitter，故只断言区间）', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('e'));
    const { sleep, waits } = spySleep();
    await expect(retryAsync(fn, { attempts: 4, baseDelayMs: 100, sleep })).rejects.toThrow();
    expect(waits).toHaveLength(3);
    // 每步是 base * 2^(n-1) 的 [1,2) 倍。
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    expect(waits[0]).toBeLessThan(200);
    expect(waits[1]).toBeGreaterThanOrEqual(200);
    expect(waits[1]).toBeLessThan(400);
    expect(waits[2]).toBeGreaterThanOrEqual(400);
    expect(waits[2]).toBeLessThan(800);
  });

  it('sleep 收到本次失败的 err（供 Retry-After 之类的实现使用）', async () => {
    const err = new Error('with hint');
    const fn = vi.fn().mockRejectedValue(err);
    const seen: unknown[] = [];
    await expect(
      retryAsync(fn, {
        attempts: 2,
        baseDelayMs: 10,
        sleep: async (_ms, _sig, e) => {
          seen.push(e);
        },
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([err]);
  });
});
