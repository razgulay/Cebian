// Worker Team routing hard gate — main agent 在 Team ON 状态下若想用 native
// `fs_create_file` / `fs_edit_file` 写 HTML 产物，必须先走 `delegate_task` 找
// `frontend_coder`，否则被拦下、reason 转成可执行的指令让模型改去调 delegate_task。
//
// 设计取舍：
// - 这是单独的 `beforeToolCall` hook，不复用 `ToolGate`：permission gate 是要
//   弹授权卡给用户；routing gate 是要直接拒绝并把模型踢回 worker 子代理。
//   两者语义不同，硬塞同 interface 只会让 ToolGate 变成「可选弹窗」混合体。
// - 只对 main session 的 `createCebianAgent` 装上；worker agent 由 `runWorkerAttempt()`
//   单独创建，路径里根本不传这个 hook，所以 `frontend_coder` 自己调 `fs_create_file`
//   写 HTML 不会被拦。
// - 检测保守：
//   * `fs_create_file` + `.html` / `.htm` 路径 → 直接拦。
//   * `fs_edit_file` + `.html` / `.htm` + new_string 看起来是 full-document
//     rewrite（长度超阈值且含 document-level marker）才拦；typo / 改字 / 改
//     div 一小块仍照旧放过，避免 dispatch 整个 worker 只修一个 typo。
//   * 非 HTML 路径不拦——README / .txt 含 `<!doctype html>` codeblock 不误判。

import type { BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';

// full-document rewrite 判定阈值：new_string 长度超过这个值才视为整篇覆写。
// 比这短的多半是局部修改（typo / 改字 / 换 div），仍允许主代理直写。
export const HTML_REWRITE_MIN_CHARS = 300;

// document-level marker——`<!doctype html>` 是 HTML5 标配开头；
// `<html>` 标签加 `</html>` / `<body>` 是另一种 document shell 形态。
// 任一形态命中即视为 document-level rewrite（不是嵌在 markdown 里的示例代码）。
const DOC_MARKER_PATTERNS: readonly RegExp[] = [
  /<!doctype\s+html/i,
  /<html[\s>]/i,
];

const DOC_CLOSER_PATTERNS: readonly RegExp[] = [
  /<\/html>/i,
  /<body[\s>]/i,
];

function isHtmlPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function looksLikeFullDocumentRewrite(newString: string): boolean {
  if (newString.length <= HTML_REWRITE_MIN_CHARS) return false;
  const hasOpen = DOC_MARKER_PATTERNS.some((re) => re.test(newString));
  if (!hasOpen) return false;
  return DOC_CLOSER_PATTERNS.some((re) => re.test(newString));
}

const CREATE_FILE_BLOCKED_REASON = (path: string) =>
  'Team mode blocks direct fs_create_file for HTML deliverables. ' +
  'Call delegate_task({ role: "frontend_coder", task: "...", ' +
  `output_path: "${path}" }) ` +
  'instead. Do NOT retry this native fs_create_file in Team mode — the worker sub-agent ' +
  'writes the file in isolation and handoffs via VFS.';

const EDIT_FILE_BLOCKED_REASON = (path: string) =>
  'Team mode blocks full-document fs_edit_file rewrites for HTML files. ' +
  'Call delegate_task({ role: "frontend_coder", task: "Apply the requested change ' +
  'to the existing file while preserving everything else", ' +
  `input_files: ["${path}"], output_path: "${path}" }) ` +
  'instead. Do NOT retry this native fs_edit_file in Team mode.';

export type WorkerTeamRoutingDecision =
  | { kind: 'allow' }
  | { kind: 'block'; reason: string };

/**
 * 纯函数：把一个 beforeToolCall 上下文映射成 allow/block 决定。
 * - 单独抽出来便于 unit test（不依赖 storage / agent 状态）。
 * - `workerTeamOn` 由调用方按单一快照传入，避免 hook 内部再去读 storage 导致
 *   一轮 dispatch 内 prompt/tools/gate 三个快照对不上。
 */
export function decideWorkerTeamRouting(
  ctx: BeforeToolCallContext,
  workerTeamOn: boolean,
): WorkerTeamRoutingDecision {
  if (!workerTeamOn) return { kind: 'allow' };
  const name = ctx.toolCall.name;
  const args = (ctx.args ?? {}) as Record<string, unknown>;

  if (name === 'fs_create_file') {
    const path = typeof args.path === 'string' ? args.path : '';
    if (isHtmlPath(path)) {
      return { kind: 'block', reason: CREATE_FILE_BLOCKED_REASON(path) };
    }
    return { kind: 'allow' };
  }

  if (name === 'fs_edit_file') {
    const path = typeof args.path === 'string' ? args.path : '';
    if (!isHtmlPath(path)) return { kind: 'allow' };
    const newString = typeof args.new_string === 'string' ? args.new_string : '';
    if (looksLikeFullDocumentRewrite(newString)) {
      return { kind: 'block', reason: EDIT_FILE_BLOCKED_REASON(path) };
    }
    return { kind: 'allow' };
  }

  return { kind: 'allow' };
}

/**
 * 工厂：生成一个 `beforeToolCall` hook。装到 main-session agent 的
 * `createCebianAgent({ ..., beforeToolCall })` 上即生效。
 *
 * worker 子代理（`runWorkerAttempt` 内的 `createCebianAgent` 调用）不传此
 * hook，所以 `frontend_coder` 自己写 HTML 不会被拦。
 */
export function createWorkerTeamRoutingHook(getWorkerTeamOn: () => Promise<boolean>) {
  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const on = await getWorkerTeamOn();
    const decision = decideWorkerTeamRouting(context, on);
    if (decision.kind === 'allow') return undefined;
    return { block: true, reason: decision.reason };
  };
}
