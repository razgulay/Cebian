import { vfs } from '@/lib/persistence/vfs';

/** Recursively remove a VFS path. `vfs.rm` itself refuses to delete non-empty
 *  directories; this helper reads children first and walks depth-first so the
 *  parent becomes empty and `rm` accepts it. Errors propagate on the first
 *  failure so the caller can surface a toast.
 *
 *  Why not zip-then-delete or move-to-trash? Out of scope for Subtask 2. Today
 *  this is a hard delete from the /vfs page; users who want a recycle-bin can
 *  ship it as a follow-up. */
export async function rmRecursive(path: string): Promise<void> {
  let children: string[];
  try {
    children = await vfs.readdir(path);
  } catch (err) {
    // Path is a regular file (or vanished) — fall through to direct rm.
    await vfs.rm(path);
    return;
  }
  await Promise.all(
    children.map(async (name) => {
      const child = path === '/' ? `/${name}` : `${path}/${name}`;
      await rmRecursive(child);
    }),
  );
  await vfs.rm(path);
}
