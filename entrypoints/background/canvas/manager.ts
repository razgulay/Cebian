// Canvas Live Artifacts — background 能力。
//
// 负责：
//   - 跟踪「哪个 session 的 canvas 当前打开了哪个 VFS 文件」（一条记录 / session，
//     v1 限制：每个会话只能有一个打开的文件，详情见 plan §「Feature 1 files」）。
//   - 让 LLM 工具（`canvas_open`，见 `lib/canvas/tool-canvas-open.ts`，在 ST-A4
//     加）直接把 `{sessionId, path}` 报上来；本模块负责读文件、记录、广播。
//   - 监听 VFS 的 `onChange`，对正被打开着的路径做热重载广播。
//
// 设计选择：
//   1. **每会话单文件**——v1 不支持「一 session 多个打开的文件」。状态存一个
//      `Map<sessionId, OpenCanvasFile>`，冲突时后写入覆盖前者。
//   2. **broadcastAll 而非 broadcastToCanvasViewers**——chat/viewers.ts 的
//      session→port 映射住在 chat 域里，按 §「capability 文件夹边界」规则，
//      canvas 不得 import chat。本模块用 `broadcastAll` 把它推到所有连接，
//      由 sidepanel-channel 在 `handleMessage` 里按 `activeSessionId` 过滤
//      （详见 `lib/canvas/sidepanel-channel.ts` 文件头注释）；用户多窗口
//      同 session 时会略浪费带宽，但 schema 复杂度低、零跨域依赖。v2 改成
//      自维护 `canvasViewers` 时再加 `canvas_subscribe` ClientMessage。
//   3. **VFS `onChange` 取代 wrap-writeFile**——`lib/persistence/vfs.ts` 第 132–264
//      行已经维护 `onChange` 事件总线，并且 emit 内部事件后通过
//      `chrome.runtime.sendMessage` 唤醒睡眠中的 SW（vfs.ts 头注释解释了为什么
//      用 `sendMessage` 而非 BroadcastChannel）。本模块直接订阅——零 risk #1
//      「writeFile 没走 hook 导致 missed hot reload」。
//
// 为什么这个文件住在 `entrypoints/background/canvas/`（capability 文件夹）而
// 不是 `lib/canvas/`：`lib/` 不允许有「写入 chrome.* / 持有 VFS 写源」这类本
// 地副作用的 manager。canvas manager 调 vfs.readFile（不算写，但要走确保 VFS
// 已 bootstrap 的 `ensureDefaults`）、注册 VFS 监听、广播 chrome.runtime 消息——
// 这些都是 BG-only。`lib/canvas/` 只放 wire 类型 + sidepanel-channel 这种纯
// 类型 / 纯 pub/sub 的桥模块。

import { vfs, normalizePath, type VfsChangeEvent } from '@/lib/persistence/vfs';
import { broadcastAll } from '../ipc/port-registry';
import { canvasToolChannel } from '@/lib/canvas/tool-channel';
import type { OpenCanvasFile } from '@/lib/canvas/types';

// ─── 内部状态 + helpers ───

/** sessionId → 当前打开的文件。`openCanvas` 写入，`closeCanvas` 删除；VFS 写
 *  入命中既有 path 时原地更新（不变更 path，只更新 content）。 */
const openBySession = new Map<string, OpenCanvasFile>();

/** 给定路径，返回所有正在 watch 该路径的 session。VFS `onChange` 过滤用——
 *  跨 session 也要命中，例如两个窗口同时打开同一 workspace 里的两个不同会话
 *  都 watch 着某个共享文件——这种情况让两个 session 的 viewer 都收到）。 */
function sessionsWatchingPath(path: string): string[] {
  const sessions: string[] = [];
  for (const [sessionId, file] of openBySession) {
    if (file.path === path) sessions.push(sessionId);
  }
  return sessions;
}

/** 处理一次 VFS 变更。只关心命中正被打开路径的 `write` 事件：
 *   - `write`：重读文件，把每个 watch 该路径的 session 推 `canvas_file_changed`。
 *   - `delete` / `rename`：留空——v1 行为是 canvas 仍显示上次缓存的内容（陈旧
 *     但不会闪没），文档化为「v1 不跟踪文件删除 / 重命名」；UI 可在 v2 加
 *     「文件已删」横幅，超出本次 plan scope。
 *   - 重入守门：本 handler 是 read-only（不写 VFS），无反馈环；刻意不写
 *     writeFile 等可能触发自身的事件，避免 linter 暗示「listener 写 VFS
 *     形成自环」。 */
function handleVfsChange(event: VfsChangeEvent): void {
  if (event.kind !== 'write') return;
  const watchingSessions = sessionsWatchingPath(event.path);
  if (watchingSessions.length === 0) return;
  // 重读是异步的；可能期间 openBySession 已被 closeCanvas 改写——以本次
  // 读到的内容为准发送，state 更新用乐观 set（`closeCanvas` 之后下一次
  // 重读就会发现无 session 与之关联，跳过广播）。
  void (async () => {
    let content: string;
    try {
      const raw = await vfs.readFile(event.path, 'utf8');
      content = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
    } catch (err) {
      // 文件被快速删除 / rename 后又 race 出 read 失败；忽略本次广播，
      // state 保留旧 content（陈旧而非崩溃）。下一次 write 会重试。
      console.warn('[canvas] re-read after VFS change failed:', err);
      return;
    }
    const updated: OpenCanvasFile = {
      path: event.path,
      content,
      updatedAt: Date.now(),
    };
    for (const sessionId of watchingSessions) {
      // 后到的 closeCanvas 已经把 session 从 map 删了——这种情况下跳过更新
      // 与广播，但保留其他 session 的更新。
      if (openBySession.get(sessionId)?.path !== event.path) continue;
      openBySession.set(sessionId, updated);
      broadcastAll({
        type: 'canvas_file_changed',
        sessionId,
        path: event.path,
        content,
      });
    }
  })();
}

// ─── 公开 API ───

/**
 * 把指定 session 的 canvas 打开到给定 VFS 路径。读文件内容、记录、广播
 * `canvas_opened` 给所有连接的 sidepanel。
 *
 * 错误路径：
 * - VFS 读失败（ENOENT、I/O 等）→ 直接抛，让调用方（LLM 工具 handler）按
 *   AGENTS.md「Tool Failure Handling」包装成 tool 返回的 `error` 字段。抛错
 *   而不是返回成功 + 空内容，message.isError = true 才能正确触发 LLM 重试。
 * - 文件已存在但路径被某会话打开着 → 后写入覆盖，与 multi-window 同源原则
 *   一致（最新一次工具调用是真相）。
 */
export async function openCanvas(sessionId: string, path: string): Promise<OpenCanvasFile> {
  // 在入口处做一次规范化：vfs.readFile 内部也会 normalizePath，但 broadcast
  // 的 path 字段需要 wire 形态与磁盘形态一致——把 `foo/../bar` 与 `/bar` 都
  // 收敛到 `/bar`，避免下游把这两个不同输入当成两个不同文件。
  const normalized = normalizePath(path);
  const raw = await vfs.readFile(normalized, 'utf8');
  const content = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
  const file: OpenCanvasFile = {
    path: normalized,
    content,
    updatedAt: Date.now(),
  };
  openBySession.set(sessionId, file);
  broadcastAll({
    type: 'canvas_opened',
    sessionId,
    path: normalized,
    content,
  });
  return file;
}

/**
 * 关闭指定 session 的 canvas。仅清理 BG 内存态，不广播——sidepanel 端的
 * CanvasPane 关闭由它自己的 UI state 决定（点 toggle 按钮 / 用户在 chat
 * 里走别的路径），不需要 BG 推一个「请关闭 canvas」的语义消息。
 */
export function closeCanvas(sessionId: string): void {
  openBySession.delete(sessionId);
}

/**
 * 注册 canvas 域的 BG 侧 wiring：VFS change 监听 + 把 `openCanvas` 实现注入
 * `lib/canvas/tool-channel`，供 `canvas_open` 工具（`lib/canvas/tool-canvas-open.ts`）
 * 跨过 depcruise `lib-no-up-runtime` 阻断调用。在 `entrypoints/background/index.ts`
 * 启动序列里、所有能力 setup 之后调用。
 *
 * 调用时机：必须在任何 LLM 工具可能调用 `openCanvas` 之前。但 `tool-channel`
 * 的 setOpenCanvas 是幂等的，启动序列任意位置调都可。
 */
export function setupCanvas(): void {
  vfs.onChange(handleVfsChange);
  canvasToolChannel.setOpenCanvas(openCanvas);
}
