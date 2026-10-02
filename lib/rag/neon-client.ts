//
// Neon pgvector client — thin wrapper over `@neondatabase/serverless`.
//
// The serverless driver API split (v1.x):
//   - `sql` is a tagged-template function ONLY:
//       sql`SELECT * FROM t WHERE id = ${id}`
//   - For parameterized queries with $1/$2 placeholders, use `sql.query()`:
//       sql.query('SELECT * FROM t WHERE id = $1', [id])
// We use `sql.query()` because our SQL strings are built dynamically
// (variable column lists for batch INSERTs) — tagged templates would
// require interleaving values into the literal at the call site.
//

import { neon } from '@neondatabase/serverless';
import { retryAsync, withTimeout } from '@/lib/utils';

/** 驱动 `sql.query()` 的可选第三参。只用 `fetchOptions`——driver 会把它 spread
 *  进底层 `fetch`，所以 `signal` 能真正传到网络层。 */
interface NeonQueryOpts {
  fetchOptions?: RequestInit;
}

interface NeonQueryFn {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
    opts?: NeonQueryOpts,
  ): Promise<T[]>;
}

/** 超时按语句类别分档——**不能用统一值**。
 *
 *  一个 15s 的统一上限会掐死 schema 迁移本身：`ALTER COLUMN TYPE` 要重写整张表，
 *  `CREATE INDEX ... hnsw` 要建图，两者在大 collection 上都会远超 15s。
 *
 *  `ddlHeavy` 是「高天花板」而不是「不设限」：`handleTest` 调用
 *  `bootstrapSchema` 时不传 signal，UI 也只有 spinner 没有取消按钮，所以
 *  「靠调用方 signal 兜底」是错的——不设限就会永久挂住。 */
export const QUERY_TIMEOUT_MS = {
  /** SELECT / INSERT / DELETE —— 正常单次往返。 */
  query: 15_000,
  /** CREATE TABLE / ADD COLUMN / CREATE EXTENSION —— 快，但不该被慢网掐死。 */
  ddl: 60_000,
  /** ALTER COLUMN TYPE / CREATE INDEX —— 耗时与表大小成正比。 */
  ddlHeavy: 10 * 60_000,
} as const;

/** Lazily-create a query function for the given connection string.
 *  The driver recommends reusing the same instance for the lifetime of
 *  the script, but for our low-frequency usage (one user action = one
 *  query) a fresh call is fine — it's just a thin wrapper that builds
 *  a fetch request. */
function getSql(connectionString: string): NeonQueryFn {
  if (!connectionString) {
    throw new Error('Neon connection string is empty');
  }
  return neon(connectionString) as unknown as NeonQueryFn;
}

/** 判断一个错误是否值得重试。
 *
 *  按 SQLSTATE 分类，而不是「凡是错就重试」：
 *  - `08*` 连接异常、`53*` 资源不足、`57P0*` 服务端关闭 —— 都是瞬时的，重试有意义；
 *  - 没有 `code` 的是网络层错误（fetch failed / 超时），同样值得重试；
 *  - `42*` 语法/对象不存在、`23*` 约束冲突 —— 重试只会用同样的输入再失败一次，
 *    白白拖延，还掩盖了真正的问题。
 */
export function isRetryableDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  // 没有 code 的是网络层错误（fetch failed / 超时）。
  if (typeof code !== 'string' || code === '') return true;
  return code.startsWith('08') || code.startsWith('53') || code.startsWith('57P0');
}

export interface QueryOptions {
  /** 超时上限。默认 {@link QUERY_TIMEOUT_MS.query}。 */
  timeoutMs?: number;
  /** 是否对瞬时错误重试。**DDL 一律传 `false`**——见 `retryAsync` 的调用点。 */
  retry?: boolean;
  /** 外部取消信号（例如索引进度对话框的取消按钮）。 */
  signal?: AbortSignal;
}

/** Execute a parameterized query and return rows. Throws on connection
 *  or syntax errors. Each call opens a fresh HTTP request (serverless
 *  model — no pooling) which is fine for our low-frequency usage.
 *
 *  默认对瞬时错误重试 3 次（500/1000/2000ms + jitter）。DDL 调用方应显式传
 *  `retry: false`：`CREATE INDEX` 幂等，但超时后盲目重试可能让两个 build 叠在
 *  一起跑，在大表上是实打实的资源事故。 */
export async function query<T = Record<string, unknown>>(
  connectionString: string,
  sqlText: string,
  params: unknown[] = [],
  opts: QueryOptions = {},
): Promise<T[]> {
  const timeoutMs = opts.timeoutMs ?? QUERY_TIMEOUT_MS.query;
  // 超时信号在重试循环**外面**建一次，并同时交给 fetch 与 `retryAsync`。
  //
  // 若只在 `run()` 内部合成，`retryAsync` 拿到的就只是外部 signal，超时对它
  // 不可见：driver 把 abort 包成没有 `code` 的错误，`isRetryableDbError` 判定
  // 「可重试」，于是 15s 超时会再重试两轮，实际拖到约 47s 才报错。而 DB 查询
  // 超时几乎总是「这条查询慢」，不是瞬时抖动，重试买不到任何东西。
  const signal = withTimeout(timeoutMs, opts.signal);
  const run = async () => {
    const sqlFn = getSql(connectionString);
    return sqlFn.query<T>(sqlText, params, { fetchOptions: { signal } });
  };
  if (opts.retry === false) return run();
  return retryAsync(run, {
    attempts: 3,
    baseDelayMs: 500,
    shouldRetry: isRetryableDbError,
    signal,
  });
}

export interface ConnectionTestResult {
  ok: boolean;
  pgvector: boolean;
  version: string;
  error?: string;
}

/** Verify the connection string works and pgvector is enabled. If
 *  pgvector is missing, attempt to auto-create it (Neon's `neondb_owner`
 *  role has CREATE EXTENSION privilege on a fresh database). Only
 *  fall back to the "enable in Neon console" hint when the auto-create
 *  itself fails — that way the happy path is one click instead of a
 *  detour through the Neon dashboard. */
export async function testConnection(connectionString: string): Promise<ConnectionTestResult> {
  if (!connectionString) {
    return { ok: false, pgvector: false, version: '', error: 'Connection string is empty' };
  }
  try {
    const [versionRows, extRows] = await Promise.all([
      query<{ version: string }>(connectionString, 'SELECT version()'),
      query<{ extname: string }>(
        connectionString,
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      ),
    ]);
    if (extRows.length > 0) {
      return {
        ok: true,
        pgvector: true,
        version: versionRows[0]?.version ?? 'unknown',
      };
    }
    // pgvector not yet installed — try auto-create.
    try {
      await query(connectionString, 'CREATE EXTENSION IF NOT EXISTS vector', [], { timeoutMs: QUERY_TIMEOUT_MS.ddl, retry: false });
      return {
        ok: true,
        pgvector: true,
        version: versionRows[0]?.version ?? 'unknown',
      };
    } catch (autoErr) {
      return {
        ok: true,
        pgvector: false,
        version: versionRows[0]?.version ?? 'unknown',
        error: `Connected, but pgvector extension is missing and could not be auto-installed: ${(autoErr as Error).message}. Enable it in your Neon console → Extensions.`,
      };
    }
  } catch (err) {
    return { ok: false, pgvector: false, version: '', error: (err as Error).message };
  }
}

/** 校验嵌入维度。维度会被插值进 DDL，所以必须是正整数——非整数既是
 *  schema 错误也是注入面。校验失败直接抛错，无返回值。 */
function assertDim(dim: number): void {
  if (!Number.isSafeInteger(dim) || dim <= 0) {
    throw new Error(`Embedding dim must be a positive integer, got ${String(dim)}`);
  }
}

/** 非致命问题。必须由调用方展示在 Settings 上——`console.warn` 在 MV3
 *  service worker 里几乎不可见，用户会永远跑 seq-scan 而不知情。
 *
 *  用 code + detail 而不是成品文案：这一层不该产出面向用户的字符串
 *  （i18n 归 UI 层）。 */
export interface BootstrapWarning {
  code: 'hnsw-index-failed' | 'embedder-probe-failed';
  /** 原始错误信息，供 UI 插值展示。 */
  detail: string;
}

export interface BootstrapResult {
  warnings: BootstrapWarning[];
}

/** Idempotent schema bootstrap. Runs once after the user confirms the
 *  connection. `CREATE EXTENSION` and `CREATE TABLE IF NOT EXISTS` are
 *  safe to re-run.
 *
 *  `embedding` 是 `vector(dim)`（有维度），不是 untyped `vector`。untyped
 *  有两个后果，都实测过：pgvector 拒绝在无维度列上建普通索引
 *  （`hnswbuild.c` 里 `atttypmod < 0` → `ereport(ERROR, "column does not
 *  have dimensions")`，于是 `CREATE INDEX ... hnsw` 每次 bootstrap 都失败，
 *  索引根本不存在）；`ALTER COLUMN TYPE` 的按维检查也没有基准可比。而
 *  `embedderDim` 是全局设置，所有 collection 共用同一维度，所谓「多态」没有
 *  任何实际收益。
 *
 *  DDL 顺序：先建必需分支（表 / collection 索引 / 稀疏分支），再迁移 embedding
 *  列，最后才是 HNSW。一条 DDL 失败会中断其后的所有语句——把可能失败的排在
 *  后面，故障半径最小。HNSW 放最后还有一个实际理由：它正是那条在 untyped 列上
 *  注定失败的语句。 */
export async function bootstrapSchema(
  connectionString: string,
  dim: number,
): Promise<BootstrapResult> {
  assertDim(dim);
  const warnings: BootstrapWarning[] = [];

  await query(connectionString, 'CREATE EXTENSION IF NOT EXISTS vector', [], { timeoutMs: QUERY_TIMEOUT_MS.ddl, retry: false });
  await query(
    connectionString,
    `CREATE TABLE IF NOT EXISTS rag_chunks (
       id BIGSERIAL PRIMARY KEY,
       collection TEXT NOT NULL,
       source_path TEXT NOT NULL,
       chunk_index INTEGER NOT NULL,
       content TEXT NOT NULL,
       content_hash TEXT NOT NULL,
       embedding vector(${dim}),
       metadata JSONB,
       created_at TIMESTAMPTZ DEFAULT now(),
       UNIQUE(collection, source_path, chunk_index)
     )`,
    [],
    { timeoutMs: QUERY_TIMEOUT_MS.ddl, retry: false },
  );

  // 读出 embedding 列的 typmod，供下面（稀疏分支之后）决定是否迁移。
  // `CREATE TABLE IF NOT EXISTS` 对已有表是 no-op，所以本次改动之前建的列
  // 仍是 untyped（`atttypmod = -1`），而它无法承载 HNSW 索引。
  const typmodRows = await query<{ atttypmod: number }>(
    connectionString,
    `SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'rag_chunks'::regclass AND attname = 'embedding'`,
  );
  const atttypmod = typmodRows[0]?.atttypmod;

  // B-tree on collection keeps the WHERE-clause selective even when the
  // pgvector cosine scan dominates. Cheap to maintain.
  await query(
    connectionString,
    'CREATE INDEX IF NOT EXISTS rag_chunks_coll_idx ON rag_chunks (collection)',
    [],
    { timeoutMs: QUERY_TIMEOUT_MS.ddlHeavy, retry: false },
  );

  // tsvector column for BM25 full-text search — added in Subtask 2.
  // Generated from `content` so we never have to maintain it manually
  // — Postgres keeps it in sync on every INSERT/UPDATE.
  //
  // The expression includes `COALESCE(metadata->>'context_prefix', '')`
  // deliberately. Contextual Retrieval (Subtask 3) will populate
  // `metadata.context_prefix` for new chunks; the prefix becomes part
  // of the BM25 token stream at zero extra cost. Pre-Subtask-3 rows
  // have `context_prefix` absent → COALESCE returns '' → the column
  // degrades to plain `to_tsvector('simple', content)`. This forward-
  // compat avoids a DROP + ADD COLUMN cycle in Subtask 3 (Postgres
  // will not let us ALTER a generated column's expression in place).
  //
  // `to_tsvector('simple', ...)` uses no stemming — CJK-safe (and
  // fine for English identifiers / code). If a user needs English
  // stemming later they can swap to `'english'`; we deliberately
  // pick `simple` to avoid breaking CJK recall in the default.
  //
  // GIN index on the tsvector column is what makes BM25 fast — the
  // tsvector itself is useless without it. Idempotent.
  await query(
    connectionString,
    `ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS content_tsv tsvector
       GENERATED ALWAYS AS (
         to_tsvector('simple', COALESCE(metadata->>'context_prefix', '') || ' ' || content)
       ) STORED`,
    [],
    { timeoutMs: QUERY_TIMEOUT_MS.ddlHeavy, retry: false },
  );
  await query(
    connectionString,
    'CREATE INDEX IF NOT EXISTS rag_chunks_tsv_idx ON rag_chunks USING gin (content_tsv)',
    [],
    { timeoutMs: QUERY_TIMEOUT_MS.ddlHeavy, retry: false },
  );

  // 迁移已存在的 embedding 列——排在稀疏分支**之后**，与 HNSW 同理：一条
  // DDL 失败会中断它后面的所有语句，而迁移是这里第二容易失败的语句（改维度
  // 时若表内数据宽度不符会直接抛错）。放在稀疏分支后面，迁移失败不会连带
  // 让 BM25 也建不出来。
  //
  // 两种错误形态（untyped 与维度不符）由同一个条件覆盖——untyped 的 `-1`
  // 必然 `!== dim`。`USING` 必需：Postgres 没有 vector → vector(n) 的隐式转换。
  if (atttypmod !== undefined && atttypmod !== dim) {
    // 迁移前先读数据实际宽度。非空表且宽度与目标不符时 `ALTER COLUMN TYPE`
    // 必然抛错——提前报出可操作的错误，胜过先发起一次注定失败的全表重写。
    // 读不到（空表 / 无权限）就当作可迁移，交给 ALTER 自己判定。
    const dataDim = await query<{ dim: number | null }>(
      connectionString,
      'SELECT DISTINCT vector_dims(embedding) AS dim FROM rag_chunks WHERE embedding IS NOT NULL LIMIT 1',
    )
      .then((rows) => rows[0]?.dim ?? null)
      .catch(() => null);

    if (dataDim !== null && dataDim !== dim) {
      throw new Error(
        `The collection holds ${dataDim}-dimension vectors, but the embedder is ` +
          `configured for ${dim}. Vectors cannot be converted between dimensions, so ` +
          `either set "Dimension" in Settings → Knowledge to ${dataDim} to match the ` +
          `existing data, or delete the collection and index it again with the ` +
          `current embedder.`,
      );
    }

    // `ALTER COLUMN TYPE` 会重写整张表——大 collection 上耗时与表大小成正比。
    console.warn(
      `[RAG schema] migrating embedding column atttypmod=${atttypmod} → vector(${dim}); ` +
        'this rewrites the whole table',
    );
    try {
      await query(
        connectionString,
        `ALTER TABLE rag_chunks ALTER COLUMN embedding TYPE vector(${dim}) USING embedding::vector(${dim})`,
        [],
        { timeoutMs: QUERY_TIMEOUT_MS.ddlHeavy, retry: false },
      );
    } catch (err) {
      throw new Error(
        `Failed to migrate the embedding column to vector(${dim}): ${(err as Error).message}`,
      );
    }
  }

  // HNSW index on the embedding column — 放在最后，且失败只记 warning。
  //
  // 顺序原则：一条 DDL 失败会中断它后面的所有语句，所以最容易失败的语句不该
  // 排在必需语句前面。HNSW 依赖 pgvector 版本与 build 内存，是这里最容易失败
  // 的一条，因此排最后——它失败只损失 dense 分支，稀疏分支（BM25）已建好。
  //
  // 用 `<=>`（cosine）操作符类，与 `retrieve()` 的查询一致。`m=16` /
  // `ef_construction=64` 是 pgvector 推荐起点，v1 不需要调。
  try {
    await query(
      connectionString,
      'CREATE INDEX IF NOT EXISTS rag_chunks_hnsw_idx ON rag_chunks USING hnsw (embedding vector_cosine_ops)',
      [],
      { timeoutMs: QUERY_TIMEOUT_MS.ddlHeavy, retry: false },
    );
  } catch (err) {
    warnings.push({ code: 'hnsw-index-failed', detail: (err as Error).message });
  }

  return { warnings };
}

/** Drop all chunks belonging to a collection. Used by the "Delete
 *  collection" UI action. Returns the number of chunks deleted. */
export async function deleteCollectionChunks(
  connectionString: string,
  collection: string,
): Promise<number> {
  const rows = await query<{ id: string }>(
    connectionString,
    'DELETE FROM rag_chunks WHERE collection = $1 RETURNING id',
    [collection],
  );
  return rows.length;
}

/** 一行已存在的 chunk 的**轻量**视图——刻意**不含向量**。
 *
 *  1536 维向量转成文本约 15 KB/行；一个 10k chunk 的 collection 全量拉进
 *  service worker 就是约 150 MB，足以让 MV3 side panel 被杀。向量只在确定要
 *  复用哪些 chunk 之后按批取（见 `fetchEmbeddings`）。
 *
 *  `metadata` 里的字段在 SQL 侧拍平成独立列，避免把整个 JSONB（含体积最大的
 *  `context_prefix`）传过来再在 JS 里拆。 */
export interface ExistingChunkRow {
  source_path: string;
  chunk_index: number;
  content_hash: string;
  model: string | null;
  dim: number | null;
  heading_path: string | null;
  llm_prefix: string | null;
  doc_hash: string | null;
}

/** 一次性读取整个 collection 的存在性 + 复用所需字段，供 `planIndex` 决策。
 *
 *  返回原样的行；调用方负责映射成 `ExistingChunk`。**不要**在这里加
 *  `embedding`——见 `ExistingChunkRow` 的说明。 */
export async function listCollectionChunks(
  connectionString: string,
  collection: string,
): Promise<ExistingChunkRow[]> {
  return query<ExistingChunkRow>(
    connectionString,
    `SELECT source_path,
            chunk_index,
            content_hash,
            metadata->>'embedModel'    AS model,
            (metadata->>'embedDim')::int AS dim,
            metadata->>'heading_path'  AS heading_path,
            metadata->>'llm_prefix'    AS llm_prefix,
            metadata->>'doc_hash'      AS doc_hash
       FROM rag_chunks WHERE collection = $1
      ORDER BY source_path, chunk_index`,
    [collection],
  );
}

/** 按批取回指定 chunk 的向量文本，用于复用。**只取要复用的那些**——这是
 *  与「全量拉向量」的关键差别（见 `ExistingChunkRow`）。
 *
 *  返回 `Map<chunk_index, 向量字面量>`。 */
export async function fetchEmbeddings(
  connectionString: string,
  collection: string,
  sourcePath: string,
  chunkIndexes: number[],
): Promise<Map<number, string>> {
  if (chunkIndexes.length === 0) return new Map();
  const rows = await query<{ chunk_index: number; emb: string }>(
    connectionString,
    `SELECT chunk_index, embedding::text AS emb
       FROM rag_chunks
      WHERE collection = $1 AND source_path = $2 AND chunk_index = ANY($3::int[])`,
    [collection, sourcePath, chunkIndexes],
  );
  const out = new Map<number, string>();
  for (const r of rows) out.set(r.chunk_index, r.emb);
  return out;
}

/** 裁掉某个文件尾部多余的 chunk（文件变短时）。`chunk_index` 恒为
 *  `0..N-1` 的连续前缀，所以删 `>= fromIndex` 恰好留下新的 `0..N-1`。
 *  作用域被 `source_path` 锁死，不可能波及其他文件。 */
export async function deleteChunksFromIndex(
  connectionString: string,
  collection: string,
  sourcePath: string,
  fromIndex: number,
): Promise<number> {
  const rows = await query<{ id: string }>(
    connectionString,
    `DELETE FROM rag_chunks
      WHERE collection = $1 AND source_path = $2 AND chunk_index >= $3
      RETURNING id`,
    [collection, sourcePath, fromIndex],
  );
  return rows.length;
}

/** 按 `source_path` 精确删除（同步模式下，用户确认过的那批文件）。
 *  `ANY($2)` 只作用于确认列表里的路径——调用方必须先让用户看过这份列表。 */
export async function deleteChunksByPaths(
  connectionString: string,
  collection: string,
  sourcePaths: string[],
): Promise<number> {
  if (sourcePaths.length === 0) return 0;
  const rows = await query<{ id: string }>(
    connectionString,
    'DELETE FROM rag_chunks WHERE collection = $1 AND source_path = ANY($2::text[]) RETURNING id',
    [collection, sourcePaths],
  );
  return rows.length;
}

/** Count chunks in a collection. Used to refresh the UI after
 *  indexing or deletion. */
export async function countCollectionChunks(
  connectionString: string,
  collection: string,
): Promise<number> {
  const rows = await query<{ count: string }>(
    connectionString,
    'SELECT count(*)::text AS count FROM rag_chunks WHERE collection = $1',
    [collection],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/** Format a `number[]` into the Postgres `vector` literal shape:
 *  `[0.1,0.2,...]`. Used at INSERT time. pgvector accepts the array
 *  literal directly when cast to `vector` in the SQL. */
export function embeddingToVectorLiteral(embedding: number[]): string {
  // Limit precision to 6 decimal places — beyond that the cosine
  // operator's float4 rounding dominates and we're wasting bytes.
  const parts = new Array<string>(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    parts[i] = embedding[i]!.toFixed(6);
  }
  return `[${parts.join(',')}]`;
}
