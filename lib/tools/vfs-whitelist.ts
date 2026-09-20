/**
 * Shared VFS proxy whitelist + scoped-path enforcement for skill scripts.
 *
 * 类比 `chrome-api-whitelist.ts`：单一事实来源，决定 skill 通过 sandbox 的
 * `vfs` 全局可以调哪些方法、对哪些路径生效。
 *
 * 设计要点：
 * - 权限拆为 `vfs.read` / `vfs.write` 两档，分别覆盖纯读 / 含写操作方法
 * - **写**作用域绑定到该 skill 在当前 session 里的子目录：
 *   `/workspaces/<sessionId>/<skill>/`。产物跟 agent 自己写入 workspace 的文件
 *   共存于同一棵子树下，session 删除时 `background/index.ts` 已有的
 *   `vfs.rm({recursive:true})` 顺带清理，markdown 链接形如
 *   `#/workspaces/<sessionId>/<skill>/cat.png` 也直接命中
 *   `MarkdownRenderer.resolveVfsHref` 的 Case 1，零额外渲染逻辑。
 * - **读**作用域放宽到父 session workspace `/workspaces/<sessionId>/` —— skill
 *   需要读取 agent 在同 session 内早些时候产生的内容（待部署的 HTML、生成的
 *   PDF 等）时不必再借 `fs_rename` 把文件物理搬进 skill 子目录，避免跨 tab 引用
 *   失效。跨 session 仍然被 `resolveScopedPath` 拦下：readRoot 永远不超出本
 *   session 的 workspace。
 * - 跨 session 持久状态**不在 v1 范围**，需要时另起 `vfs.cache` 之类的权限。
 */

import { normalizePath } from '@/lib/persistence/vfs';
import { workspaceRootForSession } from '@/lib/persistence/vfs-paths';
import { isValidSessionId } from '@/lib/utils';
import { parsePermission } from './permissions';

// ─── Method groups (white-list) ───

/** Read-only VFS methods — granted by `vfs.read`. */
export const VFS_READ_METHODS = new Set([
  'readFile', 'readdir', 'stat', 'exists',
]);

/** Mutating VFS methods — granted by `vfs.write`. */
export const VFS_WRITE_METHODS = new Set([
  'writeFile', 'mkdir', 'unlink',
]);

// ─── Path security helpers ───

/** Prototype-pollution guard for method names and skill segments. */
const FORBIDDEN_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate a skill folder name for the purpose of **path construction**.
 *
 * 这条校验只是「构造 `/workspaces/<sessionId>/<skill>` 时不会被打穿」的安全底线，
 * **不是** agentskills 规范的形状校验。规范层面的命名（小写、连字符、长度上限等）由 scanner /
 * skill-creator 引导用户遵守。如果在这一层加入规范层校验，会导致 scanner 已加载、能跑
 * 其它权限的 skill 仅在声明 `vfs.*` 时炸掉 —— 同类的“silent cliff”。
 *
 * 拒绝项（全部是路径构造安全项）：
 * - 空串、非字符串
 * - `.` / `..` （会打穿路径作用域）
 * - 包含 `/` `\` 或控制字符（会裂变成多段路径）
 * - prototype-pollution 关键字
 *
 * 长度上限、大小写、前导点 .hidden 、unicode 名字 —— 都不是这一层的职责。
 */
export function isValidSkillName(skill: string): boolean {
  if (!skill || typeof skill !== 'string') return false;
  if (FORBIDDEN_PARTS.has(skill)) return false;
  if (skill === '.' || skill === '..') return false;
  // 任何路径分隔符 / 控制字符都不允许 —— 一旦放行就会破坏 normalizePath 的不变量。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\/\\]/.test(skill)) return false;
  return true;
}

/**
 * Compute the per-session, per-skill VFS root.
 *
 * 形如 `/workspaces/<sessionId>/<skill>`（无尾斜杠）。skill 脚本相对该路径
 * 写入文件，落地到 session 的 workspace 子目录下，跟 agent 自己产生的
 * 文件共存。
 */
export function sessionSkillRoot(sessionId: string, skill: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid sessionId for vfs scope: ${sessionId}`);
  }
  if (!isValidSkillName(skill)) {
    throw new Error(`Invalid skill name for vfs scope: ${skill}`);
  }
  return normalizePath(`${workspaceRootForSession(sessionId)}/${skill}`);
}

/**
 * Compute the parent session workspace root.
 *
 * 形如 `/workspaces/<sessionId>`（无尾斜杠）—— 同 session 内 agent 自身
 * 产生的文件、其它 skill 子目录的落点。`vfs.read` 把这层作为读根：skill
 * 需要读取 agent 在同一 session 内早些时候创建的内容（待部署的 HTML、
 * 编译产物等）时不必再借 `fs_rename` 把文件物理搬过来。
 *
 * 与 `sessionSkillRoot` 对称：同样过 `isValidSessionId` 校验，畸形
 * sessionId 在 run 启动时就抛错，避免把 `..` / 空串拼进路径。
 */
export function sessionWorkspaceRoot(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid sessionId for vfs scope: ${sessionId}`);
  }
  return normalizePath(`/workspaces/${sessionId}`);
}

/**
 * Per-run VFS scope: read 与 write 用不同的根。
 *
 * - `writeRoot` 总是等于 `sessionSkillRoot(sessionId, skill)` —— skill 自己
 *   的子目录，写操作不允许越界。
 * - `readRoot` 是父 session workspace `sessionWorkspaceRoot(sessionId)`，
 *   允许读 session 内任一同级文件（含其它 skill 子目录），跨 session
 *   仍由 `resolveScopedPath` 拦截。
 *
 * 用对象而非两个独立字段（`vfsReadRoot` / `vfsWriteRoot`），是为了让
 * "this run declared vfs.*" 这个 nullability 决策集中在一个地方，沿用现有
 * `vfsRoot: string | null` 的控制流形状。
 */
export interface VfsScope {
  readRoot: string;
  writeRoot: string;
}

/**
 * Check whether a vfs method call is allowed for the given permission set.
 * Blocks prototype pollution attempts (`__proto__`, `constructor`, ...) and
 * enforces flat method names (no dots).
 *
 * 权限语义：
 * - `vfs.read` 单独存在：仅允许读类方法（readFile / readdir / stat / exists）
 * - `vfs.write` 存在：允许全部方法，**自动包含读类**。
 *   理由：skill 已经能在自己的 `.data/` 子目录里任意写文件，再禁止它读
 *   自己刚写的东西没有意义，只会逼用户两条权限都写一遍。作用域本身已经
 *   是隐私边界，读写细分在 scope 内部没有保护价值。
 */
export function isVfsCallAllowed(method: string, permissions: string[]): boolean {
  if (typeof method !== 'string') return false;
  if (FORBIDDEN_PARTS.has(method)) return false;
  if (method.includes('.')) return false;
  // 认 token 统一走沙箱能力词汇（lib/tools/permissions），不在这里重复比字符串。
  const hasWrite = permissions.some((p) => parsePermission(p)?.kind === 'vfsWrite');
  const hasRead = hasWrite || permissions.some((p) => parsePermission(p)?.kind === 'vfsRead');
  if (VFS_READ_METHODS.has(method)) return hasRead;
  if (VFS_WRITE_METHODS.has(method)) return hasWrite;
  return false;
}

/**
 * Resolve a skill-supplied relative path to an absolute VFS path, asserting
 * it stays under the given `root`. Throws on:
 *   - non-string input
 *   - absolute paths (`/...`) or `~`-prefixed paths
 *   - paths that, after normalization (`..` resolution), escape the root
 *
 * **允许** `''` / `'.'` / `'./'` 这种归一到 root 本身的输入 —— 对 `readdir`
 * / `stat` 这种目录方法来说，根目录是天然的合法目标；`readFile('.')` /
 * `writeFile('')` 等明显不合理的用法交给底层 VFS 报 EISDIR 之类的明确错误，
 * 不在这一层包办。这一层只负责**安全**（防越界）。
 *
 * skill 调用方写 `'cat.png'` 或 `'subdir/cat.png'`，落地路径会是
 * `<root>/cat.png` 或 `<root>/subdir/cat.png`。
 */
export function resolveScopedPath(rel: unknown, root: string): string {
  if (typeof rel !== 'string') {
    throw new Error('vfs path must be a string');
  }
  // 拒绝绝对路径 / ~ 起手 —— skill 只能传相对路径。
  if (rel.startsWith('/') || rel === '~' || rel.startsWith('~/') || rel.startsWith('~\\')) {
    throw new Error(`vfs path must be relative to skill workspace, got: ${rel}`);
  }
  const candidate = normalizePath(`${root}/${rel}`);
  // candidate === root 是合法情况（如 readdir('.')）；只拦实际越界。
  if (candidate !== root && !candidate.startsWith(root + '/')) {
    throw new VfsScopeError(`vfs path escapes skill workspace: ${rel}`);
  }
  return candidate;
}

/**
 * Typed error for "path resolved outside the skill's effective scope". Used
 * by both `resolveScopedPath` and `resolveReadScopedPath` so callers can
 * branch on `err instanceof VfsScopeError` instead of grep-ing the message
 * string (fragile + locale-sensitive).
 */
export class VfsScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VfsScopeError';
  }
}

/**
 * Minimal vfs-read surface used by `dispatchReadWithFallback`. Mirrors the
 * read methods on `lib/persistence/vfs`. Kept as a structural type so tests
 * can inject a fake without pulling in the real lightning-fs-backed module.
 */
export interface VfsReader {
  readFile(
    path: string,
    opts?: 'utf8' | { encoding?: 'utf8' },
  ): Promise<string | Uint8Array>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{
    size: number;
    mtimeMs: number;
    isFile: () => boolean;
    isDirectory: () => boolean;
  }>;
  exists(path: string): Promise<boolean>;
}

/**
 * Read-method dispatch with writeRoot-first / readRoot-fallback resolution.
 *
 * 1. 先按 writeRoot 解析 + 调底层 vfs —— skill 用 `'cat.png'` / `'.'` 读
 *    自己刚写进 writeRoot 的产物（既有文档行为）保持不变。
 * 2. 底层抛 ENOENT（文件不在 writeRoot），或 `resolveScopedPath` 在 writeRoot
 *    抛 `VfsScopeError`（路径里有 `..` 越出 writeRoot），就改用
 *    `resolveReadScopedPath` 把路径"从 writeRoot 吃掉 skill 子目录后再走"
 *    一次 —— `../foo` 现在落进 session 根下，能读到 agent 在同 session 内
 *    早些时候产生的同级文件。
 *
 * 跨 session（`../..` 出 `/workspaces/<sessionId>/`）在 readRoot 兜底时仍
 * 会被拦下 —— 归一化后的路径不落在 readRoot（含）以内。
 *
 * 其它错误（EINVAL / EACCES / 上层 caller bug）必须透传，让 skill 看到准确
 * 诊断，不要被静默吞掉 —— 见 `isMiss`。
 */
export async function dispatchReadWithFallback(
  method: string,
  rel: unknown,
  writeRoot: string,
  readRoot: string,
  callArgs: unknown[],
  vfs: VfsReader,
): Promise<unknown> {
  try {
    const absPath = resolveScopedPath(rel, writeRoot);
    return await invokeReadMethod(method, absPath, callArgs, vfs);
  } catch (err) {
    if (!isMiss(err)) throw err;
    const absPath = resolveReadScopedPath(rel, writeRoot, readRoot);
    return await invokeReadMethod(method, absPath, callArgs, vfs);
  }
}

/**
 * 判断错误是否为"未命中"——值得走 readRoot fallback 的两类信号。
 * 其它错误（EINVAL / EACCES / 上层 caller bug）必须直接抛，让 skill 看到
 * 准确的诊断，不要被静默吞掉。
 */
function isMiss(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // `..` 越界 writeRoot 抛的 VfsScopeError —— 视作"writeRoot 没这条路径"，
  // 让 readRoot 兜底再试。ENOENT 是底层 VFS 抛的"文件不在这里"，同样
  // 走 fallback。两类错误分别由 resolveScopedPath 和 lightning-fs 抛出。
  if (err instanceof VfsScopeError) return true;
  const code = (err as { code?: unknown }).code;
  if (code === 'ENOENT') return true;
  return false;
}

async function invokeReadMethod(
  method: string,
  absPath: string,
  callArgs: unknown[],
  vfs: VfsReader,
): Promise<unknown> {
  switch (method) {
    case 'readFile': {
      // encoding 参数原样透传给 vfs.readFile —— 支持 `'utf8'` / undefined /
      // `{ encoding: 'utf8' }` 三种形式（跟 Node `fs.promises` 一致）。不法的
      // encoding 由 lightning-fs / vfs 底层报 EINVAL，不在这一层扫语义。
      return await vfs.readFile(
        absPath,
        callArgs[1] as 'utf8' | { encoding?: 'utf8' } | undefined,
      );
    }
    case 'readdir': {
      return await vfs.readdir(absPath);
    }
    case 'stat': {
      const st = await vfs.stat(absPath);
      // Flatten —— 方法属性结构化克隆会丢。
      return {
        size: st.size,
        mtimeMs: st.mtimeMs,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
      };
    }
    case 'exists': {
      return await vfs.exists(absPath);
    }
    default:
      throw new Error(`Unknown vfs read method: ${method}`);
  }
}

/**
 * 读方法的 fallback 解析器：把相对路径先按 `writeRoot`（skill 自己的子目录）
 * 拼出来做归一化，然后用 `readRoot`（父 session workspace）做"安全边界"检查。
 *
 * 与 `resolveScopedPath(rel, readRoot)` 的差别：在 readRoot 模式下 skill 用
 * `'../foo'` 是合法写法（`'..'` 把 skill 子目录吃掉，落在 readRoot 下）；直接
 * 调 `resolveScopedPath(rel, readRoot)` 会把 `'../foo'` 解析成
 * `readRoot/../foo` = `/workspaces/foo`，越出 readRoot 报错。这里的语义是
 * "skill 站在 writeRoot，路径里 `'..'` 把 writeRoot 吃掉再继续走"，所以从
 * writeRoot 起算，落到 readRoot（含）以内就算合法。
 *
 * 跨 session（`../../<otherSession>`）在 readRoot 这一关会被拦下 —— 归一化
 * 后的路径不落在 readRoot（含）下，抛 "escapes skill workspace"。
 *
 * 同样的 `'..'` 路径在 writeRoot 上也会抛 "escapes skill workspace"，这条
 * 异常在调用方（sandbox-rpc dispatchReadWithFallback）被识别为"未命中
 * writeRoot"，触发本函数兜底。
 */
export function resolveReadScopedPath(
  rel: unknown,
  writeRoot: string,
  readRoot: string,
): string {
  if (typeof rel !== 'string') {
    throw new Error('vfs path must be a string');
  }
  if (rel.startsWith('/') || rel === '~' || rel.startsWith('~/') || rel.startsWith('~\\')) {
    throw new Error(`vfs path must be relative to skill workspace, got: ${rel}`);
  }
  // 从 writeRoot 起算，让 `..` 先吃 skill 子目录。归一化后再以 readRoot 做
  // 安全边界 —— readRoot 是父 session workspace，落点（含）以内都合法。
  const candidate = normalizePath(`${writeRoot}/${rel}`);
  if (candidate !== readRoot && !candidate.startsWith(readRoot + '/')) {
    throw new VfsScopeError(`vfs path escapes skill workspace: ${rel}`);
  }
  return candidate;
}
