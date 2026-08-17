#!/usr/bin/env node
/**
 * check-branches.mjs — branch hygiene guard.
 *
 * 检测三类常见的分支堆积症状，给出警告（默认非阻塞）：
 *  1. `worktree-agent-*` 前缀的分支 —— 并行 agent 残留，merge 后应清掉
 *  2. 本地分支指向已删除的 worktree（orphan）—— 提示 `git worktree prune`
 *  3. 本地分支总数 > 阈值（默认 5）—— 越界就该清理，不是合并
 *
 * 用法：
 *   node scripts/check-branches.mjs           # 警告模式（exit 0）
 *   node scripts/check-branches.mjs --strict  # 严格模式（exit 1）
 *
 * 设计动机：单 maintainer 容易跑出 14 个 branch（真实发生过），把
 * `git branch` 列表变成考古层。提前给噪声，而不是攒到爆炸再人工梳理。
 */
import { execSync } from 'node:child_process';

const THRESHOLD = Number(process.env.BRANCH_HYGIENE_THRESHOLD ?? 5);
const STRICT = process.argv.includes('--strict');

function git(args) {
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    // `git for-each-ref` 等命令理论上不会失败；如失败就当错误抛出，
    // 让调用方看到 exit code 而非静默通过。
    throw new Error(`git ${args} failed: ${err.message}`);
  }
}

// ─── 检测 ───

const localBranches = git('for-each-ref --format=%(refname:short) refs/heads/')
  .split('\n')
  .filter(Boolean);

const currentBranch = git('symbolic-ref --short HEAD');
const protectedBranches = new Set([currentBranch, 'master', 'main']);

const worktreeBranches = new Set(
  git('worktree list --porcelain')
    .split('\n')
    .filter(l => l.startsWith('branch '))
    .map(l => l.replace(/^branch\s+/, '').replace(/^refs\/heads\//, ''))
);

const worktreeAgentBranches = localBranches.filter(b => b.startsWith('worktree-agent-'));
const orphanBranches = localBranches.filter(b =>
  !protectedBranches.has(b) && !worktreeBranches.has(b)
);

const violations = [];

// 1. worktree-agent-*
if (worktreeAgentBranches.length > 0) {
  violations.push({
    kind: 'worktree-agent',
    branches: worktreeAgentBranches,
    message: `${worktreeAgentBranches.length} 个 worktree-agent-* 分支残留 —— merge 后应清掉`,
  });
}

// 2. orphan（无 worktree 且非 master/main/current）
if (orphanBranches.length > 0) {
  violations.push({
    kind: 'orphan',
    branches: orphanBranches,
    message: `${orphanBranches.length} 个本地分支没有对应的 worktree（用 git worktree prune 检查）`,
  });
}

// 3. 总数阈值
if (localBranches.length > THRESHOLD) {
  violations.push({
    kind: 'threshold',
    branches: localBranches,
    message: `本地分支 ${localBranches.length} 个 > 阈值 ${THRESHOLD}`,
  });
}

// ─── 输出 ───

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const useColor = process.stdout.isTTY;

const paint = useColor ? (s) => s : (s) => s;

if (violations.length === 0) {
  console.log(paint(`✓ branch hygiene: ${localBranches.length} local branch(es), clean`));
  process.exit(0);
}

console.log(paint(YELLOW(`⚠ branch hygiene violations:`)));
for (const v of violations) {
  console.log(`  ${v.message}`);
  for (const b of v.branches) {
    const isCurrent = b === currentBranch ? ' *' : '';
    const inWorktree = worktreeBranches.has(b) ? '' : paint(DIM(' (no worktree)'));
    console.log(`    - ${b}${isCurrent}${inWorktree}`);
  }
}

console.log();
if (STRICT) {
  console.log(paint(RED(`✗ strict mode: exit 1`)));
  process.exit(1);
} else {
  console.log(paint(DIM(`(warning only — pass --strict to fail, or set BRANCH_HYGIENE_THRESHOLD)`)));
  process.exit(0);
}