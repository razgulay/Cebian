// Session-scoped path-safety helper — pure-function 测试覆盖每个 attack vector。
// `assertInputFilesReadable` 因有 IO（vfs.access）单独走 `vi.mock` 段，pure 段不 mock。
import { describe, it, expect, vi } from 'vitest';
import { CEBIAN_SKILLS_DIR, WORKSPACES_ROOT } from '@/lib/persistence/vfs-paths';
import { normalizePath } from '@/lib/persistence/vfs';
import { VfsScopeError } from '@/lib/tools/vfs-whitelist';
import {
  assertInputFilesReadable,
  assertWithinSessionRoot,
  assertWithinSkillsRoot,
  isWithinSessionRoot,
  isWithinSkillsRoot,
  resolveSessionPath,
  sessionRoot,
  skillRoot,
} from '@/lib/agent/path-safety';

const SID = '01234567-89ab-cdef-0123-456789abcdef';
const ROOT = `${WORKSPACES_ROOT}/${SID}`;
const SKILL_NAME = 'races-template';
const SKILL_ROOT = normalizePath(`${CEBIAN_SKILLS_DIR}/${SKILL_NAME}`);

describe('sessionRoot', () => {
  it('合法 UUID → /workspaces/<id>', () => {
    expect(sessionRoot(SID)).toBe(ROOT);
  });

  it('非法 sessionId → 抛 VfsScopeError', () => {
    expect(() => sessionRoot('not-a-uuid')).toThrow(VfsScopeError);
    expect(() => sessionRoot('')).toThrow(VfsScopeError);
    expect(() => sessionRoot(undefined as unknown as string)).toThrow(VfsScopeError);
    expect(() => sessionRoot('../etc/passwd' as unknown as string)).toThrow(VfsScopeError);
  });
});

describe('resolveSessionPath', () => {
  it('相对路径 → 落在 session 根下', () => {
    expect(resolveSessionPath(SID, 'foo/bar.txt')).toBe(`${ROOT}/foo/bar.txt`);
  });

  it('leading slash 的相对路径被正确归一（不会双 //）', () => {
    expect(resolveSessionPath(SID, '/foo')).toBe(`${ROOT}/foo`);
  });

  it('~ 起手 → 不被解析为 cebian home；按字面归一', () => {
    // normalizePath 把 ~ 解到 /home/user/，但 caller 拿到的是 session 根 + 拼回去的字符串。
    // 即「写 `~/foo`」最终落进 session 根下的 `home/user/foo`——这是 normalizePath 的
    // 既定行为；session 作用域由 isWithinSessionRoot 在调用方那一侧把关。
    const out = resolveSessionPath(SID, '~/foo');
    expect(out.startsWith(ROOT)).toBe(true);
  });

  it('非法 sessionId → 抛 VfsScopeError（在拼路径之前）', () => {
    expect(() => resolveSessionPath('bad', 'foo')).toThrow(VfsScopeError);
  });

  it('空字符串 → 归一到 root（退化情形）', () => {
    // `normalizePath('')` 返回 `/`，root + '/' 把它锚到 root；调用方传入空串
    // 在我们的 tool 层会用 `a.task` 非空检查先拦掉，但 path-safety 本身仍是
    // 容错的 —— 空串不会让 resolve 飞掉或拼出非法路径。
    expect(resolveSessionPath(SID, '')).toBe(ROOT);
  });

  it('非字符串 relativePath → 抛 VfsScopeError（与 isWithinSessionRoot 对称）', () => {
    // 与 isWithinSessionRoot 在 absolutePath 上做的 typeof 守卫对称——同一种「防御
    // 垃圾输入」语义，由 caller 调用前的误用避免被 normalizePath 当字符串拼接变成奇怪
    // 路径。sessionId gate 之后才到这一步，所以合法 SID + 非法路径本身应独立报错。
    expect(() => resolveSessionPath(SID, undefined as unknown as string)).toThrow(VfsScopeError);
    expect(() => resolveSessionPath(SID, null as unknown as string)).toThrow(VfsScopeError);
  });

  it('幂等：传入已是 session 根下的绝对路径 → 原样返回，不双 prefix', () => {
    // Subtask 7 bug fix：tool layer 已经在 execute() 里 resolve 成 absolute path，
    // 再调 resolveSessionPath 必须仍是同一个 shape，不能再 prepend 一次 root。
    // 修前会得到 /workspaces/<id>/workspaces/<id>/content.json。
    const alreadyAbsolute = `${ROOT}/content.json`;
    expect(resolveSessionPath(SID, alreadyAbsolute)).toBe(alreadyAbsolute);
    // 深层路径同样幂等
    const deep = `${ROOT}/a/b/c.md`;
    expect(resolveSessionPath(SID, deep)).toBe(deep);
    // 根本身幂等
    expect(resolveSessionPath(SID, ROOT)).toBe(ROOT);
  });

  it('根外的绝对路径 → 仍 prepend 走 root（不当 in-root idempotent 处理）', () => {
    // 落在本 session 根**之外**的 absolute path（如另一个 session 的工作区或
    // /home/user/.cebian/skills/foo）应该继续走「prepend root」分支，调用方的
    // assertWithinSessionRoot 后续再 gate；不能误判为「已在 root 下」返
    // 回原值让越界 path 漏网。
    const outOfRoot = '/home/user/.cebian/skills/foo';
    const resolved = resolveSessionPath(SID, outOfRoot);
    expect(resolved).not.toBe(outOfRoot);
    expect(resolved.startsWith(ROOT + '/')).toBe(true);
  });
});

describe('isWithinSessionRoot', () => {
  it('根自身 → true', () => {
    expect(isWithinSessionRoot(SID, ROOT)).toBe(true);
  });

  it('直接子节点 → true', () => {
    expect(isWithinSessionRoot(SID, `${ROOT}/foo.txt`)).toBe(true);
  });

  it('深层子目录 → true', () => {
    expect(isWithinSessionRoot(SID, `${ROOT}/a/b/c/d.md`)).toBe(true);
  });

  it('未归一化的根（含尾斜杠） → true（normalizePath 在比较前吃掉斜杠）', () => {
    expect(isWithinSessionRoot(SID, `${ROOT}/`)).toBe(true);
  });

  it('../ 逃逸 → 归一化后落在根外，false', () => {
    expect(isWithinSessionRoot(SID, `${ROOT}/../etc/passwd`)).toBe(false);
    expect(isWithinSessionRoot(SID, `${ROOT}/../../etc/passwd`)).toBe(false);
  });

  it('另一个 session 的工作区 → false', () => {
    const OTHER = `${WORKSPACES_ROOT}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    expect(isWithinSessionRoot(SID, `${OTHER}/foo`)).toBe(false);
  });

  it('受保护的非 session 根（CEBIAN_HOME 等） → false', () => {
    expect(isWithinSessionRoot(SID, '/home/user/.cebian/skills/foo')).toBe(false);
    expect(isWithinSessionRoot(SID, '/home/user/.cebian/prompts/foo')).toBe(false);
  });

  it('相邻同名前缀目录（footgun） → false', () => {
    // /workspaces-<id> 容易被裸 startsWith 误判为 /workspaces 子孙；本模块用 root + '/' 守卫。
    expect(isWithinSessionRoot(SID, `${WORKSPACES_ROOT}-bak/foo`)).toBe(false);
    expect(isWithinSessionRoot(SID, `${WORKSPACES_ROOT}2/foo`)).toBe(false);
  });

  it('空 / 非字符串 → false', () => {
    expect(isWithinSessionRoot(SID, '')).toBe(false);
    expect(isWithinSessionRoot(SID, undefined as unknown as string)).toBe(false);
    expect(isWithinSessionRoot(SID, null as unknown as string)).toBe(false);
  });

  it('非法 sessionId → 抛 VfsScopeError（gate 早于任何 path 检查）', () => {
    expect(() => isWithinSessionRoot('bad', `${ROOT}/foo`)).toThrow(VfsScopeError);
  });
});

describe('assertWithinSessionRoot', () => {
  it('合法路径 → 静默 resolve', () => {
    expect(() => assertWithinSessionRoot(SID, `${ROOT}/foo`)).not.toThrow();
    expect(() => assertWithinSessionRoot(SID, ROOT)).not.toThrow();
  });

  it('越界 → 抛 VfsScopeError，且 message 不回显外部路径', () => {
    let caught: unknown;
    try {
      assertWithinSessionRoot(SID, '/home/user/.cebian/skills/foo');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VfsScopeError);
    expect((caught as Error).message).not.toContain('/home/user/.cebian');
    expect((caught as Error).message).not.toContain('/skills/foo');
  });

  it('../ 逃逸 → 抛 VfsScopeError', () => {
    expect(() => assertWithinSessionRoot(SID, `${ROOT}/../etc/passwd`)).toThrow(VfsScopeError);
  });

  it('非法 sessionId → 抛 VfsScopeError', () => {
    expect(() => assertWithinSessionRoot('bad', `${ROOT}/foo`)).toThrow(VfsScopeError);
  });
});

describe('assertInputFilesReadable', () => {
  // 这一段是唯一带 IO 的 helper —— vfs.access 经 `vi.mock` 替换；mock 之外的所有
  // 谓词逻辑仍走真模块，保证「越界时根本不去 stat」的 gate 顺序真的被守住。
  it('空数组 → 立即 resolve，不调 IO', async () => {
    const { vfs } = await import('@/lib/persistence/vfs');
    const accessSpy = vi.spyOn(vfs, 'access');
    await expect(assertInputFilesReadable(SID, [])).resolves.toBeUndefined();
    expect(accessSpy).not.toHaveBeenCalled();
    accessSpy.mockRestore();
  });

  it('路径合法 + 存在 → resolve', async () => {
    const { vfs } = await import('@/lib/persistence/vfs');
    const accessSpy = vi.spyOn(vfs, 'access').mockResolvedValue(undefined);
    await expect(
      assertInputFilesReadable(SID, [`${ROOT}/a.txt`, `${ROOT}/b/c.md`]),
    ).resolves.toBeUndefined();
    expect(accessSpy).toHaveBeenCalledTimes(2);
    accessSpy.mockRestore();
  });

  it('路径合法但文件不存在 → reject with File not found', async () => {
    const { vfs } = await import('@/lib/persistence/vfs');
    const accessSpy = vi.spyOn(vfs, 'access').mockRejectedValue(new Error('ENOENT'));
    await expect(assertInputFilesReadable(SID, [`${ROOT}/missing.txt`])).rejects.toThrow(
      'File not found',
    );
    accessSpy.mockRestore();
  });

  it('越界路径 → 先抛 VfsScopeError，根本不调 IO（不泄漏「外部 stat 失败」掩盖越权）', async () => {
    const { vfs } = await import('@/lib/persistence/vfs');
    const accessSpy = vi.spyOn(vfs, 'access');
    await expect(
      assertInputFilesReadable(SID, [`${ROOT}/ok.txt`, '/home/user/.cebian/skills/x']),
    ).rejects.toBeInstanceOf(VfsScopeError);
    expect(accessSpy).not.toHaveBeenCalled();
    accessSpy.mockRestore();
  });

  it('非法 sessionId → 抛 VfsScopeError', async () => {
    await expect(assertInputFilesReadable('bad', [`${ROOT}/x`])).rejects.toBeInstanceOf(
      VfsScopeError,
    );
  });
});

// ─── Skills scope（Subtask 5.1）────────────────────────────────────────────
//
// 平行 API：与 session-root 完全对称的形状，只是根换成 `~/.cebian/skills/<name>`。
// `isValidSkillName`（vfs-whitelist.ts:60）已是 project 唯一事实源，本模块不重写。

describe('skillRoot', () => {
  it('合法名字 → /home/user/.cebian/skills/<name>', () => {
    expect(skillRoot(SKILL_NAME)).toBe(SKILL_ROOT);
  });

  it('非法名字 → 抛 VfsScopeError', () => {
    // 形态谱完全 mirror isValidSkillName：空串 / `.` / `..` / 含 `/` / 含 `\` /
    // 含控制字符 / prototype-pollution 关键字。任何一项放行都会让 normalizePath
    // 拼出意料外的路径。
    const bad: readonly string[] = [
      '',
      '.',
      '..',
      '../escape',
      'a/b',
      'a\\b',
      'a b',
      '__proto__',
      'constructor',
      'prototype',
    ];
    for (const name of bad) {
      expect(() => skillRoot(name), `skillRoot(${JSON.stringify(name)}) should throw`).toThrow(
        VfsScopeError,
      );
    }
  });
});

describe('isWithinSkillsRoot', () => {
  it('根自身 → true', () => {
    expect(isWithinSkillsRoot(SKILL_NAME, SKILL_ROOT)).toBe(true);
  });

  it('直接子节点（SKILL.md 等） → true', () => {
    expect(isWithinSkillsRoot(SKILL_NAME, `${SKILL_ROOT}/SKILL.md`)).toBe(true);
  });

  it('深层子目录（assets/img/foo.png） → true', () => {
    expect(isWithinSkillsRoot(SKILL_NAME, `${SKILL_ROOT}/assets/img/foo.png`)).toBe(true);
  });

  it('../ 逃逸 → 归一化后落在根外，false', () => {
    expect(isWithinSkillsRoot(SKILL_NAME, `${SKILL_ROOT}/../other-skill/SKILL.md`)).toBe(false);
    expect(isWithinSkillsRoot(SKILL_NAME, `${SKILL_ROOT}/../../etc/passwd`)).toBe(false);
  });

  it('另一个 skill → false', () => {
    // 同样的 prefix-collision 防呆：skills-vs-foo 不该被当作 skills 子孙。
    expect(isWithinSkillsRoot(SKILL_NAME, `${SKILL_ROOT}-vs-foo/SKILL.md`)).toBe(false);
    // 另一个合法 skill 名字 → 各自根互不相干。
    const OTHER_SKILL = normalizePath(`${CEBIAN_SKILLS_DIR}/other-template`);
    expect(isWithinSkillsRoot(SKILL_NAME, `${OTHER_SKILL}/SKILL.md`)).toBe(false);
  });

  it('受保护的非 skills 根（session workspace 等） → false', () => {
    expect(isWithinSkillsRoot(SKILL_NAME, ROOT)).toBe(false);
    expect(isWithinSkillsRoot(SKILL_NAME, `${ROOT}/foo.txt`)).toBe(false);
    expect(isWithinSkillsRoot(SKILL_NAME, '/home/user/.cebian/prompts/x')).toBe(false);
  });

  it('相邻同名前缀目录（footgun） → false', () => {
    // 裸 startsWith(CEBIAN_SKILLS_DIR) 会把 skills-vs-foo 误判为子孙；
    // 本模块用 root + '/' 守卫——与 isWithinSessionRoot 同姿态。
    expect(isWithinSkillsRoot(SKILL_NAME, '/home/user/.cebian/skills-vs-foo/SKILL.md')).toBe(
      false,
    );
    expect(isWithinSkillsRoot(SKILL_NAME, '/home/user/.cebian/skills2/SKILL.md')).toBe(false);
  });

  it('空 / 非字符串 → false', () => {
    expect(isWithinSkillsRoot(SKILL_NAME, '')).toBe(false);
    expect(isWithinSkillsRoot(SKILL_NAME, undefined as unknown as string)).toBe(false);
    expect(isWithinSkillsRoot(SKILL_NAME, null as unknown as string)).toBe(false);
  });

  it('非法 skill name → 抛 VfsScopeError（gate 早于任何 path 检查）', () => {
    expect(() => isWithinSkillsRoot('..', `${SKILL_ROOT}/SKILL.md`)).toThrow(VfsScopeError);
    expect(() => isWithinSkillsRoot('a/b', `${SKILL_ROOT}/SKILL.md`)).toThrow(VfsScopeError);
  });
});

describe('assertWithinSkillsRoot', () => {
  it('合法路径 → 静默 resolve', () => {
    expect(() => assertWithinSkillsRoot(SKILL_NAME, `${SKILL_ROOT}/SKILL.md`)).not.toThrow();
    expect(() => assertWithinSkillsRoot(SKILL_NAME, SKILL_ROOT)).not.toThrow();
  });

  it('越界 → 抛 VfsScopeError，且 message 不回显 skill name 或绝对路径', () => {
    let caught: unknown;
    const evilPath = '/home/user/.cebian/skills-vs-foo/SKILL.md';
    try {
      assertWithinSkillsRoot(SKILL_NAME, evilPath);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VfsScopeError);
    // 隐私姿态：error message 不可回显外部路径 / skill name（避免跨 skill
    // 名字线索被主代理 / 日志看到）。skill name 也不该回显：LLM 可能用
    // 不算秘密但越界的 name 试探。
    const msg = (caught as Error).message;
    expect(msg).not.toContain(evilPath);
    expect(msg).not.toContain(SKILL_NAME);
  });

  it('../ 逃逸 → 抛 VfsScopeError', () => {
    expect(() =>
      assertWithinSkillsRoot(SKILL_NAME, `${SKILL_ROOT}/../other/SKILL.md`),
    ).toThrow(VfsScopeError);
  });

  it('非法 skill name → 抛 VfsScopeError', () => {
    expect(() => assertWithinSkillsRoot('..', `${SKILL_ROOT}/x`)).toThrow(VfsScopeError);
  });
});
