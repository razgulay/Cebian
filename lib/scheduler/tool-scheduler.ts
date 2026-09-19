// Scheduler 域的 LLM 工具（4 个）—— `scheduler_list` / `scheduler_create` /
// `scheduler_delete` / `scheduler_run_now`。`scheduler_update` 不暴露给 LLM
// —— 用户通过 Settings UI 编辑，LLM 不应改 user schedule（防 LLM 误覆盖）。
//
// 跨 context：工具跑在 extension context（sidepanel / BG），通过
// `chrome.runtime.sendMessage` → BG 端 `schedulerClientHandlers` 走
// `lib/scheduler/validate.ts` 校验 → 落 `local:scheduledTasks` 存储。
// `lastRunAt` / `lastResult` 由 BG 写入（自动 tick 或手动 run_now 后）——
// 工具不主动写。错误路径按 AGENTS.md「Tool Failure Handling」：真错 →
// `throw new Error(...)` 让 pi-agent-core 把 `message.isError = true` 冒给 LLM。
// 空结果（如 `scheduler_list` 没 task）→ `return` success + descriptive content。

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  TOOL_SCHEDULER_CREATE,
  TOOL_SCHEDULER_DELETE,
  TOOL_SCHEDULER_LIST,
  TOOL_SCHEDULER_RUN_NOW,
} from '@/lib/tools/names';
import type { ClientMessage } from '@/lib/ipc/protocol';
import type {
  Action,
  NotifyConfig,
  ScheduledTask,
  Schedule,
} from '@/lib/scheduler/types';
import { isSchedulerCreateResult, isSchedulerListResult, sendAndReceive } from './scheduler-ipc';

// ─── Per-tool details side channel (AGENTS.md 约定：named interface 优于 inline 匿名) ───

/** `scheduler_list` 无 payload；details 保留 `{}` 与现有 `read-page.ts` 等 shared tool 对齐。 */
export interface SchedulerListDetails {}

/** `scheduler_create` 回执携带 BG 写完后立刻得到的 id 与完整 task 镜像。
 *  LLM 据此调用 run_now / delete 时不会因 name-match 拿到旧 task。 */
export interface SchedulerCreateDetails {
  id: string;
  task: ScheduledTask;
}

/** `scheduler_delete` 回执带 `id` + `deleted: true` 标记——LLM 可在多 task 同名
 *  情况下精确知道是哪一条被删。 */
export interface SchedulerDeleteDetails {
  id: string;
  deleted: true;
}

/** `scheduler_run_now` 回执的 id 是 LLM 输入的 id（BG handler 不返回 server-acked
 *  id——只回 replyList；详见 BG `client-handlers.ts#scheduler_run_now`）。工具
 *  只 ack 派发成功，result 通过 `scheduler_result` pub/sub 推到 UI。 */
export interface SchedulerRunNowDetails {
  id: string;
}

// ─── Parameter schemas ───

const ScheduleSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('interval'),
    minutes: Type.Number({
      description: 'Run every N minutes. Must be ≥ 1 (chrome.alarms periodInMinutes floor).',
      minimum: 1,
    }),
  }),
  Type.Object({
    kind: Type.Literal('cron'),
    expr: Type.String({
      description:
        '5-field cron expression (minute hour dayOfMonth month dayOfWeek). ' +
        'The same cron-parser v5 syntax used by the Settings UI; 5-field input is auto-padded with leading 0.',
    }),
  }),
]);

const ActionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('fetch'),
    url: Type.String({ description: 'HTTP/HTTPS URL to fetch (max 30s timeout per task).' }),
    extract: Type.Optional(Type.String({
      description:
        'Optional simple dot-path to extract a JSON field from the response ' +
        '(e.g. "data.user.name"). Wildcards / brackets not supported.',
    })),
  }),
  Type.Object({
    kind: Type.Literal('webcheck'),
    url: Type.String({ description: 'HTTP/HTTPS URL to probe.' }),
    condition: Type.Union([
      Type.Literal('status_200'),
      Type.Literal('contains_text'),
    ]),
    expected: Type.Optional(Type.String({
      description:
        'Required when condition is "contains_text": substring the response body must include.',
    })),
  }),
]);

const SchedulerCreateParameters = Type.Object({
  name: Type.String({
    description: 'Display name (≤ 60 chars). Shown in notifications + Settings list.',
    maxLength: 60,
  }),
  schedule: ScheduleSchema,
  action: ActionSchema,
  notify: Type.Object({
    onSuccess: Type.Boolean({ description: 'Show a desktop notification when the task succeeds.' }),
    onFailure: Type.Boolean({ description: 'Show a desktop notification when the task fails.' }),
  }),
  enabled: Type.Boolean({ description: 'If false, the task is skipped until re-enabled (per-session toggle).' }),
});

const SchedulerDeleteParameters = Type.Object({
  id: Type.String({
    description: 'UUID of the task to delete. Use scheduler_list first to find IDs.',
  }),
});

const SchedulerRunNowParameters = Type.Object({
  id: Type.String({
    description: 'UUID of the task to run immediately (without waiting for the next scheduled tick).',
  }),
});

// ─── Tool definitions ───

/** List all scheduled tasks (any status: enabled / disabled; lastRunAt / lastResult included). */
const schedulerListTool: AgentTool<{}, SchedulerListDetails> = {
  name: TOOL_SCHEDULER_LIST,
  label: 'List scheduled tasks',
  description:
    'List all BG scheduler tasks: name, schedule (interval/cron), action (fetch/webcheck), ' +
    'notify config, enabled flag, lastRunAt, and lastResult (ok + summary + at). ' +
    'Use scheduler_delete by id; use scheduler_run_now by id.',
  parameters: Type.Object({}),

  async execute(_toolCallId, _params, signal): Promise<AgentToolResult<Record<string, never>>> {
    signal?.throwIfAborted();
    try {
      const reply = await sendAndReceive({ type: 'scheduler_list' }, isSchedulerListResult);
      const tasks = reply.tasks as unknown as ScheduledTask[];
      if (tasks.length === 0) {
        return {
          content: [{ type: 'text', text: 'No scheduled tasks. Use scheduler_create to add one.' }],
          details: {},
        };
      }
      // 摘要给 LLM 看——单行 per task，含 schedule + action + lastResult 标记。
      // LLM 不需要完整 JSON；具体字段在 Settings UI 里查。
      const lines = tasks.map((t) => {
        const sched = t.schedule.kind === 'interval'
          ? `every ${t.schedule.minutes} min`
          : `cron ${t.schedule.expr}`;
        const act = t.action.kind === 'fetch'
          ? `fetch ${t.action.url}${t.action.extract ? `→${t.action.extract}` : ''}`
          : `webcheck ${t.action.url} ${t.action.condition}${t.action.expected ? ` "${t.action.expected}"` : ''}`;
        const last = t.lastResult
          ? ` [last: ${t.lastResult.ok ? '✓' : '✗'} ${t.lastResult.summary}]`
          : '';
        const en = t.enabled ? '●' : '○';
        return `${en} ${t.id.slice(0, 8)} "${t.name}" — ${sched}; ${act}${last}`;
      });
      return {
        content: [{ type: 'text', text: `${tasks.length} task(s):\n${lines.join('\n')}` }],
        details: {},
      };
    } catch (err) {
      throw new Error(`scheduler_list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

/** Create a new scheduled task. BG validates URL scheme / cron / minutes ≥ 1 / webcheck.expected requirements. */
const schedulerCreateTool: AgentTool<typeof SchedulerCreateParameters, SchedulerCreateDetails> = {
  name: TOOL_SCHEDULER_CREATE,
  label: 'Create scheduled task',
  description:
    'Create a new BG automation job. Schedule by interval (every N minutes, ' +
    'chrome.alarms periodInMinutes floor) or by 5-field cron expression. ' +
    'Action either fetches a URL (optionally extracting a JSON field) or probes a URL ' +
    'for status_200 / body-contains-text. The task fires once per minute tick per BG, ' +
    'respecting enabled + schedule. Note: the LLM cannot edit an existing task (no ' +
    'scheduler_update) — ask the user to adjust via the Settings UI to avoid schedule drift.',
  parameters: SchedulerCreateParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<SchedulerCreateDetails>> {
    signal?.throwIfAborted();
    try {
      // 工具层 cast `unknown` 给 BG——BG 端 `lib/scheduler/validate.ts` 才是 source of truth。
      const task: Omit<ScheduledTask, 'id' | 'lastRunAt' | 'lastResult'> = {
        name: params.name,
        schedule: params.schedule as Schedule,
        action: params.action as Action,
        notify: params.notify as NotifyConfig,
        enabled: params.enabled,
        createdAt: Date.now(),
      };
      const reply = await sendAndReceive(
        { type: 'scheduler_create', task } as ClientMessage,
        isSchedulerCreateResult,
      );
      // BG 直接给 id + 写完后的 task——比 name-match 找 id 安全（用户/已有同名校时不误导 LLM）
      const taskCreated = reply.task as unknown as ScheduledTask;
      return {
        content: [
          {
            type: 'text',
            text: `Scheduled task "${params.name}" created (id: ${reply.id}). ` +
              `It will fire on the next minute tick per its schedule. ` +
              `Use scheduler_run_now with this id to trigger immediately.`,
          },
        ],
        details: { id: reply.id, task: taskCreated },
      };
    } catch (err) {
      throw new Error(`scheduler_create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

/** Delete a task by id. */
const schedulerDeleteTool: AgentTool<typeof SchedulerDeleteParameters, SchedulerDeleteDetails> = {
  name: TOOL_SCHEDULER_DELETE,
  label: 'Delete scheduled task',
  description:
    'Delete a BG scheduler task by its id. Use scheduler_list first to find the id. ' +
    'Cannot be undone — the task + its history are removed from storage.',
  parameters: SchedulerDeleteParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<SchedulerDeleteDetails>> {
    signal?.throwIfAborted();
    try {
      const reply = await sendAndReceive(
        { type: 'scheduler_delete', id: params.id } as ClientMessage,
        isSchedulerListResult,
      );
      const tasks = reply.tasks as unknown as ScheduledTask[];
      const stillExists = tasks.some((t) => t.id === params.id);
      if (stillExists) {
        throw new Error(`scheduler_delete failed: task with id "${params.id}" still present after delete (BG handler bug?).`);
      }
      return {
        content: [{ type: 'text', text: `Scheduled task "${params.id}" deleted.` }],
        details: { id: params.id, deleted: true },
      };
    } catch (err) {
      throw new Error(`scheduler_delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

/** Manually trigger a task immediately (without waiting for the next minute tick). */
const schedulerRunNowTool: AgentTool<typeof SchedulerRunNowParameters, SchedulerRunNowDetails> = {
  name: TOOL_SCHEDULER_RUN_NOW,
  label: 'Run scheduled task now',
  description:
    'Trigger an immediate run of the scheduled task (does not affect its schedule). ' +
    'The result is pushed via the BG scheduler_result pub/sub and surfaces as a Sonner ' +
    'toast in the sidepanel — this tool only waits for the BG ack (task dispatched), ' +
    'not the final run result.',
  parameters: SchedulerRunNowParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ id: string }>> {
    signal?.throwIfAborted();
    try {
      await sendAndReceive(
        { type: 'scheduler_run_now', id: params.id } as ClientMessage,
        isSchedulerListResult,
      );
      return {
        content: [
          {
            type: 'text',
            text: `Task "${params.id}" dispatched. The run result will appear as a ` +
              `notification when it completes (typically a few seconds, max 30s).`,
          },
        ],
        details: { id: params.id },
      };
    } catch (err) {
      throw new Error(`scheduler_run_now failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

/** All 4 scheduler tools bundled together. Tools run in extension context (BG / sidepanel)
 *  — they share `chrome.runtime.sendMessage`, no per-session factory needed. */
export const schedulerTools: AgentTool<any>[] = [
  schedulerListTool,
  schedulerCreateTool,
  schedulerDeleteTool,
  schedulerRunNowTool,
];
