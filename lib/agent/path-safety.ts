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
      // Sibling-name suggestions 防 main agent 自创「近似名字」文件来兜底
      // （QA 见过 main agent 收到 file thiếu → tạo file fake → worker đọc nội
      // dung bịa；hard gate ở đây cắt luồng đó bằng error + suggestions, agent
      // buộc báo lại cho user thay vì tự cứu）。
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      let dirListing: readonly string[] = [];
      try {
        dirListing = dir ? await vfs.readdir(dir) : [];
      } catch {
        // parent dir missing / unreadable: chỉ có thể báo missing, không kèm suggestion.
        dirListing = [];
      }
      const suggestions = suggestFileMatches(
        p.slice(p.lastIndexOf('/') + 1),
        dirListing,
      );
      throw new FileNotFoundError(p, suggestions);
    }
  }
}

/** Caller 传了不存在的文件路径时抛出的硬错误——比 `Error("File not found: …")`
 *  多带一份 `suggestions: string[]`（同级目录里的近似名字），让 tool-layer
 *  可以直接 surface 给 main agent 当 structured detail。AGENTS.md: "permission
 *  denied / missing resources → throw new Error"；本错误对应「missing
 *  resources」一族，所以走 throw 路径而非 text return。 */
export class FileNotFoundError extends Error {
  readonly suggestions: readonly string[];

  constructor(path: string, suggestions: readonly string[]) {
    super(
      suggestions.length > 0
        ? `File not found: "${path}". Did you mean: ${suggestions.join(' | ')}?`
        : `File not found: "${path}".`,
    );
    this.name = 'FileNotFoundError';
    this.suggestions = suggestions;
  }
}

/** 把缺失的 basename 跟同级目录的 listing 做模糊匹配，返回 top-N 候选。
 *  Pure：测试可以脱离 VFS 直接喂字符串数组验证。规则：
 *  - exact basename match → 返回 []（理论上 caller 不该走到这：路径全等就该
 *    vfs.access 过了；但保留这条 guard 防 caller 把 basename 错配成 display 名）；
 *  - Levenshtein 编辑距离 ≤ maxDistance（默认 3），或
 *  - 公共前缀 ≥ 3 chars（捕获前缀一致 + 后续差异的场景，如 `faq-final.json` vs
 *    `faq-khachhang.json`），
 *  满足任一即可入选；按距离升序、字母序 tiebreak，返回前 maxResults（默认 3）。
 *
 *  选 3-char prefix 而非 2-char 是为了防噪音：`output/abc.md` vs `output/abx.md`
 *  距离 2 但可能只是合法的两个文件；3-char 阈值同时仍是常见 typo "faq.json" vs
 *  "faq_khachhang.json" 的舒适距离。 */
export function suggestFileMatches(
  missingBasename: string,
  dirListing: readonly string[],
  opts?: { maxDistance?: number; maxResults?: number },
): string[] {
  if (!missingBasename) return [];
  const maxDistance = opts?.maxDistance ?? 3;
  const maxResults = opts?.maxResults ?? 3;

  // exact basename match → 空（同名文件已存在，caller 不该要 suggestion）。
  if (dirListing.includes(missingBasename)) return [];

  const scored: Array<{ name: string; distance: number }> = [];
  for (const candidate of dirListing) {
    const distance = levenshtein(missingBasename, candidate);
    const prefixLen = commonPrefix(missingBasename, candidate);
    // 距离 ≤ 阈值 OR 前缀 ≥ 3 → 入选；距离更小的优先（距离严格小于；
    // 否则按字母序 tiebreak，由 sort 保证稳定）。
    if (distance <= maxDistance || prefixLen >= 3) {
      scored.push({ name: candidate, distance });
    }
  }
  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return scored.slice(0, maxResults).map((s) => s.name);
}

/** Iterative Levenshtein，纯 JS 无依赖。O(m·n)，但输入是 basename（≤
 *  256 chars），目录 listing 通常几十条，跑一次 gate 成本 < 1ms。 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** 公共前缀长度（字符级）。空串时返回 0。 */
function commonPrefix(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
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
