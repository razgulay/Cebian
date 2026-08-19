import { describe, it, expect } from 'vitest';
import { assertJsonSerializable, type AgentMessage } from '@earendil-works/pi-agent-core';
import { replaceUserText, sanitizeAgentMessages, stripDirectives, extractInlineDirectives, extractInlineDirectivesFromMessage, extractUserText } from './message-helpers';

// 用 `as unknown as AgentMessage[]` 构造违反类型契约的运行时数据（这正是本函数要兜的场景）。
const asMessages = (arr: unknown[]) => arr as unknown as AgentMessage[];

describe('sanitizeAgentMessages', () => {
  it('把 assistant text 块的 null text 兜成空串', () => {
    const out = sanitizeAgentMessages(
      asMessages([{ role: 'assistant', content: [{ type: 'text', text: null }], timestamp: 1 }]),
    );
    expect((out[0] as any).content[0].text).toBe('');
  });

  it('把 assistant thinking 块的 null thinking 兜成空串并保留同级字段', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: null, thinkingSignature: 'reasoning_content' }],
          timestamp: 1,
        },
      ]),
    );
    expect((out[0] as any).content[0].thinking).toBe('');
    expect((out[0] as any).content[0].thinkingSignature).toBe('reasoning_content');
  });

  it('把 toolCall 块的 null name 兜成空串并保留 id / arguments', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: null, arguments: { a: 1 } }], timestamp: 1 },
      ]),
    );
    expect((out[0] as any).content[0].name).toBe('');
    expect((out[0] as any).content[0].id).toBe('x');
    expect((out[0] as any).content[0].arguments).toEqual({ a: 1 });
  });

  it('把标准角色缺失的顶层 content（null / undefined）兜成空数组', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        { role: 'assistant', content: null, timestamp: 1 },
        { role: 'user', content: undefined, timestamp: 2 },
        { role: 'toolResult', toolCallId: 't', content: null, timestamp: 3 },
      ]),
    );
    expect((out[0] as any).content).toEqual([]);
    expect((out[1] as any).content).toEqual([]);
    expect((out[2] as any).content).toEqual([]);
  });

  it('移除标准消息顶层值为 undefined 的可选字段，使其满足 durable payload 契约', () => {
    const toolResult = {
      role: 'toolResult',
      toolCallId: 't',
      toolName: 'demo',
      content: [],
      details: undefined,
      usage: undefined,
      isError: false,
      timestamp: 1,
    };
    const assistant = {
      role: 'assistant',
      content: [],
      api: 'demo-api',
      provider: 'demo',
      model: 'demo-model',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'aborted',
      errorMessage: undefined,
      timestamp: 2,
    };
    const out = sanitizeAgentMessages(asMessages([toolResult, assistant]));

    expect(() => assertJsonSerializable(out)).not.toThrow();
    expect(Object.hasOwn(out[0], 'details')).toBe(false);
    expect(Object.hasOwn(out[0], 'usage')).toBe(false);
    expect(Object.hasOwn(out[1], 'errorMessage')).toBe(false);
    expect(Object.hasOwn(toolResult, 'usage')).toBe(true);
    expect(Object.hasOwn(assistant, 'errorMessage')).toBe(true);
  });

  it('不给 compactionSummary 这类自定义消息塞 content，原样返回', () => {
    const summary = { role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: 1 };
    const out = sanitizeAgentMessages(asMessages([summary]));
    expect(out[0]).toBe(summary);
    expect('content' in (out[0] as any)).toBe(false);
  });

  it('字符串形式的 user content 原样返回', () => {
    const m = { role: 'user', content: 'hello', timestamp: 1 };
    const out = sanitizeAgentMessages(asMessages([m]));
    expect(out[0]).toBe(m);
  });

  it('全部干净时返回同一数组与同一消息引用（copy-on-write）', () => {
    const msgs = asMessages([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }, { type: 'thinking', thinking: 'hmm' }], timestamp: 2 },
    ]);
    const out = sanitizeAgentMessages(msgs);
    expect(out).toBe(msgs);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
  });

  it('只替换出问题的消息，干净的兄弟消息保持引用', () => {
    const clean = { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 };
    const bad = { role: 'assistant', content: [{ type: 'text', text: null }], timestamp: 2 };
    const msgs = asMessages([clean, bad]);
    const out = sanitizeAgentMessages(msgs);
    expect(out).not.toBe(msgs);
    expect(out[0]).toBe(clean);
    expect(out[1]).not.toBe(bad);
    expect((out[1] as any).content[0].text).toBe('');
  });

  it('只复制出问题的块，干净的块保持引用', () => {
    const cleanBlock = { type: 'text', text: 'ok' };
    const badBlock = { type: 'thinking', thinking: null };
    const msg = { role: 'assistant', content: [cleanBlock, badBlock], timestamp: 1 };
    const out = sanitizeAgentMessages(asMessages([msg]));
    expect((out[0] as any).content[0]).toBe(cleanBlock);
    expect((out[0] as any).content[1]).not.toBe(badBlock);
  });

  it('不改动入参（原始消息 / 块保持原值）', () => {
    const bad = { role: 'assistant', content: [{ type: 'text', text: null }], timestamp: 1 };
    sanitizeAgentMessages(asMessages([bad]));
    expect((bad.content[0] as any).text).toBe(null);
  });

  it('undefined 的 text / thinking / name 同样兜成空串', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        {
          role: 'assistant',
          content: [
            { type: 'text' }, // text 缺失
            { type: 'thinking' }, // thinking 缺失
            { type: 'toolCall', id: 'a', arguments: {} }, // name 缺失
          ],
          timestamp: 1,
        },
      ]),
    );
    expect((out[0] as any).content[0].text).toBe('');
    expect((out[0] as any).content[1].thinking).toBe('');
    expect((out[0] as any).content[2].name).toBe('');
  });

  it('image / 未知类型 / null / 原始值块一律原样保持引用', () => {
    const image = { type: 'image', data: 'd', mimeType: 'image/png' };
    const unknown = { type: 'weird', foo: 1 };
    const msg = { role: 'assistant', content: [image, unknown, null, 42], timestamp: 1 };
    const out = sanitizeAgentMessages(asMessages([msg]));
    expect(out[0]).toBe(msg); // 无任何需矫正的块 → 整条消息原样返回
    expect((out[0] as any).content[0]).toBe(image);
    expect((out[0] as any).content[1]).toBe(unknown);
    expect((out[0] as any).content[2]).toBe(null);
    expect((out[0] as any).content[3]).toBe(42);
  });

  it('只矫正 toolCall 的 name，arguments 为 null 时不动', () => {
    const out = sanitizeAgentMessages(
      asMessages([
        { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: null, arguments: null }], timestamp: 1 },
      ]),
    );
    expect((out[0] as any).content[0].name).toBe('');
    expect((out[0] as any).content[0].arguments).toBe(null);
  });

  it('移除 block 内值为 undefined 的属性，使其满足 durable payload 契约', () => {
    const toolResultBlock = {
      type: 'toolResult',
      toolCallId: 't',
      content: [{ type: 'text', text: 'ok' }],
      isError: undefined,
      metadata: undefined,
    };
    const msg = {
      role: 'toolResult',
      toolCallId: 't',
      content: [toolResultBlock],
      timestamp: 1,
    };
    const out = sanitizeAgentMessages(asMessages([msg]));

    expect(() => assertJsonSerializable(out)).not.toThrow();
    const sanitizedBlock = (out[0] as any).content[0];
    expect(Object.hasOwn(sanitizedBlock, 'isError')).toBe(false);
    expect(Object.hasOwn(sanitizedBlock, 'metadata')).toBe(false);
    expect(Object.hasOwn(toolResultBlock, 'isError')).toBe(true);
  });

  it('移除 details 对象内值为 undefined 的属性', () => {
    const msg = {
      role: 'toolResult',
      toolCallId: 't',
      toolName: 'demo',
      content: [{ type: 'text', text: 'ok' }],
      details: {
        server: { id: '1', name: 'srv' },
        structured: undefined, // this caused the crash
      },
      isError: false,
      timestamp: 1,
    };
    const out = sanitizeAgentMessages(asMessages([msg]));

    expect(() => assertJsonSerializable(out)).not.toThrow();
    const details = (out[0] as any).details;
    expect(Object.hasOwn(details, 'structured')).toBe(false);
    expect(Object.hasOwn(details, 'server')).toBe(true);
    // original is unmutated
    expect(Object.hasOwn(msg.details, 'structured')).toBe(true);
  });
});

describe('extractInlineDirectives', () => {

  it('矫正发生在中间时，其后干净的消息仍走透传分支保持引用', () => {
    const bad = { role: 'assistant', content: [{ type: 'text', text: null }], timestamp: 1 };
    const cleanTail = { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 2 };
    const out = sanitizeAgentMessages(asMessages([bad, cleanTail]));
    expect(out[0]).not.toBe(bad);
    expect(out[1]).toBe(cleanTail);
  });

  it('空数组原样返回', () => {
    const msgs = asMessages([]);
    expect(sanitizeAgentMessages(msgs)).toBe(msgs);
  });
});

describe('replaceUserText', () => {
  const wrap = (text: string) => `<user-request>\n${text}\n</user-request>`;

  it('字符串 content：有 <user-request> 包裹时只换内文，兄弟块保留', () => {
    const msg = {
      role: 'user',
      content: `<attachments><attached-file name="a.txt" type="text/plain"></attached-file></attachments>\n${wrap('旧文案')}`,
      timestamp: 1,
    } as any;
    const out = replaceUserText(msg, '新文案');
    expect(out.content).toContain('<attachments>');
    expect(out.content).toContain(wrap('新文案'));
    expect(out.content).not.toContain('旧文案');
    expect(msg.content).toContain('旧文案'); // 纯函数，不改入参
  });

  it('字符串 content：无包裹（裸文本）时整体替换', () => {
    const out = replaceUserText({ role: 'user', content: '裸文本', timestamp: 1 } as any, '新');
    expect(out.content).toBe('新');
  });

  it('块数组 content：替换含 <user-request> 的 text 块，image 块原样保留', () => {
    const msg = {
      role: 'user',
      content: [
        { type: 'text', text: wrap('旧') },
        { type: 'image', data: 'xxx', mimeType: 'image/png' },
      ],
      timestamp: 1,
    } as any;
    const out = replaceUserText(msg, '新');
    expect(out.content[0].text).toBe(wrap('新'));
    expect(out.content[1]).toBe(msg.content[1]);
  });

  it('新文案含 $& / $1 等 replace 特殊模式时按字面写入', () => {
    const out = replaceUserText(
      { role: 'user', content: wrap('旧'), timestamp: 1 } as any,
      '价格是 $1，匹配 $& 保留',
    );
    expect(out.content).toContain('价格是 $1，匹配 $& 保留');
  });

  it('块数组无 text 块时追加一个', () => {
    const out = replaceUserText(
      { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }], timestamp: 1 } as any,
      '新',
    );
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({ type: 'text', text: '新' });
  });
});

describe('stripDirectives', () => {
  it('剥掉单个 COMMAND 块，保留用户敲的字', () => {
    const text = '[DIRECTIVE — ATTACHED COMMAND: "english"]\n\nAlways respond in English.\n\n[END DIRECTIVE]\n\n---\n\nxin chào';
    expect(stripDirectives(text)).toBe('xin chào');
  });

  it('剥掉多个堆叠指令（PROMPT + SKILL + COMMAND）并按出现顺序保留用户字', () => {
    const text = [
      '[DIRECTIVE — ATTACHED PROMPT: "a"]\n\nbody A\n\n[END DIRECTIVE]',
      '[DIRECTIVE — ATTACHED SKILL: "b"]\n\nbody B\n\n[END DIRECTIVE]',
      '[DIRECTIVE — ATTACHED COMMAND: "c"]\n\nbody C\n\n[END DIRECTIVE]',
      '---',
      'user words',
    ].join('\n\n');
    expect(stripDirectives(text)).toBe('user words');
  });

  it('剥掉指令后把残留的 `---` 分隔线和连续空行归一成标准换行', () => {
    const text = '[DIRECTIVE — ATTACHED COMMAND: "x"]\n\nbody\n\n[END DIRECTIVE]\n\n\n\n\n   ---   \n\n\n\nfinal';
    expect(stripDirectives(text)).toBe('final');
  });

  it('对没有指令的文本只做 trim（不动）', () => {
    expect(stripDirectives('  hello world  ')).toBe('hello world');
  });

  it('剥掉带 pinned="true" 的指令块', () => {
    const text = '[DIRECTIVE — ATTACHED SKILL: "reminder" pinned="true"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nhi';
    expect(stripDirectives(text)).toBe('hi');
  });

  it('幂等：跑两次和跑一次结果相同', () => {
    const text = '[DIRECTIVE — ATTACHED COMMAND: "x"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nhi';
    const once = stripDirectives(text);
    const twice = stripDirectives(once);
    expect(twice).toBe(once);
  });

  it('纯指令（无 --- 分隔符也无用户字）剥完返回空串', () => {
    // ChatInput 在用户只输入 `/foo` 没敲别的字时，组装出的就是这种形状：
    //   `<user-request>${slashDirective}</user-request>`
    // 没有 `\n\n---\n\n` 分隔符，也没有用户字。剥完后应为空串，气泡不显示字。
    const text = '[DIRECTIVE — ATTACHED COMMAND: "x"]\n\nbody\n\n[END DIRECTIVE]';
    expect(stripDirectives(text)).toBe('');
  });
});

describe('extractInlineDirectives', () => {
  it('识别 COMMAND 类型并返回正确的 name', () => {
    const text = '[DIRECTIVE — ATTACHED COMMAND: "english"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nhi';
    expect(extractInlineDirectives(text)).toEqual([
      { kind: 'command', name: 'english', pinned: false },
    ]);
  });

  it('没有指令时返回空数组', () => {
    expect(extractInlineDirectives('just plain text')).toEqual([]);
  });

  it('多指令按源顺序返回', () => {
    const text = [
      '[DIRECTIVE — ATTACHED PROMPT: "a"]\n\nA\n\n[END DIRECTIVE]',
      '[DIRECTIVE — ATTACHED SKILL: "b"]\n\nB\n\n[END DIRECTIVE]',
      '[DIRECTIVE — ATTACHED COMMAND: "c"]\n\nC\n\n[END DIRECTIVE]',
    ].join('\n\n---\n\n');
    expect(extractInlineDirectives(text)).toEqual([
      { kind: 'prompt', name: 'a', pinned: false },
      { kind: 'skill', name: 'b', pinned: false },
      { kind: 'command', name: 'c', pinned: false },
    ]);
  });

  it('正确解析 pinned="true" 标记', () => {
    const text = '[DIRECTIVE — ATTACHED PROMPT: "english" pinned="true"]\n\nbody\n\n[END DIRECTIVE]';
    expect(extractInlineDirectives(text)).toEqual([
      { kind: 'prompt', name: 'english', pinned: true },
    ]);
  });

  it('半截指令（缺少 [END DIRECTIVE]）的 open 行不被误判（BLOCK_RE 会泄漏但 OPEN_RE 仍识别开头）', () => {
    // extractInlineDirectives 只看开头行——所以「只有开头行」的伪指令仍被识别为合法指令。
    // stripDirectives 处理完整块，行为见对应 describe。
    const text = '[DIRECTIVE — ATTACHED COMMAND: "x"]\n\nbody without close';
    expect(extractInlineDirectives(text)).toEqual([
      { kind: 'command', name: 'x', pinned: false },
    ]);
  });
});

describe('extractInlineDirectivesFromMessage', () => {
  const wrap = (text: string) => `<user-request>\n${text}\n</user-request>`;

  it('从 <user-request> 内文里抽出指令元信息', () => {
    const msg = {
      role: 'user',
      content: wrap('[DIRECTIVE — ATTACHED COMMAND: "english"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nhi'),
      timestamp: 1,
    } as any;
    expect(extractInlineDirectivesFromMessage(msg)).toEqual([
      { kind: 'command', name: 'english', pinned: false },
    ]);
  });

  it('非 user 角色返回空数组', () => {
    expect(extractInlineDirectivesFromMessage({ role: 'assistant', content: 'x', timestamp: 1 } as any)).toEqual([]);
  });

  it('从块数组 content 里也读得到（text 块里包着 <user-request>）', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'text', text: wrap('[DIRECTIVE — ATTACHED SKILL: "search"]\n\nb\n\n[END DIRECTIVE]\n\n---\n\nq') }],
      timestamp: 1,
    } as any;
    expect(extractInlineDirectivesFromMessage(msg)).toEqual([
      { kind: 'skill', name: 'search', pinned: false },
    ]);
  });

  it('混合 pin 和非-pin 指令都抽出（Message.tsx 用 d.pinned 决定是否渲染 chip）', () => {
    // Pin chip đã ở composer strip, không lặp trên bubble.
    // Slash/mention chip (không pin) v�n render để confirm đã attach.
    const msg = {
      role: 'user',
      content: wrap([
        '[DIRECTIVE — ATTACHED PROMPT: "pinned-prompt" pinned="true"]\n\nbody A\n\n[END DIRECTIVE]',
        '[DIRECTIVE — ATTACHED SKILL: "search"]\n\nbody B\n\n[END DIRECTIVE]',
        '[DIRECTIVE — ATTACHED COMMAND: "english"]\n\nbody C\n\n[END DIRECTIVE]',
        'q',
      ].join('\n\n---\n\n')),
      timestamp: 1,
    } as any;
    expect(extractInlineDirectivesFromMessage(msg)).toEqual([
      { kind: 'prompt', name: 'pinned-prompt', pinned: true },
      { kind: 'skill', name: 'search', pinned: false },
      { kind: 'command', name: 'english', pinned: false },
    ]);
  });
});

describe('extractUserText + stripDirectives 集成', () => {
  const wrap = (text: string) => `<user-request>\n${text}\n</user-request>`;

  it('带指令的 user 消息提取出的文本不包含指令块 / 分隔线', () => {
    const msg = {
      role: 'user',
      content: wrap('[DIRECTIVE — ATTACHED COMMAND: "english"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nxin chào'),
      timestamp: 1,
    } as any;
    const text = extractUserText(msg);
    expect(text).toBe('xin chào');
    expect(text).not.toContain('[DIRECTIVE');
    expect(text).not.toContain('---');
  });

  it('裸文本（无 <user-request> 包裹）也走 strip 路径', () => {
    const msg = {
      role: 'user',
      content: '[DIRECTIVE — ATTACHED COMMAND: "x"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nhi',
      timestamp: 1,
    } as any;
    expect(extractUserText(msg)).toBe('hi');
  });

  it('非 user 角色返回空串', () => {
    expect(extractUserText({ role: 'assistant', content: 'x', timestamp: 1 } as any)).toBe('');
  });
});
