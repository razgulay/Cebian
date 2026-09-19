import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createSessionAskUserTool } from './ask-user';
import { executeJsTool } from './execute-js';
import { readPageTool } from './read-page';
import { interactTool } from './interact';
import { inspectTool } from './inspect';
import { tabTool } from './tab';
import { screenshotTool } from './screenshot';
import { pdfTool } from './pdf';
import { fsCreateFileTool } from './fs-create-file';
import { fsEditFileTool } from './fs-edit-file';
import { fsMkdirTool } from './fs-mkdir';
import { fsRenameTool } from './fs-rename';
import { fsDeleteTool } from './fs-delete';
import { fsReadFileTool } from './fs-read-file';
import { fsListTool } from './fs-list';
import { fsSearchTool } from './fs-search';
import { fsSaveUrlTool } from './fs-save-url';
import { ragInspectTool } from './rag-inspect';
import { ragSearchTool } from './rag-search';
import { createSessionRunSkillTool } from './run-skill';
import { chromeApiTool } from './chrome-api-tool';
import { SessionToolContext } from './session-context';
import { TOOL_ASK_USER } from '@/lib/tools/names';
import { getMCPManager } from '@/lib/mcp/manager';
import { createMCPAgentTool } from './mcp-tool';
import { createSessionCanvasOpenTool } from '@/lib/canvas/tool-canvas-open';
import { schedulerTools } from '@/lib/scheduler/tool-scheduler';
import { debugLog, withSession } from '@/lib/debug/log';
import type { ServerMessage } from '@/lib/ipc/protocol';
import { workerTeamEnabled, type ModelIdentity } from '@/lib/persistence/storage';

interface SessionToolOptions {
  /** 会话维度的广播通道，仅由 background 提供（见 `createSessionTools`）。 */
  broadcast?: (msg: ServerMessage) => void;
  /** 本轮已读取的 Team 快照；缺省时由 builder 自行读取 storage。 */
  workerTeamOn?: boolean;
  /** 当前主会话模型，供 worker 未配置 per-role model 时继承。 */
  getMainModel?: () => ModelIdentity | null;
}

/** Non-interactive tools shared by all sessions. `runSkillTool` is intentionally
 *  NOT here —— 每个 session 用 `createSessionRunSkillTool(sessionId)` 拿到
 *  绑定到该 session workspace 的实例，避免 vfs 写入丢失会话上下文。
 *
 *  `ragSearchTool` is intentionally NOT here either — see
 *  `buildSessionToolArray` which conditionally pushes it based on
 *  `settings.ragSearchEnabled`. Adding it to `sharedTools` would
 *  ship it unconditionally, which both slows down tool-selection
 *  cost AND lets the LLM hallucinate calls when the user has the
 *  toggle off. */
const sharedTools: AgentTool<any>[] = [
  executeJsTool, readPageTool, interactTool, inspectTool, tabTool, screenshotTool, pdfTool,
  fsCreateFileTool, fsEditFileTool, fsMkdirTool, fsRenameTool, fsDeleteTool,
  fsReadFileTool, fsListTool, fsSearchTool, fsSaveUrlTool,
  // rag_inspect lives in sharedTools (not session-specific) because it
  // touches a per-installation Neon database, not the session workspace.
  // Read-only — safe to expose to every session.
  ragInspectTool,
  chromeApiTool,
  // BG scheduler automation — 4 CRUD-style tools shared across sessions
  // (BG holds task state in storage, not per-session). LLM cannot update
  // existing tasks (no scheduler_update) to prevent schedule drift; the
  // Settings UI is the only path for partial edits.
  ...schedulerTools,
];

/**
 * Discover MCP tools across all enabled servers, isolating per-server failures.
 * Returns AgentTool instances ready to merge into a session's tool array.
 *
 * Safe to call repeatedly — manager caches results with a long TTL and dedups
 * concurrent refreshes.
 *
 * Filters out tools whose `_meta.ui.visibility` excludes `"model"` per MCP
 * Apps SEP-1865 — those are app-only tools (callable by the iframe via
 * `tools/call` but invisible to the LLM). v1 doesn't proxy app-initiated
 * tool calls, so app-only tools are effectively dormant; we still exclude
 * them from the agent's list to honour the spec and avoid polluting the
 * LLM with unreachable options.
 */
export async function discoverMCPTools(): Promise<AgentTool<any>[]> {
  const mcpResults = await getMCPManager().getAllTools();
  const out: AgentTool<any>[] = [];
  for (const result of mcpResults) {
    if (result.error) {
      console.warn(`[mcp] failed to load tools from "${result.server.name}":`, result.error);
      continue;
    }
    for (const t of result.tools) {
      const visibility = t._meta?.ui?.visibility;
      if (Array.isArray(visibility) && !visibility.includes('model')) {
        // Spec MUST: do not expose app-only tools to the agent. Warn once
        // per discovery so a user wondering where their tool went finds
        // an answer in the BG console rather than digging through specs.
        console.warn(`[mcp] hidden from agent: "${t.name}" on "${result.server.name}" — _meta.ui.visibility=${JSON.stringify(visibility)}`);
        continue;
      }
      out.push(createMCPAgentTool(result.server, t));
    }
  }
  return out;
}

/**
 * Build the full tool array for a session = interactive tools + shared + MCP +
 * the per-session `run_skill` instance (sessionId-bound so its vfs writes land
 * in the session's workspace).
 *
 * Used at session creation, when MCP config changes mid-session
 * (`watchMCPTools`), and when the Worker Team master switch flips
 * (`watchWorkerTeam` → immediate rebuild of live sessions' tool arrays).
 *
 * `delegate_dom` is ALWAYS included so the main agent sees it in its tool
 * list even when the user hasn't yet configured a sub-agent model. The tool
 * itself checks `domSubAgentModel` at execute time and returns a friendly
 * error message if not configured — that's cheaper than hiding the tool and
 * having the agent ask the user "do you have a sub-agent tool?" when they
 * could just turn it on in Settings → Advanced. This also avoids the trap
 * where the user changes the setting AFTER creating a session: the tool is
 * already in the list, so changes take effect immediately.
 *
 * `delegate_task` is gated by the Worker Team master switch
 * (`workerTeamEnabled` storage): we always import + factory-build the tool
 * (the per-session factory closes `sessionId` for path validation regardless
 * of the flag), but only push it into the session's tool array when ON.
 * When OFF, the corresponding `<available-workers>` L1 block is also omitted
 * from the system prompt (`prompt-composer.ts`) so the agent neither sees
 * the tool nor reads about how to call it. This two-sided gate mirrors the
 * `rag_search` / `ragSearchEnabled` pattern: tool + prompt must agree, or
 * the LLM hallucinates calls (tool missing) or never picks the tool (prompt
 * missing). The per-role model config (`workerModels` storage) is checked
 * at execute time by the worker runner — independent of this on/off gate.
 */
export async function buildSessionToolArray(
  ctx: SessionToolContext,
  /** 兼容旧调用：直接传 broadcast callback；新调用传 options 以携带 Team 快照和主模型。 */
  optionsOrBroadcast?: SessionToolOptions | ((msg: ServerMessage) => void),
): Promise<AgentTool<any>[]> {
  const options: SessionToolOptions = typeof optionsOrBroadcast === 'function'
    ? { broadcast: optionsOrBroadcast }
    : optionsOrBroadcast ?? {};
  const { broadcast, getMainModel } = options;
  const teamOn = options.workerTeamOn ?? (await workerTeamEnabled.getValue());
  // Cold-start profiling: MCP discovery and the lazy delegate_dom import are
  // the two async paths in this function. Log each so we can see which one
  // dominates when `createSessionTools` is slow on a fresh session. Pure
  // instrumentation — no behavior change. Remove once we've measured enough
  // sessions to confirm nothing is unexpectedly heavy.
  const mcpStart = Date.now();
  const mcpTools = await discoverMCPTools();
  debugLog.info('tool', 'tool:init:mcp',
    withSession({
      durationMs: Date.now() - mcpStart,
      toolCount: mcpTools.length,
    }, ctx.sessionId));

  const runSkill = createSessionRunSkillTool(ctx.sessionId);
  const base = [...ctx.getInteractiveTools(), ...sharedTools, runSkill, ...mcpTools];
  // canvas_open 也是 per-session 工厂（BG canvas 状态按 session 隔离）；
  // 见 `lib/canvas/tool-canvas-open.ts` 头注释。
  base.push(createSessionCanvasOpenTool(ctx.sessionId));
  // Always include delegate_dom — checks the sub-agent model at runtime.
  const delegateStart = Date.now();
  const { delegateDomTool } = await import('./delegate-dom');
  debugLog.info('tool', 'tool:init:delegate-dom',
    withSession({
      durationMs: Date.now() - delegateStart,
    }, ctx.sessionId));
  base.push(delegateDomTool);
  // `delegate_task` is gated by the Worker Team master switch
  // (`workerTeamEnabled` storage). Per-session factory runs unconditionally
  // (closes sessionId for path validation); the resulting tool object is
  // pushed only when the flag is on. When off, the matching `<available-workers>`
  // L1 block is also omitted from the system prompt (`prompt-composer.ts`).
  const delegateTaskStart = Date.now();
  const { createDelegateTaskTool } = await import('./delegate-task');
  const delegateTaskTool = createDelegateTaskTool({ sessionId: ctx.sessionId, broadcast, getMainModel });
  debugLog.info('tool', 'tool:init:delegate-task',
    withSession({
      durationMs: Date.now() - delegateTaskStart,
      workerTeamEnabled: teamOn,
    }, ctx.sessionId));
  if (teamOn) {
    base.push(delegateTaskTool);
  }

  // Conditional opt-in: only ship `rag_search` when the user has
  // flipped the toggle in Settings → Knowledge. Keeping it out of
  // the tool list when off (rather than shipping it and erroring at
  // execute time) means the LLM never sees an option it can't
  // actually use — lower tool-selection latency, smaller prompts.
  // The execute path also re-checks the flag as a safety net in
  // case the user toggled the switch mid-session and a stale tool
  // entry somehow survived.
  const ragSettingsStart = Date.now();
  const { ragSettings } = await import('@/lib/rag');
  const currentRagSettings = await ragSettings.getValue();
  debugLog.info('tool', 'tool:init:rag-search',
    withSession({
      durationMs: Date.now() - ragSettingsStart,
      enabled: currentRagSettings.ragSearchEnabled,
    }, ctx.sessionId));
  if (currentRagSettings.ragSearchEnabled) {
    base.push(ragSearchTool);
  }
  return base;
}

/**
 * Create a session-specific tools array with its own SessionToolContext.
 * Each session gets independent bridges so concurrent sessions don't conflict.
 *
 * Async because MCP tool discovery may need to fetch from remote servers
 * (cached by the manager so subsequent sessions are fast).
 */
export async function createSessionTools(
  sessionId: string,
  /** 见 `buildSessionToolArray` 的同名参数：由 background 注入的会话 options。 */
  optionsOrBroadcast?: SessionToolOptions | ((msg: ServerMessage) => void),
): Promise<{
  tools: AgentTool<any>[];
  ctx: SessionToolContext;
}> {
  const totalStart = Date.now();
  const ctx = new SessionToolContext(sessionId);

  // Register interactive tools (each gets its own bridge)
  const { tool: askUserTool, bridge: askUserBridge } = createSessionAskUserTool();
  ctx.register(TOOL_ASK_USER, askUserBridge, askUserTool);

  const tools = await buildSessionToolArray(ctx, optionsOrBroadcast);

  // Final cold-start total. Pairs with the per-phase markers in
  // buildSessionToolArray so we can attribute the time to MCP discovery vs
  // delegate_dom import vs everything else (register + map + push).
  debugLog.info('tool', 'tool:init:total',
    withSession({
      durationMs: Date.now() - totalStart,
      totalCount: tools.length,
    }, sessionId));

  return { tools, ctx };
}
