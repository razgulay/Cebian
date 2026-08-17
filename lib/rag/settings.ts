//
// RAG settings storage — the user's persistent configuration for the
// Neon connection string, embedder endpoint/model, and the per-collection
// index.
//
// Two storage items:
//   - `local:ragSettings`   — single record, the user's global config
//   - `local:ragCollections` — array of collection metadata
//
// We use `chrome.storage.local` (via WXT's `defineItem`) rather than
// VFS because:
//   1. Settings are small (< 1 KB each), no need for VFS file overhead.
//   2. The collections array is read on every composer mount to populate
//      the RAG mention chip — storage watch gives us instant updates.
//   3. Sensitive content (the connection string with embedded creds)
//      shares the same security boundary as `webdavConfig` which is
//      already in storage.local — the user opted in to that pattern.
//

import { storage } from '#imports';
import { defineLoggedItem } from '@/lib/persistence/storage';
import type { RagCollection, RagSettings } from './types';
import { DEFAULT_RAG_SETTINGS } from './types';

export const ragSettings = defineLoggedItem<RagSettings>(
  'local:ragSettings',
  { fallback: { ...DEFAULT_RAG_SETTINGS } },
);

export const ragCollections = defineLoggedItem<RagCollection[]>(
  'local:ragCollections',
  { fallback: [] as RagCollection[] },
);

/** Merge a partial update into the current settings. Uses
 *  `getValue`/`setValue` directly (not the React hook) so it can be
 *  called from outside components — Settings form submit, mention
 *  resolver before embedding, etc. */
export async function updateRagSettings(patch: Partial<RagSettings>): Promise<RagSettings> {
  const current = await ragSettings.getValue();
  const next: RagSettings = { ...current, ...patch };
  await ragSettings.setValue(next);
  return next;
}

/** Slugify a user-entered collection name. Lowercase ASCII letters /
 *  digits / underscore / hyphen; max 63 chars; must start with an
 *  alphanumeric. Matches the regex used by the indexer / retriever
 *  when interpolating into SQL. Returns null if the input is empty
 *  or doesn't survive normalization. */
export function normalizeCollectionName(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  // Replace any run of non-alphanumeric/dash/underscore with a single dash.
  const slug = lower.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length === 0) return null;
  // Cap at 63 chars (Postgres identifier limit is 63 bytes; ASCII-safe
  // since our slug excludes non-ASCII by construction).
  const capped = slug.slice(0, 63);
  if (!/^[a-z0-9]/.test(capped)) return null;
  return capped;
}

/** Replace or insert a collection entry by name. Used by the indexer
 *  after a successful run. */
export async function upsertCollection(entry: RagCollection): Promise<RagCollection[]> {
  const current = await ragCollections.getValue();
  const idx = current.findIndex((c) => c.name === entry.name);
  let next: RagCollection[];
  if (idx >= 0) {
    next = current.slice();
    next[idx] = entry;
  } else {
    next = [...current, entry];
  }
  await ragCollections.setValue(next);
  return next;
}

/** Remove a collection from the local index. Caller is responsible for
 *  also deleting the matching chunks in Neon. */
export async function removeCollectionMeta(name: string): Promise<RagCollection[]> {
  const current = await ragCollections.getValue();
  const next = current.filter((c) => c.name !== name);
  await ragCollections.setValue(next);
  return next;
}

/** Patch the `chunkCount` field on a collection (called after
 *  delete / reindex to keep the local count in sync with Neon). */
export async function patchCollectionCount(name: string, chunkCount: number): Promise<void> {
  const current = await ragCollections.getValue();
  const idx = current.findIndex((c) => c.name === name);
  if (idx < 0) return;
  const next = current.slice();
  next[idx] = { ...next[idx]!, chunkCount };
  await ragCollections.setValue(next);
}

/** Rename a collection in the local index. Returns the next array; if
 *  `newName` already exists, throws — caller should treat that as a
 *  conflict (the user picked a name that's already taken) before
 *  hitting the Neon UPDATE which would also fail. */
export async function renameCollectionMeta(
  oldName: string,
  newName: string,
): Promise<RagCollection[]> {
  if (oldName === newName) return await ragCollections.getValue();
  const current = await ragCollections.getValue();
  if (current.some((c) => c.name === newName)) {
    throw new Error(`Collection "${newName}" already exists`);
  }
  const idx = current.findIndex((c) => c.name === oldName);
  if (idx < 0) {
    throw new Error(`Collection "${oldName}" not found`);
  }
  const next = current.slice();
  const existing = next[idx]!;
  next[idx] = {
    ...existing,
    name: newName,
    updatedAt: Date.now(),
  };
  await ragCollections.setValue(next);
  return next;
}

// Re-export so callers only need to import from one module.
export { DEFAULT_RAG_SETTINGS };
export type { RagCollection, RagSettings };

// `storage` import is kept so this file participates in WXT's module
// init order — without it, the defineItem calls happen after first
// use in some hot-reload scenarios. The linter usually flags unused
// imports; this comment suppresses that.
void storage;
