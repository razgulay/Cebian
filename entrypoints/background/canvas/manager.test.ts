// Unit tests for the BG canvas manager: VFS-onChange wiring, openCanvas,
// and the `canvas_file_changed` broadcast flow.
//
// We mock two modules so the test stays focused on the manager's decision
// logic without touching real IndexedDB (VFS) or chrome.runtime (broadcast):
//   - `@/lib/persistence/vfs` — replaced with a stub exposing just the
//     surface the manager uses (`readFile`, `onChange`, `normalizePath`).
//     `vfs.onChange` captures the registered listener into a module-level
//     variable so tests can inject synthesized `VfsChangeEvent`s directly.
//   - `../ipc/port-registry` — replaced with a recording `broadcastAll` so
//     tests assert on the exact `ServerMessage` payloads delivered.
//
// 异步刷盘用 `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(0)`，
// 比 `setTimeout(0)` 更确定——后者在 CI 高负载下偶尔被宿主「合并 tick」到
// 比预期晚一拍，跑在 4ms 最低 timer 边界时可能 race 断言。fake timers
// 把所有 setTimeout 调度换成可控虚拟队列，与 jsdom / node 微任务队列
// 保持一致 drain。这是 `stream-broadcast.test.ts` 已确立的模式。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { VfsChangeEvent } from '@/lib/persistence/vfs';

// ─── mock module surface ───

/** 注入测试用 VFS 监听器：捕获 `vfs.onChange` 注册的回调供测试直接调用。 */
let vfsHandler: ((event: VfsChangeEvent) => void) | null = null;

vi.mock('@/lib/persistence/vfs', () => ({
  vfs: {
    readFile: vi.fn(),
    onChange: (handler: (event: VfsChangeEvent) => void) => {
      vfsHandler = handler;
      return () => {
        if (vfsHandler === handler) vfsHandler = null;
      };
    },
  },
  /**
   * 测试用的最简规范化：`./` 与 `foo/../bar` 不在此覆盖——本测试只关心
   * 「入口 normalize 一次」行为。`/foo/../bar` 这种由 normalizePath 真正处理
   * 的语义不在本测试套件覆盖范围（属于 vfs.test.ts）。
   */
  normalizePath: (p: string) => (p.startsWith('/') ? p : `/${p}`),
}));

const broadcastCalls: { msg: unknown }[] = [];
vi.mock('../ipc/port-registry', () => ({
  broadcastAll: (msg: unknown) => {
    broadcastCalls.push({ msg });
  },
}));

// ─── 受测模块（必须在 mock 注册之后导入） ───

const { openCanvas, closeCanvas, setupCanvas } = await import('./manager');
const { vfs } = await import('@/lib/persistence/vfs');

const mockRead = () => vfs.readFile as unknown as ReturnType<typeof vi.fn>;

/** 等待 `handleVfsChange` 内的 fire-and-forget `void (async () => {…})()`
 *  走完一次 microtask + timer flush。与 `setTimeout(0)` 不同，确定且不依赖
 *  宿主最小 timer 间隔。 */
const flushAsync = () => vi.advanceTimersByTimeAsync(0);

const KNOWN_SESSIONS = ['s1', 's2'];

describe('canvas BG manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    broadcastCalls.length = 0;
    vfsHandler = null;
    // 模块级 `openBySession` map 在测试文件内跨测试持久；按已知 session id
    // 关闭以隔离状态。新增测试若引入新 id，记得追加到 KNOWN_SESSIONS。
    for (const id of KNOWN_SESSIONS) closeCanvas(id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('openCanvas', () => {
    it('reads VFS, stores, and broadcasts canvas_opened with normalized path', async () => {
      mockRead().mockResolvedValue('<html>hi</html>');

      const file = await openCanvas('s1', '/foo.html');

      expect(file.path).toBe('/foo.html');
      expect(file.content).toBe('<html>hi</html>');
      expect(broadcastCalls).toEqual([
        {
          msg: {
            type: 'canvas_opened',
            sessionId: 's1',
            path: '/foo.html',
            content: '<html>hi</html>',
          },
        },
      ]);
    });

    it('normalizes relative paths via mock normalizePath (entry-side normalization)', async () => {
      // 输入 `foo.html` → mock normalizePath 把它变 `/foo.html`。
      mockRead().mockResolvedValue('content');

      const file = await openCanvas('s1', 'foo.html');

      expect(file.path).toBe('/foo.html');
      expect(broadcastCalls[0].msg).toMatchObject({
        type: 'canvas_opened',
        sessionId: 's1',
        path: '/foo.html',
      });
    });

    it('VFS read failure surfaces as a thrown error (not silent empty content)', async () => {
      mockRead().mockRejectedValue(new Error('ENOENT'));

      await expect(openCanvas('s1', '/missing.html')).rejects.toThrow('ENOENT');
      // 失败路径不应有 broadcast——LLM 工具 handler 见到 throw 会包成 tool error。
      expect(broadcastCalls).toHaveLength(0);
    });

    it('overwrites a previously-open file in the same session (last-write-wins)', async () => {
      mockRead().mockResolvedValueOnce('first');
      await openCanvas('s1', '/first.html');
      broadcastCalls.length = 0;

      mockRead().mockResolvedValueOnce('second');
      await openCanvas('s1', '/second.html');

      expect(broadcastCalls).toEqual([
        { msg: { type: 'canvas_opened', sessionId: 's1', path: '/second.html', content: 'second' } },
      ]);
    });
  });

  describe('closeCanvas', () => {
    it('removes the session entry (subsequent VFS writes do not broadcast)', async () => {
      mockRead().mockResolvedValueOnce('initial');
      await openCanvas('s1', '/foo.html');
      closeCanvas('s1');

      setupCanvas();
      expect(vfsHandler).not.toBeNull();
      broadcastCalls.length = 0;

      await vfsHandler!({ kind: 'write', path: '/foo.html' });
      await flushAsync();

      expect(broadcastCalls).toHaveLength(0);
    });
  });

  describe('VFS onChange → canvas_file_changed broadcast', () => {
    beforeEach(() => {
      setupCanvas();
      expect(vfsHandler).not.toBeNull();
    });

    it('write to a watched path → broadcasts canvas_file_changed with new content', async () => {
      mockRead().mockResolvedValueOnce('initial');
      await openCanvas('s1', '/watched.html');
      mockRead().mockReset().mockResolvedValue('updated content');
      broadcastCalls.length = 0;

      await vfsHandler!({ kind: 'write', path: '/watched.html' });
      await flushAsync();

      expect(broadcastCalls).toEqual([
        {
          msg: {
            type: 'canvas_file_changed',
            sessionId: 's1',
            path: '/watched.html',
            content: 'updated content',
          },
        },
      ]);
    });

    it('write to an unwatched path → no broadcast (no session is listening)', async () => {
      mockRead().mockResolvedValueOnce('initial');
      await openCanvas('s1', '/watched.html');
      broadcastCalls.length = 0;

      await vfsHandler!({ kind: 'write', path: '/other.html' });
      await flushAsync();

      expect(broadcastCalls).toHaveLength(0);
    });

    it('write when no canvas is open anywhere → no broadcast', async () => {
      broadcastCalls.length = 0;

      await vfsHandler!({ kind: 'write', path: '/anywhere.html' });
      await flushAsync();

      expect(broadcastCalls).toHaveLength(0);
    });

    it('delete event on a watched path → no broadcast (v1 limitation: 文件删除不刷 canvas)', async () => {
      mockRead().mockResolvedValueOnce('initial');
      await openCanvas('s1', '/watched.html');
      broadcastCalls.length = 0;

      await vfsHandler!({ kind: 'delete', path: '/watched.html' });
      await flushAsync();

      expect(broadcastCalls).toHaveLength(0);
    });

    it('rename event on a watched path → no broadcast (v1 limitation: 文件 rename 不刷 canvas)', async () => {
      mockRead().mockResolvedValueOnce('initial');
      await openCanvas('s1', '/old.html');
      broadcastCalls.length = 0;

      await vfsHandler!({ kind: 'rename', path: '/new.html', oldPath: '/old.html' });
      await flushAsync();

      expect(broadcastCalls).toHaveLength(0);
    });

    it('two sessions watching the same path → two canvas_file_changed broadcasts, distinct sessionIds', async () => {
      mockRead().mockResolvedValueOnce('a');
      await openCanvas('s1', '/shared.html');
      mockRead().mockResolvedValueOnce('b');
      await openCanvas('s2', '/shared.html');
      mockRead().mockReset().mockResolvedValue('updated');
      broadcastCalls.length = 0;

      await vfsHandler!({ kind: 'write', path: '/shared.html' });
      await flushAsync();

      // 两条 broadcast，sessionId 各自不同，path / content 一致。
      expect(broadcastCalls).toHaveLength(2);
      const sessionIds = broadcastCalls
        .map((c) => (c.msg as { sessionId: string }).sessionId)
        .sort();
      expect(sessionIds).toEqual(['s1', 's2']);
      for (const call of broadcastCalls) {
        expect(call.msg).toMatchObject({
          type: 'canvas_file_changed',
          path: '/shared.html',
          content: 'updated',
        });
      }
    });

    it('concurrent close between read and broadcast → skipped broadcast for that session only', async () => {
      mockRead().mockResolvedValueOnce('initial');
      await openCanvas('s1', '/foo.html');
      mockRead().mockResolvedValueOnce('initial2');
      await openCanvas('s2', '/foo.html');
      broadcastCalls.length = 0;

      // s1 closes after the readFile resolves but before broadcasts flush;
      // handler 的乐观 set 检查会跳过 s1 的 broadcast，但 s2 仍命中。
      mockRead().mockReset().mockImplementation(async () => {
        closeCanvas('s1');
        return 'updated';
      });

      await vfsHandler!({ kind: 'write', path: '/foo.html' });
      await flushAsync();

      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0].msg).toMatchObject({
        type: 'canvas_file_changed',
        sessionId: 's2',
        path: '/foo.html',
        content: 'updated',
      });
    });

    it('VFS re-read failure mid-flight → silently skipped (canvas keeps stale content)', async () => {
      mockRead().mockResolvedValueOnce('initial');
      await openCanvas('s1', '/foo.html');
      broadcastCalls.length = 0;
      mockRead().mockReset().mockRejectedValue(new Error('EIO'));

      await vfsHandler!({ kind: 'write', path: '/foo.html' });
      await flushAsync();

      // 失败不应广播；下一次 write 触发时还会再尝试。
      expect(broadcastCalls).toHaveLength(0);
    });
  });
});
