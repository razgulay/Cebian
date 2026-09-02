import { describe, it, expect, vi } from 'vitest';
import {
  sessionSkillRoot,
  sessionWorkspaceRoot,
  resolveScopedPath,
  resolveReadScopedPath,
  isVfsCallAllowed,
  VFS_READ_METHODS,
  VFS_WRITE_METHODS,
  dispatchReadWithFallback,
  type VfsReader,
  type VfsScope,
} from '@/lib/tools/vfs-whitelist';

const SESSION_ID = 'c67cc299-1111-2222-3333-444455556666';
const OTHER_SESSION_ID = '00000000-aaaa-bbbb-cccc-dddddddddddd';

describe('sessionSkillRoot', () => {
  it('builds /workspaces/<sessionId>/<skill> with no trailing slash', () => {
    expect(sessionSkillRoot(SESSION_ID, 'vercel-deploy')).toBe(
      `/workspaces/${SESSION_ID}/vercel-deploy`,
    );
  });

  it('rejects malformed sessionId (path-traversal defense)', () => {
    expect(() => sessionSkillRoot('../etc', 'skill')).toThrow(/Invalid sessionId/);
    expect(() => sessionSkillRoot('', 'skill')).toThrow(/Invalid sessionId/);
    expect(() => sessionSkillRoot(undefined as unknown as string, 'skill')).toThrow(/Invalid sessionId/);
  });

  it('rejects malformed skill name (path-traversal defense)', () => {
    expect(() => sessionSkillRoot(SESSION_ID, '..')).toThrow(/Invalid skill name/);
    expect(() => sessionSkillRoot(SESSION_ID, '../etc')).toThrow(/Invalid skill name/);
    expect(() => sessionSkillRoot(SESSION_ID, 'with/slash')).toThrow(/Invalid skill name/);
  });
});

describe('sessionWorkspaceRoot', () => {
  it('builds /workspaces/<sessionId> with no trailing slash', () => {
    expect(sessionWorkspaceRoot(SESSION_ID)).toBe(`/workspaces/${SESSION_ID}`);
  });

  it('rejects malformed sessionId (path-traversal defense)', () => {
    expect(() => sessionWorkspaceRoot('../etc')).toThrow(/Invalid sessionId/);
    expect(() => sessionWorkspaceRoot('')).toThrow(/Invalid sessionId/);
  });
});

describe('resolveScopedPath — single-root building block', () => {
  // resolveScopedPath 只负责单根解析 + 防越界，不管 read/write 双根 fallback；
  // 那部分逻辑在 sandbox-rpc.ts 的 dispatchReadWithFallback。本测试钉住
  // 单根的合法 / 非法输入形状，确保 fallback 层在它之上拼接的语义不偏移。

  describe('skill 子目录（writeRoot 角色）下的行为', () => {
    const writeRoot = sessionSkillRoot(SESSION_ID, 'vercel-deploy');

    it('合法相对路径：放行', () => {
      expect(resolveScopedPath('cat.png', writeRoot)).toBe(
        `/workspaces/${SESSION_ID}/vercel-deploy/cat.png`,
      );
    });

    it('".." 越出 writeRoot：拦截（fallback 层会把这条异常当作"未命中 writeRoot"）', () => {
      expect(() => resolveScopedPath('../agent-wrote.html', writeRoot)).toThrow(
        /escapes skill workspace/,
      );
    });

    it('绝对路径 / ~ 路径：拦截（fallback 不会重解）', () => {
      expect(() => resolveScopedPath('/etc/passwd', writeRoot)).toThrow(/must be relative/);
      expect(() => resolveScopedPath('~/x', writeRoot)).toThrow(/must be relative/);
    });

    it('"" / "."：归一到 root 本身（合法 —— 跟 lib 一致）', () => {
      expect(resolveScopedPath('', writeRoot)).toBe(writeRoot);
      expect(resolveScopedPath('.', writeRoot)).toBe(writeRoot);
    });
  });
});

describe('resolveReadScopedPath — 读方法 fallback 的语义', () => {
  // resolveReadScopedPath 是 dispatchReadWithFallback 在 writeRoot 未命中时
  // 调用的兜底解析器。`..` 路径用它处理：把 `..` 当作"从 writeRoot 吃掉
  // skill 子目录"，归一化后落在 readRoot（含）以内就算合法。`..` 直接
  // 调 resolveScopedPath(rel, readRoot) 不行 —— 那条会把 `..` 当作
  // "从 readRoot 往上走"，越出 readRoot。

  const writeRoot = sessionSkillRoot(SESSION_ID, 'vercel-deploy');
  const readRoot = sessionWorkspaceRoot(SESSION_ID);

  it('readFile 直接传文件名：归一化到 writeRoot/cat.png（与既有行为一致）', () => {
    expect(resolveReadScopedPath('cat.png', writeRoot, readRoot)).toBe(
      `/workspaces/${SESSION_ID}/vercel-deploy/cat.png`,
    );
  });

  it('readFile 用 .. 读父 session workspace 下的同级文件：放行', () => {
    expect(resolveReadScopedPath('../agent-wrote.html', writeRoot, readRoot)).toBe(
      `/workspaces/${SESSION_ID}/agent-wrote.html`,
    );
  });

  it('readFile 用 ../<other-skill> 读同 session 内另一个 skill 子目录：放行（用户设计：跨 skill 同 session 允许读）', () => {
    expect(
      resolveReadScopedPath('../other-skill/foo.txt', writeRoot, readRoot),
    ).toBe(`/workspaces/${SESSION_ID}/other-skill/foo.txt`);
  });

  it('readFile 用 ../../ 跨出本 session 进别的 session：拦截（跨 session 永远拦）', () => {
    expect(() =>
      resolveReadScopedPath(`../../${OTHER_SESSION_ID}/x.html`, writeRoot, readRoot),
    ).toThrow(/escapes skill workspace/);
  });

  it('readFile 试图穿越出 /workspaces/：拦截', () => {
    expect(() => resolveReadScopedPath('../../etc/passwd', writeRoot, readRoot)).toThrow(
      /escapes skill workspace/,
    );
  });

  it('readFile 读父根自身（"."）：归一到 writeRoot（与 vfs.readdir 文档一致）', () => {
    expect(resolveReadScopedPath('.', writeRoot, readRoot)).toBe(writeRoot);
  });

  it('绝对路径 / ~ 路径：拦截（fallback 不会重解）', () => {
    expect(() => resolveReadScopedPath('/etc/passwd', writeRoot, readRoot)).toThrow(
      /must be relative/,
    );
    expect(() => resolveReadScopedPath('~/x', writeRoot, readRoot)).toThrow(/must be relative/);
  });
});

describe('VfsScope — 双根嵌套关系不变量', () => {
  it('writeRoot 总是 readRoot 的子路径（fallback 顺序靠这条保证）', () => {
    const scope: VfsScope = {
      writeRoot: sessionSkillRoot(SESSION_ID, 'vercel-deploy'),
      readRoot: sessionWorkspaceRoot(SESSION_ID),
    };
    expect(scope.writeRoot.startsWith(scope.readRoot + '/')).toBe(true);
    expect(scope.readRoot.endsWith(SESSION_ID)).toBe(true);
  });
});

describe('isVfsCallAllowed — 与 read/write scope 选择的配合', () => {
  it('vfs.read 权限：仅读类方法允许；写方法拒', () => {
    expect(isVfsCallAllowed('readFile', ['vfs.read'])).toBe(true);
    expect(isVfsCallAllowed('readdir', ['vfs.read'])).toBe(true);
    expect(isVfsCallAllowed('stat', ['vfs.read'])).toBe(true);
    expect(isVfsCallAllowed('exists', ['vfs.read'])).toBe(true);
    expect(isVfsCallAllowed('writeFile', ['vfs.read'])).toBe(false);
    expect(isVfsCallAllowed('mkdir', ['vfs.read'])).toBe(false);
    expect(isVfsCallAllowed('unlink', ['vfs.read'])).toBe(false);
  });

  it('vfs.write 权限：自动包含读类方法（避免写完不能读自己产物的语义陷阱）', () => {
    for (const m of VFS_READ_METHODS) {
      expect(isVfsCallAllowed(m, ['vfs.write'])).toBe(true);
    }
    for (const m of VFS_WRITE_METHODS) {
      expect(isVfsCallAllowed(m, ['vfs.write'])).toBe(true);
    }
  });

  it('未声明 vfs.* 时所有方法拒', () => {
    expect(isVfsCallAllowed('readFile', [])).toBe(false);
    expect(isVfsCallAllowed('writeFile', [])).toBe(false);
  });

  it('原型污染 / 带点的方法名：拒', () => {
    expect(isVfsCallAllowed('__proto__', ['vfs.read'])).toBe(false);
    expect(isVfsCallAllowed('constructor', ['vfs.read'])).toBe(false);
    expect(isVfsCallAllowed('readFile.extra', ['vfs.read'])).toBe(false);
  });

  it('读 / 写方法集合保持 VFS_READ_METHODS / VFS_WRITE_METHODS 互不重叠（registry 守卫）', () => {
    for (const m of VFS_READ_METHODS) {
      expect(VFS_WRITE_METHODS.has(m)).toBe(false);
    }
    for (const m of VFS_WRITE_METHODS) {
      expect(VFS_READ_METHODS.has(m)).toBe(false);
    }
  });
});

/**
 * `dispatchReadWithFallback` 依赖一个 vfs 实现 —— 测试用 vi.fn() 拼一个
 * 最小化的 VfsReader mock，把 writeRoot 与 readRoot 看作两个独立的目录，
 * 各自返回不同的内容 / 错误。调用计数用于断言"先 writeRoot，再 readRoot"
 * 的顺序。
 */
function makeMockVfs(opts: {
  writeRootExists: boolean;
  readRootExists: boolean;
  readFileContent?: string;
  statShape?: { size: number; mtimeMs: number; isFile: boolean; isDirectory: boolean };
  readdirWrite?: string[];
  readdirRead?: string[];
  existsWrite?: boolean;
  existsRead?: boolean;
}): { vfs: VfsReader; calls: string[] } {
  const calls: string[] = [];
  const enoent = (path: string) => {
    const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
    err.code = 'ENOENT';
    return err;
  };
  const vfs: VfsReader = {
    async readFile(path, _opts) {
      calls.push(`readFile:${path}`);
      if (path.endsWith('/cat.png') && opts.writeRootExists) return opts.readFileContent ?? 'cat-bytes';
      if (path.endsWith('/cat.png') && opts.readRootExists) return opts.readFileContent ?? 'cat-bytes';
      throw enoent(path);
    },
    async readdir(path) {
      calls.push(`readdir:${path}`);
      if (path === `/workspaces/${SESSION_ID}/vercel-deploy`) return opts.readdirWrite ?? [];
      if (path === `/workspaces/${SESSION_ID}`) return opts.readdirRead ?? [];
      throw enoent(path);
    },
    async stat(path) {
      calls.push(`stat:${path}`);
      if (path === `/workspaces/${SESSION_ID}/vercel-deploy/cat.png`) {
        const s = opts.statShape ?? { size: 12, mtimeMs: 0, isFile: true, isDirectory: false };
        return {
          size: s.size,
          mtimeMs: s.mtimeMs,
          isFile: () => s.isFile,
          isDirectory: () => s.isDirectory,
        };
      }
      throw enoent(path);
    },
    async exists(path) {
      calls.push(`exists:${path}`);
      if (path.startsWith(`/workspaces/${SESSION_ID}/vercel-deploy`)) return opts.existsWrite ?? false;
      if (path.startsWith(`/workspaces/${SESSION_ID}`)) return opts.existsRead ?? false;
      return false;
    },
  };
  return { vfs, calls };
}

describe('dispatchReadWithFallback — writeRoot-first / readRoot-fallback 调度', () => {
  const writeRoot = sessionSkillRoot(SESSION_ID, 'vercel-deploy');
  const readRoot = sessionWorkspaceRoot(SESSION_ID);

  it('readFile 在 writeRoot 命中：只调 writeRoot 一次，不走 fallback', async () => {
    const { vfs: mock, calls } = makeMockVfs({
      writeRootExists: true,
      readRootExists: true,
      readFileContent: 'skill-self',
    });
    const result = await dispatchReadWithFallback('readFile', 'cat.png', writeRoot, readRoot, ['cat.png'], mock);
    expect(result).toBe('skill-self');
    expect(calls).toEqual([`readFile:${writeRoot}/cat.png`]);
  });

  it('readFile "../cat.png" —— writeRoot 抛 VfsScopeError（.. 越界），fallback 到 readRoot', async () => {
    const { vfs: mock, calls } = makeMockVfs({
      writeRootExists: false,
      readRootExists: true,
      readFileContent: 'sibling-content',
    });
    const result = await dispatchReadWithFallback(
      'readFile', '../cat.png', writeRoot, readRoot, ['../cat.png'], mock,
    );
    expect(result).toBe('sibling-content');
    // writeRoot 解析阶段抛 VfsScopeError → 走 readRoot；readRoot 路径归一化后
    // 落在 /workspaces/<id>/cat.png（合法）。writeRoot 那次还没调到底层 vfs
    // 就在解析阶段被 catch，所以 mock 调用次数只有 1（仅 readRoot）。
    expect(calls).toEqual([`readFile:/workspaces/${SESSION_ID}/cat.png`]);
  });

  it('readFile "../<other-session>/x" —— readRoot 兜底时仍拦截（跨 session 永远拦）', async () => {
    const { vfs: mock } = makeMockVfs({
      writeRootExists: false,
      readRootExists: true,
    });
    await expect(
      dispatchReadWithFallback(
        'readFile',
        `../../${OTHER_SESSION_ID}/x.html`,
        writeRoot,
        readRoot,
        [`../../${OTHER_SESSION_ID}/x.html`],
        mock,
      ),
    ).rejects.toThrow(/escapes skill workspace/);
  });

  it('readFile 把 callArgs[1]（encoding）原样转给 vfs.readFile', async () => {
    // 用 vi.fn 替换 mock.readFile，断言 callArgs[1]（即 'utf8'）被原样转发。
    const readFileMock = vi.fn(async () => 'ok');
    const mock: VfsReader = {
      ...makeMockVfs({ writeRootExists: true, readRootExists: true }).vfs,
      readFile: readFileMock,
    };
    await dispatchReadWithFallback(
      'readFile', 'cat.png', writeRoot, readRoot, ['cat.png', 'utf8'], mock,
    );
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(readFileMock).toHaveBeenCalledWith(
      `${writeRoot}/cat.png`,
      'utf8',
    );
  });

  it('stat 返回值被 flatten 成纯对象（结构化克隆跨 postMessage 不丢方法）', async () => {
    const { vfs: mock } = makeMockVfs({
      writeRootExists: true,
      readRootExists: true,
      statShape: { size: 42, mtimeMs: 1234, isFile: true, isDirectory: false },
    });
    const result = await dispatchReadWithFallback(
      'stat', 'cat.png', writeRoot, readRoot, ['cat.png'], mock,
    );
    expect(result).toEqual({
      size: 42,
      mtimeMs: 1234,
      isFile: true,
      isDirectory: false,
    });
  });

  it('writeRoot 与 readRoot 都未命中：readRoot 抛出的 ENOENT 透传给上层', async () => {
    const { vfs: mock } = makeMockVfs({
      writeRootExists: false,
      readRootExists: false,
    });
    await expect(
      dispatchReadWithFallback(
        'readFile', '../missing.html', writeRoot, readRoot, ['../missing.html'], mock,
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  it('writeRoot 抛非 ENOENT / 非 VfsScopeError 的错误（如 EACCES）：透传，不走 fallback', async () => {
    const eacces = new Error('EACCES: permission denied') as Error & { code: string };
    eacces.code = 'EACCES';
    const readFileMock = vi.fn(async () => { throw eacces; });
    const mock: VfsReader = {
      ...makeMockVfs({ writeRootExists: true, readRootExists: true }).vfs,
      readFile: readFileMock,
    };
    await expect(
      dispatchReadWithFallback(
        'readFile', 'cat.png', writeRoot, readRoot, ['cat.png'], mock,
      ),
    ).rejects.toThrow(/EACCES/);
    // 关键断言：fallback 没被触发（EACCES 不是"未命中"信号）。如果 isMiss
    // 把 EACCES 误判为 miss，就会再调一次 readFile，调用次数 = 2 —— 这条
    // 守住 isMiss 的边界。
    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it('未知 read 方法：抛 "Unknown vfs read method"', async () => {
    const { vfs: mock } = makeMockVfs({ writeRootExists: true, readRootExists: true });
    await expect(
      dispatchReadWithFallback(
        'readSomethingWeird', 'cat.png', writeRoot, readRoot, ['cat.png'], mock,
      ),
    ).rejects.toThrow(/Unknown vfs read method/);
  });
});