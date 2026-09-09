// Worker role registry 测试 —— 把「4 个 role 都齐 / 没漏字段 / 没把禁词放进
// whitelist」三件事钉在 CI。任何一处漂移都会让覆盖性测试失败。

import { describe, it, expect } from 'vitest';
import { TOOL_DELEGATE_DOM, TOOL_DELEGATE_TASK } from '@/lib/tools/names';
import {
  WORKER_ROLES,
  WORKER_ROLE_KEYS,
  WORKER_TTFT_MS,
  WORKER_IDLE_MS,
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

  it('systemPrompt ≤ 500 字符（worker 上下文预算，reviewer 例外）', () => {
    // 4-char/byte 估算：英文 + JSON 模板大约 1 token / 4 char。500 char ≈ 125
    // tokens，与 worker 单任务上下文留出的 system prompt 预算相符。
    //
    // Subtask 2.1 把 reviewer 的 prompt 从 4 条 grep rule 扩到 15 条
    // checklist（9 fail + 6 warn），加上「15-item + grep method + 90s
    // ceiling」三段说明后总长 ~1100 char —— 仍然 ≤ 1.5 KB，约 270 tokens，
    // 与 reviewer 单任务的 ~5 KB 上下文 budget 相比 < 6%。Subtask 2.2
    // code-review Finding #1 又加了「Handoff emit shape + 15 个 allowed
    // item id 列表」段落，prompt 长到 ~1700 char / 425 tokens（仍在 1.5 KB
    // cap 内）。把 id 列表喂给 LLM 是为了让它能可靠 emit `checklist` 字段
    // —— 不然 schema auto-inject 是空枪。reviewer prompt 必须可读，可读
    // 的成本就是把 15 pattern names + id 列表直接 inline 进 system prompt
    // （比走 skill hydration 节省 1 round-trip VFS read + 可靠）。
    // Subtask 9.0：cap 从 500 提到 600 —— frontend_coder rule (5) cứng hóa
    // chống re-read loop 后 prompt 实测 572 char (旧版 479 char, +93 char
    // 来自 "emit handoff and STOP — NEVER re-read or fs_list to verify; the
    // file is final" + 非 artifact 分支 keep rule 5)。剩 28 char 缓冲给
    // 后续 rule hardening (比 500 → 600 的 100 char buffer 紧, 但仍守住
    // 10% frontend_coder context budget 上限)。如未来 prompt 逼近 600
    // cap, 应 carve-out frontend_coder 单独 cap (mirror reviewer 2 KB 例外)
    // 而不是继续 bump global cap —— global cap 是给"通用 role"的预算约束,
    // per-role carve-out 是给"已确认需要更多 prompt space"的角色开特例。
    for (const role of EXPECTED_ROLES) {
      if (role === 'reviewer') continue; // 例外 —— 见 Subtask 2.1 docstring
      const len = WORKER_ROLES[role].systemPrompt.length;
      expect(len, `role ${role} systemPrompt too long: ${len}`).toBeLessThanOrEqual(600);
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

  it('reviewer 白名单不含 browser-side verify 工具（Subtask 8.7）', () => {
    // Subtask 8.7：实测 `inspect` / `execute_js` 在 reviewer SW-background
    // worker 上下文里 9/9 次 errored（无 sidepanel active tab，工具拿不到
    // `tabs.query({ active: true })`），claude 试了几次发现工具坏了就
    // fallback 多读文件，把 rule 1 "最多 3 次" cap 也连带突破。把两个工具
    // 从 reviewer whitelist 砍掉后，reviewer 唯一路径是「读 → 推理 → emit」，
    // 与角色本意相符。这条测试钉死这条不可逆决策——下次有人把
    // execute_js / inspect 加回 reviewer whitelist，下面的断言会失败。
    const tools = getWorkerToolNames('reviewer');
    expect(tools).not.toContain('execute_js');
    expect(tools).not.toContain('inspect');
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

// ─── Subtask 8.9: artifact-rule markers (frontend_coder + reviewer) ─────────
//
// Subtask 8.9 把 artifact skill (`skills/artifact/SKILL.md`) 的 hard rules 编进
// worker systemPrompt。下面这些测试把核心关键词钉在 CI——下次有人改 prompt 时
// 不小心丢掉任意一条，下面的 expect.toContain 会失败。比让 reviewer 复盘靠
// 谱。Negative tests（不存在的 substring）同样要钉：Tailwind coupling 和
// "<30s" hardcode 在 design review 时被明确剔除，必须 absent。
describe('Subtask 8.9 — artifact-rule markers in worker prompts', () => {
  describe('frontend_coder.systemPrompt', () => {
    const prompt = WORKER_ROLES.frontend_coder.systemPrompt;

    it('encodes artifact single-file + no storage APIs + show at rest + color tokens', () => {
      // Rule (1) inline CSS/JS, https:// libs only
      expect(prompt).toContain('inline CSS/JS');
      expect(prompt).toContain('https://');
      // Rule (2) NO localStorage / sessionStorage / document.cookie (sandbox SecurityError)
      expect(prompt).toContain('NO localStorage');
      expect(prompt).toContain('sessionStorage');
      expect(prompt).toContain('document.cookie');
      expect(prompt).toContain('SecurityError');
      // Rule (3) initial DOM shows all content statically
      expect(prompt).toContain('initial DOM');
      expect(prompt).toContain('scripts enhance, not construct');
      // Rule (4) semantic color tokens on :root for light + dark
      expect(prompt).toContain('color tokens on :root');
      expect(prompt).toContain('light + dark');
      // Rule (5) one fs_create_file then emit handoff and STOP — NEVER re-read
      expect(prompt).toContain('one fs_create_file then emit handoff and STOP');
      expect(prompt).toContain('NEVER re-read or fs_list to verify');
    });

    it('preserves Subtask 8.8 silent-write fallback rule (after fs_create_file emit text)', () => {
      // Subtask 8.8 fix is still load-bearing — Minimax-M3 silent-write bug is
      // real and the runner-level fallback only fires if the model emits zero
      // text. Rule 0 (universal preamble) still in place.
      expect(prompt).toContain('After fs_create_file emit a short text handoff');
      expect(prompt).toContain('no text = failure');
    });

    it('scope qualifier present: non-artifact branch keeps rules 2 + 4 + 5 (Subtask 9.0)', () => {
      // Generic + scope qualifier pattern: frontend_coder is NOT artifact-only.
      // Multi-file / editing tasks keep storage-API ban + color tokens + loop
      // guard, relax the rest. This is the design-feedback Option 1.
      //
      // Subtask 9.0：rule 5 之前在 "relax 1/3/5" 里被 relax —— 这是 bug, 非
      // artifact 任务同样会 re-read loop 烧光 ceiling。Cap "keep rules" 范围
      // 从 2+4 扩到 2+4+5, "relax" 从 1/3/5 缩到 1/3。下面 2 条 expect 把
      // 这条 invariant 钉死 —— 哪天有人 revert 回原写法, CI 会 fail。
      expect(prompt).toContain('Non-artifact: keep rules 2 + 4 + 5');
      expect(prompt).toContain('relax 1/3');
      // 防未来把规则集写错（如 relax 1/4 或 keep 2/4/5/6）—— 显式 forbid
      // 旧 substring, 反向 pin 比正向 pin 更鲁棒。
      expect(prompt).not.toContain('keep rules 2 + 4; relax 1/3/5');
      expect(prompt).not.toContain('relax 1/3/5');
    });

    it('does NOT couple to Tailwind (design review feedback)', () => {
      // Design feedback: artifact skill uses semantic color tokens + CSS
      // variables, framework-agnostic. Tailwind mention in system prompt
      // would lock the role to one CSS framework. The artifact skill's
      // own references/design.md does not mandate Tailwind.
      expect(prompt.toLowerCase()).not.toContain('tailwind');
    });
  });

  describe('reviewer.systemPrompt', () => {
    const prompt = WORKER_ROLES.reviewer.systemPrompt;

    it('encodes the 4 original sandbox grep audit concerns (now within 14-item checklist)', () => {
      // Subtask 2.1 把 4 条 sandbox rule 扩展为 14 条 checklist；但原始
      // 4 条 concern 必须仍然 in scope —— 防 future edit 把 storage API /
      // https / :root / layout 这些 load-bearing pattern 删掉。这条 pin
      // 只校验 4 个原始 concern 的关键字存在，不再校验旧 prompt 4 条
      // 编号格式（Subtask 2.1 改成 1-14 编号）。
      // Rule (1) NO storage APIs as substrings (现在 item 1-3)
      expect(prompt).toContain('localStorage');
      expect(prompt).toContain('sessionStorage');
      expect(prompt).toContain('document.cookie');
      // Rule (2) all CDN use https:// (现在 item 5-6)
      expect(prompt).toContain('https://');
      // Rule (3) :root defines color tokens (现在 item 7)
      expect(prompt).toContain(':root');
      // Rule (4) layout uses CSS Grid / Flexbox (现在 item 9)
      expect(prompt).toContain('Grid');
      expect(prompt).toContain('Flexbox');
    });

    it('audit method explicit (grep file content, no DOM execution available)', () => {
      // Subtask 8.7 stripped execute_js / inspect from whitelist; reviewer is
      // SW-background, no DOM execution. Prompt must call this out so model
      // doesn't try to call the deleted tools. Subtask 2.1 扩展 prompt 时不能
      // 删这段 —— pin 防 drift。
      expect(prompt).toMatch(/grep(ping)?\s+file\s+content/i);
      expect(prompt).toMatch(/no\s+DOM\s+execution/i);
    });

    it('does NOT have hardcoded "<30s" budget (rely on 90s ceiling per design feedback)', () => {
      // Design feedback: 30s too tight for 100 KB+ HTML audit; rely on the
      // per-role 90s ceiling to fail-fast naturally.
      expect(prompt).not.toContain('<30s');
      expect(prompt).not.toContain('30 seconds');
      expect(prompt).not.toContain('30s');
    });

    it('preserves Subtask 8.6 read cap (≤ 3 files via fs_read_file) and 90s ceiling', () => {
      // Subtask 8.6's read cap and emit-within-time rules are preserved.
      expect(prompt).toContain('≤ 3 files via fs_read_file');
      expect(prompt).toContain('90s ceiling');
    });
  });
});

// ─── Subtask 2.1: inline 15-item checklist into reviewer systemPrompt ───────
//
// 把 15 条 artifact audit checklist（9 fail + 6 warn）直接写进 reviewer
// `systemPrompt`。为什么不走 skill `cl-review-checklist`：skill hydration
// 每 call 多 1 轮 VFS read + LLM 还要先消化 skill body 再 grep，inline 让
// LLM 直接拿到 pattern names 列表。代价是 reviewer prompt 比 500-char 通用
// cap 长（实测 ~1017 char），所以上方 systemPrompt ≤ 500 char 那条测试
// 已对 reviewer 例外豁免。
//
// 15 条按 1..15 编号（设计上对应 cl-review-checklist skill 的 stable item id）
// —— 编号也写进 prompt 里让 LLM 在 checklist emit 时按编号引用，Subtask 2.2
// 的 handoff schema 与 Subtask 2.3 的 DelegationCard mini-table 都用这套
// id。下面 expect 把每条 item 的关键 substring 钉死（line / pattern 字段
// 不 pin，否则下次有人调 phrasing 整个 test 失效）。
describe('Subtask 2.1 — reviewer 15-item checklist inlined into systemPrompt', () => {
  const prompt = WORKER_ROLES.reviewer.systemPrompt;

  it('包含 15 条 checklist item 编号 (1)..(15)', () => {
    for (let i = 1; i <= 15; i++) {
      expect(prompt, `item ${i} missing`).toContain(`(${i})`);
    }
  });

  it('fail / warn 标记正确（9 fail + 6 warn, item 14 是 warn per user duyệt）', () => {
    // Plan 头部写「7 fail + 7 warn」，但实际 item 1-3 + 5 + 7 + 9 + 11 +
    // 12 + 15 是 fail（9 条），4 + 6 + 8 + 10 + 13 + 14 是 warn（6 条）。
    // 「7+7」是 plan 早期记错，下面以 prompt 真值为准 —— 配比在 prompt
    // 改写时是 first-class invariant：15 条全显式标注是给 LLM 的「不要漏
    // 任何 item」信号，不能让它 fallback 到「默认 fail」混淆 warn 与 fail
    // 语义。
    const failCount = (prompt.match(/\(\d+\)\s*fail:/g) || []).length;
    const warnCount = (prompt.match(/\(\d+\)\s*warn:/g) || []).length;
    expect(failCount, 'expected 9 fail markers').toBe(9);
    expect(warnCount, 'expected 6 warn markers').toBe(6);
  });

  it('item 14 (no-inline-event-handlers) 是 warn 而不是 fail（user duyệt override）', () => {
    // Item 14 的标 marker 是 `warn:`，rationale 文案里有 prose "keep as warn
    // not fail" —— 不能直接断言整段不含 `fail`（那是 prose 在解释「为什么不
    // 判 fail」）。改成断言：(a) marker 是 `warn:` 而非 `fail:`；(b) item 14
    // body 内（到 item 15 开始前）不该误用 `fail:` 标 marker —— 但 prose 里
    // 的 "not fail" 单字允许。
    const item14Match = prompt.match(/\(14\)\s*(fail|warn):/);
    expect(item14Match, 'item 14 marker missing').toBeTruthy();
    expect(item14Match![1], 'item 14 marker should be warn, not fail').toBe('warn');
    const item14Start = prompt.indexOf('(14)');
    const item15Start = prompt.indexOf('(15)', item14Start + 1);
    const item14Body = prompt.slice(item14Start, item15Start);
    expect(item14Body, 'item 14 body should not contain fail: marker').not.toMatch(/\bfail:\s/);
  });

  it('item 15 (overflow-x auto guard) 在 prompt 中（code-review Subtask 2.1 恢复）', () => {
    // Code-review phát hiện Subtask 8.9 原 4 条的第 4 句「overflow-x: auto
    // on wide content」在 14-item 化时漏掉 —— 删了 prompt 也 relax 了 test
    // pin。User duyệt「Add item 15」恢复 wide-content 兜底：table / pre /
    // code block 不该撑爆页面触发 horizontal scroll。Item 15 是 prompt 最后
    // 一条（无 trailing `;`），用 marker `(15) fail:` 起头 + `[\s\S]+?` 截
    // 到字符串末即可。
    const item15Match = prompt.match(/\(15\)\s*fail:[\s\S]+/);
    expect(item15Match, 'item 15 clause missing').toBeTruthy();
    expect(item15Match![0]).toContain('overflow-x');
  });

  it('每条 item 含可 grep 的 pattern 名（localStorage / sessionStorage / etc.）', () => {
    // LLM audit 时需要 grep 这些 token —— prompt 至少要含 pattern literal，
    // 否则 LLM 不知道要查什么。每个 fail item 必须有 concrete 关键字。
    const requiredKeywords = [
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'indexedDB',
      'https://',
      ':root',
      'prefers-color-scheme',
      'Grid', // Flexbox 也存在；但只校验其一避免重复
      'viewport',
      '<title>',
      'alt',
      'prefers-reduced-motion',
      'onclick', // item 14 mention legacy handlers
      'overflow-x', // item 15 wide-content guard
    ];
    for (const kw of requiredKeywords) {
      expect(prompt, `keyword "${kw}" missing from reviewer prompt`).toContain(kw);
    }
  });

  it('audit method 仍说 "grepping file content"（Subtask 8.7 的 anti-revert pin）', () => {
    // 防 future edit 删掉「no DOM execution」声明 —— reviewer 是 SW 后台，
    // 不能跑 DOM。删了这段 LLM 会试着调已砍的 execute_js / inspect 然后困惑。
    // 上方 Subtask 8.9 「audit method explicit」那条已经 pin 了同样两条
    // substring —— 这里跳过重复断言，避免 future edit 改 wording 时两
    // 处 test 同时 fail 噪音。
    expect(prompt).toMatch(/grep(ping)?\s+file\s+content/i);
    expect(prompt).toMatch(/no\s+DOM\s+execution/i);
  });

  it('保留 read cap (≤ 3 files) + 90s ceiling（Subtask 8.6 load-bearing）', () => {
    // Subtask 8.6 read cap 与 90s ceiling 是 load-bearing —— Subtask 2.1
    // 扩展 prompt 时不能删。
    expect(prompt).toMatch(/≤\s*3\s+files/);
    expect(prompt).toContain('90s');
  });

  it('reviewer prompt ≤ 2 KB（reviewer 单任务上下文预算 guard）', () => {
    // 4-char/byte 估算：2 KB ≈ 500 tokens。Reviewer ~5 KB 上下文 budget 下
    // systemPrompt 占 < 10% —— 给 LLM 留足 file content + reasoning 空间。
    // 这是把 reviewer 从通用 ≤ 500 char cap 切到独立 cap 的依据。Subtask 2.2
    // code-review Finding #1 fix 把「Handoff emit shape + 15 个 allowed item
    // id 列表」段落加进 prompt（约 +600 char），1.5 KB cap 不再够用。Cap 提到
    // 2 KB 仍守住 reviewer context budget 的 10% 上限，同时给 emit-shape 段
    // 留余地。如果将来 prompt 逼近 2 KB，下面 expect 会立刻 fail 提醒
    // reviewer context contention —— 该拆走 skill hydration 而不是继续 inline。
    expect(prompt.length).toBeLessThanOrEqual(2048);
  });
});

// ─── Subtask 8.9: Fast Lane routing rule presence in L1 block ──────────────
//
// Fast Lane routing lives in 3 places (defense in depth): PREAMBLE,
// META.content_writer.description, delegate_task tool schema (covered by
// 8.9b + 8.9c). Tests here pin the L1-block presence + the explicit
// "not for HTML artifacts" clarification on content_writer.description.
describe('Subtask 8.9 — Fast Lane routing in buildAvailableWorkersBlock', () => {
  it('PREAMBLE contains Fast Lane routing rule (HTML / dashboard → frontend_coder)', () => {
    const block = buildAvailableWorkersBlock();
    // Substantive markers from the routing rule body
    expect(block).toContain('Fast Lane routing');
    expect(block).toContain('HTML / dashboard / interactive-demo');
    expect(block).toContain('directly to');
    expect(block).toContain('frontend_coder');
    // Negative constraint: explicitly forbid content_writer for HTML
    expect(block).toContain('NOT route generated HTML through');
    expect(block).toContain('content_writer');
    // Concrete-number argument (mirror the existing "Why" pattern)
    expect(block).toContain('100 KB+ HTML');
  });

  it('Fast Lane rule sits BEFORE "Do it YOURSELF" carve-outs (does not add a 4th bullet)', () => {
    // Existing test pins exactly 3 carve-out bullets in the "Do it YOURSELF"
    // section. Fast Lane rule is added BEFORE that section so it doesn't
    // affect the bullet count. This test asserts positional ordering as
    // defense against future edits that move the rule into the bullet list.
    const block = buildAvailableWorkersBlock();
    const fastLaneIdx = block.indexOf('Fast Lane routing');
    const doItYourselfIdx = block.indexOf('Do it YOURSELF');
    expect(fastLaneIdx).toBeGreaterThan(-1);
    expect(doItYourselfIdx).toBeGreaterThan(-1);
    expect(fastLaneIdx).toBeLessThan(doItYourselfIdx);
  });

  it('content_writer <description> clarifies "Not for HTML artifacts" (Fast Lane negative constraint)', () => {
    // Defense in depth: PREAMBLE says "use frontend_coder for HTML", and
    // content_writer.description says "NOT for HTML artifacts". Both layers
    // active; LLM sees the constraint no matter which path it scans first.
    const block = buildAvailableWorkersBlock();
    const contentWorker = block.match(
      /<worker>\s*<role>content_writer<\/role>[\s\S]*?<\/worker>/,
    );
    expect(contentWorker, '<worker> for content_worker missing').toBeTruthy();
    expect(contentWorker![0]).toContain('Not for HTML artifacts');
    expect(contentWorker![0]).toContain('frontend_coder');
  });
});

// ─── Subtask 8.10: timeout constant pinning ─────────────────────────────────
//
// 把「plan / CHANGELOG / 运行时 / 测试」四处对齐到同一组字面量。Plan / CHANGELOG
// 最初记的「TTFT 45s + idle 20s」是 Subtask 8.5 时期的理想值；实测落地后被调成
// 120s/180s 以兼容 buffering proxy（Kimi K3 emit gap 227s、Minimax-M3 冷启
// 首字节 30–60s）。这两个 pinning test 锁住真值——任何后续想改这两个常量必须
// 同一笔 commit 里同步更新：CHANGELOG 双语条目 + 计划文件 + 这两个字面量 +
// Subtask 8.10 写在 worker-roles.ts 里的 drift-fix docstring。少改一处 CI
// 会直接 fail（这条 pinning test 就是这个同步强制机制）。
describe('Subtask 8.10 — worker timeout constants pinned to runtime values', () => {
  it('WORKER_TTFT_MS === 120_000 (Subtask 8.10 drift fix)', () => {
    // 锁死真值（runtime tuning 后的值）。Subtask 8.5 plan 写 45_000 是理想值，
    // 落地后被 runtime 调成 120_000。改这个字面量前请读 worker-roles.ts:287
    // 上方的 drift-fix docstring，按那里写的同步清单走完整流程。
    expect(WORKER_TTFT_MS).toBe(120_000);
  });

  it('WORKER_IDLE_MS === 180_000 (Subtask 8.10 drift fix)', () => {
    // 锁死真值。Subtask 8.5 plan 写 20_000 是理想值，落地后被 runtime 调成
    // 180_000。同上：改前请读 worker-roles.ts 上方的 drift-fix docstring。
    expect(WORKER_IDLE_MS).toBe(180_000);
  });
});

// ─── Subtask 1.4: PREAMBLE batch shape + tool schema description ─────────
//
// Subtask 1.1–1.3 在 tool schema 加了 `tasks: [...]`（最多 4 个 INDEPENDENT
// items 并行 dispatch），handler 加了 mutual exclusion + batch dispatch。
// 这条 PREAMBLE 章节是 LLM 在主代理 system prompt 里最早看到的「能不能
// batch / 怎么 batch / 什么不能 batch」的契约 —— defense in depth 第二层
// （第一层是 tool schema description，已经在 8.9 + Subtask 1.2 加过）。下面
// 的 pin 把关键 substring 钉死：batch 入口、`Promise.allSettled`、
// 「仅独立 task」、与 top-level `task`/`role` 互斥。下次有人精简 PREAMBLE
// 把 batch 段删掉，下面 expect.toContain 会失败 —— 不会有「主代理不知道
// 可以 batch」silently regression。
describe('Subtask 1.4 — PREAMBLE batch shape marker', () => {
  it('PREAMBLE 解释 batch 入口 + 上限 + 独立 task 约束 + 互斥', () => {
    const block = buildAvailableWorkersBlock();
    // 段落标题 —— 与 "Fast Lane routing" 同样用 `**...**` 包裹的 ASCII 风格
    expect(block).toContain('Parallel batch');
    expect(block).toContain('INDEPENDENT');
    // 上限字面量（与 schema maxItems=4 同步）
    expect(block).toContain('up to 4 items');
    // 并发机制 —— 让 LLM 知道「1 个 item 失败不会取消 siblings」
    expect(block).toContain('Promise.allSettled');
    // 反例：依赖链场景必须显式提到，否则 LLM 容易把所有 task 都塞进
    // batch。Pin 两个反例 token，避免有人精简 PREAMBLE 时把「依赖链要
    // 拆多 call」这条规则一并删掉（这条比 maxItems 更脆弱，因为它是
    // 「不要做什么」型指令，删了不会让 schema 报错，只会让主代理把
    // content_writer → frontend_coder 链塞进同一个 batch）。
    expect(block).toContain('worker B may fs_read_file');
    expect(block).toContain('worker A writes the file');
    // 互斥契约 —— batch vs single-task 不能混用。case-insensitive 让
    // 大小写微调（"are mutually exclusive" ↔ "Mutually exclusive"）不会
    // 把 pin 弄假阳性；对齐 Subtask 1.2 schema description pin（也是 /i）。
    expect(block).toMatch(/mutually exclusive/i);
    expect(block).toContain('pick one shape, not both');
  });

  it('PREAMBLE batch 段落在 "Do it YOURSELF" 之后（positioning pin）', () => {
    // 防 future edit 把 batch 段塞进 YOURSELF carve-out 子弹列表 —— 那会
    // 加一个第 4 颗子弹，破坏上方 line 177-182 的 3 颗子弹 pin。Batch
    // 段落必须在 "Do it YOURSELF" 之后、</available-workers> 之前。
    const block = buildAvailableWorkersBlock();
    const doItYourselfIdx = block.indexOf('Do it YOURSELF');
    const batchIdx = block.indexOf('Parallel batch');
    const closeIdx = block.lastIndexOf('</available-workers>');
    expect(doItYourselfIdx).toBeGreaterThan(-1);
    expect(batchIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(-1);
    expect(batchIdx).toBeGreaterThan(doItYourselfIdx);
    expect(batchIdx).toBeLessThan(closeIdx);
  });
});
