import type { SessionLabelRow } from '@/lib/persistence/db';

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** Discriminated union of file rendering modes. The loader picks the type
 *  via `classifyFile` + size check; `FileView` switches on `type`. Media
 *  variants (image/video/audio) carry a blob `url` whose lifetime is owned
 *  by the loader — it is revoked when a new file is loaded or the
 *  component unmounts. */
export type FileMedia =
  | { type: 'text'; content: string; size: number }
  | { type: 'markdown'; content: string; size: number }
  | { type: 'pdf'; data: Uint8Array; size: number }
  | { type: 'image'; mime: string; size: number; url: string }
  | { type: 'video'; mime: string; size: number; url: string }
  | { type: 'audio'; mime: string; size: number; url: string }
  | { type: 'binary'; size: number }
  | { type: 'unknown'; size: number }
  | { type: 'tooLarge'; size: number };

export type ViewState =
  | { kind: 'loading' }
  | {
      kind: 'dir';
      path: string;
      entries: DirEntry[];
      /** 仅当 `path` 正好是 `/workspaces` 时存在：`uuid → 会话标签行`，DirView 据此把
       *  UUID 子目录渲染成「会话标题 · 日期」并按最后活动倒序排。查不到的 UUID 不在 map 里。 */
      workspaceLabels?: Map<string, SessionLabelRow>;
      /** 仅当 `path` 正好是某个会话工作区目录且会话仍存在时存在：该会话的标签行，
       *  DirView 据此渲染顶部信息条。 */
      workspaceRow?: SessionLabelRow;
    }
  | { kind: 'file'; path: string; media: FileMedia }
  | { kind: 'error'; path: string; message: string };
