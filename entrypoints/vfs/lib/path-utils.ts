import { File, FileCode, FileText, type LucideIcon } from 'lucide-react';
import { normalizePath } from '@/lib/persistence/vfs';
import { WORKSPACES_ROOT } from '@/lib/persistence/vfs-paths';

/** Extensions that the loader treats as binary (no inline preview, no utf8
 *  read). Some media extensions (e.g. `png`, `mp4`) also appear here as a
 *  safety net — `classifyFile` routes the dedicated image/video/audio
 *  buckets first, so this set only matches "binary blobs we don't render"
 *  like archives and fonts. */
export const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp',
  'zip', 'gz', 'tar', '7z', 'rar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'ogg',
]);

const CODE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html']);

/** UTF-8 decoding is opt-in. Unknown extensions must stay opaque because a
 * binary payload decoded with replacement characters is both misleading and
 * potentially expensive to render. */
export const TEXT_EXTS = new Set([
  'txt', 'text', 'log', 'csv', 'tsv',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'xml',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'astro', 'mdx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
  'swift', 'php', 'lua', 'r', 'dart', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs',
  'scala', 'groovy', 'gradle', 'proto', 'tf', 'hcl',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql',
  'ini', 'cfg', 'conf', 'env', 'properties', 'lock',
  'gitignore', 'gitattributes', 'dockerignore', 'npmrc', 'nvmrc', 'editorconfig',
  'prettierrc', 'eslintrc', 'stylelintrc', 'babelrc', 'browserslistrc',
]);

export const TEXT_FILENAMES = new Set([
  'readme', 'license', 'copying', 'changelog', 'dockerfile', 'makefile',
  'gemfile', 'rakefile', 'procfile', 'vagrantfile', 'brewfile', 'justfile',
]);

/** Extensions recognized as inline-renderable media. */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
export const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv']);
export const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
export const MARKDOWN_EXTS = new Set(['md', 'markdown']);

/** Upper bound for in-browser preview payloads. Files larger than this are
 *  surfaced as a "too large" placeholder with a hint to download instead.
 *  50 MB comfortably fits typical screenshots, short clips, and source
 *  trees while keeping browser memory bounded. */
export const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

/** Classify a file purely by its extension. Order matters: the more
 *  specific media buckets (markdown / image / video / audio) win before
 *  the generic binary fallback, since BINARY_EXTS still overlaps with
 *  some media extensions for safety. */
export type FileClass = 'text' | 'markdown' | 'pdf' | 'image' | 'video' | 'audio' | 'binary' | 'unknown';

export function classifyFile(name: string): FileClass {
  const ext = fileExtension(name);
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (BINARY_EXTS.has(ext)) return 'binary';
  if (TEXT_EXTS.has(ext) || (!ext && TEXT_FILENAMES.has(name.toLowerCase()))) return 'text';
  return 'unknown';
}

/** Decode previewable text without silently substituting malformed bytes. */
export function decodePreviewText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type VfsOpenPreference = 'smart' | 'preview' | 'source';
export type MarkdownOpenMode = 'preview' | 'source';

export function resolveMarkdownOpenMode(preference: VfsOpenPreference | string): MarkdownOpenMode {
  return preference === 'source' ? 'source' : 'preview';
}

export function parseVfsLocation(hash: string, search: string): { path: string; anchor: string | null } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep malformed percent escapes literal so a bad link reaches the normal
    // VFS not-found state instead of crashing the entire viewer route.
  }
  const path = normalizePath(decoded || '/');
  const anchor = new URLSearchParams(search).get('anchor');
  return { path, anchor: anchor || null };
}

export function getHashPath(): string {
  return parseVfsLocation(window.location.hash, window.location.search).path;
}

export function getRequestedAnchor(): string | null {
  return parseVfsLocation(window.location.hash, window.location.search).anchor;
}

export function vfsNavigationUrl(path: string, pathname: string): string {
  return pathname + '#' + encodeURIComponent(path);
}

export function navigateTo(path: string) {
  if (window.location.search) {
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }
  window.location.hash = vfsNavigationUrl(path, '').slice(1);
}

export function parentOf(p: string): string {
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

/** 当前路径是否正好是工作区根 `/workspaces`——此时目录列表的子项都是会话 UUID，
 *  需要翻译成「会话标题 · 日期」。 */
export function isWorkspacesRoot(p: string): boolean {
  return p === WORKSPACES_ROOT;
}

/** 若 `p` 正好是某个会话工作区目录（`/workspaces/<uuid>`，父目录正好是工作区根），
 *  返回该 `<uuid>` 段，用于解析头部信息条；否则返回 null（更深的子目录不算）。 */
export function workspaceUuidOf(p: string): string | null {
  return parentOf(p) === WORKSPACES_ROOT ? (p.split('/').pop() ?? null) : null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Pick the lucide icon component for a given file extension. Used by
 *  both DirView and FileView so the same `.md` file gets the same glyph
 *  in the listing and in its detail header. */
export function pickFileIcon(ext: string): LucideIcon {
  if (CODE_EXTS.has(ext)) return FileCode;
  if (ext === 'md') return FileText;
  return File;
}
