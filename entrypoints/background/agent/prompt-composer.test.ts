import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildSkillsBlock } from '@/lib/ai-config/scanner';
import { memorySettings, userInstructions, workerTeamEnabled } from '@/lib/persistence/storage';
import { ragSettings } from '@/lib/rag/settings';
import { composeSystemPrompt, composeUserMessage } from './prompt-composer';

// skills 索引扫描要读 VFS（IndexedDB），与本文件要验的「拼接 + 占位符替换」无关，
// 故整模块打桩，让每个用例自己决定 skills 块内容。
vi.mock('@/lib/ai-config/scanner', () => ({
  scanSkillIndex: vi.fn(async () => []),
  buildSkillsBlock: vi.fn(() => ''),
}));

// 页面上下文要 chrome.tabs / scripting，与本文件要验的信封拼接无关。
vi.mock('./page-context', () => ({ gatherPageContext: vi.fn(async () => '') }));

describe('composeSystemPrompt', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.mocked(buildSkillsBlock).mockReturnValue('');
  });

  // 最重要的一条：base prompt 里新增 `{{KEY}}` 占位符却忘了在 composeSystemPrompt
  // 的变量表里给值时，替换会静默保留原文并把 `{{KEY}}` 原样发给模型——不抛错、
  // 本地和 CI 都看不出来。这条断言是唯一的拦截点。
  it.each([true, false])('产出不残留任何 {{占位符}}（memory=%s）', async (enabled) => {
    const prompt = await composeSystemPrompt('sess-1', enabled);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it('SESSION_ID 替换成传入的会话 id', async () => {
    const prompt = await composeSystemPrompt('abc-123', false);
    expect(prompt).toContain('/workspaces/abc-123/');
  });

  it('memory 开启 → 注入记忆指引段与「有跨会话记忆」的 limitation 措辞', async () => {
    const prompt = await composeSystemPrompt('s', true);
    expect(prompt).toContain('## Cross-conversation Memory');
    expect(prompt).toContain('You retain memory across conversations');
  });

  it('memory 关闭 → 不注入记忆指引段，limitation 回到「每次会话独立」', async () => {
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).not.toContain('## Cross-conversation Memory');
    expect(prompt).toContain('Each session is independent');
  });

  it('memoryEnabled 省略 → 回退读 memorySettings 存储项', async () => {
    await memorySettings.setValue({ enabled: true });
    const prompt = await composeSystemPrompt('s');
    expect(prompt).toContain('## Cross-conversation Memory');
  });

  it('用户指令为空 → 不追加 <user-instructions> 段', async () => {
    const prompt = await composeSystemPrompt('s', false);
    // base prompt 正文里本就提到 `<user-instructions>` 这个标签名（告诉模型怎么对待它），
    // 故不能用裸的 not.toContain；这里断言的是「没有以成段形式被包裹追加」。
    expect(prompt).not.toMatch(/<user-instructions>\n/);
  });

  it('用户指令非空 → 包成 <user-instructions> 段并去除首尾空白', async () => {
    await userInstructions.setValue('  always answer in Chinese  ');
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).toContain('<user-instructions>\nalways answer in Chinese\n</user-instructions>');
  });

  it('skills 块位于 base prompt 之后、用户指令之前', async () => {
    vi.mocked(buildSkillsBlock).mockReturnValue('<skills>\nfoo\n</skills>');
    await userInstructions.setValue('bar');
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt.indexOf('<skills>')).toBeGreaterThan(0);
    expect(prompt.indexOf('<skills>')).toBeLessThan(prompt.indexOf('<user-instructions>'));
  });

  it('workerTeamEnabled 开启（默认）→ 注入 <available-workers> L1 块', async () => {
    // workerTeamEnabled storage fallback = true（见 lib/persistence/storage.ts），
    // 故默认 composeSystemPrompt 应包含 <available-workers> 块。Runner 在某个
    // role 的 model 未配置时会自己报错，故此处不区分 4 个 role 的 per-model
    // 配置——只要总开关 ON，4 个 role 都在 L1 菜单中可见。
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).toContain('<available-workers>');
    // Prescriptive polarity 标记——见 worker-roles.test.ts 同名注释了解为何
    // "DEFAULT to delegate_task" 比 "delegate when ..." 更可靠。
    expect(prompt).toContain('DEFAULT to `delegate_task`');
    for (const role of ['content_writer', 'frontend_coder', 'reviewer', 'researcher']) {
      expect(prompt).toContain(`<role>${role}</role>`);
    }
  });

  it('workerTeamEnabled 关闭 → 省略 <available-workers> L1 块（与 tool list 同步撤掉）', async () => {
    // OFF 时主代理既看不到 `delegate_task` 工具（lib/tools/index.ts 条件 push），
    // 也读不到 `<available-workers>` 提示块——任一缺失都会让 LLM 幻觉调用或反之
    // 不知何时该用 worker，故两侧必须同步。
    await workerTeamEnabled.setValue(false);
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).not.toContain('<available-workers>');
    // 那条 prescriptive polarity 标记也跟着消失——避免给关了开关的主代理继续灌
    // "DEFAULT to delegate_task" 的指令，引它去调一个不存在的工具。
    expect(prompt).not.toContain('DEFAULT to `delegate_task`');
  });

  it('workerTeamOn 参数存在时优先于 storage，供单轮 dispatch 复用同一快照', async () => {
    await workerTeamEnabled.setValue(false);
    const forcedOn = await composeSystemPrompt('s', false, true);
    expect(forcedOn).toContain('<available-workers>');

    await workerTeamEnabled.setValue(true);
    const forcedOff = await composeSystemPrompt('s', false, false);
    expect(forcedOff).not.toContain('<available-workers>');
  });

  it('<available-workers> 位于 <skills> 之后、<user-instructions> 之前', async () => {
    // 顺序约定：base → skills（domain packs）→ workers（通用能力菜单）→
    // user-instructions（用户偏好）。任何一项错位都会让 model 的注意力
    // 顺序漂移，钉死。
    //
    // 关键：必须用**注入后的 wrapper 形态**（`\n` 后缀）来定位，而不是裸
    // `<skills>` / `<user-instructions>`——这两个标签在 DEFAULT_SYSTEM_PROMPT
    // 的 "Runtime Extensions" 段里就被描述过一次（base prompt 自己讲它们
    // 是什么），裸 tag 的 `indexOf()` 会返回那个描述位置而不是注入位置，
    // 测试就会给出"位置错"的假阳性。
    vi.mocked(buildSkillsBlock).mockReturnValue('<skills>\nfoo\n</skills>');
    await userInstructions.setValue('bar');
    const prompt = await composeSystemPrompt('s', false);
    const idxSkills = prompt.indexOf('<skills>\nfoo\n</skills>');
    const idxWorkers = prompt.indexOf('<available-workers>');
    // <available-workers> 标签**不在** base prompt 文本里（只有描述里提了
    // `<skills>` / `<user-instructions>`，没提 `<available-workers>`），所以
    // 裸 tag 定位安全。
    const idxUserInstr = prompt.indexOf('<user-instructions>\n');
    expect(idxSkills, 'injected <skills> wrapper missing').toBeGreaterThan(0);
    expect(idxWorkers, '<available-workers> block missing').toBeGreaterThan(0);
    expect(idxUserInstr, 'injected <user-instructions> wrapper missing').toBeGreaterThan(0);
    expect(idxWorkers).toBeGreaterThan(idxSkills);
    expect(idxUserInstr).toBeGreaterThan(idxWorkers);
  });

  it('skills 与用户指令都为空 → 段间不出现三连以上换行', async () => {
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).not.toMatch(/\n{3,}/);
  });

  it('workerTeamEnabled 关闭 + skills 非空 + 指令非空 → 段间不出现三连以上换行', async () => {
    // OFF 时 <available-workers> 段消失，但 prompt 各段间仍必须保持 \n\n 单换行
    // 不变——否则破坏 Anthropic prompt caching 的字节稳定前提。
    vi.mocked(buildSkillsBlock).mockReturnValue('<skills>\nfoo\n</skills>');
    await userInstructions.setValue('bar');
    await workerTeamEnabled.setValue(false);
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).not.toMatch(/\n{3,}/);
  });

  // Subtask 4 — opt-in agentic `rag_search` tool. The two new
  // placeholders (`{{RAG_SEARCH_TOOL_LINE}}`, `{{RAG_SEARCH_WORKFLOW_STEP}}`)
  // resolve to empty strings when the toggle is off, so the prompt
  // must NOT mention `rag_search` at all in that state (otherwise the
  // LLM hallucinates calls to a tool that isn't in the tool list).
  // When the toggle is on, the prompt must surface both the Tools
  // roster bullet AND the RAG Workflow step-5 so the LLM knows when
  // to reach for `rag_search`.
  it('ragSearchEnabled 关闭 → prompt 不出现 rag_search 字样（避免 LLM 幻觉调用）', async () => {
    // 默认值就是关闭（DEFAULT_RAG_SETTINGS.ragSearchEnabled = false）。
    const prompt = await composeSystemPrompt('s', false);
    // 工具 roster 段：原本没有这一行
    expect(prompt).not.toMatch(/^\s*-\s+\*\*rag_search\*\*/m);
    // Workflow step-5：原本没有这一步
    expect(prompt).not.toContain('call `rag_search`');
  });

  it('ragSearchEnabled 开启 → prompt 注入 rag_search 工具条目 + Workflow step-5', async () => {
    await ragSettings.setValue({ ragSearchEnabled: true } as never);
    const prompt = await composeSystemPrompt('s', false);
    // Tools roster bullet
    expect(prompt).toMatch(/^\s*-\s+\*\*rag_search\*\*/m);
    // RAG Workflow step-5 — both the trigger keyword and the call site
    expect(prompt).toContain('call `rag_search`');
    expect(prompt).toContain('For deeper lookups beyond the pre-injected chunks');
  });
});

describe('composeUserMessage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('不带斜杠提示词 → 信封里没有 <slash-prompt> 块', async () => {
    const msg = await composeUserMessage('你好', [], false);
    expect(msg).not.toContain('<slash-prompt');
    expect(msg).toContain('<user-request>\n你好\n</user-request>');
  });

  it('workerTeamOn=true → reminder-instructions 提醒 HTML 交付物优先派给 frontend_coder', async () => {
    const msg = await composeUserMessage('build an HTML dashboard', [], false, undefined, true);
    expect(msg).toContain('<reminder-instructions>');
    expect(msg).toContain('Worker Team is ON for this turn');
    expect(msg).toContain('delegate_task');
    expect(msg).toContain("role: 'frontend_coder'");
  });

  it('workerTeamOn=false → 不注入 Team routing reminder，保持旧 byte shape', async () => {
    const msg = await composeUserMessage('build an HTML dashboard', [], false, undefined, false);
    expect(msg).toContain('<reminder-instructions>\n</reminder-instructions>');
    expect(msg).not.toContain('Worker Team is ON for this turn');
    expect(msg).not.toContain('Worker Team');
  });

  // 块必须在请求块之前：信封的不变式是「<user-request> 永远置末」。
  it('带斜杠提示词 → 块排在 <user-request> 之前，用户文本仍独占请求块', async () => {
    const msg = await composeUserMessage('顺便翻成英文', [], false, {
      name: 'summarize',
      body: '总结这个页面。',
    });
    expect(msg).toContain('<slash-prompt name="summarize">\n总结这个页面。\n</slash-prompt>');
    expect(msg).toContain('<user-request>\n顺便翻成英文\n</user-request>');
    expect(msg.indexOf('<slash-prompt')).toBeLessThan(msg.indexOf('<user-request>'));
    // 「请求块恒为末块」是信封的不变式，也是 extractUserText / replaceUserText 以
    // 「整串以 </user-request> 收尾」判定信封的前提——只比相对下标的话，末尾再追加一个
    // 块也照样绿。
    expect(msg.endsWith('</user-request>')).toBe(true);
  });

  // 只挂提示词、一个字没打：请求块留空会让模型以为这轮没有请求。
  it('只挂提示词、用户没打字 → 请求块放一句指向提示词块的话', async () => {
    const msg = await composeUserMessage('   ', [], false, { name: 'x', body: 'do it' });
    expect(msg).toContain('<user-request>\nFollow the instructions in the slash-prompt block above.\n</user-request>');
    // 占位句不能自带尖括号：它在 <user-request> 里，会变成没闭合的嵌套元素。
    expect(msg).not.toContain('<slash-prompt> block');
  });

  it('既没提示词也没文本 → 请求块为空（维持旧行为）', async () => {
    const msg = await composeUserMessage('   ', [], false);
    expect(msg).toContain('<user-request>\n\n</user-request>');
  });
});
