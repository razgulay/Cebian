import { describe, it } from 'vitest';
import { buildSkillsBlock } from '@/lib/ai-config/scanner';
import { userInstructions } from '@/lib/persistence/storage';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { composeSystemPrompt } from './prompt-composer';

describe('debug', () => {
  it('check positions', async () => {
    fakeBrowser.reset();
    const m = await import('@/lib/ai-config/scanner');
    (m.buildSkillsBlock as any) = () => '<skills>\nfoo\n</skills>';
    await userInstructions.setValue('bar');
    const prompt = await composeSystemPrompt('s', false);
    console.log('idxSkills:', prompt.indexOf('<skills>'));
    console.log('idxWorkers:', prompt.indexOf('<available-workers>'));
    console.log('idxUserInstr:', prompt.indexOf('<user-instructions>'));
  });
});
