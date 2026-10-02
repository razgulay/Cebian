import { afterEach, describe, expect, it, vi } from 'vitest';
import * as neonClient from './neon-client';
import { indexCollection, IndexCancelledError } from './indexer';
import type { Embedder } from './embedder';

/** `indexCollection` 的删除行为是本阶段最危险的部分——判错就静默删数据。
 *  这里覆盖的是「什么时候**不**删」以及删除的**作用域**，而不是 happy path。
 *
 *  用 `vi.mock` 换掉 driver 而不是 spy `neonClient` 命名空间：`indexer.ts` 从
 *  `./neon-client` 具名导入，spy 命名空间拦不住已绑定的引用。 */
const queryMock = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: () => ({ query: queryMock }),
}));

describe('indexCollection — 删除边界', () => {
  const CS = 'postgresql://user:pass@host.tld/db';

  /** 记录所有 SQL，并按内容给出应答。 */
  interface Captured {
    sql: string;
    params: unknown[];
  }

  function mockDb(opts: { existingRows?: unknown[] } = {}) {
    const calls: Captured[] = [];
    queryMock.mockImplementation(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      // pre-query：返回已有的轻量行
      if (sql.includes("metadata->>'embedModel'")) {
        return opts.existingRows ?? [];
      }
      if (sql.includes('DELETE')) return [{ id: '1' }];
      return [];
    });
    return calls;
  }

  const deletes = (calls: Captured[]) => calls.filter((c) => c.sql.includes('DELETE'));

  /** 桩 embedder——每个输入返回一个定长向量。 */
  const embedder: Embedder = {
    model: 'stub',
    dim: 4,
    async embed(texts: string[]) {
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    },
  };

  function fileOf(name: string, body: string): File {
    return new File([body], name, { type: 'text/plain' });
  }

  afterEach(() => {
    queryMock.mockReset();
  });

  it('activePaths 为空时不发任何 DELETE', async () => {
    // 最便宜也最重要的一条：绝不基于空集合删数据。
    const calls = mockDb();
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [], // 没选任何文件
      chunkSize: 800,
      chunkOverlap: 100,
      syncMode: true, // 即使显式要求同步
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('默认模式（syncMode 未传）→ 不删除 collection 里已有的其他文件', async () => {
    // collection 里已有 a.txt；本次只索引 c.txt。a.txt 必须原样保留。
    const calls = mockDb({
      existingRows: [
        { source_path: 'a.txt', chunk_index: 0, content_hash: 'x', metadata: {} },
        { source_path: 'a.txt', chunk_index: 1, content_hash: 'y', metadata: {} },
      ],
    });
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('c.txt', 'nội dung mới')],
      chunkSize: 800,
      chunkOverlap: 100,
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('文件变短 → 只裁自己的尾部，且带 source_path 作用域', async () => {
    // a.txt 上次 3 个 chunk，这次内容变短只产出 1 个 → 删 chunk_index >= 1。
    const calls = mockDb({
      existingRows: [
        { source_path: 'a.txt', chunk_index: 0, content_hash: 'h0', metadata: {} },
        { source_path: 'a.txt', chunk_index: 1, content_hash: 'h1', metadata: {} },
        { source_path: 'a.txt', chunk_index: 2, content_hash: 'h2', metadata: {} },
      ],
    });
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('a.txt', 'ngắn')],
      chunkSize: 800,
      chunkOverlap: 100,
    });
    const dels = deletes(calls);
    expect(dels).toHaveLength(1);
    expect(dels[0]!.sql).toContain('source_path = $2');
    expect(dels[0]!.sql).toContain('chunk_index >= $3');
    expect(dels[0]!.params).toEqual(['c', 'a.txt', 1]);
  });

  it('同步模式 + 用户确认 → 删除未选中的文件', async () => {
    const calls = mockDb({
      existingRows: [
        { source_path: 'a.txt', chunk_index: 0, content_hash: 'h', metadata: {} },
      ],
    });
    const confirmPrune = vi.fn().mockResolvedValue(true);
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('c.txt', 'nội dung')],
      chunkSize: 800,
      chunkOverlap: 100,
      syncMode: true,
      confirmPrune,
    });
    expect(confirmPrune).toHaveBeenCalledWith([{ path: 'a.txt', chunks: 1 }]);
    const dels = deletes(calls);
    expect(dels.some((d) => d.sql.includes('ANY($2::text[])'))).toBe(true);
  });

  it('同步模式 + 用户拒绝 → 整轮取消，一个字节都不写', async () => {
    const calls = mockDb({
      existingRows: [
        { source_path: 'a.txt', chunk_index: 0, content_hash: 'h', metadata: {} },
      ],
    });
    const confirmPrune = vi.fn().mockResolvedValue(false);
    await expect(
      indexCollection({
        connectionString: CS,
        collection: 'c',
        embedder,
        files: [fileOf('c.txt', 'nội dung')],
        chunkSize: 800,
        chunkOverlap: 100,
        syncMode: true,
        confirmPrune,
      }),
    ).rejects.toThrow(IndexCancelledError);
    // 关键：拒绝后既没有 DELETE，也没有 INSERT。
    expect(deletes(calls)).toEqual([]);
    expect(calls.some((c) => c.sql.includes('INSERT INTO rag_chunks'))).toBe(false);
  });

  it('confirmPrune 在第一条 INSERT 之前被调用', async () => {
    // 顺序是安全性的核心：确认必须在**任何写入之前**。若反过来（先写再确认），
    // 用户拒绝时旧数据已被覆盖，无法回滚。
    const calls = mockDb({
      existingRows: [
        { source_path: 'a.txt', chunk_index: 0, content_hash: 'h', metadata: {} },
      ],
    });
    const confirmPrune = vi.fn().mockResolvedValue(true);
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('c.txt', 'nội dung')],
      chunkSize: 800,
      chunkOverlap: 100,
      syncMode: true,
      confirmPrune,
    });

    const insertOrder = queryMock.mock.invocationCallOrder[
      calls.findIndex((c) => c.sql.includes('INSERT INTO rag_chunks'))
    ]!;
    const confirmOrder = confirmPrune.mock.invocationCallOrder[0]!;
    expect(confirmOrder).toBeLessThan(insertOrder);
  });

  it('同步模式但无文件被删 → 不弹确认框', async () => {
    const calls = mockDb({ existingRows: [] });
    const confirmPrune = vi.fn().mockResolvedValue(true);
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('c.txt', 'nội dung')],
      chunkSize: 800,
      chunkOverlap: 100,
      syncMode: true,
      confirmPrune,
    });
    expect(confirmPrune).not.toHaveBeenCalled();
    expect(deletes(calls)).toEqual([]);
  });

  it('同步模式下即使本轮产出 0 chunk，仍执行 prune', async () => {
    // 扫描版 PDF 没有文字层 → chunks 为空。但用户勾了同步，文件不在选择里
    // 就该被删——否则「删掉文件后用同步重跑」永远删不掉。
    const calls = mockDb({
      existingRows: [
        { source_path: 'gone.txt', chunk_index: 0, content_hash: 'h', metadata: {} },
      ],
    });
    const confirmPrune = vi.fn().mockResolvedValue(true);
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('empty.txt', '')], // 提取不出任何 chunk
      chunkSize: 800,
      chunkOverlap: 100,
      syncMode: true,
      confirmPrune,
    });
    expect(confirmPrune).toHaveBeenCalled();
    expect(deletes(calls).some((d) => d.sql.includes('ANY($2::text[])'))).toBe(true);
  });

  it('同步删除成功后，notInLastRun 不再列出刚被删掉的文件', async () => {
    // 回归：否则 collection 行会在删完之后仍提示「有 N 个源不在最近一次索引中」，
    // 指着刚刚被删掉的文件，自相矛盾。
    const calls = mockDb({
      existingRows: [
        { source_path: 'gone.txt', chunk_index: 0, metadata: {} },
        { source_path: 'gone.txt', chunk_index: 1, metadata: {} },
      ],
    });
    const result = await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('c.txt', 'nội dung')],
      chunkSize: 800,
      chunkOverlap: 100,
      syncMode: true,
      confirmPrune: vi.fn().mockResolvedValue(true),
    });
    expect(calls.some((c) => c.sql.includes('ANY($2::text[])'))).toBe(true);
    expect(result.notInLastRun).toEqual([]);
  });

  it('非同步模式下 notInLastRun 仍列出未选中的文件（提示用户该清理）', async () => {
    mockDb({
      existingRows: [{ source_path: 'kept.txt', chunk_index: 0, metadata: {} }],
    });
    const result = await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('c.txt', 'nội dung')],
      chunkSize: 800,
      chunkOverlap: 100,
    });
    expect(result.notInLastRun).toEqual([{ path: 'kept.txt', chunks: 1 }]);
  });

  it('无 confirmPrune 通道时不删除（fail-closed）', async () => {
    const calls = mockDb({
      existingRows: [{ source_path: 'kept.txt', chunk_index: 0, metadata: {} }],
    });
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('c.txt', 'nội dung')],
      chunkSize: 800,
      chunkOverlap: 100,
      syncMode: true,
      // 故意不传 confirmPrune——没有确认通道就不该删。
    });
    expect(deletes(calls)).toEqual([]);
  });

  it('pre-query 不取 embedding（全量向量会撑爆 MV3 service worker）', async () => {
    const calls = mockDb();
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('c.txt', 'nội dung')],
      chunkSize: 800,
      chunkOverlap: 100,
    });
    const pre = calls.find((c) => c.sql.includes("metadata->>'embedModel'"));
    expect(pre).toBeDefined();
    expect(pre!.sql).not.toContain('embedding');
  });

  it('pre-query 对整轮只发一次，不是每文件一次', async () => {
    const calls = mockDb();
    await indexCollection({
      connectionString: CS,
      collection: 'c',
      embedder,
      files: [fileOf('a.txt', 'aaa'), fileOf('b.txt', 'bbb')],
      chunkSize: 800,
      chunkOverlap: 100,
    });
    const pres = calls.filter((c) => c.sql.includes("metadata->>'embedModel'"));
    expect(pres).toHaveLength(1);
  });
});
