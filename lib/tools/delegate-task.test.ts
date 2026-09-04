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
}));

import { runWorker } from '@/entrypoints/background/agent/worker-runner';
import { vfs } from '@/lib/persistence/vfs';

// 真实格式的 UUID sessionId —— `lib/utils.ts` 的 `isValidSessionId` 强制
// UUID v4 形态，`'session-test-1'` 会被 `path-safety.sessionRoot` 直接抛
// `VfsScopeError('Invalid sessionId...')` 然后被 tool 翻成「outside the
// session workspace」错误，让 path-gate 测例假阳性。必须用合规 UUID。
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

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
    const absoluteInput = `/workspaces/${SESSION_ID}/a.md`;
    const absoluteOutput = `/workspaces/${SESSION_ID}/b.md`;
    await tool.execute('call-9', {
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
    expect(call.mainModel).toBeNull();
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
