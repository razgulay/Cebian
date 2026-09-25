// Registry guard——session tool array 绝不允许出现重名 tool。Vertex AI 会以
// 400 `Duplicate function declaration found: <name>` 直接拒绝重复声明（v1.7.1
// 就是因为 `schedulerTools` 在 `sharedTools` 里 spread 一次、又在
// `buildSessionToolArray` 末尾 push 一次而炸掉 vertex/gemini 路由）。本测试
// 枚举真实的 `createSessionTools` 产物，任何重名都让 CI 失败，而不是等
// 某家 provider 在线上报 400。
//
// 依 AGENTS.md Testing：不 mock chrome.storage——fakeBrowser 内存实现，
// `fakeBrowser.reset()` 保证每例干净起点；MCP 未配置 → discoverMCPTools
// 返回空数组，无网络请求。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// fake-browser 不实现 chrome.i18n.getMessage——buildSessionToolArray 走
// search engines 默认配置时会调 t()；与 run-skill.test.ts 同一 stub 方案。
vi.mock('@/lib/i18n', () => ({
  t: (key: string, subs?: unknown[]) =>
    subs && subs.length ? `${key}|${subs.join(',')}` : key,
}));

// 与 lib/tools/names.ts 中的常量保持一致；这里直接写字符串以同时验证
// names.ts 常量值本身（若有人改常量值，此测试会一起失败提醒同步）。
const SCHEDULER_TOOL_NAMES = [
  'scheduler_list',
  'scheduler_create',
  'scheduler_delete',
  'scheduler_run_now',
];

describe('buildSessionToolArray registry guard', () => {
  let createSessionTools: typeof import('./index').createSessionTools;

  beforeEach(async () => {
    fakeBrowser.reset();
    const mod = await import('./index');
    createSessionTools = mod.createSessionTools;
  });

  it('session tool array 里 tool name 全局唯一（任意重名即 fail）', async () => {
    const { tools } = await createSessionTools('guard-test-session');
    const names = tools.map((t) => t.name);
    const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    expect(dupes, `发现重名 tool: ${dupes.join(', ')}`).toEqual([]);
  });

  it('scheduler 4 件套恰好各注册一次（v1.7.1 重复注册回归锚点）', async () => {
    const { tools } = await createSessionTools('guard-test-session');
    const names = tools.map((t) => t.name);
    for (const n of SCHEDULER_TOOL_NAMES) {
      const count = names.filter((x) => x === n).length;
      expect(count, `${n} 出现了 ${count} 次，期望恰好 1 次`).toBe(1);
    }
  });
});
