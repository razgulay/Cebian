// `delegate_task` 工具的单测——对照 `delegate-dom.test.ts`：
//  - 用 vi.mock('@/entrypoints/background/agent/worker-runner') 接管 runWorker；
//  - 在 beforeEach 清 mocks（lazy import 拿到的 module 跨测试共享）；
//  - 测试 factory 返回的 tool：schema 形状 / execute() 各失败分支 / 成功分支
//    的 handoff 文本截断 + annotation。
//
// 关键的 path-safety gate（output_path / input_files / skills / model_override）
// 全部在「调 runWorker 之前」完成，所以失败用例里 mock 必须 **从未被调用**
// —— 这是顺序保证。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDelegateTaskTool } from './delegate-task';
import { TOOL_DELEGATE_TASK } from './names';
import { workerTeamEnabled } from '@/lib/persistence/storage';

vi.mock('@/entrypoints/background/agent/worker-runner', () => ({
  runWorker: vi.fn(async () => ({
    status: 'success',
    ok: true,
    output_file: 'output.md',
    summary: 'done',
    handoff_notes: 'clean run',
    output_content: '# hi',
    outputPath: 'output.md',
    modelKey: 'openai/gpt-4o-mini',
    role: 'content_writer',
    attempts: 1,
  })),
  runBatchWorker: vi.fn(async () => ({
    status: 'success',
    ok: true,
    summary: 'Batch: 2 succeeded, 0 partial, 0 failed, 0 cancelled (2 total)',
    handoff_notes: '',
    modelKey: 'openai/gpt-4o-mini',
    role: 'content_writer',
    attempts: 1,
    batch: [
      {
        status: 'success',
        ok: true,
        output_file: 'a.md',
        summary: 'item 0 done',
        handoff_notes: '',
        output_content: '# A',
        modelKey: 'openai/gpt-4o-mini',
        role: 'content_writer',
        attempts: 1,
      },
      {
        status: 'success',
        ok: true,
        output_file: 'b.md',
        summary: 'item 1 done',
        handoff_notes: '',
        output_content: '# B',
        modelKey: 'openai/gpt-4o-mini',
        role: 'frontend_coder',
        attempts: 1,
      },
    ],
    batchSummary: { total: 2, succeeded: 2, failed: 0, partial: 0, cancelled: 0 },
  })),
}));

import { runWorker, runBatchWorker } from '@/entrypoints/background/agent/worker-runner';
import { vfs } from '@/lib/persistence/vfs';
import { REVIEWER_HANDOFF_SCHEMA } from '@/lib/agent/schema-validate';

// 真实格式的 UUID sessionId —— `lib/utils.ts` 的 `isValidSessionId` 强制
// UUID v4 形态，`'session-test-1'` 会被 `path-safety.sessionRoot` 直接抛
// `VfsScopeError('Invalid sessionId...')` 然后被 tool 翻成「outside the
// session workspace」错误，让 path-gate 测例假阳性。必须用合规 UUID。
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const MAIN_MODEL = { provider: 'anthropic', modelId: 'claude-opus-5' } as const;

describe('createDelegateTaskTool — delegate_task 工具', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认让 `vfs.access` 假装成功 —— 调用 `input_files: [...]` 的测试期望
    // 文件存在；个别测试（如「越界时不调 IO」）通过 `mockImplementationOnce`
    // 或 spy 自行覆盖。
    vi.spyOn(vfs, 'access').mockResolvedValue(undefined);
  });

  const tool = createDelegateTaskTool({ sessionId: SESSION_ID });

  it('tool 名是 TOOL_DELEGATE_TASK 且 schema 暴露 4 个 role literal', () => {
    expect(tool.name).toBe(TOOL_DELEGATE_TASK);
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props.role).toBeDefined();
    // Encode the role schema to JSON to verify the 4 literal members show up —
    // TypeBox Type.Union emits { oneOf: [...] } or { anyOf: [...] } depending
    // on version; we just confirm the literals are present somewhere.
    const roleJson = JSON.stringify(props.role);
    for (const literal of ['content_writer', 'frontend_coder', 'reviewer', 'researcher']) {
      expect(roleJson).toContain(literal);
    }
  });

  it('空 task 直接返回 text error，不调 runner', async () => {
    const result = await tool.execute('call-1', { task: '   ', role: 'content_writer' } as never, undefined);
    expect(result.details).toEqual({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('`task` is required');
    }
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('output_path 越界返回 text error，不调 runner', async () => {
    const result = await tool.execute('call-2', {
      task: 'do thing',
      role: 'content_writer',
      output_path: '../escapee.md',
    } as never, undefined);
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('outside the session workspace');
    }
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('skills 名字非法返回 text error，不调 runner', async () => {
    const result = await tool.execute('call-3', {
      task: 'do thing',
      role: 'content_writer',
      skills: ['../../../etc/passwd'],
    } as never, undefined);
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('skill name');
      expect(result.content[0].text).toContain('invalid');
    }
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('model_override JSON 非法返回 text error，不调 runner', async () => {
    const result = await tool.execute('call-4', {
      task: 'do thing',
      role: 'content_writer',
      model_override: 'not-json',
    } as never, undefined);
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('model_override');
    }
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('成功 handoff 包含 status / output_file / summary / annotation + 模型+role', async () => {
    const result = await tool.execute('call-5', {
      task: 'write a poem',
      role: 'content_writer',
      output_path: 'poem.md',
    } as never, undefined);
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('"status":"success"');
    expect(text).toContain('"output_file":"output.md"');
    expect(text).toContain('via worker');
    expect(text).toContain('role=content_writer');
    expect(text).toContain('openai/gpt-4o-mini');
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it('runner-level 失败（ok=false）返回 modelKey+error 文本', async () => {
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'failed',
      ok: false,
      error: 'model not configured',
      modelKey: '',
      role: 'content_writer',
      summary: '',
      handoff_notes: '',
    });
    const result = await tool.execute('call-6', {
      task: 'do thing',
      role: 'content_writer',
    } as never, undefined);
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Worker sub-agent failed');
    expect(text).toContain('model not configured');
  });

  it('worker-level failed status 仍返回 handoff JSON + annotation', async () => {
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'failed',
      ok: true,
      error: 'JSON schema mismatch',
      summary: 'output did not match schema',
      handoff_notes: 'missing required field: summary',
      modelKey: 'openai/gpt-4o-mini',
      role: 'content_writer',
      attempts: 2,
    });
    const result = await tool.execute('call-7', {
      task: 'do thing',
      role: 'content_writer',
    } as never, undefined);
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('"status":"failed"');
    expect(text).toContain('attempts=2');
  });

  it('model_override 合法 JSON 会被 parse 后传给 runner', async () => {
    await tool.execute('call-8', {
      task: 'do thing',
      role: 'content_writer',
      model_override: JSON.stringify({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' }),
    } as never, undefined);
    const lastCall = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(lastCall.modelOverride).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' });
  });

  it('skills / input_files / anti_patterns / expected_schema 都会透传给 runner，路径 resolve 为绝对', async () => {
    // 关键：relative path 'a.md' / 'b.md' 必须被 tool layer 解析成
    // `/workspaces/<sessionId>/...` 绝对路径再传给 runner —— worker
    // 没有 session context，不 resolve 就只能猜根目录写到 `/content.json`
    // （E2E 实测 bug）。asserts use the real sessionId used by the tool.
    const toolWithMainModel = createDelegateTaskTool({
      sessionId: SESSION_ID,
      getMainModel: () => MAIN_MODEL,
    });
    const absoluteInput = `/workspaces/${SESSION_ID}/a.md`;
    const absoluteOutput = `/workspaces/${SESSION_ID}/b.md`;
    await toolWithMainModel.execute('call-9', {
      task: 'do thing',
      role: 'content_writer',
      input_files: ['a.md'],
      output_path: 'b.md',
      expected_schema: '{"type":"object"}',
      skills: ['races-template'],
      anti_patterns: ['Do not fabricate quotes'],
    } as never, undefined);
    const call = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(call.inputFiles).toEqual([absoluteInput]);
    expect(call.outputPath).toBe(absoluteOutput);
    expect(call.expectedSchema).toBe('{"type":"object"}');
    expect(call.skills).toEqual(['races-template']);
    expect(call.antiPatterns).toEqual(['Do not fabricate quotes']);
    expect(call.enableRetry).toBe(true);
    expect(call.sessionId).toBe(SESSION_ID);
    expect(call.mainModel).toEqual(MAIN_MODEL);
  });

  it('input_files 已是 session 根下的绝对路径 → 幂等不双 prefix', async () => {
    // E2E bug fix：tool layer 已经在执行 resolve，但若 caller 直接传绝对
    // 路径（已被前一层 resolve 过），不能再次 prefix 成
    // `/workspaces/<id>/workspaces/<id>/a.md`。
    const absoluteInput = `/workspaces/${SESSION_ID}/a.md`;
    await tool.execute('call-10', {
      task: 'do thing',
      role: 'content_writer',
      input_files: [absoluteInput],
    } as never, undefined);
    const call = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(call.inputFiles).toEqual([absoluteInput]);
    // 关键负向断言：不能被双 prefix
    expect(call.inputFiles[0]).not.toBe(`/workspaces/${SESSION_ID}/workspaces/${SESSION_ID}/a.md`);
  });
});

// ─── Subtask 1.2: batch dispatch (`tasks: [...]`) ───────────────────────────
//
// 新 schema 字段 `tasks: Type.Array(DelegateTaskItem, {minItems:1, maxItems:4})`
// + `renderBatchToolResult` + 互斥校验 + per-item path-safety gate。`runBatchWorker`
// 被 vi.mock 接管（顶部的 stub 模拟「2 个 item 全 success」场景）。

describe('Subtask 1.2 — delegate_task batch dispatch', () => {
  // 每个 `it` 自己起一份 fresh tool + reset mocks，避免共享 describe scope
  // 的 `tool` 常量 + mock call history 跨 test 泄漏。
  // `mockReset` 比 `clearAllMocks` 更彻底 —— 既清 call history 也重置 mock
  // implementation（虽然这里 mock 不带 implementation），防止 `runWorker` /
  // `runBatchWorker` 跨 test 累加调用次数。
  const batchTool = createDelegateTaskTool({ sessionId: SESSION_ID });
  beforeEach(() => {
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    // Re-apply stub behavior after reset
    (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'success',
      ok: true,
      summary: 'Batch: 2 succeeded, 0 partial, 0 failed, 0 cancelled (2 total)',
      handoff_notes: '',
      modelKey: 'openai/gpt-4o-mini',
      role: 'content_writer',
      attempts: 1,
      batch: [
        {
          status: 'success',
          ok: true,
          output_file: 'a.md',
          summary: 'item 0 done',
          handoff_notes: '',
          output_content: '# A',
          modelKey: 'openai/gpt-4o-mini',
          role: 'content_writer',
          attempts: 1,
        },
        {
          status: 'success',
          ok: true,
          output_file: 'b.md',
          summary: 'item 1 done',
          handoff_notes: '',
          output_content: '# B',
          modelKey: 'openai/gpt-4o-mini',
          role: 'frontend_coder',
          attempts: 1,
        },
      ],
      batchSummary: { total: 2, succeeded: 2, failed: 0, partial: 0, cancelled: 0 },
    });
    // item 5 (review finding #5): explicitly re-declare vfs.access spy to make
    // this describe block self-contained — outer describe's beforeEach still
    // installs it, but if a future refactor moves the spy, batch tests would
    // fail with cryptic "File not found" instead of being obviously missing.
    vi.spyOn(vfs, 'access').mockResolvedValue(undefined);
  });

  it('valid 2-item batch → runBatchWorker 被调 1 次，resolvedItems 路径正确', async () => {
    const result = await batchTool.execute('call-batch-1', {
      tasks: [
        { task: 'write a.md', role: 'content_writer', output_path: 'a.md' },
        { task: 'write b.md', role: 'frontend_coder', output_path: 'b.md' },
      ],
    } as never, undefined);
    expect(runBatchWorker).toHaveBeenCalledTimes(1);
    expect(runWorker).not.toHaveBeenCalled();
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('[batch]');
      expect(result.content[0].text).toContain('[item 0]');
      expect(result.content[0].text).toContain('[item 1]');
      expect(result.content[0].text).toContain('role=content_writer');
      expect(result.content[0].text).toContain('role=frontend_coder');
    }
  });

  it('互斥：tasks 同时带 top-level task 或 role → text error，不调任何 runner', async () => {
    const result = await batchTool.execute('call-batch-2', {
      task: 'leftover top-level',
      role: 'content_writer',
      tasks: [
        { task: 'x', role: 'frontend_coder' },
      ],
    } as never, undefined);
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('mutually exclusive');
    }
    expect(runBatchWorker).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('size cap 守门在 typebox schema 层（提供 5 个 task → pi-agent-core 拦在 schema 校验阶段）', () => {
    // schema maxItems 是主路径（pi-agent-core execute() 前跑 validateToolArguments）；
    // execute() 里另有一条 runtime belt 兜不吃 schema enforcement 的 provider
    //（见 delegate-task.ts 的 MAX_BATCH_ITEMS 注释 + 文件末 worker-team guards 用例）。
    const schema = batchTool.parameters;
    const json = JSON.stringify(schema);
    expect(json).toContain('"maxItems":4');
    expect(json).toContain('"minItems":1');
  });

  it('items 内 path-safety 失败（output_path 越界）→ 整批 fail-fast，不调 runBatchWorker', async () => {
    // 单 item 越界 → resolveBatchItem 返回 { error } → tool 立即 return，
    // runBatchWorker 完全没机会跑。比 top-level 路径更严：不让 runner 空转
    // 一次才发现第一个 item 就有问题。
    const result = await batchTool.execute('call-batch-3', {
      tasks: [
        { task: 'safe', role: 'content_writer', output_path: 'safe.md' },
        { task: 'evil', role: 'content_writer', output_path: '../escape.md' },
      ],
    } as never, undefined);
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('tasks[1].output_path');
      expect(result.content[0].text).toContain('outside the session workspace');
    }
    expect(runBatchWorker).not.toHaveBeenCalled();
  });

  it('item skill 名字非法 → 整批 fail-fast', async () => {
    const result = await batchTool.execute('call-batch-4', {
      tasks: [
        { task: 'x', role: 'content_writer', skills: ['../../../etc/passwd'] },
      ],
    } as never, undefined);
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('tasks[0].skills');
    }
    expect(runBatchWorker).not.toHaveBeenCalled();
  });

  it('item model_override 非法 → 整批 fail-fast', async () => {
    const result = await batchTool.execute('call-batch-5', {
      tasks: [
        { task: 'x', role: 'content_writer', model_override: 'not-json' },
      ],
    } as never, undefined);
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('tasks[0].model_override');
    }
    expect(runBatchWorker).not.toHaveBeenCalled();
  });

  it('合法 model_override JSON 解析后透传到 runBatchWorker', async () => {
    await batchTool.execute('call-batch-6', {
      tasks: [
        {
          task: 'x',
          role: 'content_writer',
          model_override: JSON.stringify({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' }),
        },
      ],
    } as never, undefined);
    const call = (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(call.tasks[0].modelOverride).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('batch path 把主会话模型透传给 runBatchWorker，供 role 未配置时兜底', async () => {
    const toolWithMainModel = createDelegateTaskTool({
      sessionId: SESSION_ID,
      getMainModel: () => MAIN_MODEL,
    });
    await toolWithMainModel.execute('call-batch-main-model', {
      tasks: [
        { task: 'write a.md', role: 'content_writer', output_path: 'a.md' },
      ],
    } as never, undefined);
    const call = (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(call.mainModel).toEqual(MAIN_MODEL);
  });

  it('relative output_path / input_files resolve 成绝对路径再传给 runBatchWorker', async () => {
    // E2E bug fix：worker 不知道 sessionId → 必须给绝对路径。batch item
    // 同样走 resolveSessionPath（top-level path 的镜像）。
    await batchTool.execute('call-batch-7', {
      tasks: [
        {
          task: 'x',
          role: 'content_writer',
          output_path: 'a.md',
          input_files: ['b.md'],
        },
      ],
    } as never, undefined);
    const call = (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(call.tasks[0].outputPath).toBe(`/workspaces/${SESSION_ID}/a.md`);
    expect(call.tasks[0].inputFiles).toEqual([`/workspaces/${SESSION_ID}/b.md`]);
  });

  it('batch mode 完全不调 runWorker（防御 regression：互斥分支独立）', async () => {
    // top-level path 用 `runWorker`，batch 用 `runBatchWorker`；绝不能让 batch
    // 误调 `runWorker`（一个 item）或让 runWorker 在 batch 模式下被触达。
    await batchTool.execute('call-batch-8', {
      tasks: [
        { task: 'a', role: 'content_writer' },
        { task: 'b', role: 'frontend_coder' },
      ],
    } as never, undefined);
    expect(runBatchWorker).toHaveBeenCalledTimes(1);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('renderBatchToolResult 输出含 [batch] / [batch-summary] / [item N] / annotation', async () => {
    // 验证文本格式契约 —— UI 后续要用这套 prefix 解析（Subtask 1.3）。
    const result = await batchTool.execute('call-batch-9', {
      tasks: [
        { task: 'a', role: 'content_writer', output_path: 'a.md' },
        { task: 'b', role: 'frontend_coder', output_path: 'b.md' },
      ],
    } as never, undefined);
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('[batch]');
    expect(text).toContain('[batch-summary]');
    expect(text).toContain('total=2');
    expect(text).toContain('succeeded=2');
    expect(text).toContain('[item 0]');
    expect(text).toContain('[item 1]');
    expect(text).toContain('via batch worker');
  });

  // ─── Review findings 1, 2, 4, 6 增量测试 ──────────────────────────────

  it('expected_schema / skills / anti_patterns 都会透传给 runBatchWorker（review #1）', async () => {
    // Mirror top-level path 测 (line 209-234)，保证 batch 路径不丢字段。
    await batchTool.execute('call-batch-r1', {
      tasks: [
        {
          task: 'x',
          role: 'content_writer',
          expected_schema: '{"type":"object"}',
          skills: ['races-template'],
          anti_patterns: ['Do not fabricate quotes'],
        },
      ],
    } as never, undefined);
    const call = (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(call.tasks[0].expectedSchema).toBe('{"type":"object"}');
    expect(call.tasks[0].skills).toEqual(['races-template']);
    expect(call.tasks[0].antiPatterns).toEqual(['Do not fabricate quotes']);
  });

  it('input_files 已是绝对路径 → 幂等不双 prefix（review #2: E2E bug 防回归）', async () => {
    // Top-level path 有这个测 (line 236-250)；batch 路径同样走 resolveSessionPath，
    // 必须保幂等。
    const absoluteInput = `/workspaces/${SESSION_ID}/b.md`;
    await batchTool.execute('call-batch-r2', {
      tasks: [
        { task: 'x', role: 'content_writer', input_files: [absoluteInput] },
      ],
    } as never, undefined);
    const call = (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(call.tasks[0].inputFiles).toEqual([absoluteInput]);
    expect(call.tasks[0].inputFiles[0]).not.toBe(
      `/workspaces/${SESSION_ID}/workspaces/${SESSION_ID}/b.md`,
    );
  });

  it('size cap 真正被 typebox 拒：5 个 item 数组 → schema 校验失败（review #4）', async () => {
    // 直接用 Value.Check 验证 schema 真的 enforce maxItems；之前的 JSON 嗅
    // 探测只能确认字符串里有 maxItems 字面量，无法验约束生效。
    const { Value } = await import('typebox/value');
    // 5 个 item 应被拒（maxItems: 4）
    const five = {
      tasks: Array.from({ length: 5 }, (_, i) => ({
        task: `t${i}`,
        role: 'content_writer' as const,
      })),
    };
    expect(Value.Check(batchTool.parameters, five)).toBe(false);
    // 1 个 item（合法 baseline）
    const one = {
      tasks: [{ task: 't', role: 'content_writer' as const }],
    };
    expect(Value.Check(batchTool.parameters, one)).toBe(true);
  });

  it('deadlock 防回归：仅 tasks: [...] 也应 schema-valid（manual test deadlock fix）', async () => {
    // 之前 DelegateTaskParameters top-level 把 task / role 标 required，
    // LLM 调 batch 时被 schema 拦在门外；如果 LLM 加上 task/role 凑齐
    // required，handler 又抛 mutually exclusive —— 死锁：LLM 没法表达
    // batch intent。修复：schema 把 task/role 降到 Optional，互斥由
    // handler mutual-exclusion 分支校验。这里 pin 死 schema 放宽。
    const { Value } = await import('typebox/value');
    // 只传 tasks，不传 top-level task/role —— schema 必须接受
    const batchOnly = {
      tasks: [
        { task: 'a', role: 'content_writer' as const },
        { task: 'b', role: 'reviewer' as const },
      ],
    };
    expect(Value.Check(batchTool.parameters, batchOnly)).toBe(true);
    // 反向：空对象（既无 task/role 也无 tasks）也 schema-valid，错误由
    // handler mutual-exclusion 收尾
    expect(Value.Check(batchTool.parameters, {})).toBe(true);
    // 单 task 路径仍接受 task + role —— 向后兼容
    const single = { task: 't', role: 'content_writer' as const };
    expect(Value.Check(batchTool.parameters, single)).toBe(true);
  });

  it('handler 在 single-task 路径拒 missing/empty role（schema 放宽后的兜底）', async () => {
    // Schema 把 role 降到 Optional 之后，single-task 路径必须在 handler
    // 显式校验 role 是否在 4 literal union —— 否则 runner 拿到 undefined
    // 会 panic。`role: 'undefined' as never` 模拟 LLM 漏传或 typo。
    const result = await batchTool.execute('call-no-role', {
      task: 'do something',
      // 故意省略 role
    } as never, undefined);
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toMatch(/role.*required/);
  });

  it('per-item output_content 在 renderBatchToolResult 里被渲染为 labeled chunk（review #6）', async () => {
    // batch renderer 有 if (item.output_content) 块 + `--- output_content (${label}) ---`
    // 分隔符；这是 Subtask 1.3 UI 解析的关键格式契约。当前测试只断言
    // summary / batch-summary prefix；这条把 output_content 渲染分支钉死。
    const result = await batchTool.execute('call-batch-r6', {
      tasks: [{ task: 'a', role: 'content_writer', output_path: 'a.md' }],
    } as never, undefined);
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    // mock stub 给 item 0 设了 output_content: '# A'
    expect(text).toContain('--- output_content');
    expect(text).toContain('a.md');
    expect(text).toContain('# A');
  });

  // Subtask 1.4: PREAMBLE + schema doc 双层 defense-in-depth —— tool
  // schema description 里也要带 batch 入口 + 上限 + 独立约束 + 互斥契约。
  // Subtask 8.9 已经在 PREAMBLE / role.description 里放过 Fast Lane rule；
  // 这条测试把 `tasks` 参数 description 也钉死，避免下次精简 description
  // 时悄悄删掉关键条款导致 LLM 看不到 batch 入口 / 把依赖链塞进 batch。
  it('tool schema description 把 batch 入口 + 独立约束 + 互斥契约写进 description', () => {
    // `tasks` 参数的 description 在 DelegateTaskParameters 里；
    // 抽出字段 props 检查 substring（避免依赖完整 schema dump）
    const schema = batchTool.parameters as unknown as {
      properties: Record<string, { description?: string }>;
    };
    const tasksDesc = schema.properties?.tasks?.description;
    expect(tasksDesc, '`tasks` parameter description missing').toBeTruthy();
    // 关键契约 substring —— 这些字面量被 LLM 在 tool 选定前看到一次，
    // 是 defense-in-depth 的第二层（第一层是 PREAMBLE）
    expect(tasksDesc).toContain('Up to 4');
    expect(tasksDesc).toContain('INDEPENDENT');
    expect(tasksDesc).toContain('Promise.allSettled');
    // 反例：依赖链 —— content_writer → frontend_coder reads content.json
    expect(tasksDesc).toMatch(/frontend_coder reads content\.json/);
    // 互斥契约：tasks 与 top-level task/role 不能混用
    expect(tasksDesc).toMatch(/Mutually exclusive/i);
  });

  // Subtask 1.3 deadlock fix 的 schema 层 pin：top-level `task` / `role`
  // 都是 Optional —— batch-only call 必须 schema-valid。这是上一条
  // 「description pin」对应的 schema-shape pin，两条一起锁死 schema
  // 放宽契约（不再回到 required 死锁）。
  it('schema shape: top-level task / role 都是 Optional（batch 入口不被 schema 拦）', () => {
    const schema = batchTool.parameters as unknown as {
      required?: readonly string[];
      properties: Record<string, { type?: string }>;
    };
    // 用 default-empty 而不是 if-defined —— 防止 TypeBox 当前 undefined
    // required 的行为哪天变成 `required: []` 时整段 assert 被静默跳过
    // （CLAUDE.md 反复警告「test give zero signal」是 silent regression
    // 最危险形态）。
    const required = schema.required ?? [];
    expect(required, 'top-level `task` is back in schema.required').not.toContain('task');
    expect(required, 'top-level `role` is back in schema.required').not.toContain('role');
    // properties 层面：task / role 仍存在（schema 没漏字段），type 是 string
    expect(schema.properties.task).toBeDefined();
    expect(schema.properties.role).toBeDefined();
  });
});

// ─── Subtask 2.2: reviewer auto-schema inject ───────────────────────────────
//
// Reviewer 角色当 caller 不传 `expected_schema` 时，tool 层自动注入
// `REVIEWER_HANDOFF_SCHEMA`（让 reviewer 第二轮 retry 按 15 条 checklist 重
// emit）。Caller 显式传 → 用 caller 的（不覆盖）。
//
// 这里只测「auto-inject 开关」语义：调用 runWorker 时拿到什么 `expectedSchema`
// 参数。Schema 本身的形状/校验走 `schema-validate.test.ts`，不在这里重复。

describe('Subtask 2.2 — reviewer auto-schema inject (delegate_task tool layer)', () => {
  const reviewTool = createDelegateTaskTool({ sessionId: SESSION_ID });
  const REVIEWER_SCHEMA_JSON = JSON.stringify(REVIEWER_HANDOFF_SCHEMA);

  beforeEach(() => {
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    // Re-apply stub：reviewer handoff 不强制跑通，stub 返 success 即可。
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'success',
      ok: true,
      output_file: null,
      summary: 'audit done',
      handoff_notes: '',
      checklist: [{ item: 'no-localstorage', status: 'pass', evidence: 'ok' }],
      modelKey: 'openai/gpt-4o-mini',
      role: 'reviewer',
      attempts: 1,
    });
    vi.spyOn(vfs, 'access').mockResolvedValue(undefined);
  });

  it('role=reviewer + 无 expected_schema → runner 收到 REVIEWER_HANDOFF_SCHEMA', async () => {
    // 关键 case：caller 完全不传 expected_schema —— tool 必须自动注入，
    // 否则 reviewer 不会走 schema fail-retry。
    await reviewTool.execute(
      'call-2.2-1',
      {
        task: 'audit studio.html',
        role: 'reviewer',
        input_files: ['studio.html'],
      } as never,
      undefined,
    );
    expect(runWorker).toHaveBeenCalledTimes(1);
    const callArgs = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.expectedSchema).toBe(REVIEWER_SCHEMA_JSON);
  });

  it('role=reviewer + caller 自传 expected_schema → runner 用 caller 的（不覆盖）', async () => {
    // Caller 自传 schema 必须原样透传 —— auto-inject 只在 caller 没传时兜底。
    const customSchema = JSON.stringify({
      type: 'object',
      required: ['status', 'summary'],
      properties: { status: { enum: ['success', 'failed'] }, summary: { type: 'string' } },
    });
    await reviewTool.execute(
      'call-2.2-2',
      {
        task: 'audit studio.html',
        role: 'reviewer',
        input_files: ['studio.html'],
        expected_schema: customSchema,
      } as never,
      undefined,
    );
    expect(runWorker).toHaveBeenCalledTimes(1);
    const callArgs = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.expectedSchema).toBe(customSchema);
    expect(callArgs.expectedSchema).not.toBe(REVIEWER_SCHEMA_JSON);
  });

  it('role=content_writer + 无 expected_schema → runner 收到 undefined（auto-inject 仅 reviewer）', async () => {
    // content_writer / frontend_coder / researcher 都没自动 schema —— 三个
    // role 的 handoff 是自由 prose，不需要结构化。
    await reviewTool.execute(
      'call-2.2-3',
      {
        task: 'write a poem',
        role: 'content_writer',
      } as never,
      undefined,
    );
    expect(runWorker).toHaveBeenCalledTimes(1);
    const callArgs = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.expectedSchema).toBeUndefined();
  });

  it('top-level tool schema 描述里提了 reviewer auto-schema 提示', () => {
    // Caller 看到 schema description 时应知道 reviewer 有 auto-inject —— 不
    // 然 caller 不知道「不传 expected_schema 也能拿到结构化 checklist」。
    const schema = reviewTool.parameters as { properties: Record<string, { description?: string }> };
    const desc = schema.properties.expected_schema?.description ?? '';
    expect(desc).toMatch(/reviewer/i);
    expect(desc).toMatch(/auto-?inject/i);
    expect(desc).toMatch(/REVIEWER_HANDOFF_SCHEMA/);
  });

  // ── Subtask 2.2 code-review fixes (Finding #8) ──────────────────
  it('expected_schema = "" (空串) → 按 undefined 处理，不调 caller-supplied 路径', async () => {
    // 关键 case：call site 可能把 setting 默认值 '' 透传过来。空串 → 让
    // parseExpectedSchema 抛「not valid JSON」runner error 是 UX 灾难，
    // 等同没传即可。这里测 empty-string 兜底：runner 拿到 REVIEWER_HANDOFF_SCHEMA
    // （auto-inject），而不是空串。
    await reviewTool.execute(
      'call-2.2-empty',
      {
        task: 'audit',
        role: 'reviewer',
        expected_schema: '   ',
      } as never,
      undefined,
    );
    expect(runWorker).toHaveBeenCalledTimes(1);
    const callArgs = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.expectedSchema).toBe(REVIEWER_SCHEMA_JSON);
  });

  it('expected_schema = "  " (whitespace only) → 按 undefined 处理', async () => {
    await reviewTool.execute(
      'call-2.2-ws',
      {
        task: 'audit',
        role: 'reviewer',
        expected_schema: '  ',
      } as never,
      undefined,
    );
    expect(runWorker).toHaveBeenCalledTimes(1);
    const callArgs = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.expectedSchema).toBe(REVIEWER_SCHEMA_JSON);
  });
});

// ─── Subtask 2.2 code-review Finding #3+#6: checklist_summary surfaces ──────
//
// `summarizeHandoffJson` 和 `renderBatchToolResult` 现在挂 `checklist_summary:
// {pass, warn, fail}` 让主代理 LLM 一眼看出 reviewer audit 的 fail/warn 计数。
// 测试用 vi.mock('@/entrypoints/background/agent/worker-runner') 已经 stub
// 了一个固定 handoff —— 改用 mockResolvedValueOnce 让每个测试自定义 handoff
// 形状，再断言 tool result text 含 `checklist_summary: pass=X warn=Y fail=Z`。
//
// 这里测的是 text-rendering 函数本身；mock 拿到什么 handoff → render 出什么
// string。`summarizeHandoffJson` 是 file-local（无 export），通过 mock
// `runWorker` 把 handoff 喂进 tool，再断言 result.content[0].text。

describe('Subtask 2.2 — checklist_summary surfaced to main agent (single-task)', () => {
  const summaryTool = createDelegateTaskTool({ sessionId: SESSION_ID });

  beforeEach(() => {
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    vi.spyOn(vfs, 'access').mockResolvedValue(undefined);
  });

  it('reviewer handoff 带 checklist (2 fail + 1 warn + 1 pass) → tool text 含 checklist_summary', async () => {
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'success',
      ok: true,
      output_file: null,
      summary: 'Audit done',
      handoff_notes: '',
      checklist: [
        { item: 'no-localstorage', status: 'fail', evidence: 'line 42' },
        { item: 'overflow-x-auto', status: 'fail', evidence: 'wide table' },
        { item: 'no-indexeddb', status: 'warn', evidence: 'indexedDB.open' },
        { item: 'title-present', status: 'pass', evidence: 'ok' },
      ],
      modelKey: 'openai/gpt-4o-mini',
      role: 'reviewer',
      attempts: 1,
    });
    const result = await summaryTool.execute(
      'call-2.2-sum-1',
      {
        task: 'audit',
        role: 'reviewer',
      } as never,
      undefined,
    );
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toMatch(/"checklist_summary":\{"pass":1,"warn":1,"fail":2\}/);
  });

  it('non-reviewer handoff 无 checklist → tool text 不含 checklist_summary', async () => {
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'success',
      ok: true,
      output_file: 'poem.md',
      summary: 'done',
      handoff_notes: '',
      modelKey: 'openai/gpt-4o-mini',
      role: 'content_writer',
      attempts: 1,
    });
    const result = await summaryTool.execute(
      'call-2.2-sum-2',
      {
        task: 'write poem',
        role: 'content_writer',
      } as never,
      undefined,
    );
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).not.toMatch(/checklist_summary/);
  });

  it('reviewer handoff 带空 checklist 数组 → tool text 不含 checklist_summary', async () => {
    // 空 array → 不挂字段（minItems gate）。tool text 不应该出现计数行。
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'success',
      ok: true,
      output_file: null,
      summary: 'Audit done',
      handoff_notes: '',
      checklist: [],
      modelKey: 'openai/gpt-4o-mini',
      role: 'reviewer',
      attempts: 1,
    });
    const result = await summaryTool.execute(
      'call-2.2-sum-3',
      {
        task: 'audit',
        role: 'reviewer',
      } as never,
      undefined,
    );
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).not.toMatch(/checklist_summary/);
  });
});

describe('Subtask 2.2 — checklist_summary surfaced to main agent (batch per-item)', () => {
  const summaryBatchTool = createDelegateTaskTool({ sessionId: SESSION_ID });

  beforeEach(() => {
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    vi.spyOn(vfs, 'access').mockResolvedValue(undefined);
  });

  it('batch reviewer item 带 checklist → batch text 含 per-item checklist_summary', async () => {
    (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'success',
      ok: true,
      summary: 'Batch: 1 succeeded',
      handoff_notes: '',
      modelKey: 'openai/gpt-4o-mini',
      role: 'reviewer',
      attempts: 1,
      batch: [
        {
          status: 'success',
          ok: true,
          output_file: null,
          summary: 'audit done',
          handoff_notes: '',
          checklist: [
            { item: 'no-localstorage', status: 'fail', evidence: 'line 42' },
            { item: 'title-present', status: 'pass', evidence: 'ok' },
          ],
          modelKey: 'openai/gpt-4o-mini',
          role: 'reviewer',
          attempts: 1,
        },
      ],
      batchSummary: { total: 1, succeeded: 1, failed: 0, partial: 0, cancelled: 0 },
    });
    const result = await summaryBatchTool.execute(
      'call-2.2-bsum-1',
      {
        tasks: [{ task: 'audit', role: 'reviewer' as const }],
      } as never,
      undefined,
    );
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toMatch(/checklist_summary: pass=1 warn=0 fail=1/);
  });

  it('batch non-reviewer item → batch text 不含 checklist_summary', async () => {
    (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'success',
      ok: true,
      summary: 'Batch: 1 succeeded',
      handoff_notes: '',
      modelKey: 'openai/gpt-4o-mini',
      role: 'content_writer',
      attempts: 1,
      batch: [
        {
          status: 'success',
          ok: true,
          output_file: 'a.md',
          summary: 'done',
          handoff_notes: '',
          modelKey: 'openai/gpt-4o-mini',
          role: 'content_writer',
          attempts: 1,
        },
      ],
      batchSummary: { total: 1, succeeded: 1, failed: 0, partial: 0, cancelled: 0 },
    });
    const result = await summaryBatchTool.execute(
      'call-2.2-bsum-2',
      {
        tasks: [{ task: 'write', role: 'content_writer' as const, output_path: 'a.md' }],
      } as never,
      undefined,
    );
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).not.toMatch(/checklist_summary/);
  });
});

describe('Subtask 2.2 — reviewer auto-schema inject (batch per-item path)', () => {
  // batch path 的 per-item resolver 复用同一个 `defaultExpectedSchemaForRole`
  // helper。这里验证 batch reviewer item 同样收到 auto-inject。
  const batchTool2 = createDelegateTaskTool({ sessionId: SESSION_ID });
  const REVIEWER_SCHEMA_JSON = JSON.stringify(REVIEWER_HANDOFF_SCHEMA);

  beforeEach(() => {
    (runWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mockReset();
    (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'success',
      ok: true,
      summary: 'Batch: 2 succeeded',
      handoff_notes: '',
      modelKey: 'openai/gpt-4o-mini',
      role: 'reviewer',
      attempts: 1,
      batch: [
        {
          status: 'success',
          ok: true,
          output_file: null,
          summary: 'item 0 done',
          handoff_notes: '',
          checklist: [{ item: 'no-localstorage', status: 'pass', evidence: 'ok' }],
          modelKey: 'openai/gpt-4o-mini',
          role: 'reviewer',
          attempts: 1,
        },
        {
          status: 'success',
          ok: true,
          output_file: null,
          summary: 'item 1 done',
          handoff_notes: '',
          checklist: [{ item: 'no-localstorage', status: 'pass', evidence: 'ok' }],
          modelKey: 'openai/gpt-4o-mini',
          role: 'reviewer',
          attempts: 1,
        },
      ],
      batchSummary: { total: 2, succeeded: 2, failed: 0, partial: 0, cancelled: 0 },
    });
    vi.spyOn(vfs, 'access').mockResolvedValue(undefined);
  });

  it('batch 中 reviewer item 无 expected_schema → 每 item 收到 REVIEWER_HANDOFF_SCHEMA', async () => {
    await batchTool2.execute(
      'call-2.2-batch-1',
      {
        tasks: [
          { task: 'audit A', role: 'reviewer' as const, input_files: ['a.html'] },
          { task: 'audit B', role: 'reviewer' as const, input_files: ['b.html'] },
        ],
      } as never,
      undefined,
    );
    expect(runBatchWorker).toHaveBeenCalledTimes(1);
    const callArgs = (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const items = callArgs.tasks as Array<{ expectedSchema?: string }>;
    expect(items).toHaveLength(2);
    expect(items[0].expectedSchema).toBe(REVIEWER_SCHEMA_JSON);
    expect(items[1].expectedSchema).toBe(REVIEWER_SCHEMA_JSON);
  });

  it('batch 中 reviewer item 自传 expected_schema → 用 caller 的（不 auto-inject）', async () => {
    const customSchema = JSON.stringify({
      type: 'object',
      required: ['status', 'summary'],
    });
    await batchTool2.execute(
      'call-2.2-batch-2',
      {
        tasks: [
          { task: 'audit', role: 'reviewer' as const, expected_schema: customSchema },
        ],
      } as never,
      undefined,
    );
    expect(runBatchWorker).toHaveBeenCalledTimes(1);
    const callArgs = (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const items = callArgs.tasks as Array<{ expectedSchema?: string }>;
    expect(items[0].expectedSchema).toBe(customSchema);
  });

  it('batch 中 non-reviewer item → 不 auto-inject（content_writer 自由 prose）', async () => {
    await batchTool2.execute(
      'call-2.2-batch-3',
      {
        tasks: [
          { task: 'write poem', role: 'content_writer' as const, output_path: 'poem.md' },
        ],
      } as never,
      undefined,
    );
    expect(runBatchWorker).toHaveBeenCalledTimes(1);
    const callArgs = (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const items = callArgs.tasks as Array<{ expectedSchema?: string }>;
    expect(items[0].expectedSchema).toBeUndefined();
  });
});

// ─── worker-team guards: execute-time 开关复核 + batch 尺寸 belt ────────────
//
// 两条 belt 的共同合同：被拒时 **零 IO、零 worker**（runner mock 必须从未被
// 调用）。storage 走真 fakeBrowser（AGENTS.md：不 mock chrome.storage），
// 测毕 setValue(true) 恢复，避免污染后续读取。

describe('createDelegateTaskTool — worker-team guards', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // 显式前置条件：开关 belt 的放行依赖 Team=on；不依赖 fallback 默认值
    //（storage.ts 若改 fallback 本组用例也不受影响），也让 (b) 不隐含
    // 依赖 (a) 的 finally 恢复。
    await workerTeamEnabled.setValue(true);
  });

  const guardTool = createDelegateTaskTool({ sessionId: SESSION_ID });

  it('workerTeamEnabled=false → execute 抛错（is_error 进 LLM），worker 零启动', async () => {
    await workerTeamEnabled.setValue(false);
    await expect(
      guardTool.execute('call-off', { task: 'x', role: 'content_writer' } as never, undefined),
    ).rejects.toThrow(/worker team is (currently )?disabled \(Fast mode\)/i);
    expect(runWorker).not.toHaveBeenCalled();
    expect(runBatchWorker).not.toHaveBeenCalled();
  });

  it('batch tasks 超上限 → text error（与互斥错同族：形状错可拆参重发）', async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({
      task: `write one line to output/guard-${i}.md`,
      role: 'content_writer' as const,
    }));
    const result = await guardTool.execute('call-big', { tasks: five } as never, undefined);
    const first = result.content[0];
    expect(first.type).toBe('text');
    if (first.type === 'text') {
      expect(first.text).toContain('at most 4 items (got 5)');
    }
    expect(runBatchWorker).not.toHaveBeenCalled();
  });

  it('read-only role (reviewer) + output_path → runWorker 不拿 outputPath（掐掉 "success 但 output missing" retry 的触发器）', async () => {
    // 实测 bug（vilao-landing review）：coder 写 workspace 根，reviewer 的
    // handoff.output_file 填 `output/...` 前缀 → runner 的 declaredOutputPath
    // 校验文件不存在 → retry 一次 → 仍 fail。修法是 read-only role 不传 outputPath。
    await guardTool.execute('call-rev', {
      task: 'audit the html file',
      role: 'reviewer',
      output_path: 'output/x.html',
    } as never, undefined);
    const call = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.outputPath).toBeUndefined();
    // reviewer auto-schema 注入不受影响（与 outputPath 无关）。
    expect(call.expectedSchema).toBeDefined();
  });

  it('read-only role (researcher) + output_path → 同样不拿 outputPath（capability 派生，非按名硬编码）', async () => {
    // researcher 的 whitelist 没有 fs_create_file / fs_edit_file（registry 派生），
    // 与 reviewer 同族：output_file 是「被研究的文件」，不是它写的交付物。
    await guardTool.execute('call-res', {
      task: 'summarize content.json',
      role: 'researcher',
      output_path: 'output/outline.md',
    } as never, undefined);
    const call = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.outputPath).toBeUndefined();
  });

  it('batch item read-only role → runBatchWorker 的 item 也不带 outputPath', async () => {
    // resolveBatchItem 是第二个被改的 call-site（喂 runBatchWorker 的 items），
    // 单测必须覆盖到，否则 batch 半边静默回归。
    await guardTool.execute('call-batch-rev', {
      tasks: [
        { task: 'audit it', role: 'reviewer', output_path: 'output/y.html' },
        { task: 'write one line', role: 'content_writer', output_path: 'output/z.md' },
      ],
    } as never, undefined);
    const items = (runBatchWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].tasks;
    expect(items[0].outputPath).toBeUndefined();
    expect(items[1].outputPath).toContain('z.md');
  });

  it('content_writer + output_path → outputPath 照传（writer 仍受 output-missing 保护）', async () => {
    await guardTool.execute('call-cw', {
      task: 'write one line',
      role: 'content_writer',
      output_path: 'output/cw-guard.md',
    } as never, undefined);
    const call = (runWorker as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.outputPath).toContain('cw-guard.md');
  });
});
