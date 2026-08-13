//
// `rag_inspect` tool — let the LLM see RAG collection metadata (file
// list + chunk counts + embedder model + dimension) without falling
// back to fs_list/fs_search. fs_* only sees the virtual filesystem
// under /home/user/..., so it cannot answer "what files are in
// <collection>?" — that question used to make the LLM call fs_* and
// mislabel the VFS results as "RAG search results".
//
// This tool is read-only against Neon (uses `query()` from
// neon-client.ts) and returns a structured text block listing each
// file's source path + chunk count, the total chunk count, and the
// embedder model + dimension pulled from the chunk metadata JSONB.
// It does NOT return chunk text — chunks arrive via the
// <attached-rag-context> envelope at send-time. Keeping this tool
// metadata-only prevents the LLM from double-counting context and
// keeps the tool cheap (two queries: a GROUP BY and a single-row
// metadata peek).
//

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_RAG_INSPECT } from '@/lib/tools/names';
import { query } from '@/lib/rag/neon-client';
import { ragSettings } from '@/lib/rag';

const RagInspectParameters = Type.Object({
  collection: Type.String({
    description:
      'Name of the RAG collection to inspect (e.g. "phaply"). ' +
      'This is the slug the user picked when creating the collection — ' +
      'lowercase ASCII letters/digits/dashes/underscores, must start with letter or digit.',
  }),
});

/** Row shape returned by the GROUP BY query. */
interface CollectionFileRow {
  source_path: string;
  chunk_count: number;
}

/** Row shape returned by the metadata peek. The metadata JSONB is
 *  written by the indexer with `embedModel` + `embedDim` keys. */
interface MetadataRow {
  metadata: { embedModel?: string; embedDim?: number } | null;
  created_at: string;
}

export const ragInspectTool: AgentTool<typeof RagInspectParameters> = {
  name: TOOL_RAG_INSPECT,
  label: 'Inspect RAG collection',
  description:
    'List files + chunk counts in a named RAG collection, plus the embedder model and dimension used at index time. ' +
    'RAG collections live in Neon pgvector — they are NOT mirrored to VFS. fs_list / fs_search / fs_read_file will not see RAG content; ' +
    'use this tool for any question about what files are in a collection, how many chunks it has, or which embedder indexed it. ' +
    'Returns file paths + chunk counts only — chunk text arrives via <attached-rag-context> when the user pins or attaches the collection.',
  parameters: RagInspectParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
    signal?.throwIfAborted();

    const settings = await ragSettings.getValue();
    if (!settings.neonConnectionString) {
      throw new Error(
        'RAG is not configured — open Settings → Knowledge and paste your Neon connection string.',
      );
    }

    // Run the two queries in parallel — they hit the same table on the
    // same partition key and the planner caches them independently.
    const [fileRows, metaRows] = await Promise.all([
      query<CollectionFileRow>(
        settings.neonConnectionString,
        `SELECT source_path, count(*)::int AS chunk_count
           FROM rag_chunks
          WHERE collection = $1
          GROUP BY source_path
          ORDER BY source_path`,
        [params.collection],
      ),
      query<MetadataRow>(
        settings.neonConnectionString,
        `SELECT metadata, created_at
           FROM rag_chunks
          WHERE collection = $1
          ORDER BY created_at ASC
          LIMIT 1`,
        [params.collection],
      ),
    ]);

    if (fileRows.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `Collection '${params.collection}' exists but is empty (no chunks indexed yet).`,
          },
        ],
        details: {},
      };
    }

    const totalChunks = fileRows.reduce((s, r) => s + r.chunk_count, 0);
    const meta = metaRows[0]?.metadata ?? null;
    const embedModel = meta?.embedModel ?? 'unknown';
    const embedDim = meta?.embedDim ?? 'unknown';
    const oldestChunk = metaRows[0]?.created_at ?? null;

    const lines: string[] = [];
    lines.push(`Collection: ${params.collection}`);
    lines.push(`Total chunks: ${totalChunks} across ${fileRows.length} file(s)`);
    lines.push(`Embedder: ${embedModel} (dim=${embedDim})`);
    if (oldestChunk) {
      lines.push(`Oldest chunk indexed: ${oldestChunk}`);
    }
    lines.push('');
    lines.push('Files:');
    for (const r of fileRows) {
      lines.push(`  - ${r.source_path}  (${r.chunk_count} chunk${r.chunk_count === 1 ? '' : 's'})`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: {},
    };
  },
};