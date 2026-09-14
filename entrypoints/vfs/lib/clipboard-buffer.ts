import { vfs } from '@/lib/persistence/vfs';

export type ClipboardVerb = 'copy' | 'cut';

interface ClipboardBuffer {
  verb: ClipboardVerb;
  paths: string[];
}

let buffer: ClipboardBuffer = { verb: 'copy', paths: [] };

/** Module-level buffer for cross-folder copy / cut in the /vfs tab. Not real
 *  clipboard content — we keep it in-process so paste works even after the
 *  user navigates between folders within the same tab. Cleared after a
 *  successful paste of a `cut` verb (analogous to native cut+paste). */
export function setClipboardBuffer(next: ClipboardBuffer): void {
  buffer = next;
}

export function getClipboardBuffer(): ClipboardBuffer {
  return buffer;
}

export function clearClipboardBuffer(): void {
  buffer = { verb: 'copy', paths: [] };
}

/** Recursively copy a VFS path. Mirrors `rmRecursive` in shape: walks children
 *  depth-first so the parent directory exists before its contents. Caller is
 *  responsible for not pointing this at a path inside itself (pasteSelf check
 *  in the UI prevents the user-triggered loop). */
export async function cpRecursive(src: string, dest: string): Promise<void> {
  let children: string[];
  try {
    children = await vfs.readdir(src);
  } catch {
    // src is a file (or vanished): copy bytes.
    const data = (await vfs.readFile(src)) as unknown as Uint8Array;
    await vfs.writeFile(dest, data as unknown as Parameters<typeof vfs.writeFile>[1]);
    return;
  }
  await vfs.mkdir(dest);
  await Promise.all(
    children.map(async (name) => {
      const srcChild = src === '/' ? `/${name}` : `${src}/${name}`;
      const destChild = dest === '/' ? `/${name}` : `${dest}/${name}`;
      await cpRecursive(srcChild, destChild);
    }),
  );
}
