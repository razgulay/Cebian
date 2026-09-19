// ScheduledTask input validation — pure function shared by BG client-handlers
// （以及未来的 UI 表单）。
//
// 所有函数返回 `{ ok, value? | error? }` 形态，不抛——`cron.ts` 同款约定。
// 调用方负责把 `error` 透给 LLM / UI 显示，调用方不需要 try/catch。

import type {
  Action,
  NotifyConfig,
  ScheduledTask,
  Schedule,
  WebCheckCondition,
} from './types';
import { validateCronExpression } from './cron';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 校验一个 URL 是否合法且 scheme 是 http/https。空字符串与 malformed 都拒。
 *  用 `URL` 构造器（标准平台 API，不引依赖）。Exported 给 `validate.test.ts`
 *  单测 + 未来 UI 表单的 inline 校验复用。 */
export function validateUrl(field: string, url: unknown): ValidationResult<string> {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, error: `${field} must be a non-empty string.` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `${field} is not a valid URL.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `${field} must use http or https scheme (got '${parsed.protocol}').` };
  }
  return { ok: true, value: url };
}

/** Validate `fetch` action. */
function validateFetchAction(input: unknown, pathPrefix: string): ValidationResult<Action> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: `${pathPrefix}.action must be an object.` };
  }
  const obj = input as Record<string, unknown>;
  if (obj.kind !== 'fetch') {
    return { ok: false, error: `${pathPrefix}.action.kind must be 'fetch'.` };
  }
  const url = validateUrl(`${pathPrefix}.action.url`, obj.url);
  if (!url.ok) return url;

  if (obj.extract !== undefined) {
    if (typeof obj.extract !== 'string' || obj.extract.length === 0) {
      return { ok: false, error: `${pathPrefix}.action.extract must be a non-empty string when provided.` };
    }
    // v1 只支持点路径，不接受带 wildcard / bracket
    if (/[\[\]*?]/.test(obj.extract)) {
      return { ok: false, error: `${pathPrefix}.action.extract only supports simple dot paths; got '${obj.extract}'.` };
    }
  }

  const action: Action = {
    kind: 'fetch',
    url: url.value,
    ...(typeof obj.extract === 'string' && obj.extract.length > 0 ? { extract: obj.extract } : {}),
  };
  return { ok: true, value: action };
}

/** Validate `webcheck` action. `expected` required iff condition === 'contains_text'. */
function validateWebCheckAction(input: unknown, pathPrefix: string): ValidationResult<Action> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: `${pathPrefix}.action must be an object.` };
  }
  const obj = input as Record<string, unknown>;
  if (obj.kind !== 'webcheck') {
    return { ok: false, error: `${pathPrefix}.action.kind must be 'webcheck'.` };
  }
  const url = validateUrl(`${pathPrefix}.action.url`, obj.url);
  if (!url.ok) return url;

  const condition = obj.condition;
  if (condition !== 'status_200' && condition !== 'contains_text') {
    return {
      ok: false,
      error: `${pathPrefix}.action.condition must be 'status_200' or 'contains_text' (got '${String(condition)}').`,
    };
  }

  if (condition === 'contains_text') {
    if (typeof obj.expected !== 'string' || obj.expected.length === 0) {
      return {
        ok: false,
        error: `${pathPrefix}.action.expected must be a non-empty string when condition is 'contains_text'.`,
      };
    }
  }

  const action: Action = {
    kind: 'webcheck',
    url: url.value,
    condition: condition as WebCheckCondition,
    ...(condition === 'contains_text' && typeof obj.expected === 'string'
      ? { expected: obj.expected }
      : {}),
  };
  return { ok: true, value: action };
}

/** Validate `schedule` discriminated union. */
function validateSchedule(input: unknown, pathPrefix: string): ValidationResult<Schedule> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: `${pathPrefix}.schedule must be an object.` };
  }
  const obj = input as Record<string, unknown>;

  if (obj.kind === 'interval') {
    if (typeof obj.minutes !== 'number' || !Number.isFinite(obj.minutes)) {
      return { ok: false, error: `${pathPrefix}.schedule.minutes must be a number.` };
    }
    // chrome.alarms periodInMinutes 最小 1 分钟（MV3 强制）。
    if (!Number.isInteger(obj.minutes) || obj.minutes < 1) {
      return {
        ok: false,
        error: `${pathPrefix}.schedule.minutes must be an integer ≥ 1 (chrome.alarms floor).`,
      };
    }
    return { ok: true, value: { kind: 'interval', minutes: obj.minutes } };
  }

  if (obj.kind === 'cron') {
    if (typeof obj.expr !== 'string' || obj.expr.length === 0) {
      return { ok: false, error: `${pathPrefix}.schedule.expr must be a non-empty string.` };
    }
    const cron = validateCronExpression(obj.expr);
    if (!cron.ok) {
      return { ok: false, error: `${pathPrefix}.schedule.expr: ${cron.error}` };
    }
    return { ok: true, value: { kind: 'cron', expr: obj.expr } };
  }

  return { ok: false, error: `${pathPrefix}.schedule.kind must be 'interval' or 'cron' (got '${String(obj.kind)}').` };
}

/** Validate `notify` config. */
function validateNotifyConfig(input: unknown, pathPrefix: string): ValidationResult<NotifyConfig> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: `${pathPrefix}.notify must be an object.` };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.onSuccess !== 'boolean' || typeof obj.onFailure !== 'boolean') {
    return {
      ok: false,
      error: `${pathPrefix}.notify.onSuccess and onFailure must both be booleans.`,
    };
  }
  return {
    ok: true,
    value: { onSuccess: obj.onSuccess, onFailure: obj.onFailure },
  };
}

/** Validate 完整 task input for create. `id` 由 server 生成；`lastRunAt` / `lastResult`
 *  必须为 null（新建任务不可能有历史结果）。 */
export function validateNewTaskInput(input: unknown): ValidationResult<Omit<ScheduledTask, 'id' | 'lastRunAt' | 'lastResult'>> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Task must be an object.' };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return { ok: false, error: 'Task name must be a non-empty string.' };
  }
  if (obj.name.length > 60) {
    return { ok: false, error: 'Task name must be ≤ 60 characters.' };
  }

  const schedule = validateSchedule(obj.schedule, 'task');
  if (!schedule.ok) return schedule;

  const action = obj.action;
  if (typeof action !== 'object' || action === null) {
    return { ok: false, error: 'task.action must be an object.' };
  }
  const actionKind = (action as Record<string, unknown>).kind;
  let actionResult: ValidationResult<Action>;
  if (actionKind === 'fetch') {
    actionResult = validateFetchAction(action, 'task');
  } else if (actionKind === 'webcheck') {
    actionResult = validateWebCheckAction(action, 'task');
  } else {
    return { ok: false, error: `task.action.kind must be 'fetch' or 'webcheck' (got '${String(actionKind)}').` };
  }
  if (!actionResult.ok) return actionResult;

  const notify = validateNotifyConfig(obj.notify, 'task');
  if (!notify.ok) return notify;

  if (typeof obj.enabled !== 'boolean') {
    return { ok: false, error: 'task.enabled must be a boolean.' };
  }
  if (typeof obj.createdAt !== 'number' || !Number.isFinite(obj.createdAt)) {
    return { ok: false, error: 'task.createdAt must be a finite number (ms timestamp).' };
  }

  return {
    ok: true,
    value: {
      name: obj.name,
      schedule: schedule.value,
      action: actionResult.value,
      notify: notify.value,
      enabled: obj.enabled,
      createdAt: obj.createdAt,
    },
  };
}

/** Validate partial update payload. All fields optional; at least one must be present.
 *  返回 `Partial<...>` 让 handler 自己 merge 到现有 task。 */
export function validateTaskPatchInput(
  input: unknown,
): ValidationResult<Partial<Pick<ScheduledTask, 'name' | 'schedule' | 'action' | 'notify' | 'enabled'>>> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Patch must be an object.' };
  }
  const obj = input as Record<string, unknown>;

  // 至少一个字段必须存在
  const keys = ['name', 'schedule', 'action', 'notify', 'enabled'] as const;
  const hasAny = keys.some((k) => obj[k] !== undefined);
  if (!hasAny) {
    return { ok: false, error: 'Patch must contain at least one of: name, schedule, action, notify, enabled.' };
  }

  const patch: Partial<Pick<ScheduledTask, 'name' | 'schedule' | 'action' | 'notify' | 'enabled'>> = {};

  if (obj.name !== undefined) {
    if (typeof obj.name !== 'string' || obj.name.length === 0) {
      return { ok: false, error: 'patch.name must be a non-empty string.' };
    }
    if (obj.name.length > 60) {
      return { ok: false, error: 'patch.name must be ≤ 60 characters.' };
    }
    patch.name = obj.name;
  }

  if (obj.schedule !== undefined) {
    const r = validateSchedule(obj.schedule, 'patch');
    if (!r.ok) return r;
    patch.schedule = r.value;
  }

  if (obj.action !== undefined) {
    const actionKind = (obj.action as Record<string, unknown> | null)?.kind;
    let actionResult: ValidationResult<Action>;
    if (actionKind === 'fetch') {
      actionResult = validateFetchAction(obj.action, 'patch');
    } else if (actionKind === 'webcheck') {
      actionResult = validateWebCheckAction(obj.action, 'patch');
    } else {
      return { ok: false, error: `patch.action.kind must be 'fetch' or 'webcheck' (got '${String(actionKind)}').` };
    }
    if (!actionResult.ok) return actionResult;
    patch.action = actionResult.value;
  }

  if (obj.notify !== undefined) {
    const r = validateNotifyConfig(obj.notify, 'patch');
    if (!r.ok) return r;
    patch.notify = r.value;
  }

  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== 'boolean') {
      return { ok: false, error: 'patch.enabled must be a boolean.' };
    }
    patch.enabled = obj.enabled;
  }

  return { ok: true, value: patch };
}
