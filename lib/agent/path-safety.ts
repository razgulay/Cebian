// Session-scoped VFS path safety — 把 worker-runner / 任何将来 agent 工具的
// 路径参数锁死在 `/workspaces/<sessionId>/` 之内。
//
// 这是「agent 路径必须在 session 根内」这一边界的第一道硬关——`lib/tools/fs-*.ts`
// 至今相信 LLM 给的 path，worker 流程里我们不能再这么放任：worker 会读 input_files、
// 写 output_path，路径形参来自模型输出，必须经本模块 gate。同一 session 根内的子目录
// 是合法的（reviewer 可以读 coder 写在同 session 的产物），跨 session / 跨根不允许。
//
// 设计要点（mirror `lib/memory/organize-scope.ts` 的成熟形态，避免重写）：
//   1. 两端都 `normalizePath` —— 这样 `../` 逃逸在 compare 之前就被吃掉，根内外的
//      比较才是「真形状 vs 真形状」而不是「脏形状 vs 干净形状」。
//   2. 前缀比必须用 `root + '/'`，不是裸 `startsWith(root)` —— 否则
//      `/workspaces-bak/...` 会被误判为 `/workspaces` 子孙。
//   3. 复用 `VfsScopeError`（project-standard typed error）而不是新立 error class，
//      caller 可 `instanceof VfsScopeError` 分支。
//   4. 错误信息**不**回显外部路径 —— 避免泄露跨 session 的路径线索给 LLM / 日志。
//   5. Session id 必经 `isValidSessionId` —— 单一事实源（持久层、备份、agent 工具
//      全用之），不在这里写第二份正则。

import { CEBIAN_SKILLS_DIR, WORKSPACES_ROOT } from '@/lib/persistence/vfs-paths';
import { normalizePath } from '@/lib/persistence/vfs';
import { isValidSessionId } from '@/lib/utils';
import { isValidSkillName, VfsScopeError } from '@/lib/tools/vfs-whitelist';

/**
 * 单个 session 的工作区根 `/workspaces/<sessionId>`（已 normalize）。
 * UUID gate 在前，sessionId 不合法直接抛——`sessionRoot` 是其余 3 个公开 API 的
 * 共同底座，gate 必须落在最底层以免调用方各自再写一遍。
 *
 * 仅本模块内部用；测试可见。
 */
export function sessionRoot(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new VfsScopeError('Invalid sessionId for vfs scope');
  }
  return normalizePath(`${WORKSPACES_ROOT}/${sessionId}`);
}

/**
 * 把一个路径 resolve 成 session 根下的绝对路径。
 *
 * **幂等**：如果输入已经是落在本 session 根内的绝对路径（`/workspaces/<id>/...`），
 * normalize 后原样返回，**不再** prepend 一次 root —— 防
 * `/workspaces/<id>/content.json` 被二次前缀成
 * `/workspaces/<id>/workspaces/<id>/content.json`。这样无论 caller 传 relative
 * 还是已 resolve 过的 absolute，结果都是同一个真形状，可以安全地重复调用。
 *
 * 相对路径 → 拼到 root 下；含 `~` 的写法由 `normalizePath` 归一后再拼接。
 * 落在根**之外**的绝对路径会被重新锚定到 root 下（当作 relative 拼接），
 * 越界与否由调用方的 `isWithinSessionRoot` / `assertWithinSessionRoot` 二次把关。
 *
 * `..` 会被 `normalizePath` 吃掉；调用方若要 reject `..` 形参，用
 * `isWithinSessionRoot` 二次校验。
 */
export function resolveSessionPath(sessionId: string, relativePath: string): string {
  const root = sessionRoot(sessionId);
  if (typeof relativePath !== 'string') {
    throw new VfsScopeError('vfs path must be a string');
  }
  // 幂等 gate：先归一，若已在本 session 根内（含根本身）直接返回。
  const normalized = normalizePath(relativePath);
  if (normalized === root || normalized.startsWith(root + '/')) {
    return normalized;
  }
  return normalizePath(`${root}/${relativePath}`);
}

/**
 * `absolutePath` 是否落在 session 根内（含根本身）。两端都 normalize；`../`
 * 逃逸在比较之前被吃掉，相邻同名前缀目录（`<root>-bak/...`）也不会误命中。
 *
 * 不抛——caller 决定 throw 什么 / 怎么用（assert 变体见下）。返回 boolean 便于
 * 复合判定（如「先 isWithin，再做别的事」）。
 */
export function isWithinSessionRoot(sessionId: string, absolutePath: string): boolean {
  if (typeof absolutePath !== 'string' || !absolutePath) return false;
  const root = sessionRoot(sessionId);
  const p = normalizePath(absolutePath);
  return p === root || p.startsWith(root + '/');
}

/**
 * `assertWithinSessionRoot` 的 throwing 版本。path 越界抛 `VfsScopeError`，
 * message 不回显绝对路径——只说「outside the session workspace root」，
 * 避免把跨 session / 外部路径线索泄露给 LLM / 日志 / UI 错误冒泡。
 */
export function assertWithinSessionRoot(sessionId: string, absolutePath: string): void {
  if (!isWithinSessionRoot(sessionId, absolutePath)) {
    throw new VfsScopeError('Path is outside the session workspace root');
  }
}

/**
 * 校验一批 input_files：每条路径都得在 session 根内 + VFS 里真存在。
 *
 * - 越界 → `VfsScopeError`（且**先**报越界，**不**去调 IO——避免对外路径做无谓
 *   stat，stat 抛 ENOENT 还会被误读为「文件不存在」掩盖越权）。
 * - 在根内但 VFS 找不到 → `Error('File not found: <path>')`，路径在根内允许回显
 *   （是用户/agent 自己给的输入，不是越界线索）。
 * - 数组为空 → 直接 resolve，无副作用。
 */
export async function assertInputFilesReadable(
  sessionId: string,
  paths: readonly string[],
): Promise<void> {
  for (const p of paths) {
    assertWithinSessionRoot(sessionId, p);
  }
  if (paths.length === 0) return;
  // 动态 import：避免本模块被同步导入时把 VFS（IndexedDB + lightning-fs）一起拉进
  // 纯谓词的测试链路。运行时是 background / sidepanel，IO 模块一定可用。
  const { vfs } = await import('@/lib/persistence/vfs');
  for (const p of paths) {
    try {
      await vfs.access(p);
    } catch {
      throw new Error(`File not found: ${p}`);
    }
  }
}

// ─── Skills scope ─────────────────────────────────────────────────────────
//
// `delegate_task.skills` 把名字喂进来，runner 要在 `~/.cebian/skills/<name>/` 里
// 读 `SKILL.md`。这是 session 根**之外**的另一棵子树——和 sessionRoot 独立
// 校验互不干涉，所以走平行 API 而不是抽 `isWithinRoot(root, path)` 通用工厂。
// AGENTS.md：Make the layer visible when names collide；One concept, one type。
//
// 设计：
//   1. 走 `isValidSkillName`（project 内单一事实源，已经在
//      `lib/tools/vfs-whitelist.ts:60` 处理空串/`.`/`..`/`/`/`\`/控制字符/
//      prototype-pollution 关键字）。不在这里写第二份校验。
//   2. 错误**不**回显 skill name 本身——LLM 可能用一个不算秘密但越界的名字
//      试探，回显等于向主代理 / 日志 / UI 错误冒泡额外信号。Mirror
//      `assertWithinSessionRoot` 的隐私姿态。

/**
 * 单个 skill 的根 `~/.cebian/skills/<skillName>`（已 normalize）。
 * skill name 不合法直接抛 `VfsScopeError`——`skillRoot` 是另两个公开 API 的
 * 共同底座，gate 必须落在最底层以免调用方各自再写一遍。
 *
 * 仅本模块内部用；测试可见。
 */
export function skillRoot(skillName: string): string {
  if (!isValidSkillName(skillName)) {
    throw new VfsScopeError('Invalid skill name for vfs scope');
  }
  // CEBIAN_SKILLS_DIR 形如 `~/.cebian/skills`；`normalizePath` 把 `~` 解到
  // /home/user/，结果根形如 `/home/user/.cebian/skills/<name>`。
  return normalizePath(`${CEBIAN_SKILLS_DIR}/${skillName}`);
}

/**
 * `absolutePath` 是否落在 skill 根内（含根本身）。两端都 normalize；`../`
 * 逃逸在比较之前被吃掉，相邻同名前缀目录（`skills-vs-foo`）也不会误命中。
 *
 * 不抛——caller 决定 throw 什么 / 怎么用。返回 boolean 便于复合判定
 * （如「先 isWithin，再做别的事」）。与 `isWithinSessionRoot` 同语义、同形状，
 * caller 可以一组组合用。
 */
export function isWithinSkillsRoot(skillName: string, absolutePath: string): boolean {
  if (typeof absolutePath !== 'string' || !absolutePath) return false;
  const root = skillRoot(skillName);
  const p = normalizePath(absolutePath);
  return p === root || p.startsWith(root + '/');
}

/**
 * `assertWithinSkillsRoot` 的 throwing 版本。path 越界抛 `VfsScopeError`，
 * message **不**回显 skill name / 绝对路径——只说「outside the skill root」，
 * 避免把跨 skill / 跨根的路径线索泄露给 LLM / 日志 / UI 错误冒泡。
 *
 * Mirror `assertWithinSessionRoot`：同样的「错误不泄线索」姿态。
 */
export function assertWithinSkillsRoot(skillName: string, absolutePath: string): void {
  if (!isWithinSkillsRoot(skillName, absolutePath)) {
    throw new VfsScopeError('Path is outside the skill root');
  }
}
