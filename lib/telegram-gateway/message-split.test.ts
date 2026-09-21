// message-split.test.ts — finalize 切分器纯函数单测。两层分别钉住：
//   splitReply  — 主入口：Block 1 = 完整第一段（首段锚点）、Block 2+ 段落分组
//                 ≤2000、fence 原子、超长单段兜底、内容不丢。
//   splitMessage — 通用窗口切分兜底：优先级顺序（段落 → 换行 → 句末 → 空格 →
//                 硬切）、code fence 守卫、终止性（不丢内容不死循环）。

import { describe, expect, it } from 'vitest';
import {
  splitMessage,
  splitReply,
  TELEGRAM_HARD_LIMIT,
} from '@/lib/telegram-gateway/message-split';

describe('splitReply — 首段锚点切分（finalize 主入口）', () => {
  it('Block 1 = 完整第一段：超长段落也不做字符截断（语义优先）', () => {
    const a = 'A'.repeat(3000);
    const b = 'B'.repeat(100);
    const chunks = splitReply(`${a}\n\n${b}`);
    expect(chunks).toEqual([a, b]);
  });

  it('Block 2+ 段落贪心分组：多段并作一条 ≤2000，超出即分块', () => {
    const p = (c: string) => `${c}.repeat-marker-${c}`;
    const segments = [p('A'), p('B'), p('C'), p('D'), p('E')].map((s) => s + 'x'.repeat(500));
    const text = segments.join('\n\n');
    const chunks = splitReply(text);
    // Block 1 = 第一段；Block 2+ 每块 ≤2000（多个 500+ 字符段分组）
    expect(chunks[0]).toBe(segments[0]);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.length).toBeLessThanOrEqual(2000);
    }
    // 拼回（块间以段落间隔补回）不丢任何段落
    const rejoined = chunks.join('\n\n');
    for (const seg of segments) expect(rejoined).toContain(seg);
  });

  it('fence 原子：code fence 内的空行不产生段落边界', () => {
    const p1 = 'Đoạn mở đầu.';
    const fence = ['```js', 'const a = 1;', '', 'const b = 2;', '```'].join('\n');
    const p3 = 'Đoạn kết.';
    const chunks = splitReply(`${p1}\n\n${fence}\n\n${p3}`);
    expect(chunks[0]).toBe(p1);
    // fence 整块保活：包含它的块以 ```js 开头，fence 内的空行原样保留
    // （证明 fence 内的空行没有产生段落边界），且闭合 ``` 与 fence 同块。
    const fenceBlock = chunks.find((c) => c.startsWith('```js'));
    expect(fenceBlock).toBeDefined();
    expect(fenceBlock).toContain('const a = 1;\n\nconst b = 2;');
    expect(fenceBlock).toContain('const b = 2;\n```');
    // p3 (đoạn ngắn) được gom chung vào cùng block theo grouping ≤2000
    expect(chunks[chunks.length - 1]!.endsWith(p3)).toBe(true);
  });

  it('超长单段（> Bot API 硬上限）→ splitMessage 句子级兜底再切，不丢内容', () => {
    const wall = 'x'.repeat(4500);
    const chunks = splitReply(wall);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_HARD_LIMIT);
    expect(chunks.join('')).toBe(wall);
  });

  it('空白文本 → 无块；单段短文 → 单块', () => {
    expect(splitReply('   \n\n  ')).toEqual([]);
    expect(splitReply('Xin chào Cebian!')).toEqual(['Xin chào Cebian!']);
  });
});

describe('splitMessage — 通用窗口切分（超长单段兜底）', () => {
  it('短文本 → 单块原样返回', () => {
    expect(splitMessage('Xin chào Cebian!')).toEqual(['Xin chào Cebian!']);
    expect(splitMessage('a'.repeat(TELEGRAM_HARD_LIMIT))).toHaveLength(1);
  });

  it('段落边界优先：在 \\n\\n 处切开，块首尾无残留空白', () => {
    const a = 'A'.repeat(1500);
    const b = 'B'.repeat(1500);
    const chunks = splitMessage(`${a}\n\n${b}`, 2048);
    expect(chunks).toEqual([a, b]);
  });

  it('无段落 → 退到句末标点切分', () => {
    // 句末标点落在 limit 窗口内，其后是短尾巴 → 恰好 2 块
    const text = `${'x'.repeat(2040)}. ${'y'.repeat(50)}`;
    const chunks = splitMessage(text, 2048);
    expect(chunks).toHaveLength(2);
    // 第一块在句末标点处收尾
    expect(chunks[0]).toBe(`${'x'.repeat(2040)}.`);
    expect(chunks[1]).toBe('y'.repeat(50));
  });

  it('词 → 退到空格切分（词边界完整，拼回等于原文）', () => {
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`).join(' ');
    const chunks = splitMessage(words, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      expect(c.startsWith(' ')).toBe(false);
      expect(c.endsWith(' ')).toBe(false);
    }
    // 每个切点都落在空格上——用单空格拼回应逐词还原原文
    expect(chunks.join(' ')).toBe(words);
  });

  it('无空白的 CJK 长墙 → 硬切在 limit，不丢内容不死循环', () => {
    const wall = '中'.repeat(5000);
    const chunks = splitMessage(wall, 1000);
    expect(chunks.join('')).toBe(wall);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });

  it('code fence 守卫：候选切点落在未闭合围栏内 → 切点回退到围栏开始处', () => {
    const before = 'A'.repeat(1000);
    const fenceBody = 'B'.repeat(1500);
    const after = 'C'.repeat(500);
    // 围栏打开于窗口中部（index 1000），窗口内无更早的段落 / 句子候选——
    // 硬切 2048 会落在未闭合围栏内 → 守卫把切点回退到围栏开始处
    const text = `${before}\`\`\`js\n${fenceBody}\n\n${after}`;
    const chunks = splitMessage(text, 2048);
    expect(chunks[0]).toBe(before);
    expect(chunks[1]?.startsWith('```js')).toBe(true);
    // 所有块拼回（去边界空白）不丢内容
    const rejoined = chunks.join('\n');
    expect(rejoined.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('终止性：任意输入都产出非空块集合，总长度不增（仅边界空白差异）', () => {
    const weird = `${'段。'.repeat(3000)}\n\n${'\`\`\`'}${'码'.repeat(100)}\n${'尾'.repeat(300)}`;
    const chunks = splitMessage(weird, 800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(800);
    }
    expect(chunks.join('').replace(/\s/g, '').length).toBe(
      weird.replace(/\s/g, '').length,
    );
  });
});
