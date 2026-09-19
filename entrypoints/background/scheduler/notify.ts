// chrome.notifications 包装——BG 域 scheduler 任务结果通知。
//
// chrome.notifications 需要 `notifications` permission（已在 wxt.config.ts 声明）；
// 用户在 install 时可能拒绝授权 → `getPermissionLevel() === 'denied'`，我们 fallback
// console.warn 跳过（不阻塞 BG tick）。icon 复用 `icon/128.png`（manifest
// `web_accessible_resources` 已声明），不内嵌资源二进制。
//
// Notification id 命名：`scheduler:<taskName>-<nowMs>`——用 taskName + 时间戳保证唯一，
// 不同 task 同时通知不互相覆盖；同 task 连续两次通知也各占一格（chrome.notifications
// 同 id 会替换，所以时间戳防撞）。

import { browser } from 'wxt/browser';
import type { RunResult, ScheduledTask } from '@/lib/scheduler/types';

const ICON_PATH = browser.runtime.getURL('/icon/128.png');

interface NotifyPayload {
  taskName: string;
  success: boolean;
  summary: string;
}

/** 把 RunResult + task 派给 chrome.notifications.create。权限缺失 / API 异常
 *  在内部兜底（warn + 返回），不抛给 caller——BG tick 不该因为通知失败而失败。 */
export async function sendTaskNotification(
  task: ScheduledTask,
  result: RunResult,
): Promise<void> {
  const shouldNotify = result.ok ? task.notify.onSuccess : task.notify.onFailure;
  if (!shouldNotify) return;

  const payload: NotifyPayload = {
    taskName: task.name,
    success: result.ok,
    summary: result.summary,
  };

  try {
    const level = await chrome.notifications.getPermissionLevel();
    if (level === 'denied') {
      console.warn(
        `[scheduler] notification permission denied, skipping "${task.name}" notification`,
      );
      return;
    }
  } catch (err) {
    // getPermissionLevel 极少失败，但防御性 catch 一下——不影响其它逻辑。
    console.warn('[scheduler] getPermissionLevel failed:', err);
    return;
  }

  const id = `scheduler:${payload.taskName}-${Date.now()}`;
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: ICON_PATH,
      title: payload.success ? `✓ ${payload.taskName}` : `✗ ${payload.taskName}`,
      message: payload.summary,
    } satisfies chrome.notifications.NotificationCreateOptions);
  } catch (err) {
    // 用户可能在系统设置关掉了通知；扩展自身没拿到授权；iconUrl 不存在等。
    // 都不该让 BG tick 翻车。
    console.warn(
      `[scheduler] notification create failed for "${task.name}":`,
      err,
    );
  }
}
