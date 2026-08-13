import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { sanitizeAgentMessages, truncateForEditRerun, extractUserAttachments, extractUserText, stripDirectives } from './message-helpers';

// 用 `as unknown as AgentMessage[]` 构造违反类型契约的运行时数据（这正是本函数要兜的场景）。
const asMessages = (arr: unknown[]) => arr as unknown as AgentMessage[];

describe('truncateForEditRerun', () => {
  it('replaces only the user-request block and truncates following messages', () => {
    const msgs = asMessages([
      { role: 'user', content: '<context>old context</context>\n\n<user-request>\nold prompt\n</user-request>', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: 2 },
      { role: 'user', content: '<user-request>later</user-request>', timestamp: 3 },
    ]);

    const out = truncateForEditRerun(msgs, 0, 'new prompt');

    expect(out).toHaveLength(1);
    expect((out![0] as any).content).toContain('<context>old context</context>');
    expect((out![0] as any).content).toContain('<user-request>\nnew prompt\n</user-request>');
    expect((out![0] as any).content).not.toContain('old prompt');
  });

  it('replaces the LAST <user-request> when a skill body contains its own placeholder', () => {
    // Same shape as the extractUserText regression: a skill template
    // includes a <user-request>...</user-request> placeholder. An edit must
    // rewrite the user-text segment AFTER the directive chain (BG's wrapper
    // contains the whole chain — directive block + user text), not the
    // placeholder inside the skill body, otherwise the user's edit lands
    // inside the skill body and the next send runs the unedited text.
    // The previous non-greedy regex matched the FIRST <user-request> (the
    // skill's placeholder) and rewrote only that, leaving "old prompt" intact
    // and wiping [placeholder] — both wrong.
    const skillBody = '<user-request>\n[placeholder]\n</user-request>';
    const raw = `<context>ctx</context>\n\n<user-request>\n[DIRECTIVE — ATTACHED SKILL: "x"]\n\n${skillBody}\n\n[END DIRECTIVE]\n\nold prompt\n</user-request>`;
    const msgs = asMessages([{ role: 'user', content: raw, timestamp: 1 }]);
    const out = truncateForEditRerun(msgs, 0, 'new prompt');
    // The directive block (with the nested skill-body placeholder) is preserved
    // verbatim — only the trailing user-text segment is rewritten.
    expect((out![0] as any).content).toContain('[DIRECTIVE — ATTACHED SKILL: "x"]');
    expect((out![0] as any).content).toContain('[placeholder]'); // untouched
    // User-text segment rewritten.
    expect((out![0] as any).content).toContain('new prompt');
    expect((out![0] as any).content).not.toContain('old prompt');
  });

  it('preserves image blocks while editing the text block', () => {
    const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
    const msgs = asMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '<attachments>x</attachments>\n\n<user-request>\nold\n</user-request>' },
          image,
        ],
        timestamp: 1,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 },
    ]);

    const out = truncateForEditRerun(msgs, 0, 'new');

    expect(out).toHaveLength(1);
    expect((out![0] as any).content[0].text).toContain('<attachments>x</attachments>');
    expect((out![0] as any).content[0].text).toContain('<user-request>\nnew\n</user-request>');
    expect((out![0] as any).content[1]).toBe(image);
  });

  it('handles plain user string messages', () => {
    const msgs = asMessages([
      { role: 'user', content: 'old', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 },
    ]);

    const out = truncateForEditRerun(msgs, 0, 'new');

    expect(out).toHaveLength(1);
    expect((out![0] as any).content).toBe('new');
  });

  it('returns null for invalid target, non-user target, empty text, or user without text content', () => {
    const msgs = asMessages([
      { role: 'user', content: 'old', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 },
      { role: 'user', content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }], timestamp: 3 },
    ]);

    expect(truncateForEditRerun(msgs, -1, 'new')).toBeNull();
    expect(truncateForEditRerun(msgs, 1, 'new')).toBeNull();
    expect(truncateForEditRerun(msgs, 0, '   ')).toBeNull();
    expect(truncateForEditRerun(msgs, 2, 'new')).toBeNull();
  });
});

describe('stripDirectives', () => {
  it('removes a single prompt directive and the trailing separator', () => {
    const out = stripDirectives(
      '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nAlways respond in English.\n\n[END DIRECTIVE]\n\n---\n\ncon người phát hiện ra như thế nào',
    );
    expect(out).toBe('con người phát hiện ra như thế nào');
  });

  it('removes multiple stacked directives (prompt + skill) before the user text', () => {
    const out = stripDirectives(
      '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nbody1\n\n[END DIRECTIVE]\n\n---\n\n[DIRECTIVE — ATTACHED SKILL: "search"]\n\nbody2\n\n[END DIRECTIVE]\n\n---\n\ncon người phát hiện ra như thế nào',
    );
    expect(out).toBe('con người phát hiện ra như thế nào');
  });

  it('returns empty when only directives were attached and the user typed nothing', () => {
    const out = stripDirectives(
      '[DIRECTIVE — ATTACHED SKILL: "search"]\n\nbody\n\n[END DIRECTIVE]',
    );
    expect(out).toBe('');
  });

  it('passes plain user text through unchanged', () => {
    expect(stripDirectives('hello world')).toBe('hello world');
    expect(stripDirectives('  multi\n\nline  \n')).toBe('multi\n\nline');
  });
});

describe('extractUserText', () => {
  it('strips directive blocks even when persisted in chat history', () => {
    // The BG stores the full enriched message (directives + user text inside
    // <user-request>). When a chat is reopened or refreshed, no pending
    // displayText override exists, so the bubble would otherwise show the
    // directive body verbatim. extractUserText is the bubble's source of
    // truth — verify it hides directives in this persisted-state path too.
    const msg = asMessages([
      {
        role: 'user',
        content: '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nAlways respond in English.\n\n[END DIRECTIVE]\n\n---\n\ncon người phát hiện ra như thế nào',
        timestamp: 1,
      },
    ])[0];

    expect(extractUserText(msg as any)).toBe('con người phát hiện ra như thế nào');
  });

  it('returns the raw user text when there are no directives', () => {
    const msg = asMessages([
      { role: 'user', content: 'just a normal question', timestamp: 1 },
    ])[0];

    expect(extractUserText(msg as any)).toBe('just a normal question');
  });

  it('extracts the LAST <user-request> when a skill body contains its own placeholder', () => {
    // Skill templates typically wrap their request in <user-request>...</user-request>
    // as a placeholder for the LLM to fill in. When the skill is injected as
    // a directive, that placeholder ends up INSIDE the BG's <user-request>
    // wrapper. The bubble must show the user's typed text (after the
    // directive), not the placeholder inside the skill body. The matcher
    // targets the LAST <user-request> — the BG's wrapper — not the first.
    const skillBody = [
      '<reminder-instructions>',
      '- Review your todos',
      '</reminder-instructions>',
      '',
      '<context>',
      '[page context]',
      '</context>',
      '',
      '<user-request>',
      '[placeholder from skill template]',
      '</user-request>',
    ].join('\n');
    const directive = `[DIRECTIVE — ATTACHED SKILL: "reminder-instructions"]\n\n${skillBody}\n\n[END DIRECTIVE]`;
    const raw = [
      '<reminder-instructions>',
      '</reminder-instructions>',
      '',
      '<context>',
      'The current date is 2026-08-12.',
      '',
      '[Active Tab] ...',
      '</context>',
      '',
      `<user-request>\n${directive}\n\n---\n\nxin chào\n</user-request>`,
    ].join('\n');
    const msg = asMessages([{ role: 'user', content: raw, timestamp: 1 }])[0];
    expect(extractUserText(msg as any)).toBe('xin chào');
  });
});

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

describe('extractUserAttachments — mention envelopes', () => {
  it('parses prompt/skill/directory chips from <attachments>', () => {
    const xml = [
      '<attachments>',
      '<attached-prompt name="translate" path="~/.cebian/prompts/translate.md">body</attached-prompt>',
      '<attached-skill name="fun-facts" path="~/.cebian/skills/fun-facts/SKILL.md">body</attached-skill>',
      '<attached-directory path="~/.cebian/memories" label="/home/user/.cebian/memories" count="3">',
      '  - notes.md',
      '  - research/',
      '</attached-directory>',
      '</attachments>',
    ].join('\n');
    const msg = { role: 'user', content: xml, timestamp: 1 };
    const out = extractUserAttachments(msg as any);
    expect(out.prompts).toEqual([{ name: 'translate', path: '~/.cebian/prompts/translate.md' }]);
    expect(out.skills).toEqual([{ name: 'fun-facts', path: '~/.cebian/skills/fun-facts/SKILL.md' }]);
    expect(out.directories).toEqual([{ path: '~/.cebian/memories', label: '/home/user/.cebian/memories', count: 3, pinned: false }]);
    expect(out.inlineDirectives).toEqual([]);  // Old envelope shape — no hybrid directives in this fixture.
  });

  it('flags pinned directory chips so the bubble can suppress them', () => {
    // Pin chips carry `pinned="true"` so the bubble renderer can hide them
    // (the pin is already in the composer strip). Mention chips omit the
    // attribute. Verify both paths parse cleanly.
    const xml = [
      '<attachments>',
      '<attached-directory pinned="true" path="~/.cebian/memories" label="memories" count="2">',
      '  - notes.md',
      '</attached-directory>',
      '<attached-directory path="~/projects" label="projects" count="1">',
      '  - app/',
      '</attached-directory>',
      '</attachments>',
    ].join('\n');
    const out = extractUserAttachments({ role: 'user', content: xml, timestamp: 1 } as any);
    expect(out.directories).toEqual([
      { path: '~/.cebian/memories', label: 'memories', count: 2, pinned: true },
      { path: '~/projects', label: 'projects', count: 1, pinned: false },
    ]);
  });

  it('parses inline directives from the user text (hybrid injection path)', () => {
    // After hybrid injection, prompt/skill mentions live as `[DIRECTIVE — ...]`
    // text blocks inside <user-request>, not as <attached-prompt>/<attached-skill>
    // envelopes. The bubble still needs to render confirmation chips, so the
    // parser scans the full raw text and surfaces them via `inlineDirectives`.
    const text = [
      '<user-request>',
      '[DIRECTIVE — ATTACHED PROMPT: "english"]',
      '',
      'Always respond in English.',
      '',
      '[END DIRECTIVE]',
      '',
      '---',
      '',
      '[DIRECTIVE — ATTACHED SKILL: "research" pinned="true"]',
      '',
      'skill body',
      '',
      '[END DIRECTIVE]',
      '',
      '---',
      '',
      'con người phát hiện ra như thế nào',
      '</user-request>',
    ].join('\n');
    const out = extractUserAttachments({ role: 'user', content: text, timestamp: 1 } as any);
    expect(out.inlineDirectives).toEqual([
      { name: 'english', kind: 'prompt', pinned: false },
      { name: 'research', kind: 'skill', pinned: true },
    ]);
  });

  it('returns an empty inlineDirectives array when no hybrid directives are present', () => {
    const out = extractUserAttachments({ role: 'user', content: 'just a normal question', timestamp: 1 } as any);
    expect(out.inlineDirectives).toEqual([]);
  });

  it('flags pinned mention-file chips via the file envelope\'s path attribute', () => {
    // Mention-file envelopes share the `<attached-file>` shape with regular
    // file attachments; the `path` attribute is the mention-file tell, and
    // `pinned="true"` carries through to the parsed object so the bubble
    // can filter pin chips.
    const xml = [
      '<attachments>',
      '<attached-file name="notes.md" type="text/markdown" path="~/notes.md" pinned="true">body</attached-file>',
      '<attached-file name="drop.txt" type="text/plain">dropped body</attached-file>',
      '</attachments>',
    ].join('\n');
    const out = extractUserAttachments({ role: 'user', content: xml, timestamp: 1 } as any);
    expect(out.files).toEqual([
      { name: 'notes.md', type: 'text/markdown', pinned: true },
      { name: 'drop.txt', type: 'text/plain', pinned: false },
    ]);
  });

  it('returns empty arrays for messages with no mention envelopes', () => {
    const msg = { role: 'user', content: '<attachments></attachments>', timestamp: 1 };
    const out = extractUserAttachments(msg as any);
    expect(out.prompts).toEqual([]);
    expect(out.skills).toEqual([]);
    expect(out.directories).toEqual([]);
    expect(out.inlineDirectives).toEqual([]);
  });
});
