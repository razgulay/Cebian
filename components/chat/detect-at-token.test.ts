import { describe, it, expect } from 'vitest';
import { detectAtToken } from '@/components/chat/detect-at-token';

describe('detectAtToken — boundary parser', () => {
  it('@ 紧贴行首 → 返回完整 token + query 小写化', () => {
    expect(detectAtToken('@reviewer', 9)).toEqual({ query: 'reviewer', start: 0, end: 9 });
  });

  it('@ 紧跟空格 → 返回 token，空 query 时仅含 @', () => {
    expect(detectAtToken('hi @', 4)).toEqual({ query: '', start: 3, end: 4 });
    expect(detectAtToken('hi @re', 6)).toEqual({ query: 're', start: 3, end: 6 });
  });

  it('@ 紧跟换行 → boundary 仍是 whitespace → 触发', () => {
    // 'hi\n@frontend_coder' = 18 字符；caret 在末尾 → 18
    expect(detectAtToken('hi\n@frontend_coder', 18)).toEqual({
      query: 'frontend_coder',
      start: 3,
      end: 18,
    });
  });

  it('@ 紧跟 tab → boundary 仍是 whitespace → 触发', () => {
    expect(detectAtToken('x\t@reviewer', 11)).toEqual({ query: 'reviewer', start: 2, end: 11 });
  });

  it('user@host 在 mid-word → 不触发（防止 email 误激活）', () => {
    // @ 前面是字母（无 whitespace）→ 跳过 @，落到行首但前面没有 @ → return null
    expect(detectAtToken('user@example.com', 16)).toBeNull();
    expect(detectAtToken('user@example', 11)).toBeNull();
  });

  it('@ 后跟非 token 字符 → 仅触发 @ 本身（空 query）', () => {
    // 函数语义：@ 紧贴 boundary + 后续字符不在 token 集合 → 仍返回 trigger，
    // query 为空——popover 拿到 4 个选项原列表即可。
    expect(detectAtToken('@!', 2)).toEqual({ query: '', start: 0, end: 1 });
    expect(detectAtToken('@.', 2)).toEqual({ query: '', start: 0, end: 1 });
  });

  it('部分输入与多种角色前缀都能匹配', () => {
    // 部分 token + caret 在末尾：query = caret 前完整部分。
    expect(detectAtToken('@con', 4)).toEqual({ query: 'con', start: 0, end: 4 });
    expect(detectAtToken('@front', 6)).toEqual({ query: 'front', start: 0, end: 6 });
    // 完整 token + caret 在末尾：query = 完整 token（end == caret == value.length）。
    expect(detectAtToken('@researcher', 11)).toEqual({
      query: 'researcher',
      start: 0,
      end: 11,
    });
    // 完整 token 'content_writer' = 14 字符 + '@' = 15 字符；caret=15 在末尾。
    expect(detectAtToken('@content_writer', 15)).toEqual({
      query: 'content_writer',
      start: 0,
      end: 15,
    });
  });

  it('token 只延伸到 caret 位置（用 caret 之前输入的中缀查询）', () => {
    // user 已输入 "rev" 但 caret 还没打后续字符——query 仍是 "rev"。
    expect(detectAtToken('@rev', 4)).toEqual({ query: 'rev', start: 0, end: 4 });
    // caret 跨过完整词——query = 完整 token。
    expect(detectAtToken('@reviewer', 9)).toEqual({ query: 'reviewer', start: 0, end: 9 });
    // caret 之后有其他字符（end 不会越过 token 末尾）——query 仍只是 caret 之前部分。
    expect(detectAtToken('@reviewer_xyz', 9)).toEqual({ query: 'reviewer', start: 0, end: 9 });
  });

  it('caret==0 或 caret>value.length → null（边界）', () => {
    expect(detectAtToken('@reviewer', 0)).toBeNull();
    // caret 在末尾（== value.length）是合法位置
    expect(detectAtToken('@reviewer', 9)).not.toBeNull();
    expect(detectAtToken('@reviewer', 100)).toBeNull();
    expect(detectAtToken('', 0)).toBeNull();
  });
});
