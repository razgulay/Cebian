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

interface NeonQueryFn {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

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

/** Execute a parameterized query and return rows. Throws on connection
 *  or syntax errors. Each call opens a fresh HTTP request (serverless
 *  model — no pooling) which is fine for our low-frequency usage. */
export async function query<T = Record<string, unknown>>(
  connectionString: string,
  sqlText: string,
  params: unknown[] = [],
): Promise<T[]> {
  const sqlFn = getSql(connectionString);
  return sqlFn.query<T>(sqlText, params);
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
    const versionRows = await query<{ version: string }>(connectionString, 'SELECT version()');
    const extRows = await query<{ extname: string }>(
      connectionString,
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    if (extRows.length > 0) {
      return {
        ok: true,
        pgvector: true,
        version: versionRows[0]?.version ?? 'unknown',
      };
    }
    // pgvector not yet installed — try auto-create.
    try {
      await query(connectionString, 'CREATE EXTENSION IF NOT EXISTS vector');
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

/** Idempotent schema bootstrap. Runs once after the user confirms the
 *  connection. `CREATE EXTENSION` and `CREATE TABLE IF NOT EXISTS` are
 *  safe to re-run. We use `vector` (untyped) for the embedding column
 *  so a single table serves models of any dim — `metadata.embedDim`
 *  records the per-collection dim for validation at insert time. */
export async function bootstrapSchema(connectionString: string): Promise<void> {
  await query(connectionString, 'CREATE EXTENSION IF NOT EXISTS vector');
  await query(
    connectionString,
    `CREATE TABLE IF NOT EXISTS rag_chunks (
       id BIGSERIAL PRIMARY KEY,
       collection TEXT NOT NULL,
       source_path TEXT NOT NULL,
       chunk_index INTEGER NOT NULL,
       content TEXT NOT NULL,
       content_hash TEXT NOT NULL,
       embedding vector,
       metadata JSONB,
       created_at TIMESTAMPTZ DEFAULT now(),
       UNIQUE(collection, source_path, chunk_index)
     )`,
  );
  // B-tree on collection keeps the WHERE-clause selective even when the
  // pgvector cosine scan dominates. Cheap to maintain.
  await query(
    connectionString,
    'CREATE INDEX IF NOT EXISTS rag_chunks_coll_idx ON rag_chunks (collection)',
  );
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

/** Rename a collection in Neon by rewriting the `collection` column
 *  on every matching chunk. pgvector doesn't expose a "rename
 *  collection" primitive (collection is just a TEXT label, not a
 *  schema object) so we run an in-place UPDATE. Idempotent — calling
 *  with `newName === oldName` is a no-op.
 *
 *  Returns the number of rows updated. Caller should ensure no
 *  collection with `newName` already exists; if it does, the UNIQUE
 *  constraint `(collection, source_path, chunk_index)` will fire and
 *  the UPDATE will fail atomically (no partial writes). */
export async function renameCollectionChunks(
  connectionString: string,
  oldName: string,
  newName: string,
): Promise<number> {
  if (oldName === newName) return 0;
  const rows = await query<{ id: string }>(
    connectionString,
    'UPDATE rag_chunks SET collection = $1 WHERE collection = $2 RETURNING id',
    [newName, oldName],
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
