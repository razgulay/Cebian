// fake-indexeddb 必须先于任何 Dexie 使用注入全局 indexedDB
import 'fake-indexeddb/auto';
import { afterEach, describe, it, expect } from 'vitest';
import Dexie from 'dexie';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  DexieSessionRepo,
  SESSION_META_SCHEMA,
  SESSION_MUTATIONS_SCHEMA,
  type SessionTreeDb,
  type SessionTreeMeta,
} from '@/lib/persistence/session-tree';
import { projectEntries } from '@/lib/agent/session-projection';
import { appendSessionMessage } from './session-store';

const asMessage = (value: unknown) => value as AgentMessage;

/** 建一个带会话树 schema 的临时库并登记，afterEach 统一关闭、删除 */
const openDbs: SessionTreeDb[] = [];
function openDb(name: string): SessionTreeDb {
  const db = new Dexie(name) as SessionTreeDb;
  db.version(1).stores({ sessions: SESSION_META_SCHEMA, sessionMutations: SESSION_MUTATIONS_SCHEMA });
  openDbs.push(db);
  return db;
}
afterEach(async () => {
  for (const db of openDbs.splice(0)) {
    db.close();
    await db.delete();
  }
});

describe('appendSessionMessage · durable payload 兜底（issue #74）', () => {
  it('details 里嵌套 undefined 的 toolResult 能落树，重开会话后整轮对话完整', async () => {
    const dbName = `session-store-${crypto.randomUUID()}`;
    const db1 = openDb(dbName);
    const tree = await new DexieSessionRepo(db1).create({ id: 's1', title: 't' });
    const transcript = [
      asMessage({ role: 'user', content: [{ type: 'text', text: '部署一个网页' }], timestamp: 1 }),
      asMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'mcp__edgeone__deploy-html', arguments: {} }], timestamp: 2 }),
      asMessage({
        role: 'toolResult', toolCallId: 'c1', toolName: 'mcp__edgeone__deploy-html',
        content: [{ type: 'text', text: 'deployed' }],
        details: { server: { id: 'srv', name: 'edgeone' }, tool: 'deploy-html', structured: undefined },
        isError: false, timestamp: 3,
      }),
      asMessage({ role: 'assistant', content: [{ type: 'text', text: '部署好了' }], timestamp: 4 }),
    ];
    for (const message of transcript) await appendSessionMessage(tree, message);
    db1.close();

    const db2 = openDb(dbName);
    const reopened = await new DexieSessionRepo(db2).open({ id: 's1' } as SessionTreeMeta);
    const { messages } = projectEntries(await reopened.findEntriesOnBranch({ order: 'oldestFirst' }));
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect(Object.hasOwn((messages[2] as any).details, 'structured')).toBe(false);
  });

  it('compactionSummary 的 retainedTail 里带嵌套 undefined 的 toolResult 同样能落树', async () => {
    const db = openDb(`session-store-${crypto.randomUUID()}`);
    const tree = await new DexieSessionRepo(db).create({ id: 's4', title: 't' });
    const summary = asMessage({
      role: 'compactionSummary', summary: '摘要', tokensBefore: 100, timestamp: 1,
      retainedTail: [{
        role: 'toolResult', toolCallId: 'c1', toolName: 'demo',
        content: [{ type: 'text', text: 'ok' }], details: { structured: undefined }, isError: false, timestamp: 1,
      }],
    });
    await expect(appendSessionMessage(tree, summary)).resolves.toBeTypeOf('string');
    const { messages } = projectEntries(await tree.findEntriesOnBranch({ order: 'oldestFirst' }));
    expect(messages[0].role).toBe('compactionSummary');
    expect(Object.hasOwn((messages[0] as any).retainedTail[0].details, 'structured')).toBe(false);
  });

  it('sanitize 覆盖不到的形态（NaN）走 JSON 归一化副本落树，而不是让水位线卡死', async () => {
    const db = openDb(`session-store-${crypto.randomUUID()}`);
    const tree = await new DexieSessionRepo(db).create({ id: 's2', title: 't' });
    const message = asMessage({
      role: 'toolResult', toolCallId: 'c1', toolName: 'demo',
      content: [{ type: 'text', text: 'ok' }],
      details: { score: Number.NaN },
      isError: false, timestamp: 1,
    });
    await expect(appendSessionMessage(tree, message)).resolves.toBeTypeOf('string');
    const { messages } = projectEntries(await tree.findEntriesOnBranch({ order: 'oldestFirst' }));
    expect((messages[0] as any).details.score).toBeNull();
  });

  it('JSON 也无法表达的形态（循环引用）仍抛出原始 invalid_payload 错误', async () => {
    const db = openDb(`session-store-${crypto.randomUUID()}`);
    const tree = await new DexieSessionRepo(db).create({ id: 's3', title: 't' });
    const details: Record<string, unknown> = {};
    details.self = details;
    const message = asMessage({
      role: 'toolResult', toolCallId: 'c1', toolName: 'demo',
      content: [{ type: 'text', text: 'ok' }], details, isError: false, timestamp: 1,
    });
    await expect(appendSessionMessage(tree, message)).rejects.toMatchObject({ code: 'invalid_payload' });
  });
});
