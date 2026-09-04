import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildSkillsBlock } from '@/lib/ai-config/scanner';
import { memorySettings, userInstructions } from '@/lib/persistence/storage';
import { composeSystemPrompt } from './prompt-composer';

// skills 索引扫描要读 VFS（IndexedDB），与本文件要验的「拼接 + 占位符替换」无关，
// 故整模块打桩，让每个用例自己决定 skills 块内容。
vi.mock('@/lib/ai-config/scanner', () => ({
  scanSkillIndex: vi.fn(async () => []),
  buildSkillsBlock: vi.fn(() => ''),
}));

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

  it('<available-workers> L1 块始终存在（4 个固定 role，registry 不变则永驻）', async () => {
    // 与 <skills> 不同：workers registry 永远是 4 个固定 role，runner 在
    // model 未配置时会自己报错，**不需要**靠 system prompt 缺省来表达
    // 「当前没 worker 可用」。无 L1 块反而让主代理更难自察觉察能力边界。
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).toContain('<available-workers>');
    // Prescriptive polarity 标记——见 worker-roles.test.ts 同名注释了解为何
    // "DEFAULT to delegate_task" 比 "delegate when ..." 更可靠。
    expect(prompt).toContain('DEFAULT to `delegate_task`');
    for (const role of ['content_writer', 'frontend_coder', 'reviewer', 'researcher']) {
      expect(prompt).toContain(`<role>${role}</role>`);
    }
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
});