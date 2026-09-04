// Worker role registry 测试 —— 把「4 个 role 都齐 / 没漏字段 / 没把禁词放进
// whitelist」三件事钉在 CI。任何一处漂移都会让覆盖性测试失败。

import { describe, it, expect } from 'vitest';
import { TOOL_DELEGATE_DOM, TOOL_DELEGATE_TASK } from '@/lib/tools/names';
import {
  WORKER_ROLES,
  WORKER_ROLE_KEYS,
  buildAvailableWorkersBlock,
  getRoleConfig,
  getWorkerToolNames,
  type WorkerRoleConfig,
} from '@/lib/agent/worker-roles';
import type { WorkerRole } from '@/lib/persistence/storage';

const EXPECTED_ROLES: readonly WorkerRole[] = [
  'content_writer',
  'frontend_coder',
  'reviewer',
  'researcher',
];

const REQUIRED_FIELDS: readonly (keyof WorkerRoleConfig)[] = [
  'systemPrompt',
  'toolWhitelist',
  'displayName',
  'i18nKey',
];

describe('WORKER_ROLES 完整性', () => {
  it('key 集合 === 4 个固定 role，无多无少', () => {
    // 排序后做 set 相等比较，避免 Object.keys 顺序在不同引擎下抖动。
    expect([...WORKER_ROLE_KEYS].sort()).toEqual([...EXPECTED_ROLES].sort());
    expect(Object.keys(WORKER_ROLES).sort()).toEqual([...EXPECTED_ROLES].sort());
  });

  it('每个 role 都填齐 4 个必需字段', () => {
    for (const role of EXPECTED_ROLES) {
      const cfg = WORKER_ROLES[role];
      expect(cfg, `role ${role} missing`).toBeDefined();
      for (const field of REQUIRED_FIELDS) {
        const value = cfg[field];
        expect(value, `role ${role}.${field} missing`).toBeDefined();
        if (field === 'toolWhitelist') {
          expect(Array.isArray(value), `role ${role}.toolWhitelist must be array`).toBe(true);
          expect((value as readonly unknown[]).length, `role ${role}.toolWhitelist empty`).toBeGreaterThan(0);
        } else {
          expect(typeof value, `role ${role}.${field} must be string`).toBe('string');
          expect((value as string).length, `role ${role}.${field} empty`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('systemPrompt ≤ 500 字符（worker 上下文预算）', () => {
    // 4-char/byte 估算：英文 + JSON 模板大约 1 token / 4 char。500 char ≈ 125
    // tokens，与 worker 单任务上下文留出的 system prompt 预算相符。
    for (const role of EXPECTED_ROLES) {
      const len = WORKER_ROLES[role].systemPrompt.length;
      expect(len, `role ${role} systemPrompt too long: ${len}`).toBeLessThanOrEqual(500);
    }
  });

  it('i18nKey 形如 chat.workerTeamRoster.role.<roleKey>', () => {
    for (const role of EXPECTED_ROLES) {
      const key = WORKER_ROLES[role].i18nKey;
      expect(key).toBe(`chat.workerTeamRoster.role.${role}`);
    }
  });
});

describe('递归 / loop 守卫', () => {
  it('toolWhitelist 不含 TOOL_DELEGATE_TASK（worker 不能起 worker）', () => {
    for (const role of EXPECTED_ROLES) {
      expect(
        WORKER_ROLES[role].toolWhitelist,
        `role ${role} unexpectedly includes ${TOOL_DELEGATE_TASK}`,
      ).not.toContain(TOOL_DELEGATE_TASK);
    }
  });

  it('toolWhitelist 不含 TOOL_DELEGATE_DOM（worker 不能起 DOM sub-agent 形成 loop）', () => {
    for (const role of EXPECTED_ROLES) {
      expect(
        WORKER_ROLES[role].toolWhitelist,
        `role ${role} unexpectedly includes ${TOOL_DELEGATE_DOM}`,
      ).not.toContain(TOOL_DELEGATE_DOM);
    }
  });

  // 兜底：禁词常量本身的值要仍是这两个字符串字面量，防止 names.ts 哪天被
  // 改坏（重命名）让守卫悄悄失效。这是「白名单测试」之上的「禁词测试」——
  // 即使 whitelist 变了，下面这条仍能保证禁词两个字面量还在。
  it('禁词字面量仍是 delegate_task / delegate_dom', () => {
    expect(TOOL_DELEGATE_TASK).toBe('delegate_task');
    expect(TOOL_DELEGATE_DOM).toBe('delegate_dom');
  });
});

describe('getRoleConfig', () => {
  it('合法 role → 返回该 role 的 config', () => {
    const cfg = getRoleConfig('content_writer');
    expect(cfg.displayName).toBe('Content Writer');
    expect(cfg.toolWhitelist).toContain('fs_read_file');
  });

  it('非法 role（编译期会被卡住）→ 运行时抛错', () => {
    // 绕过类型用 unknown 强转模拟「外部传来可疑字符串」的场景。
    expect(() => getRoleConfig('not-a-role' as unknown as WorkerRole)).toThrow(
      'Unknown worker role',
    );
    expect(() => getRoleConfig('' as unknown as WorkerRole)).toThrow('Unknown worker role');
  });
});

describe('getWorkerToolNames', () => {
  it('等价于 getRoleConfig(role).toolWhitelist', () => {
    for (const role of EXPECTED_ROLES) {
      expect(getWorkerToolNames(role)).toBe(getRoleConfig(role).toolWhitelist);
    }
  });

  it('frontend_coder 白名单不含 browser-side 工具', () => {
    // 单元测试钉死「白名单 deny-by-default」的设计意图：扩 role 时若不小心
    // 把 execute_js 加进 frontend_coder 的白名单，下面这条会失败。
    const tools = getWorkerToolNames('frontend_coder');
    expect(tools).not.toContain('execute_js');
    expect(tools).not.toContain('inspect');
    expect(tools).not.toContain('tab');
    expect(tools).not.toContain('screenshot');
  });

  it('reviewer 白名单不含任何写工具', () => {
    const tools = getWorkerToolNames('reviewer');
    expect(tools).not.toContain('fs_create_file');
    expect(tools).not.toContain('fs_edit_file');
    expect(tools).not.toContain('fs_delete');
    expect(tools).not.toContain('fs_mkdir');
    expect(tools).not.toContain('fs_rename');
  });
});

describe('buildAvailableWorkersBlock', () => {
  // 主代理 system prompt 用的 L1 索引——钉死结构 + 内容协议，让 4 个
  // role 的 description / example 不会在某次改动里漂成"什么都有但什么都没说"。

  it('顶层是 <available-workers> 包裹，且 preamble 在前', () => {
    const block = buildAvailableWorkersBlock();
    expect(block.startsWith('<available-workers>')).toBe(true);
    expect(block.endsWith('</available-workers>')).toBe(true);
    // Preamble 的 polarity 必须是 prescriptive（"DEFAULT to delegate_task" +
    // "Do it YOURSELF only when ..."），不是描述性（"delegate when ..."）。
    // 描述性写法实测让模型把 "Build a Web Studio" 误判为 "few tool calls 自己能做"，
    // 走了 20+ 次 fs_read 然后 cancel。Default-flip + 具体数字（"30+ tool
    // calls vs ~50 tokens handoff"）才让模型理解：native tool 一旦开始走，
    // 每个 tool result 都进主代理 context。
    expect(block).toContain('DEFAULT to `delegate_task`');
    expect(block).toContain('Do it YOURSELF');
    // Prescriptive 还要把例外列得明确（每条 bullet `• ...`），让模型能
    // 反例匹配；下次有人扩/减例外时这条测试会失败。文本字面量故意写死——
    // 这是写进主代理 system prompt 的契约，不能漂移。
    const yourselfSection = block.split('Do it YOURSELF')[1] ?? '';
    const bullets = yourselfSection.match(/^\s*• /gm) ?? [];
    expect(
      bullets.length,
      `expected 3 carve-out bullets, got ${bullets.length}:\n${bullets.join('\n')}`,
    ).toBe(3);
  });

  it('4 个 role 都在，且顺序与 WORKER_ROLE_KEYS 一致', () => {
    const block = buildAvailableWorkersBlock();
    for (const role of EXPECTED_ROLES) {
      expect(block).toContain(`<role>${role}</role>`);
    }
    // 顺序保护：先 content_writer → frontend_coder → reviewer → researcher
    // （与 WORKER_ROLES 字面量顺序一致），主代理按"读在前"挑得自然。
    const orderExpected = ['content_writer', 'frontend_coder', 'reviewer', 'researcher'];
    const lastIndex: Record<string, number> = {};
    orderExpected.forEach((r) => {
      lastIndex[r] = block.lastIndexOf(`<role>${r}</role>`);
    });
    for (let i = 1; i < orderExpected.length; i++) {
      expect(lastIndex[orderExpected[i]]).toBeGreaterThan(lastIndex[orderExpected[i - 1]]);
    }
  });

  it('每个 role 的 example 都是合法可读的 delegate_task 调用骨架', () => {
    // 防「example 写成 narrative 而不是可复制调用」漂移：必须含 role 标识符
    // + `delegate_task(` + 至少 1 个 `output_path` 或 `input_files`。用 regex
    // 抽出每个 <worker> 块再单独断言，比 single-pass 多行 regex 更易调试。
    const block = buildAvailableWorkersBlock();
    for (const role of EXPECTED_ROLES) {
      const m = block.match(
        new RegExp(`<worker>\\s*<role>${role}<\\/role>[\\s\\S]*?<\\/worker>`),
      );
      expect(m, `<worker> block for ${role} missing`).toBeTruthy();
      const worker = m![0];
      expect(worker).toContain(`role: '${role}'`);
      expect(worker).toMatch(/delegate_task\(\{/);
      // 每个 example 至少含 output_path 或 input_files 之一（让 main agent
      // 看见 worker 实际怎么传文件）；缺一即「example 只演示了 task 文本」。
      expect(
        worker.includes('output_path:') || worker.includes('input_files:'),
        `${role} example missing file-routing parameter`,
      ).toBe(true);
    }
  });

  it('description 每个 ≤ 200 字符（一句话最佳场景，不变成段）', () => {
    // 4-char/byte 估算：200 char ≈ 50 tokens，4 条合计 ≈ 200 tokens——可接受
    // 的 L1 索引预算。超过即"塞太多内容进 L1 块"，应拆到 SKILL.md。
    const block = buildAvailableWorkersBlock();
    const descs = [...block.matchAll(/<description>([\s\S]*?)<\/description>/g)].map(
      (m) => m[1],
    );
    expect(descs.length).toBe(EXPECTED_ROLES.length);
    for (const desc of descs) {
      expect(desc.length, `description too long: "${desc}"`).toBeLessThanOrEqual(200);
    }
  });

  it('不泄漏 implementation details（registry 内部字段 / 模型名）', () => {
    // L1 块的设计意图：让主代理知道 role 是谁、做什么、怎么调——**不**告诉它
    // role 的 registry 内部字段名（toolWhitelist / displayName / i18nKey），
    // 也**不**嵌具体模型 ID（模型由用户在 Settings 配置，缓存不友好）。
    // 注意：tool 名字面量（`fs_*` / `execute_js` / `inspect` 等）在 role 的
    // description 里**可以**出现，因为它们是「这个 role 能做什么」的自然语言
    // 描述的一部分，不属于 implementation detail。
    const block = buildAvailableWorkersBlock();
    expect(block).not.toContain('toolWhitelist');
    expect(block).not.toContain('displayName');
    expect(block).not.toContain('i18nKey');
    expect(block).not.toContain('gemini');
    expect(block).not.toContain('claude-opus');
    expect(block).not.toContain('claude-haiku');
    expect(block).not.toContain('Minimax');
  });
});
