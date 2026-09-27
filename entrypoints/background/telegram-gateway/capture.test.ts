// capture.ts 单测 —— 注入 fake `chrome.debugger` / `chrome.tabs` 全局
//（同 dom-sub-agent-runner.test.ts 的注入模式）。覆盖：后台 tab 免 activate、
// discarded 唤醒顺序、DevTools 冲突文案、finally detach、per-tab 串行化、
// 错误文案。真时钟（无 timer 依赖，串行化用受控 promise 门）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureTabForTelegram } from './capture';

interface FakeChrome {
  tabs: {
    get: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    onUpdated: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
    onRemoved: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  };
  debugger: {
    attach: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
  };
}

/** 注入 fake chrome 全局；`calls` 记录关键动作的发生顺序。 */
function injectChrome(opts?: {
  /** tabs.get 第 N 次调用的返回（默认完整 tab）；用于模拟 discarded → complete 序列 */
  getResults?: Array<Record<string, unknown>>;
  /** debugger.attach 第 N 次调用抛错 */
  attachErrorOn?: number;
  /** attach 抛错的消息（默认 DevTools 冲突文案） */
  attachErrorMessage?: string;
  /** sendCommand 是否被门控挂起（返回 release 把门打开） */
  gateCapture?: boolean;
}) {
  const calls: string[] = [];
  let getCall = 0;
  let attachCall = 0;
  const gates: Array<() => void> = [];
  const removedListeners: Array<(tabId: number) => void> = [];

  const chromeFake: FakeChrome = {
    tabs: {
      get: vi.fn(async () => {
        const idx = getCall++;
        if (opts?.getResults?.[idx]) return opts.getResults[idx]!;
        return { id: 7, title: 'Tab 7', windowId: 1, discarded: false, status: 'complete' };
      }),
      reload: vi.fn(async () => {
        calls.push('reload');
      }),
      update: vi.fn(async () => {
        calls.push('update');
      }),
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      onRemoved: {
        addListener: vi.fn((fn: (tabId: number) => void) => {
          removedListeners.push(fn);
        }),
        removeListener: vi.fn((fn: (tabId: number) => void) => {
          const i = removedListeners.indexOf(fn);
          if (i >= 0) removedListeners.splice(i, 1);
        }),
      },
    },
    debugger: {
      attach: vi.fn(async () => {
        attachCall++;
        if (opts?.attachErrorOn === attachCall) {
          throw new Error(opts?.attachErrorMessage ?? 'Another debugger is already attached to this target');
        }
        calls.push('attach');
      }),
      detach: vi.fn(async () => {
        calls.push('detach');
      }),
      sendCommand: vi.fn(async (_target: unknown, method: string) => {
        calls.push(method);
        if (opts?.gateCapture) {
          await new Promise<void>((r) => gates.push(r));
        }
        return { data: 'QUJD' }; // base64('ABC')
      }),
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeFake;
  return {
    chromeFake,
    calls,
    /** 模拟用户在等待期间关掉 tab（触发 tabs.onRemoved） */
    fireRemoved: (tabId: number) => {
      for (const fn of [...removedListeners]) fn(tabId);
    },
    releaseCapture: () => {
      while (gates.length > 0) gates.shift()!();
    },
  };
}

/** 等 microtask 链落地（capture 队列是 fire-and-forget 接线）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
  vi.restoreAllMocks();
});

describe('captureTabForTelegram', () => {
  it('后台 tab：attach + captureScreenshot，全程不 activate（无 tabs.update）', async () => {
    const { calls } = injectChrome();

    const result = await captureTabForTelegram(7);

    expect(result).toEqual({ base64: 'QUJD', title: 'Tab 7' });
    expect(calls).toEqual(['attach', 'Page.captureScreenshot', 'detach']);
    expect(calls).not.toContain('update');
  });

  it('discarded tab：先 reload 唤醒到 complete 才 attach', async () => {
    // tabs.get 序列：① discarded/unloaded（captureOnce 读）→ ② complete
    //（waitForTabWake 的 catch-up 放行）→ ③ reload 后重读 title
    const { calls } = injectChrome({
      getResults: [
        { id: 7, title: 'Tab 7', windowId: 1, discarded: true, status: 'unloaded' },
        { id: 7, title: 'Tab 7', windowId: 1, discarded: false, status: 'complete' },
        { id: 7, title: 'Tab 7 (woke)', windowId: 1, discarded: false, status: 'complete' },
      ],
    });

    const result = await captureTabForTelegram(7);

    expect(result.title).toBe('Tab 7 (woke)');
    expect(calls[0]).toBe('reload');
    expect(calls.indexOf('reload')).toBeLessThan(calls.indexOf('attach'));
    expect(calls).toEqual(['reload', 'attach', 'Page.captureScreenshot', 'detach']);
  });

  it('DevTools 冲突：attach 被拒 → 越南语文案、不进 capture、不误 detach', async () => {
    const { calls } = injectChrome({ attachErrorOn: 1 });

    await expect(captureTabForTelegram(7)).rejects.toThrow(/DevTools/);
    expect(calls).toEqual([]); // attach 抛错 → 不进 finally 段（没 attach 上）
  });

  it('受限页（chrome:// 等，「Cannot attach to this target」）→ 系统页文案，与 DevTools 区分', async () => {
    injectChrome({
      attachErrorOn: 1,
      attachErrorMessage: 'Cannot attach to this target.',
    });

    await expect(captureTabForTelegram(7)).rejects.toThrow(
      'Trang hệ thống không cho phép chụp tab này',
    );
  });

  it('非 DevTools 的 attach 错误 → Capture failed 前缀包裹', async () => {
    injectChrome({
      attachErrorOn: 1,
      attachErrorMessage: 'Scheme chrome is unattached somehow',
    });

    await expect(captureTabForTelegram(7)).rejects.toThrow('Capture failed: Scheme chrome');
  });

  it('sendCommand 抛错 → Capture failed 包裹 + finally 仍然 detach', async () => {
    const { chromeFake, calls } = injectChrome();
    chromeFake.debugger.sendCommand.mockRejectedValueOnce(new Error('boom'));

    await expect(captureTabForTelegram(7)).rejects.toThrow('Capture failed: boom');
    expect(calls.at(-1)).toBe('detach');
  });

  it('空截图 → 明确报错（不被 Capture failed 前缀二次包装）', async () => {
    const { chromeFake } = injectChrome();
    chromeFake.debugger.sendCommand.mockResolvedValueOnce({ data: '' });

    const err = await captureTabForTelegram(7).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe('CDP trả về ảnh rỗng');
  });

  it('前一个 job 失败不阻塞下一个（串行链吞 rejection 继续排）', async () => {
    const { chromeFake, calls } = injectChrome();
    chromeFake.debugger.sendCommand.mockRejectedValueOnce(new Error('boom'));

    await expect(captureTabForTelegram(7)).rejects.toThrow('Capture failed: boom');
    const second = await captureTabForTelegram(7);
    expect(second.base64).toBe('QUJD');
    expect(calls.filter((c) => c === 'attach')).toHaveLength(2);
  });

  it('等待唤醒期间 tab 被关掉（onRemoved）→ 立刻报 không tồn tại，不烧满超时', async () => {
    const { fireRemoved } = injectChrome({
      getResults: [
        { id: 7, title: 'Tab 7', windowId: 1, discarded: true, status: 'unloaded' },
        // catch-up 的 tabs.get：status=loading 不放行 → 走 onRemoved 路径
        { id: 7, title: 'Tab 7', windowId: 1, discarded: false, status: 'loading' },
      ],
    });

    const p = captureTabForTelegram(7);
    await flush();
    fireRemoved(7);
    await expect(p).rejects.toThrow('Tab đã bị đóng hoặc không tồn tại');
  });

  it('tabs.get 失败 → 「Tab đã bị đóng hoặc không tồn tại」', async () => {
    const { chromeFake } = injectChrome();
    chromeFake.tabs.get.mockRejectedValueOnce(new Error('No tab with id: 7'));

    await expect(captureTabForTelegram(7)).rejects.toThrow('Tab đã bị đóng hoặc không tồn tại');
  });

  it('同 tab 两次 capture 串行（第 2 次 attach 等第 1 次 detach 之后才开始）', async () => {
    const { calls, releaseCapture } = injectChrome({ gateCapture: true });

    const p1 = captureTabForTelegram(7);
    const p2 = captureTabForTelegram(7);
    await flush();

    // 第 1 次还在门上挂着：只有一组 attach，第 2 次尚未开始
    expect(calls.filter((c) => c === 'attach')).toHaveLength(1);

    releaseCapture(); // 放行第 1 次的 captureScreenshot
    await p1;
    await flush(); // 让第 2 次（串行接上）推进到 captureScreenshot 的门上
    releaseCapture(); // 放行第 2 次
    await Promise.all([p1, p2]);

    expect(calls.filter((c) => c === 'attach')).toHaveLength(2);
    // 顺序：第 1 轮完整（attach…detach）之后第 2 轮才开始
    expect(calls.indexOf('detach')).toBeLessThan(calls.lastIndexOf('attach'));
  });

  it('不同 tab 并行（tab A 被门挂住不阻塞 tab B）', async () => {
    const { chromeFake, calls, releaseCapture } = injectChrome({ gateCapture: true });
    chromeFake.tabs.get.mockImplementation(async (tabId: number) => ({
      id: tabId,
      title: `Tab ${tabId}`,
      windowId: 1,
      discarded: false,
      status: 'complete',
    }));

    const p1 = captureTabForTelegram(1);
    const p2 = captureTabForTelegram(2);
    await flush();

    // tab 2 不等 tab 1 的门——两个 attach 都已发生
    expect(calls.filter((c) => c === 'attach')).toHaveLength(2);

    releaseCapture();
    await Promise.all([p1, p2]);
    expect(calls.filter((c) => c === 'detach')).toHaveLength(2);
  });
});
