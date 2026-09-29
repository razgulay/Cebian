// runSkillGate 单测——重点：ChatInput toolbar 的 Skills chip（chatSkillAuto
// 缓存）短路掉 permission card，**不持久化 grant**。toggle off → 立即恢复询问。
//
// 与同目录 run-skill.test.ts 分开的原因：那份覆盖 skill 快照绑定（#80），必须
// 用**真实** vfs + fake-indexeddb 写 SKILL.md 再改文件；这份需要 vi.mock 掉
// `@/lib/persistence/vfs` 来构造固定权限。vi.mock 是文件级的，两者放进同一文件
// 会互相破坏（mock 会盖掉真实 vfs），故按关注点拆成两个文件。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

vi.mock('@/lib/persistence/vfs', () => ({
  vfs: {
    stat: vi.fn(async () => undefined),
    readFile: vi.fn(async () => '---\nmetadata:\n  permissions:\n    - chrome.cookies\n---\n'),
    exists: vi.fn(async () => true),
  },
  normalizePath: (p: string) => p,
}));

vi.mock('@/lib/content/frontmatter', () => ({
  parseFrontmatter: () => ({
    data: { metadata: { permissions: ['chrome.cookies'] } },
    body: '',
  }),
}));

vi.mock('@/lib/ai-config/skill-grants', () => ({
  getSkillGrants: vi.fn(async () => ({})),
  setSkillGrant: vi.fn(async () => {}),
  permissionsMatch: vi.fn(() => false),
}));

vi.mock('@/lib/ai-config/skill-validator', () => ({
  validateSkillName: () => ({ valid: true, error: undefined }),
}));

vi.mock('./sandbox-rpc', () => ({
  runInSandbox: vi.fn(),
}));

// fake-browser 不实现 chrome.i18n.getMessage——用 stub 避免 t 抛错。
vi.mock('@/lib/i18n', () => ({
  t: (key: string, subs?: unknown[]) =>
    subs && subs.length ? `${key}|${subs.join(',')}` : key,
}));

describe('runSkillGate — Skills chip (chatSkillAuto) toggle', () => {
  let runSkillGate: typeof import('./run-skill').runSkillGate;
  let _setChatSkillAutoCachedForTest: typeof import('./run-skill')._setChatSkillAutoCachedForTest;
  let chatSkillAuto: typeof import('@/lib/persistence/storage').chatSkillAuto;

  beforeEach(async () => {
    fakeBrowser.reset(); // AGENTS.md：清 storage 起点，避免与 watch 时序纠缠
    vi.resetModules();
    const mod = await import('./run-skill');
    runSkillGate = mod.runSkillGate;
    _setChatSkillAutoCachedForTest = mod._setChatSkillAutoCachedForTest;
    chatSkillAuto = (await import('@/lib/persistence/storage')).chatSkillAuto;
    // 测试以干净缓存启动（默认 false）。
    _setChatSkillAutoCachedForTest(false);
  });

  it('toggle ON → 立即放行（needsGrant:false），不读取 grant、不持久化', async () => {
    const grantsMod = await import('@/lib/ai-config/skill-grants');
    _setChatSkillAutoCachedForTest(true);
    const result = await runSkillGate.check({
      skill: 'web-summary',
      script: 'extract.js',
    }, 'call-'+Math.random().toString(36).slice(2));
    expect(result.needsGrant).toBe(false);
    // 关键：不读 grants（toggle ON 不查询永久授权，不读路径）、不持久化任何东西
    expect(grantsMod.getSkillGrants).not.toHaveBeenCalled();
    expect(grantsMod.setSkillGrant).not.toHaveBeenCalled();
  });

  it('toggle OFF (默认) + skill 有 permissions + 无 grant → 出 permissionRequest card', async () => {
    _setChatSkillAutoCachedForTest(false);
    const result = await runSkillGate.check({
      skill: 'web-summary',
      script: 'extract.js',
    }, 'call-'+Math.random().toString(36).slice(2));
    expect(result.needsGrant).toBe(true);
    expect(result.request).toEqual({
      title: expect.any(String),
      permissions: ['chrome.cookies'],
    });
  });

  it('toggle ON → OFF 往返 → 立即恢复询问（不留残余）', async () => {
    _setChatSkillAutoCachedForTest(true);
    const on = await runSkillGate.check({
      skill: 'web-summary',
      script: 'extract.js',
    }, 'call-'+Math.random().toString(36).slice(2));
    expect(on.needsGrant).toBe(false);

    _setChatSkillAutoCachedForTest(false);
    const off = await runSkillGate.check({
      skill: 'web-summary',
      script: 'extract.js',
    }, 'call-'+Math.random().toString(36).slice(2));
    expect(off.needsGrant).toBe(true);
    expect(off.request?.permissions).toEqual(['chrome.cookies']);
  });

  it('真实路径：写 storage → watch 同步缓存 → gate 放行（端到端覆盖实际 chip 流程）', async () => {
    // 模拟 ChatInput 的 SkillsChip 翻转：useStorageItem 写入 → watch 触发 →
    // 缓存更新 → 下次 gate.check 看到新值。这条覆盖了之前直接调 setter 时绕过的
    // watch 订阅 + 初始 getValue 同步。
    const onResult = await chatSkillAuto.getValue();
    expect(onResult).toBe(false);
    await chatSkillAuto.setValue(true);
    // watch 回调可能跨一个 microtask 边界——放一个 setTimeout(0) 让 watch 跑完。
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await runSkillGate.check({
      skill: 'web-summary',
      script: 'extract.js',
    }, 'call-'+Math.random().toString(36).slice(2));
    expect(result.needsGrant).toBe(false);
    const grantsMod = await import('@/lib/ai-config/skill-grants');
    expect(grantsMod.setSkillGrant).not.toHaveBeenCalled();
  });
});
