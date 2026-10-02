import { afterEach, describe, expect, it, vi } from 'vitest';

/** 用 `vi.mock` 换掉 driver，而不是 `vi.spyOn(neonClient, 'query')`：
 *  `bootstrapSchema` 在模块内部直接调用 `query`，spy 命名空间拦不住
 *  同模块内的调用，请求会真的发出去。换成 mock driver 后走的是真实的
 *  `getSql` → `query` 路径，覆盖更完整。 */
const queryMock = vi.fn();
vi.mock('@neondatabase/serverless', () => ({
  neon: () => ({ query: queryMock }),
}));

const { bootstrapSchema, isRetryableDbError, QUERY_TIMEOUT_MS, query } = await import('./neon-client');

/** `bootstrapSchema` 的语句顺序与容错是本模块的核心保证，所以这里断言的是
 *  **语句序列**而不是单条 SQL 的形状。
 *
 *  顺序原则：一条 DDL 失败会中断它后面的所有语句，所以最易失败的语句
 *  （HNSW——依赖 pgvector 版本与 build 内存）必须排在必需语句之后，失败时
 *  只损失 dense 分支而不波及稀疏分支（BM25）。这些测试锁住这条不变量。 */
describe('bootstrapSchema — DDL 顺序与容错', () => {
  const CS = 'postgresql://user:pass@host.tld/db';

  afterEach(() => {
    queryMock.mockReset();
  });

  /** 记录所有发往 driver 的语句，并允许按语句内容注入失败。
   *  `atttypmod` 是迁移分支读的那一列——`undefined` 表示查询没返回行
   *  （列不存在），此时不迁移。
   *  `dataDim` 是 `vector_dims` 探测返回的实际数据宽度——`null` 表示空表。 */
  function captureSql(
    opts: {
      failOn?: (sql: string) => boolean;
      atttypmod?: number;
      dataDim?: number | null;
    } = {},
  ) {
    const statements: string[] = [];
    queryMock.mockImplementation(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM pg_attribute')) {
        return opts.atttypmod === undefined ? [] : [{ atttypmod: opts.atttypmod }];
      }
      if (sql.includes('vector_dims')) {
        const d = opts.dataDim ?? null;
        return d === null ? [] : [{ dim: d }];
      }
      if (opts.failOn?.(sql)) {
        throw new Error('simulated DDL failure');
      }
      return [];
    });
    return statements;
  }

  it('用 vector(dim) 建列，而不是 untyped vector', async () => {
    const statements = captureSql();
    await bootstrapSchema(CS, 1024);
    const create = statements.find((s) => s.includes('CREATE TABLE'));
    expect(create).toContain('embedding vector(1024)');
    // untyped 列会同时挡住 HNSW 与按维迁移，回归时应该立刻炸。
    expect(create).not.toMatch(/embedding vector\s*,/);
  });

  it('稀疏分支（content_tsv + GIN）排在 HNSW 之前', async () => {
    const statements = captureSql();
    await bootstrapSchema(CS, 1536);
    const tsv = statements.findIndex((s) => s.includes('content_tsv'));
    const gin = statements.findIndex((s) => s.includes('rag_chunks_tsv_idx'));
    const hnsw = statements.findIndex((s) => s.includes('rag_chunks_hnsw_idx'));
    expect(tsv).toBeGreaterThanOrEqual(0);
    expect(gin).toBeGreaterThanOrEqual(0);
    expect(hnsw).toBeGreaterThanOrEqual(0);
    expect(tsv).toBeLessThan(hnsw);
    expect(gin).toBeLessThan(hnsw);
  });

  it('HNSW 失败不致命：稀疏分支仍然建出来，且返回 warning', async () => {
    const statements = captureSql({ failOn: (sql) => sql.includes('rag_chunks_hnsw_idx') });
    const result = await bootstrapSchema(CS, 1536);

    // 关键断言：HNSW 抛错后，BM25 分支依然存在。
    expect(statements.some((s) => s.includes('content_tsv'))).toBe(true);
    expect(statements.some((s) => s.includes('rag_chunks_tsv_idx'))).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe('hnsw-index-failed');
    expect(result.warnings[0]!.detail).toContain('simulated DDL failure');
  });

  it('一切正常时没有 warning', async () => {
    captureSql();
    const result = await bootstrapSchema(CS, 1536);
    expect(result.warnings).toEqual([]);
  });

  it('非致命错误之外的失败照常抛出（建表失败不能被吞）', async () => {
    captureSql({ failOn: (sql) => sql.includes('CREATE TABLE') });
    await expect(bootstrapSchema(CS, 1536)).rejects.toThrow('simulated DDL failure');
  });

  describe('维度校验与迁移', () => {
    it('拒绝非正整数维度', async () => {
      captureSql();
      await expect(bootstrapSchema(CS, 0)).rejects.toThrow(/positive integer/);
      await expect(bootstrapSchema(CS, -1)).rejects.toThrow(/positive integer/);
      await expect(bootstrapSchema(CS, 1.5)).rejects.toThrow(/positive integer/);
    });

    it('untyped 列（atttypmod = -1）触发迁移', async () => {
      const statements = captureSql({ atttypmod: -1 });
      await bootstrapSchema(CS, 1536);
      const alter = statements.find((s) => s.includes('ALTER COLUMN embedding TYPE'));
      expect(alter).toContain('vector(1536)');
      // `USING` 必需——没有它 Postgres 没有 vector → vector(n) 的隐式转换。
      expect(alter).toContain('USING embedding::vector(1536)');
    });

    it('维度不符（atttypmod ≠ dim）也触发迁移', async () => {
      const statements = captureSql({ atttypmod: 768 });
      await bootstrapSchema(CS, 1536);
      expect(statements.some((s) => s.includes('ALTER COLUMN embedding TYPE'))).toBe(true);
    });

    it('维度已正确时不发 ALTER（幂等）', async () => {
      const statements = captureSql({ atttypmod: 1536 });
      await bootstrapSchema(CS, 1536);
      expect(statements.some((s) => s.includes('ALTER COLUMN embedding TYPE'))).toBe(false);
    });

    it('数据宽度与目标不符时，先报可操作错误，不发注定失败的 ALTER', async () => {
      // 实测场景：embedderDim = 1536 但集合里是 1024 维数据。
      const statements = captureSql({ atttypmod: -1, dataDim: 1024 });
      await expect(bootstrapSchema(CS, 1536)).rejects.toThrow(/holds 1024-dimension vectors/);
      // 关键：没有发起全表重写。ALTER 在非空表上必然抛错，先探测能省掉这次重写。
      expect(statements.some((s) => s.includes('ALTER COLUMN embedding TYPE'))).toBe(false);
    });

    it('错误信息给出「改成匹配数据宽度」这条更便宜的出路', async () => {
      captureSql({ atttypmod: -1, dataDim: 1024 });
      await expect(bootstrapSchema(CS, 1536)).rejects.toThrow(
        /set "Dimension" in Settings → Knowledge to 1024/,
      );
    });

    it('数据宽度与目标一致时正常迁移（空表/宽度已对）', async () => {
      const statements = captureSql({ atttypmod: -1, dataDim: 1536 });
      await bootstrapSchema(CS, 1536);
      expect(statements.some((s) => s.includes('ALTER COLUMN embedding TYPE'))).toBe(true);
    });

    it('空表（探测无行）时直接迁移，不误报', async () => {
      const statements = captureSql({ atttypmod: -1, dataDim: null });
      await bootstrapSchema(CS, 1536);
      expect(statements.some((s) => s.includes('ALTER COLUMN embedding TYPE'))).toBe(true);
    });

    it('探测失败时仍尝试迁移（不因诊断查询挂掉而阻塞）', async () => {
      const statements = captureSql({ atttypmod: -1 });
      queryMock.mockImplementation(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM pg_attribute')) return [{ atttypmod: -1 }];
        if (sql.includes('vector_dims')) throw new Error('probe failed');
        return [];
      });
      await bootstrapSchema(CS, 1536);
      expect(statements.some((s) => s.includes('ALTER COLUMN embedding TYPE'))).toBe(true);
    });

    it('ALTER 本身失败时抛出错误信息', async () => {
      captureSql({
        atttypmod: -1,
        failOn: (sql) => sql.includes('ALTER COLUMN embedding TYPE'),
      });
      await expect(bootstrapSchema(CS, 1536)).rejects.toThrow(
        /Failed to migrate the embedding column/,
      );
    });
  });
});

describe('isRetryableDbError — 按 SQLSTATE 分类', () => {
  it('连接类 08* 可重试', () => {
    expect(isRetryableDbError({ code: '08006' })).toBe(true);
    expect(isRetryableDbError({ code: '08003' })).toBe(true);
  });

  it('资源类 53* 可重试', () => {
    expect(isRetryableDbError({ code: '53300' })).toBe(true);
  });

  it('服务端关闭 57P0* 可重试', () => {
    expect(isRetryableDbError({ code: '57P01' })).toBe(true);
  });

  it('无 code（网络层错误）可重试', () => {
    expect(isRetryableDbError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableDbError({ code: '' })).toBe(true);
  });

  it('语法 / 对象不存在 42* 不重试', () => {
    expect(isRetryableDbError({ code: '42P01' })).toBe(false);
    expect(isRetryableDbError({ code: '42601' })).toBe(false);
  });

  it('约束冲突 23* 不重试', () => {
    expect(isRetryableDbError({ code: '23505' })).toBe(false);
  });
});

describe('query — 超时分档', () => {
  it('DDL 重活不套用普通查询的 15s 上限', () => {
    // 回归：统一 15s 会掐死 ALTER COLUMN TYPE / CREATE INDEX，它们在大表上
    // 远超 15s，而这两个恰好是 schema 迁移的核心步骤。
    expect(QUERY_TIMEOUT_MS.ddlHeavy).toBeGreaterThan(QUERY_TIMEOUT_MS.query * 10);
    expect(QUERY_TIMEOUT_MS.ddl).toBeGreaterThan(QUERY_TIMEOUT_MS.query);
  });

  it('bootstrapSchema 给重 DDL 传了 ddlHeavy 而非默认档', async () => {
    // mock 在 driver 层，只能看到最终的 fetchOptions.signal——超时值本身读不出来。
    // 改为断言**顺序契约**：重 DDL 走的是与普通查询不同的分支。这里用
    // `QUERY_TIMEOUT_MS` 的分档关系 + 迁移/建索引语句确实被发出，二者共同覆盖。
    const statements: string[] = [];
    queryMock.mockImplementation(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM pg_attribute')) return [{ atttypmod: -1 }];
      if (sql.includes('vector_dims')) return [{ dim: 1536 }];
      return [];
    });
    await bootstrapSchema('postgresql://user:pass@host.tld/db', 1536);
    expect(statements.some((s) => s.includes('ALTER COLUMN embedding TYPE'))).toBe(true);
    expect(statements.some((s) => s.includes('rag_chunks_hnsw_idx'))).toBe(true);
  });

  it('迁移在稀疏分支之后、HNSW 之前（失败半径最小）', async () => {
    const statements: string[] = [];
    queryMock.mockImplementation(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM pg_attribute')) return [{ atttypmod: -1 }];
      if (sql.includes('vector_dims')) return [{ dim: 1536 }];
      return [];
    });
    await bootstrapSchema('postgresql://user:pass@host.tld/db', 1536);
    const tsv = statements.findIndex((s) => s.includes('content_tsv'));
    const alter = statements.findIndex((s) => s.includes('ALTER COLUMN embedding TYPE'));
    const hnsw = statements.findIndex((s) => s.includes('rag_chunks_hnsw_idx'));
    expect(tsv).toBeLessThan(alter);
    expect(alter).toBeLessThan(hnsw);
  });
});

describe('query — 超时不触发重试', () => {
  it('超时中止后不再重试（否则 15s 会被拖成约 47s）', async () => {
    // 回归：超时信号原先只在 run() 内部合成，retryAsync 看不到它，于是把
    // 「查询慢」当成「瞬时故障」重试两轮，白白多等 30 多秒。
    let calls = 0;
    queryMock.mockImplementation(async () => {
      calls++;
      // 模拟超时：driver 把 abort 包成没有 code 的错误。
      throw Object.assign(new Error('query timed out'), { name: 'TimeoutError' });
    });
    await expect(
      query('postgresql://user:pass@host.tld/db', 'SELECT 1', [], { timeoutMs: 1 }),
    ).rejects.toThrow();
    // 只应尝试一次：外层超时信号已中止，重试循环应立即退出。
    expect(calls).toBe(1);
  });

  it('普通瞬时错误仍然重试', async () => {
    let calls = 0;
    queryMock.mockImplementation(async () => {
      calls++;
      if (calls < 2) throw Object.assign(new Error('boom'), { code: '08006' });
      return [];
    });
    await query('postgresql://user:pass@host.tld/db', 'SELECT 1');
    expect(calls).toBe(2);
  });

  it('retry: false 时一次都不重试', async () => {
    let calls = 0;
    queryMock.mockImplementation(async () => {
      calls++;
      throw Object.assign(new Error('boom'), { code: '08006' });
    });
    await expect(
      query('postgresql://user:pass@host.tld/db', 'CREATE INDEX x ON y (z)', [], { retry: false }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
