// `canvas_open` 工具：让 agent 把一份 VFS 文件 open 到 sidepanel 的 canvas pane，
// 享受实时热重载（vfs.onChange → broadcast → 端上 iframe re-render）。
//
// Per-session factory：每个会话一个实例，闭包捕获 sessionId。这样 LLM 不必
// 在每次调用里都把 sessionId 当参数传——和 fs_create_file 等「无 sessionId」工具
// 不同，canvas_open 必须锁定到当前会话（canvas 的 BG 状态就是 per-session）。
//
// BG 域 `openCanvas` 通过 `lib/canvas/tool-channel.ts` 的 `setOpenCanvas` 注入；
// 本文件只在 lib/ 范围内，避开 `lib → entrypoints/background` 的 depcruise 阻断。

import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_CANVAS_OPEN } from '@/lib/tools/names';
import { canvasToolChannel } from './tool-channel';

const CanvasOpenParameters = Type.Object({
  path: Type.String({
    description:
      'Absolute VFS path of the file to display (e.g. "/workspaces/<sessionId>/artifacts/index.html"). ' +
      'Subsequent writes to this path trigger hot-reload in the canvas pane. ' +
      'Call this tool again with a different path to switch what the canvas shows.',
  }),
});

/** Tool details side channel —— UI 渲染 canvas 状态卡用。按 AGENTS.md
 *  「`details` 是 per-tool structured side channel」约定，结构由本工具自己
 *  定义；LLM 看到的是 `content[].text`，`details` 永远不流到 LLM。本工具所有
 *  失败路径都已 throw 给 LLM 看 `message.isError = true`，所以 details 没有
 *  failure discriminator —— 只有 success shape。 */
export interface CanvasOpenDetails {
  path: string;
  contentLength: number;
}

/**
 * 为某 session 创建一个绑定实例：execute 闭包捕获 sessionId + 当前
 * `canvasToolChannel.getOpenCanvas()` 的引用（不持久保留——execute 调用时再
 * 读一次，确保 BG 重启替换实现时新调用也能走到新引用）。
 */
export function createSessionCanvasOpenTool(
  sessionId: string,
): AgentTool<typeof CanvasOpenParameters, CanvasOpenDetails> {
  return {
    name: TOOL_CANVAS_OPEN,
    label: 'Open in Canvas',
    description:
      'Open a VFS file in the canvas pane — a live HTML preview area in the sidepanel. ' +
      'After this call, subsequent writes to the same path trigger hot-reload without any further action. ' +
      'Call canvas_open again with a different path to switch what the canvas shows. ' +
      'The path must already exist in the VFS; use fs_create_file first if it does not.',
    parameters: CanvasOpenParameters,

    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<CanvasOpenDetails>> {
      signal?.throwIfAborted();

      // 取当前注册的 BG openCanvas 实现。BG 没启动 = 罕见的启动竞态。
      // 该分支不该被触达——`setupCanvas()` 在 SW 启动序列里跑，远早于任何
      // LLM 工具调用——但「不变量破裂时抛权威错误」比「吞掉返回 success」更安全。
      const openCanvas = canvasToolChannel.getOpenCanvas();
      if (!openCanvas) {
        throw new Error(
          'canvas_open failed: Canvas background is not yet initialized (no opener registered). ' +
            'This usually means the background startup sequence did not complete; retry in a moment.',
        );
      }

      // TypeBox 的 Type.String 在 parse 时已拒掉非 string；这里补一道空串守门。
      const path = params.path;
      if (typeof path !== 'string' || path.length === 0) {
        throw new Error('canvas_open failed: path must be a non-empty string.');
      }

      try {
        // AGENTS.md「Tool Failure Handling」——VFS 读失败（ENOENT 等）等真错
        // 全部 throw，让 pi-agent-core 把 isError=true 冒给 LLM；不返回成
        // 功 + 空内容，否则 LLM 误判已打开会接着读 / 改文件，浪费往返。
        const file = await openCanvas(sessionId, path);
        // `OpenCanvasFile.content` 始终是 string（vfs.readFile 走 utf8 path，
        // manager 解码过 Uint8Array） —— 见 `lib/canvas/types.ts`。
        const contentLength = file.content.length;
        return {
          content: [
            {
              type: 'text',
              text: `Canvas opened: ${file.path} (${contentLength} chars). ` +
                `Any subsequent fs_edit_file / fs_save_url / fs_create_file writes to this ` +
                `path will hot-reload the preview without further action from the agent.`,
            },
          ],
          details: { path: file.path, contentLength },
        };
      } catch (err) {
        // 包装保留原始 message —— LLM 看得到「File not found: /foo」这种线索
        // 而非模糊的「打开失败」，能据此决定下一步是 fs_create_file 还是
        // fs_list 先验路径。再次 throw 而非 return，确保 message.isError=true。
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`canvas_open failed: ${message}`);
      }
    },
  };
}
