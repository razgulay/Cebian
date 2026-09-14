// Hard gate policy 的单元测试。Worker Team 关闭时一律放行；Team 开启时按
// 路径 + 内容拦截：HTML create 一律拦；HTML edit 仅在看起来是 full-document
// rewrite 时拦；非 HTML 路径不因内容 marker 而误判。

import { describe, it, expect } from 'vitest';
import {
  decideWorkerTeamRouting,
  HTML_REWRITE_MIN_CHARS,
  createWorkerTeamRoutingHook,
  type WorkerTeamRoutingDecision,
} from '@/lib/agent/worker-team-routing';
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';

function ctx(name: string, args: Record<string, unknown>): BeforeToolCallContext {
  return {
    toolCall: { type: 'toolCall', id: 'call-1', name, arguments: args },
    args,
    assistantMessage: { role: 'assistant', content: [] },
    context: { systemPrompt: '', messages: [], tools: [] },
  } as unknown as BeforeToolCallContext;
}

function allow(decision: WorkerTeamRoutingDecision): void {
  expect(decision.kind).toBe('allow');
}

describe('decideWorkerTeamRouting — Fast mode (Team OFF)', () => {
  it('Team OFF → fs_create_file .html 一律放行', () => {
    allow(decideWorkerTeamRouting(ctx('fs_create_file', { path: 'studio.html', content: 'x' }), false));
  });

  it('Team OFF → fs_edit_file 大 rewrite 也放行', () => {
    allow(
      decideWorkerTeamRouting(
        ctx('fs_edit_file', { path: 'studio.html', old_string: 'a', new_string: '<!doctype html>' + 'x'.repeat(HTML_REWRITE_MIN_CHARS + 50) + '</html>' }),
        false,
      ),
    );
  });
});

describe('decideWorkerTeamRouting — Team ON: fs_create_file', () => {
  it('Team ON + fs_create_file .html → 拦下，reason 提 delegate_task frontend_coder', () => {
    const decision = decideWorkerTeamRouting(
      ctx('fs_create_file', { path: 'studio.html', content: '...' }),
      true,
    );
    expect(decision.kind).toBe('block');
    if (decision.kind === 'block') {
      expect(decision.reason).toContain('Team mode blocks direct fs_create_file');
      expect(decision.reason).toContain('delegate_task');
      expect(decision.reason).toContain('role: "frontend_coder"');
      expect(decision.reason).toContain('studio.html');
      expect(decision.reason).toContain('Do NOT retry');
    }
  });

  it('Team ON + fs_create_file .htm → 同样拦下', () => {
    const decision = decideWorkerTeamRouting(
      ctx('fs_create_file', { path: 'page.htm', content: '...' }),
      true,
    );
    expect(decision.kind).toBe('block');
  });

  it('Team ON + fs_create_file README.md 含 <!doctype html> codeblock → 放行（不误判非 HTML 路径）', () => {
    const content =
      '# Demo\n\n```html\n<!doctype html><html><body>hello</body></html>\n```\n';
    allow(
      decideWorkerTeamRouting(ctx('fs_create_file', { path: 'README.md', content }), true),
    );
  });

  it('Team ON + fs_create_file tutorial.txt 含 html 示例 → 放行', () => {
    const content = 'HTML 示例：\n<!doctype html><html><body>x</body></html>';
    allow(
      decideWorkerTeamRouting(ctx('fs_create_file', { path: 'tutorial.txt', content }), true),
    );
  });

  it('Team ON + fs_create_file 路径大小写混合 → 仍识别 .HTML', () => {
    const decision = decideWorkerTeamRouting(
      ctx('fs_create_file', { path: 'Studio.HTML', content: '...' }),
      true,
    );
    expect(decision.kind).toBe('block');
  });
});

describe('decideWorkerTeamRouting — Team ON: fs_edit_file', () => {
  // 短于阈值的 edit 一律放行（typo / 改字 / 改 div 一小块）。
  it('Team ON + 小改动（< 阈值）→ 放行', () => {
    allow(
      decideWorkerTeamRouting(
        ctx('fs_edit_file', {
          path: 'studio.html',
          old_string: 'old',
          new_string: 'new text here',
        }),
        true,
      ),
    );
  });

  it('Team ON + 大 new_string 但无 document marker → 放行', () => {
    const big = 'x'.repeat(HTML_REWRITE_MIN_CHARS + 100);
    allow(
      decideWorkerTeamRouting(
        ctx('fs_edit_file', { path: 'studio.html', old_string: 'a', new_string: big }),
        true,
      ),
    );
  });

  it('Team ON + 大 new_string 但只有 <html 无 closer → 放行（不是合法 document）', () => {
    const newString =
      '<html><head><title>x</title></head>' + 'y'.repeat(HTML_REWRITE_MIN_CHARS);
    allow(
      decideWorkerTeamRouting(
        ctx('fs_edit_file', { path: 'studio.html', old_string: 'a', new_string: newString }),
        true,
      ),
    );
  });

  it('Team ON + full-document rewrite（> 阈值 + doctype + </html>）→ 拦下', () => {
    const newString =
      '<!doctype html>' +
      '<html><body>' +
      'x'.repeat(HTML_REWRITE_MIN_CHARS + 200) +
      '</body></html>';
    const decision = decideWorkerTeamRouting(
      ctx('fs_edit_file', { path: 'studio.html', old_string: 'a', new_string: newString }),
      true,
    );
    expect(decision.kind).toBe('block');
    if (decision.kind === 'block') {
      expect(decision.reason).toContain('Team mode blocks full-document fs_edit_file');
      expect(decision.reason).toContain('delegate_task');
      expect(decision.reason).toContain('input_files');
      expect(decision.reason).toContain('studio.html');
      expect(decision.reason).toContain('Do NOT retry');
    }
  });

  it('Team ON + rewrite 但非 HTML 路径 → 放行', () => {
    const newString =
      '<!doctype html><html><body>' + 'x'.repeat(HTML_REWRITE_MIN_CHARS + 50) + '</html>';
    allow(
      decideWorkerTeamRouting(
        ctx('fs_edit_file', { path: 'notes.md', old_string: 'a', new_string: newString }),
        true,
      ),
    );
  });
});

describe('decideWorkerTeamRouting — 其他工具名一律放行', () => {
  it.each(['fs_read_file', 'fs_list', 'fs_search', 'delegate_task', 'fs_delete', 'fs_mkdir'])(
    '%s 在 Team ON 下放行',
    (name) => {
      allow(decideWorkerTeamRouting(ctx(name, { path: 'studio.html' }), true));
    },
  );
});

describe('createWorkerTeamRoutingHook — factory shape', () => {
  it('Team OFF 时 hook 返回 undefined（放行）', async () => {
    const hook = createWorkerTeamRoutingHook(async () => false);
    const out = await hook(ctx('fs_create_file', { path: 'studio.html', content: 'x' }));
    expect(out).toBeUndefined();
  });

  it('Team ON + HTML create → hook 返回 { block: true, reason }', async () => {
    const hook = createWorkerTeamRoutingHook(async () => true);
    const out = await hook(ctx('fs_create_file', { path: 'studio.html', content: 'x' }));
    expect(out).toEqual(
      expect.objectContaining({ block: true }),
    );
    if (out && 'reason' in out) {
      expect((out as { reason: string }).reason).toContain('frontend_coder');
    }
  });
});
