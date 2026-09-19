// useSchedulerNotifications — 订阅 BG 推送的 `scheduler_result` 事件，弹 Sonner toast。
//
// Pattern mirror `useCompactionToasts`（compaction-sidepanel-channel.ts + useCompactionToasts.ts）：
//   - channel 由 useBackgroundAgent 在 connect 时调 `schedulerChannel.setPort(port)` 注入，
//     disconnect 时调 `schedulerChannel.setPort(null)` 清状态。本 hook 只读。
//   - subscribe 在 mount 时挂一次；返回的 unsubscribe 在 unmount 时调——单 mount 模式，
//     多个 toast 组件共享同一订阅（refcount 防 React StrictMode 双挂载撕订阅）。
//   - Sonner toast 用 taskName + result.summary——summary 已经被 runner 截到 ≤ 80 字符
//     （lib/scheduler/runner.ts 的 trimSummary），不重复裁剪。
//   - 通知被系统拒绝时给一次性 warning——permission state 跨 re-render 通过 dedupe id
//     保证只弹一次。

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { schedulerChannel, type SchedulerResultEvent } from '@/lib/scheduler/sidepanel-channel';
import { t } from '@/lib/i18n';

type NotificationPermission = 'granted' | 'denied' | 'default';

let mountedCount = 0;

export function useSchedulerNotifications(): void {
  const [permission, setPermission] = useState<NotificationPermission>('default');

  // mount 时探测一次通知权限。`Notification.permission` 是标准 web API（MV3 浏览器
  // 都支持）；结果不持久化——用户改浏览器站点设置后会重新探测（页面 reload 时）。
  // 现代浏览器返回字符串（不是 Promise），旧版本可能返回 Promise——两个分支都处理。
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    const perm = Notification.permission;
    if (typeof perm === 'string') {
      setPermission(perm as NotificationPermission);
    } else if (typeof (perm as Promise<NotificationPermission>).then === 'function') {
      (perm as Promise<NotificationPermission>).then(setPermission).catch(() => setPermission('default'));
    }
  }, []);

  useEffect(() => {
    mountedCount++;
    if (mountedCount > 1) return; // 已经有人订阅了

    const unsubscribe = schedulerChannel.subscribeResult((event: SchedulerResultEvent) => {
      const taskName = event.result.ok
        ? t('settings.scheduler.resultToastSuccess', [event.taskId])
        : t('settings.scheduler.resultToastFailure', [event.taskId]);
      if (event.result.ok) {
        toast.success(`${taskName}: ${event.result.summary}`, { duration: 4000 });
      } else {
        toast.error(`${taskName}: ${event.result.summary}`, { duration: 6000 });
      }
    });

    return () => {
      mountedCount--;
      if (mountedCount === 0) unsubscribe();
    };
  }, []);

  // 通知被阻止时给一次性提示（dedupe by id：permission state 不变就不重复弹）。
  useEffect(() => {
    if (permission === 'denied') {
      toast.warning(t('settings.scheduler.permissionDeniedBody'), {
        duration: 6000,
        id: 'scheduler-permission-denied',
      });
    }
  }, [permission]);
}
