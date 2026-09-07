// Worker runner 测试 —— 仅覆盖**纯函数**部分：filterToolsForRole + assembleHandoff
// + 4 个 Subtask 5.2 新增的 prompt 组合谓词（buildAntiPatternsBlock / composePrompt
// / composeRetryPrompt / shouldRetry）+ assembleHandoff 的 schema 校验新分支。
// IO-heavy 部分（VFS 读 / model 解析 / agent 跑）走 manual integration test
// （plan 显式提到 BG SW console 跑），不在 unit test 范围内。

import { describe, it, expect } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  assembleHandoff,
  buildAntiPatternsBlock,
  buildWorkspaceBlock,
  composePrompt,
  composeRetryPrompt,
  filterToolsForRole,
  shouldRetry,
  type AssembleHandoffArgs,
  type PromptContext,
  type WorkerHandoff,
} from '@/entrypoints/background/agent/worker-runner';
import type { WorkerRole } from '@/lib/persistence/storage';

function stubTool(name: string): AgentTool<any> {
  return {
    name,
    label: name,
    description: `stub ${name}`,
    parameters: { type: 'object', properties: {} } as any,
    execute: () => Promise.resolve({ content: [], details: {} }),
  };
}

const UNIVERSE: readonly AgentTool<any>[] = [
  stubTool('fs_read_file'),
  stubTool('fs_create_file'),
  stubTool('fs_edit_file'),
  stubTool('fs_list'),
  stubTool('fs_search'),
  stubTool('rag_inspect'),
  stubTool('inspect'),
  stubTool('execute_js'),
  // 故意混入禁词 —— 测 filterToolsForRole 的「无条件剥」行为
  stubTool('delegate_task'),
  stubTool('delegate_dom'),
];

describe('filterToolsForRole', () => {
  it('content_writer 拿到 6 个 fs/rag 工具，不含 execute_js / inspect / 禁词', () => {
    const tools = filterToolsForRole(UNIVERSE, 'content_writer');
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'fs_read_file',
      'fs_create_file',
      'fs_edit_file',
      'fs_list',
      'fs_search',
      'rag_inspect',
    ]);
  });

  it('frontend_coder 只有 4 个 fs 写读工具', () => {
    const names = filterToolsForRole(UNIVERSE, 'frontend_coder').map((t) => t.name);
    expect(names).toEqual(['fs_read_file', 'fs_create_file', 'fs_edit_file', 'fs_list']);
  });

  it('reviewer 有 fs_读 + execute_js + inspect，无写工具', () => {
    const names = filterToolsForRole(UNIVERSE, 'reviewer').map((t) => t.name);
    expect(names).toEqual(['fs_read_file', 'fs_list', 'inspect', 'execute_js']);
  });

  it('researcher 有 fs_读 + rag_inspect，无浏览器工具', () => {
    const names = filterToolsForRole(UNIVERSE, 'researcher').map((t) => t.name);
    expect(names).toEqual(['fs_read_file', 'fs_list', 'fs_search', 'rag_inspect']);
  });

  it('无论 whitelist 怎么写，禁词永远被剥（belt-and-suspenders）', () => {
    for (const role of ['content_writer', 'frontend_coder', 'reviewer', 'researcher'] as const) {
      const tools = filterToolsForRole(UNIVERSE, role as WorkerRole);
      const names = tools.map((t) => t.name);
      expect(names, `role ${role} leaked delegate_task`).not.toContain('delegate_task');
      expect(names, `role ${role} leaked delegate_dom`).not.toContain('delegate_dom');
    }
  });

  it('原 universe 里未在 whitelist 的工具被滤掉', () => {
    const names = filterToolsForRole(UNIVERSE, 'reviewer').map((t) => t.name);
    expect(names).not.toContain('fs_create_file');
    expect(names).not.toContain('fs_edit_file');
    expect(names).not.toContain('fs_search');
    expect(names).not.toContain('rag_inspect');
  });
});

// ─── assembleHandoff ───

function baseArgs(overrides: Partial<AssembleHandoffArgs> = {}): AssembleHandoffArgs {
  return {
    runnerOk: true,
    role: 'content_writer',
    modelKey: 'anthropic/claude-3-5-sonnet',
    rawText: '{"status":"success","output_file":"out.txt","summary":"ok","handoff_notes":""}',
    json: '{"status":"success","output_file":"out.txt","summary":"ok","handoff_notes":""}',
    outputFileExists: true,
    ...overrides,
  };
}

describe('assembleHandoff', () => {
  it('runnerOk=false → ok:false, status:failed, error 透传', () => {
    const h = assembleHandoff({
      ...baseArgs({ runnerOk: false }),
      runnerError: 'No model could be resolved for role "reviewer".',
    });
    expect(h).toMatchObject({
      ok: false,
      status: 'failed',
      error: 'No model could be resolved for role "reviewer".',
      summary: 'No model could be resolved for role "reviewer".',
      handoff_notes: '',
      modelKey: 'anthropic/claude-3-5-sonnet',
      role: 'content_writer',
    });
  });

  it('runnerError 缺失时 summary / error 各 fallback 到人类可读 / 兜底字面', () => {
    // `error` 是技术字段（给 tool 层诊断），无 message 时兜底 "Unknown error"；
    // `summary` 是给主代理 LLM 看的一句话，无 message 时兜底 "Worker run failed"
    // —— 后者更可读，避免主代理看到 "Unknown error" 一头雾水。
    const h = assembleHandoff({ ...baseArgs({ runnerOk: false }) });
    expect(h.error).toBe('Unknown error');
    expect(h.summary).toBe('Worker run failed');
  });

  // ── Phase 1.4: timeout + output file 区分 retryable / fail-fast ──
  it('timeout + output file 存在 → retryable:true（mechanical self-heal，retry 接着写完）', () => {
    // Worker 被 120s hard abort 中途, 但 output file 已存在 → retry
    // 让他写完比 fail-fast 友好. 这是 Phase 1.4 新加的例外分支.
    const h = assembleHandoff({
      ...baseArgs({ runnerOk: false }),
      runnerError: 'Worker timed out after 120000ms',
      timedOut: true,
      outputFileExists: true,
    });
    expect(h.ok).toBe(false);
    expect(h.timedOut).toBe(true);
    expect(h.retryable).toBe(true);
    expect(h.status).toBe('failed');
  });

  it('timeout + output file 不存在 → retryable:false（fail-fast）', () => {
    // Timeout 但 file 不存在 → 同一 model + prompt 再跑 120s 还会卡,
    // 不要再 retry. 配 shouldRetry 测 一起钉死「不会再重试」.
    const h = assembleHandoff({
      ...baseArgs({ runnerOk: false }),
      runnerError: 'Worker timed out after 120000ms',
      timedOut: true,
      outputFileExists: false,
    });
    expect(h.ok).toBe(false);
    expect(h.timedOut).toBe(true);
    expect(h.retryable).toBeFalsy();
  });

  it('non-timeout runner error (parent abort / exception) → retryable:false（zero regression）', () => {
    // 保持原原则: non-timeout runner-level error 永不
    // retry (重试不会让它消失). 即便 outputFileExists=true, timedOut=false
    // → retryable 仍须为 false.
    const h = assembleHandoff({
      ...baseArgs({ runnerOk: false }),
      runnerError: 'Aborted',
      timedOut: undefined,
      outputFileExists: true,
    });
    expect(h.ok).toBe(false);
    expect(h.retryable).toBeFalsy();
  });

  it('JSON parse 失败（malformed）→ ok:true, status:failed, handoff_notes 放 rawText 截断', () => {
    const raw = 'I am the LLM and I produced prose only, no JSON. '.repeat(20);
    const h = assembleHandoff(
      baseArgs({
        json: '{not valid json',
        rawText: raw,
      }),
    );
    expect(h.ok).toBe(true);
    expect(h.status).toBe('failed');
    expect(h.summary).toMatch(/could not be parsed/i);
    expect(h.handoff_notes).toBe(raw.slice(0, 500));
    expect(h.handoff_notes.length).toBeLessThanOrEqual(500);
  });

  it('json 是数组或非对象 → 当作没抽到 → status:failed', () => {
    const h1 = assembleHandoff(baseArgs({ json: '[1,2,3]' }));
    expect(h1.status).toBe('failed');
    expect(h1.ok).toBe(true);

    const h2 = assembleHandoff(baseArgs({ json: '"plain string"' }));
    expect(h2.status).toBe('failed');
  });

  it('json=null → 当作没抽到 → status:failed（与 parse 失败同路径）', () => {
    const h = assembleHandoff(baseArgs({ json: null }));
    expect(h.status).toBe('failed');
    expect(h.ok).toBe(true);
    expect(h.handoff_notes).toBe(baseArgs().rawText.slice(0, 500));
  });

  it('worker 自称 success + outputPath 声明 + VFS 文件缺失 → status:failed, error 写明', () => {
    const h = assembleHandoff(
      baseArgs({
        outputFileExists: false,
        declaredOutputPath: '/workspaces/abc/out.txt',
      }),
    );
    expect(h.status).toBe('failed');
    expect(h.ok).toBe(true);
    expect(h.error).toContain('output file is missing');
    expect(h.error).toContain('/workspaces/abc/out.txt');
    expect(h.output_file).toBe('/workspaces/abc/out.txt');
  });

  it('worker 自称 success + 无 declaredOutputPath → status:success（无文件校验）', () => {
    const h = assembleHandoff(baseArgs());
    expect(h.status).toBe('success');
    expect(h.ok).toBe(true);
    expect(h.output_file).toBe('out.txt'); // 来自 JSON
    expect(h.output_content).toBeUndefined();
  });

  it('worker 自称 success + 文件存在 + 挂 output_content', () => {
    const h = assembleHandoff(
      baseArgs({
        outputContent: 'hello world',
        declaredOutputPath: '/workspaces/abc/out.txt',
        outputFileExists: true,
      }),
    );
    expect(h.status).toBe('success');
    expect(h.output_content).toBe('hello world');
  });

  it('worker 自称 failed → status:failed, 无 error（worker 自报原因）', () => {
    const h = assembleHandoff(
      baseArgs({
        rawText: '{"status":"failed","output_file":null,"summary":"OOM","handoff_notes":"too long"}',
        json: '{"status":"failed","output_file":null,"summary":"OOM","handoff_notes":"too long"}',
        outputFileExists: false,
        declaredOutputPath: undefined,
      }),
    );
    expect(h.status).toBe('failed');
    expect(h.ok).toBe(true);
    expect(h.error).toBeUndefined();
    expect(h.summary).toBe('OOM');
    expect(h.handoff_notes).toBe('too long');
    expect(h.output_file).toBeUndefined(); // output_file 是 null 时不挂
  });

  it('worker 自称 partial → status:partial', () => {
    const h = assembleHandoff(
      baseArgs({
        rawText: '{"status":"partial","output_file":null,"summary":"halfway","handoff_notes":"need more"}',
        json: '{"status":"partial","output_file":null,"summary":"halfway","handoff_notes":"need more"}',
        outputFileExists: false,
        declaredOutputPath: undefined,
      }),
    );
    expect(h.status).toBe('partial');
    expect(h.ok).toBe(true);
    expect(h.summary).toBe('halfway');
  });

  it('JSON 缺 status 字段 → 默认 failed（保底）', () => {
    const h = assembleHandoff(
      baseArgs({
        rawText: '{"summary":"just a summary"}',
        json: '{"summary":"just a summary"}',
        outputFileExists: false,
        declaredOutputPath: undefined,
      }),
    );
    expect(h.status).toBe('failed');
  });

  it('summary / handoff_notes 不是字符串时被丢成空串', () => {
    const h = assembleHandoff(
      baseArgs({
        rawText: '{"status":"success","summary":42,"handoff_notes":true}',
        json: '{"status":"success","summary":42,"handoff_notes":true}',
        outputFileExists: false,
        declaredOutputPath: undefined,
      }),
    );
    expect(h.status).toBe('success');
    expect(h.summary).toBe('');
    expect(h.handoff_notes).toBe('');
  });

  it('JSON 里 status 不是合法值 → 默认当 failed', () => {
    // 防御：worker 写 {"status":"ohno"} 时我们不挂掉，按 failed 处理。
    const h = assembleHandoff(
      baseArgs({
        rawText: '{"status":"ohno","summary":"oops"}',
        json: '{"status":"ohno","summary":"oops"}',
        outputFileExists: false,
        declaredOutputPath: undefined,
      }),
    );
    expect(h.status).toBe('failed');
    expect(h.summary).toBe('oops');
  });

  // ── Subtask 5.2: schema 校验 + retryable 标记 + attempts 透传 ──

  it('parse 失败 → retryable:true（让外层跑单次自愈 retry）', () => {
    const h = assembleHandoff(
      baseArgs({
        json: null,
        rawText: 'I forgot to produce JSON this time.',
        outputFileExists: false,
        declaredOutputPath: undefined,
      }),
    );
    expect(h.status).toBe('failed');
    expect(h.ok).toBe(true);
    expect(h.retryable).toBe(true);
    expect(h.summary).toMatch(/could not be parsed/i);
    expect(h.handoff_notes).toContain('I forgot to produce JSON');
  });

  it('expectedSchema 本身不是合法 JSON → runner-level error（ok:false, 不 retryable）', () => {
    // 这是 caller（main agent）输入有 bug，retry 没意义——直接挡掉。
    const h = assembleHandoff(
      baseArgs({
        expectedSchema: '{not valid json',
      }),
    );
    expect(h.ok).toBe(false);
    expect(h.status).toBe('failed');
    expect(h.retryable).toBeUndefined();
    expect(h.error).toContain('expected_schema');
    expect(h.error).toMatch(/not valid JSON/i);
  });

  it('expectedSchema 合法 + worker 输出满足 schema → status:success, 无 retryable', () => {
    // schema 校验只是「额外保证」，通过时不影响 status 推断。
    const h = assembleHandoff(
      baseArgs({
        rawText: '{"status":"success","summary":"ok","output_file":"out.txt","required_field":"x"}',
        json: '{"status":"success","summary":"ok","output_file":"out.txt","required_field":"x"}',
        expectedSchema: '{"type":"object","required":["status","required_field"],"properties":{"status":{"const":"success"},"required_field":{"type":"string"}}}',
        outputFileExists: true,
        declaredOutputPath: '/workspaces/abc/out.txt',
      }),
    );
    expect(h.status).toBe('success');
    expect(h.ok).toBe(true);
    expect(h.retryable).toBeUndefined();
  });

  it('expectedSchema 合法 + worker 输出违反 schema → status:failed, retryable:true', () => {
    // required_field 缺失 → Value.Check 失败 → retryable。
    const h = assembleHandoff(
      baseArgs({
        rawText: '{"status":"success","summary":"ok","output_file":"out.txt"}',
        json: '{"status":"success","summary":"ok","output_file":"out.txt"}',
        expectedSchema: '{"type":"object","required":["status","required_field"],"properties":{"status":{"const":"success"},"required_field":{"type":"string"}}}',
        outputFileExists: true,
        declaredOutputPath: '/workspaces/abc/out.txt',
      }),
    );
    expect(h.status).toBe('failed');
    expect(h.ok).toBe(true);
    expect(h.retryable).toBe(true);
    expect(h.error).toMatch(/schema validation failed/i);
    // error 格式 mirror mcp/client.ts: ${instancePath}: ${message}
    expect(h.error).toMatch(/: /);
  });

  it('worker 自称 success + 文件缺失 → retryable:true（让外层重试给 worker 第二次机会写文件）', () => {
    const h = assembleHandoff(
      baseArgs({
        outputFileExists: false,
        declaredOutputPath: '/workspaces/abc/out.txt',
      }),
    );
    expect(h.status).toBe('failed');
    expect(h.ok).toBe(true);
    expect(h.retryable).toBe(true);
    expect(h.error).toContain('output file is missing');
  });

  it('attempts 透传：caller 显式设 1 → handoff.attempts === 1', () => {
    const h = assembleHandoff(baseArgs({ attempts: 1 }));
    expect(h.attempts).toBe(1);
  });

  it('attempts 透传：caller 显式设 2 → handoff.attempts === 2（阻止再次 retry）', () => {
    const h = assembleHandoff(baseArgs({ attempts: 2 }));
    expect(h.attempts).toBe(2);
  });

  it('attempts 透传：caller 不传 → handoff.attempts undefined（兼容老 caller）', () => {
    const h = assembleHandoff(baseArgs());
    expect(h.attempts).toBeUndefined();
  });
});

// ─── assembleHandoff: Fail-Fast (Subtask 1) ───
//
// timeout / network / abort 一律走 branch 1（runnerOk=false）。
// 原本这条路径一律不设 `retryable`（Subtask 1 时的 hard rule：runner-level
// 错误不重试），Phase 1.4 为 timeout 路径加了例外：timeout + output file
// 已有 → retryable:true（worker 被硬 abort 中途但已经写了文件，retry 让
// 它接着写完比 fail-fast 友好）。其它 runner-level 错误（parent abort /
// network / exception）保持 retryable 缺失，让 `shouldRetry(...)` 仍
// 返回 false。配套断言 `attemptDurationMs` 在所有分支都透传到 handoff。

describe('assembleHandoff: Fail-Fast (timeout / abort)', () => {
  it('runnerOk=false + timedOut:true + file 存在 → retryable:true (Phase 1.4 smart retry)', () => {
    const h = assembleHandoff({
      ...baseArgs({ runnerOk: false }),
      runnerError: 'Worker timed out after 120000ms (model "anthropic/claude-opus-4-1" did not respond)',
      timedOut: true,
      attemptDurationMs: 120_000,
      outputFileExists: true,
    });
    expect(h.ok).toBe(false);
    expect(h.status).toBe('failed');
    expect(h.timedOut).toBe(true);
    expect(h.attemptDurationMs).toBe(120_000);
    // Phase 1.4: timeout + file 存在 → retryable (mechanical self-heal)
    expect(h.retryable).toBe(true);
  });

  it('runnerOk=false + timedOut:true + file 不存在 → retryable 缺失（fail-fast）', () => {
    const h = assembleHandoff({
      ...baseArgs({ runnerOk: false }),
      runnerError: 'Worker timed out after 120000ms (model "anthropic/claude-opus-4-1" did not respond)',
      timedOut: true,
      attemptDurationMs: 120_000,
      outputFileExists: false,
    });
    expect(h.ok).toBe(false);
    expect(h.status).toBe('failed');
    expect(h.timedOut).toBe(true);
    // timeout + file 不存在 → fail-fast, retryable 缺失 → shouldRetry 返回 false
    expect(h.retryable).toBeUndefined();
  });

  it('runnerOk=false + 父 signal abort（timedOut:false） → handoff.timedOut 缺失', () => {
    const h = assembleHandoff({
      ...baseArgs({ runnerOk: false }),
      runnerError: 'Aborted',
      timedOut: false,
      attemptDurationMs: 12_345,
    });
    expect(h.ok).toBe(false);
    // timedOut:false 与「未设」等价：assembleHandoff 只在 truthy 时挂
    // 字段。语义上这是「这 attempt **不是** timeout 引起的」（可能是
    // caller abort / model exception），UI 看到字段缺失就走 generic
    // 「失败」分支，缺失→不渲染「换 model」 hint。
    expect(h.timedOut).toBeUndefined();
    expect(h.attemptDurationMs).toBe(12_345);
  });

  it('attemptDurationMs 在 branch 1（runnerOk=false）透传', () => {
    const h = assembleHandoff({
      ...baseArgs({ runnerOk: false }),
      runnerError: 'network unreachable',
      attemptDurationMs: 4_567,
    });
    expect(h.attemptDurationMs).toBe(4_567);
  });

  it('attemptDurationMs 在 branch 2（parse 失败）透传', () => {
    const h = assembleHandoff(
      baseArgs({
        json: null,
        rawText: 'no json',
        attemptDurationMs: 8_888,
      }),
    );
    expect(h.status).toBe('failed');
    expect(h.attemptDurationMs).toBe(8_888);
  });

  it('attemptDurationMs 在 branch 3（schema malformed）透传', () => {
    const h = assembleHandoff(
      baseArgs({
        expectedSchema: '{not valid',
        attemptDurationMs: 1_000,
      }),
    );
    expect(h.ok).toBe(false);
    expect(h.attemptDurationMs).toBe(1_000);
  });

  it('attemptDurationMs 在 branch 4（schema validation 失败）透传', () => {
    const h = assembleHandoff(
      baseArgs({
        rawText: '{"status":"success","summary":"x"}',
        json: '{"status":"success","summary":"x"}',
        expectedSchema: '{"type":"object","required":["missing"]}',
        attemptDurationMs: 2_500,
      }),
    );
    expect(h.retryable).toBe(true);
    expect(h.attemptDurationMs).toBe(2_500);
  });

  it('attemptDurationMs 在 branch 5（worker success + 文件缺失）透传', () => {
    const h = assembleHandoff(
      baseArgs({
        outputFileExists: false,
        declaredOutputPath: '/workspaces/abc/out.txt',
        attemptDurationMs: 7_777,
      }),
    );
    expect(h.status).toBe('failed');
    expect(h.attemptDurationMs).toBe(7_777);
  });

  it('attemptDurationMs 在 branch 6（正常 success）透传', () => {
    const h = assembleHandoff(baseArgs({ attemptDurationMs: 11_111 }));
    expect(h.status).toBe('success');
    expect(h.attemptDurationMs).toBe(11_111);
  });

  it('attemptDurationMs 不传 → handoff.attemptDurationMs 缺失（兼容老 caller）', () => {
    const h = assembleHandoff(baseArgs());
    expect(h.attemptDurationMs).toBeUndefined();
  });
});

// ─── buildAntiPatternsBlock (Subtask 5.2.B) ───

describe('buildAntiPatternsBlock', () => {
  it('空数组 → 空串（block 完全 omit，不留空 wrapper）', () => {
    expect(buildAntiPatternsBlock([])).toBe('');
  });

  it('undefined / null 防御 → 空串', () => {
    // 不抛；让 caller 不必每次都判空。
    expect(buildAntiPatternsBlock(undefined as unknown as readonly string[])).toBe('');
    expect(buildAntiPatternsBlock(null as unknown as readonly string[])).toBe('');
  });

  it('单条 rule → 单行 <rule>，包在 <do-not-do> 里', () => {
    const out = buildAntiPatternsBlock(['Do not fabricate quotes']);
    expect(out).toBe('<do-not-do>\n<rule>Do not fabricate quotes</rule>\n</do-not-do>');
  });

  it('多条 rule → 每条一行 <rule>，顺序保留', () => {
    const out = buildAntiPatternsBlock([
      'Do not fabricate quotes',
      'Always cite paragraph number',
      'Never use passive voice',
    ]);
    expect(out).toBe(
      '<do-not-do>\n' +
        '<rule>Do not fabricate quotes</rule>\n' +
        '<rule>Always cite paragraph number</rule>\n' +
        '<rule>Never use passive voice</rule>\n' +
        '</do-not-do>',
    );
  });

  it('raw string pass-through：不做转义（XML envelope 是视觉分段，不是真 XML DOM）', () => {
    // 故意混入 `<` `>` —— LLM 应该看到 raw rule，不该被 escape。
    const out = buildAntiPatternsBlock(['Avoid using <script> in output']);
    expect(out).toContain('<rule>Avoid using <script> in output</rule>');
  });
});

// ─── buildWorkspaceBlock (worker 不知道 session 根 → 写错路径的 fix) ───
//
// E2E bug：worker 是 fresh agent，没 session context。fs_* 工具要求 absolute
// path，worker 看到 'content.json' 后猜了 `/content.json`（VFS root），导致后续
// input_files 读不到。这里把 session 根绝对路径显式钉进 prompt。

describe('buildWorkspaceBlock', () => {
  const SID = '01234567-89ab-cdef-0123-456789abcdef';
  const ROOT = `/workspaces/${SID}`;

  it('有 sessionId → block 含 <workspace> wrapper + 根绝对路径', () => {
    const out = buildWorkspaceBlock(SID);
    expect(out).toMatch(/^<workspace>/);
    expect(out).toMatch(/<\/workspace>$/);
    expect(out).toContain(`Your session workspace root is: ${ROOT}`);
    // 必须明确告诉 worker：fs_* 调用必须 absolute
    expect(out).toContain('MUST be an absolute path');
  });

  it('有 absoluteOutputPath → 多一行钉死最终产物路径', () => {
    const out = buildWorkspaceBlock(SID, `${ROOT}/studio.html`);
    expect(out).toContain(`Write your final output file to this absolute path: ${ROOT}/studio.html`);
  });

  it('没有 absoluteOutputPath → 不写「Write your final output file」那一行', () => {
    const out = buildWorkspaceBlock(SID);
    expect(out).not.toContain('Write your final output file');
  });

  it('非法 sessionId → 抛 VfsScopeError（gate 早于任何 string 拼装）', () => {
    // 防御：caller 传错了 sessionId 不该 silently 拼出假根路径。
    expect(() => buildWorkspaceBlock('not-a-uuid')).toThrow();
  });
});

// ─── composePrompt (Subtask 5.2 — skills / anti_patterns / input_files / task ordering + contract reminder) ───

describe('composePrompt', () => {
  it('只有 task → 返回 task + 末尾 handoff 契约 reminder', () => {
    // 契约 reminder 是单点事实源（worker-roles.ts role systemPrompt 不再写
    // 第二份）；composePrompt 永远 append 一次。Worker 看到 task 之后立刻
    // 知道该回什么 JSON shape。
    expect(composePrompt('Write a poem.')).toBe(
      'Write a poem.\n\nReply with a JSON object of the form ' +
        '{"status": "success" | "failed" | "partial", "output_file": "<path or null>", ' +
        '"summary": "<one line>", "handoff_notes": "<caveats>"} ' +
        'and end with the literal line END OF HANDOFF.',
    );
  });

  it('顺序硬编码：workspace → skills → anti_patterns → input_files → task → 契约 reminder', () => {
    // 这个顺序不能改：workspace 根（文件该落在哪）必须在所有动作之前；
    // guardrails 在数据前；skills 在所有运行时上下文前；task 永远在
    // 契约 reminder 之前——worker 读完整 task 后才知道 handoff shape。
    const workspace = '<workspace>\nYour session workspace root is: /workspaces/<id>\n</workspace>';
    const skill = '<worker-skill name="a">A</worker-skill>';
    const anti = '<do-not-do>\n<rule>X</rule>\n</do-not-do>';
    const files = '<input-files>\nfile: a\n</input-files>';
    const ctx: PromptContext = {
      workspaceBlock: workspace,
      skillBlocks: skill,
      antiPatternsBlock: anti,
      inputFilesBlock: files,
    };
    const expected =
      [workspace, skill, anti, files, 'Do the thing', 'Reply with a JSON object of the form ' +
        '{"status": "success" | "failed" | "partial", "output_file": "<path or null>", ' +
        '"summary": "<one line>", "handoff_notes": "<caveats>"} ' +
        'and end with the literal line END OF HANDOFF.'].join('\n\n');
    expect(composePrompt('Do the thing', ctx)).toBe(expected);
  });

  it('缺某 block → 该位置直接跳过，剩余 block 用 \\n\\n 拼接，契约 reminder 永远在末', () => {
    const anti = '<do-not-do>\n<rule>X</rule>\n</do-not-do>';
    expect(composePrompt('Do the thing', { antiPatternsBlock: anti })).toBe(
      `${anti}\n\nDo the thing\n\nReply with a JSON object of the form ` +
        `{"status": "success" | "failed" | "partial", "output_file": "<path or null>", ` +
        `"summary": "<one line>", "handoff_notes": "<caveats>"} ` +
        `and end with the literal line END OF HANDOFF.`,
    );
  });

  it('全部 block 缺失 → task + 契约 reminder', () => {
    expect(composePrompt('Do the thing', {})).toBe(
      'Do the thing\n\nReply with a JSON object of the form ' +
        '{"status": "success" | "failed" | "partial", "output_file": "<path or null>", ' +
        '"summary": "<one line>", "handoff_notes": "<caveats>"} ' +
        'and end with the literal line END OF HANDOFF.',
    );
  });

  it('空字符串 block 当作缺失（与未设等价）；契约 reminder 仍 append', () => {
    // 防止 caller 误传 buildAntiPatternsBlock([]) 的空串结果进来导致空行。
    expect(composePrompt('Do the thing', { antiPatternsBlock: '' })).toBe(
      'Do the thing\n\nReply with a JSON object of the form ' +
        '{"status": "success" | "failed" | "partial", "output_file": "<path or null>", ' +
        '"summary": "<one line>", "handoff_notes": "<caveats>"} ' +
        'and end with the literal line END OF HANDOFF.',
    );
  });
});

// ─── composeRetryPrompt (Subtask 5.2.C — retry feedback 块) ───

describe('composeRetryPrompt', () => {
  it('原 prompt 完整保留 + 末尾 append <retry-feedback> 块', () => {
    const original = composePrompt('Task', {
      antiPatternsBlock: buildAntiPatternsBlock(['X']),
    });
    const failedHandoff: WorkerHandoff = {
      status: 'failed',
      ok: true,
      retryable: true,
      summary: 'Worker handoff JSON could not be parsed',
      handoff_notes: 'I forgot to produce JSON',
      modelKey: 'anthropic/claude-3-5-sonnet',
      role: 'content_writer',
    };
    const out = composeRetryPrompt(original, failedHandoff);
    // 原 prompt 整体保留
    expect(out.startsWith(original)).toBe(true);
    // retry-feedback 块存在
    expect(out).toContain('<retry-feedback>');
    expect(out).toContain('</retry-feedback>');
  });

  it('retry block 包含 status / summary / handoff_notes', () => {
    const failed: WorkerHandoff = {
      status: 'failed',
      ok: true,
      retryable: true,
      summary: 'I forgot JSON',
      handoff_notes: 'please try again',
      modelKey: 'm',
      role: 'content_writer',
    };
    const out = composeRetryPrompt('task', failed);
    expect(out).toContain('- status: failed');
    expect(out).toContain('- summary: I forgot JSON');
    expect(out).toContain('- handoff_notes: please try again');
  });

  it('retry block 在 failedHandoff 有 error 字段时包含 - error:', () => {
    const failed: WorkerHandoff = {
      status: 'failed',
      ok: true,
      retryable: true,
      summary: 'Schema fail',
      handoff_notes: '',
      error: 'Schema validation failed: /required_field: must have required property',
      modelKey: 'm',
      role: 'content_writer',
    };
    const out = composeRetryPrompt('task', failed);
    expect(out).toContain('- error: Schema validation failed');
  });

  it('retry block 不在 error 缺失时泄露 "error:" 字段', () => {
    const failed: WorkerHandoff = {
      status: 'failed',
      ok: true,
      retryable: true,
      summary: 's',
      handoff_notes: '',
      // error 故意缺失（worker 自报 failed 不必带 error 字段）
      modelKey: 'm',
      role: 'content_writer',
    };
    const out = composeRetryPrompt('task', failed);
    expect(out).not.toMatch(/^- error:/m);
  });

  it('retry block 总是带 handoff JSON 契约 reminder（防 worker 跑偏忘了 JSON shape）', () => {
    const failed: WorkerHandoff = {
      status: 'failed',
      ok: true,
      retryable: true,
      summary: 's',
      handoff_notes: '',
      modelKey: 'm',
      role: 'content_writer',
    };
    const out = composeRetryPrompt('task', failed);
    expect(out).toMatch(/JSON object/i);
    expect(out).toContain('END OF HANDOFF');
  });
});

// ─── shouldRetry (Subtask 5.2.C — retry 决策) ───

describe('shouldRetry', () => {
  const baseOk: WorkerHandoff = {
    status: 'failed',
    ok: true,
    retryable: true,
    summary: 's',
    handoff_notes: '',
    modelKey: 'm',
    role: 'content_writer',
  };

  it('parse 失败（ok=true, retryable=true, attempts=1） → true', () => {
    expect(shouldRetry({ ...baseOk, attempts: 1 })).toBe(true);
  });

  it('文件缺失（ok=true, retryable=true, attempts=1） → true', () => {
    expect(
      shouldRetry({
        ...baseOk,
        error: 'Worker reported success but output file is missing: out.txt',
        attempts: 1,
      }),
    ).toBe(true);
  });

  it('schema 校验失败（ok=true, retryable=true, attempts=1） → true', () => {
    expect(
      shouldRetry({
        ...baseOk,
        error: 'Schema validation failed: /x: missing',
        attempts: 1,
      }),
    ).toBe(true);
  });

  it('runnerOk=false（ok:false）但 timedOut=false → false（不重试 model/abort error）', () => {
    // Phase 1.4: ok=false 仍允许重试**当且仅当** timedOut=true（timeout
    // 路径). 这里验证 non-timeout 的 ok=false 仍 fail — zero regression.
    expect(shouldRetry({ ...baseOk, ok: false, timedOut: false, attempts: 1 })).toBe(false);
  });

  it('runnerOk=false + timedOut=true → true（Phase 1.4 新例外：timeout 自愈）', () => {
    // New in Phase 1.4. assembleHandoff 只在 timeout+outputFileExists
    // 时才设 retryable=true, 这里喂一个 retryable:true + ok:false +
    // timedOut:true, shouldRetry 应该 true. retryable 缺失 → false.
    expect(
      shouldRetry({
        ...baseOk,
        ok: false,
        timedOut: true,
        attempts: 1,
      }),
    ).toBe(true);
    expect(
      shouldRetry({
        ...baseOk,
        ok: false,
        timedOut: true,
        retryable: undefined,
        attempts: 1,
      }),
    ).toBe(false);
  });

  it('attempts=2（timeout 路径已自愈过一次） → false（单次自愈硬上限）', () => {
    // Phase 1.4 新加的 timeout retry 路径仍受 attempts===2 硬上限约束：
    // 即便 retryable:true + timedOut:true，跑到第二次就不再重试，避免
    // 反复 timeout 烧 120s。钉死「单次自愈」不变式。
    expect(
      shouldRetry({
        ...baseOk,
        ok: false,
        timedOut: true,
        retryable: true,
        attempts: 2,
      }),
    ).toBe(false);
  });

  it('retryable=false（worker 自报 failed，非机械故障） → false', () => {
    expect(shouldRetry({ ...baseOk, retryable: false, attempts: 1 })).toBe(false);
  });

  it('status=success（retryable 字段未设） → false（成功无 retry；caller 不会把 success handoff 标 retryable）', () => {
    // shouldRetry 不直接看 status —— 它只看 ok + retryable + attempts。但
    // assembleHandoff 只在 3 个 failure 分支设 retryable=true，success 路径
    // 不设。所以「真实世界」的 success handoff retryable 总是 undefined，
    // 此处测的就是这个不变式：retryable 缺失时直接 false。
    expect(shouldRetry({ ...baseOk, status: 'success', retryable: undefined })).toBe(false);
  });

  it('attempts=2 → false（已 retry 过一次，硬上限单次自愈）', () => {
    expect(shouldRetry({ ...baseOk, attempts: 2 })).toBe(false);
  });

  it('attempts 缺失 → 仍按「还没 retry」处理（attempts !== 2 通过）', () => {
    expect(shouldRetry(baseOk)).toBe(true);
  });
});
