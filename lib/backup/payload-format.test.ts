import { describe, it, expect } from 'vitest';
import {
  sessionFileKey,
  sessionIdFromFileKey,
  SESSIONS_DIR,
  sanitizeVfsCustomRoots,
} from '@/lib/backup/payload-format';

const UUID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

describe('备份 payload-format — 会话文件 key', () => {
  it('sessionFileKey 生成 sessions/{id}.json', () => {
    expect(sessionFileKey(UUID)).toBe(`sessions/${UUID}.json`);
    expect(sessionFileKey(UUID).startsWith(SESSIONS_DIR)).toBe(true);
  });

  it('sessionIdFromFileKey 从合法会话文件提取 UUID', () => {
    expect(sessionIdFromFileKey(`sessions/${UUID}.json`)).toBe(UUID);
    expect(sessionIdFromFileKey(sessionFileKey(UUID))).toBe(UUID);
  });

  it('sessionIdFromFileKey 拒绝非会话 / 畸形 key', () => {
    expect(sessionIdFromFileKey('config.json')).toBeNull();
    expect(sessionIdFromFileKey('vfs/workspaces/s1/sessions/x.json')).toBeNull();
    expect(sessionIdFromFileKey('sessions/readme.txt')).toBeNull();
    expect(sessionIdFromFileKey('sessions/')).toBeNull();
    // 非 UUID 的 stem（即便在 sessions/ 下）被拒绝。
    expect(sessionIdFromFileKey('sessions/not-a-uuid.json')).toBeNull();
    // 嵌套段被拒绝。
    expect(sessionIdFromFileKey(`sessions/sub/${UUID}.json`)).toBeNull();
    expect(sessionIdFromFileKey('sessions/index.json')).toBeNull();
  });
});

describe('备份 payload-format — sanitizeVfsCustomRoots（vfsCustom 自选路径净化）', () => {
  it('规范化路径：解析 .. / ~ / 冗余斜杠与尾斜杠，统一为绝对路径', () => {
    expect(
      sanitizeVfsCustomRoots([
        '/home/user/.cebian/../.cebian/notes/',
        '~/.cebian/docs',
        '//home//user///x',
      ]),
    ).toEqual(['/home/user/.cebian/notes', '/home/user/.cebian/docs', '/home/user/x']);
  });

  it('丢弃 VFS 根 `/`（collect 无从采集、restore 不作清空前缀）', () => {
    expect(sanitizeVfsCustomRoots(['/'])).toEqual([]);
    // 解析后坍缩成 / 的条目（如根上的 ..）同样丢弃。
    expect(sanitizeVfsCustomRoots(['/..'])).toEqual([]);
    // 但普通路径上的 .. 只是上跳一层，结果是合法路径、保留。
    expect(sanitizeVfsCustomRoots(['/home/user/..'])).toEqual(['/home']);
  });

  it('按规范化形态去重，保留首次出现的顺序', () => {
    expect(
      sanitizeVfsCustomRoots(['/workspaces', '/a', '/workspaces/', '//workspaces']),
    ).toEqual(['/workspaces', '/a']);
  });

  it('非字符串 / 空串 / 非数组输入 → 空数组（防御构造或损坏的 manifest）', () => {
    expect(sanitizeVfsCustomRoots(undefined)).toEqual([]);
    expect(sanitizeVfsCustomRoots(null)).toEqual([]);
    expect(sanitizeVfsCustomRoots('/workspaces')).toEqual([]);
    expect(sanitizeVfsCustomRoots([42, null, '', '/ok'])).toEqual(['/ok']);
  });

  it('相对路径被强制为绝对（normalizePath 语义），不静默丢弃', () => {
    expect(sanitizeVfsCustomRoots(['notes/todo.md'])).toEqual(['/notes/todo.md']);
  });
});

