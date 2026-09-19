// SchedulerSection — Settings → Scheduled tasks 区块。
//
// CRUD UI 通过 `useScheduledTasks` hook (IPC) 跟 BG 通信：
//   - 列表 mount 拉一次 + mutation 后 BG 回 `scheduler_list_result`
//   - 创建/编辑通过 dialog，validate 失败时 BG 回 `error` toast
//   - 「立即运行」按钮：BG 调 `runTask` + publish `scheduler_result` (source='manual')；
//     `useSchedulerNotifications` 接住后弹 Sonner toast——结果可见。
//
// Validation: 同一份 `lib/scheduler/validate.ts`（BG 端），失败时 BG 回 error，
// UI 端把 message 显示给用户。不重复校验（lib → entrypoints 边界 + DRY）。

import { useState } from 'react';
import {
  ClipboardList,
  Pencil,
  Play,
  Plus,
  Trash2,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { showConfirm } from '@/lib/ui/dialog';
import { toast } from 'sonner';
import { useScheduledTasks } from '@/hooks/useScheduledTasks';
import { useSchedulerNotifications } from '@/hooks/useSchedulerNotifications';
import { t } from '@/lib/i18n';
import type { Action, ScheduledTask, Schedule } from '@/lib/scheduler/types';

/** 编辑表单的本地 draft —— 用 partial `Pick` 因为 schedule/action 可任一形式。 */
interface DraftForm {
  name: string;
  scheduleKind: 'interval' | 'cron';
  intervalMinutes: number;
  cronExpr: string;
  actionKind: 'fetch' | 'webcheck';
  fetchUrl: string;
  fetchExtract: string;
  webcheckUrl: string;
  webcheckCondition: 'status_200' | 'contains_text';
  webcheckExpected: string;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  enabled: boolean;
}

function emptyDraft(): DraftForm {
  return {
    name: '',
    scheduleKind: 'interval',
    intervalMinutes: 15,
    cronExpr: '*/15 * * * *',
    actionKind: 'fetch',
    fetchUrl: '',
    fetchExtract: '',
    webcheckUrl: '',
    webcheckCondition: 'status_200',
    webcheckExpected: '',
    notifyOnSuccess: false,
    notifyOnFailure: true,
    enabled: true,
  };
}

function draftFromTask(t: ScheduledTask): DraftForm {
  const sched = t.schedule;
  const action = t.action;
  return {
    name: t.name,
    scheduleKind: sched.kind,
    intervalMinutes: sched.kind === 'interval' ? sched.minutes : 15,
    cronExpr: sched.kind === 'cron' ? sched.expr : '*/15 * * * *',
    actionKind: action.kind,
    fetchUrl: action.kind === 'fetch' ? action.url : '',
    fetchExtract: action.kind === 'fetch' && action.extract ? action.extract : '',
    webcheckUrl: action.kind === 'webcheck' ? action.url : '',
    webcheckCondition:
      action.kind === 'webcheck' ? action.condition : 'status_200',
    webcheckExpected:
      action.kind === 'webcheck' && action.expected ? action.expected : '',
    notifyOnSuccess: t.notify.onSuccess,
    notifyOnFailure: t.notify.onFailure,
    enabled: t.enabled,
  };
}

function buildSchedule(d: DraftForm): Schedule {
  if (d.scheduleKind === 'interval') {
    return { kind: 'interval', minutes: d.intervalMinutes };
  }
  return { kind: 'cron', expr: d.cronExpr };
}

function buildAction(d: DraftForm): Action {
  if (d.actionKind === 'fetch') {
    const extract = d.fetchExtract.trim();
    return {
      kind: 'fetch',
      url: d.fetchUrl,
      ...(extract ? { extract } : {}),
    };
  }
  const expected = d.webcheckExpected.trim();
  return {
    kind: 'webcheck',
    url: d.webcheckUrl,
    condition: d.webcheckCondition,
    ...(d.webcheckCondition === 'contains_text' && expected ? { expected } : {}),
  };
}

function summarizeSchedule(s: Schedule): string {
  if (s.kind === 'interval') return t('settings.scheduler.table.scheduleEvery', [s.minutes]);
  return s.expr;
}

function summarizeAction(a: Action): string {
  if (a.kind === 'fetch') return a.extract ? `${a.url} → ${a.extract}` : a.url;
  if (a.condition === 'status_200') return `${a.url} ${t('settings.scheduler.table.actionStatus200')}`;
  return `${a.url} ${t('settings.scheduler.table.actionContainsText', [a.expected ?? ''])}`;
}

export function SchedulerSection() {
  // 挂通知订阅——单 mount，hook 内部 refcount 防 StrictMode 双挂载撕订阅。
  useSchedulerNotifications();

  const { tasks, loading, error, createTask, updateTask, deleteTask, runNow, refresh } =
    useScheduledTasks();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftForm>(emptyDraft);
  const [busy, setBusy] = useState(false);

  const openCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setEditorOpen(true);
  };

  const openEdit = (task: ScheduledTask) => {
    setEditingId(task.id);
    setDraft(draftFromTask(task));
    setEditorOpen(true);
  };

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const schedule = buildSchedule(draft);
      const action = buildAction(draft);
      if (editingId) {
        const r = await updateTask(editingId, {
          name: draft.name,
          schedule,
          action,
          notify: { onSuccess: draft.notifyOnSuccess, onFailure: draft.notifyOnFailure },
          enabled: draft.enabled,
        });
        if (!r.ok) {
          toast.error(r.error ?? t('settings.scheduler.dialogSaveError'));
          return;
        }
        toast.success(t('settings.scheduler.dialogSave'));
      } else {
        const r = await createTask({
          name: draft.name,
          schedule,
          action,
          notify: { onSuccess: draft.notifyOnSuccess, onFailure: draft.notifyOnFailure },
          enabled: draft.enabled,
          createdAt: Date.now(),
        });
        if (!r.ok) {
          toast.error(r.error ?? t('settings.scheduler.dialogSaveError'));
          return;
        }
        toast.success(t('settings.scheduler.dialogSave'));
      }
      setEditorOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (task: ScheduledTask) => {
    const ok = await showConfirm({
      title: t('settings.scheduler.deleteConfirmTitle'),
      description: t('settings.scheduler.deleteConfirmBody', [task.name]),
      destructive: true,
    });
    if (!ok) return;
    const r = await deleteTask(task.id);
    if (!r.ok) toast.error(r.error ?? '');
  };

  const handleRunNow = async (task: ScheduledTask) => {
    toast.info(t('settings.scheduler.runNowSuccess', [task.name]));
    const r = await runNow(task.id);
    if (!r.ok) toast.error(t('settings.scheduler.runNowFailure', [task.name, r.error ?? '']));
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t('settings.scheduler.title')}</h2>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" />
          {t('settings.scheduler.createButton')}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">{t('settings.scheduler.description')}</p>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {loading && tasks.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border py-8 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border py-8 text-xs text-muted-foreground">
          <ClipboardList className="size-6 opacity-40" />
          <span>{t('settings.scheduler.empty')}</span>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 font-medium">{t('settings.scheduler.columns.name')}</th>
                <th className="px-3 py-2 font-medium">{t('settings.scheduler.columns.schedule')}</th>
                <th className="px-3 py-2 font-medium">{t('settings.scheduler.columns.action')}</th>
                <th className="px-3 py-2 font-medium">{t('settings.scheduler.columns.lastResult')}</th>
                <th className="px-3 py-2 font-medium text-right">{t('settings.scheduler.columns.enabled')}</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 font-medium">{task.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {summarizeSchedule(task.schedule)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {summarizeAction(task.action)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {task.lastResult ? (
                      <span
                        className={
                          task.lastResult.ok
                            ? 'text-emerald-600'
                            : 'text-destructive'
                        }
                      >
                        {task.lastResult.summary}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {task.enabled ? (
                      <span className="text-xs text-emerald-600">●</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">○</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => void handleRunNow(task)}
                            aria-label={t('settings.scheduler.runNowButton')}
                          >
                            <Play className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('settings.scheduler.runNowButton')}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => openEdit(task)}
                            aria-label={t('settings.scheduler.dialogEditTitle')}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('settings.scheduler.dialogEditTitle')}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void handleDelete(task)}
                            aria-label={t('settings.scheduler.dialogDelete')}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('settings.scheduler.dialogDelete')}</TooltipContent>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('settings.scheduler.dialogEditTitle') : t('settings.scheduler.dialogCreateTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('settings.scheduler.table.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">{t('settings.scheduler.table.nameLabel')}</label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} />
            </div>

            <div className="flex gap-3">
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="radio"
                  checked={draft.scheduleKind === 'interval'}
                  onChange={() => setDraft({ ...draft, scheduleKind: 'interval' })}
                />
                {t('settings.scheduler.scheduleType.interval')}
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="radio"
                  checked={draft.scheduleKind === 'cron'}
                  onChange={() => setDraft({ ...draft, scheduleKind: 'cron' })}
                />
                {t('settings.scheduler.scheduleType.cron')}
              </label>
            </div>
            {draft.scheduleKind === 'interval' ? (
              <div>
                <label className="text-xs font-medium">{t('settings.scheduler.intervalLabel')}</label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.intervalMinutes}
                  onChange={(e) =>
                    setDraft({ ...draft, intervalMinutes: Number(e.target.value) })
                  }
                />
              </div>
            ) : (
              <div>
                <label className="text-xs font-medium">{t('settings.scheduler.cronLabel')}</label>
                <Input
                  value={draft.cronExpr}
                  placeholder={t('settings.scheduler.cronPlaceholder')}
                  onChange={(e) => setDraft({ ...draft, cronExpr: e.target.value })}
                />
              </div>
            )}

            <div className="flex gap-3">
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="radio"
                  checked={draft.actionKind === 'fetch'}
                  onChange={() => setDraft({ ...draft, actionKind: 'fetch' })}
                />
                {t('settings.scheduler.actionType.fetch')}
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="radio"
                  checked={draft.actionKind === 'webcheck'}
                  onChange={() => setDraft({ ...draft, actionKind: 'webcheck' })}
                />
                {t('settings.scheduler.actionType.webcheck')}
              </label>
            </div>
            {draft.actionKind === 'fetch' ? (
              <>
                <div>
                  <label className="text-xs font-medium">{t('settings.scheduler.fetchUrlLabel')}</label>
                  <Input
                    value={draft.fetchUrl}
                    placeholder={t('settings.scheduler.table.fetchUrlPlaceholder')}
                    onChange={(e) => setDraft({ ...draft, fetchUrl: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">{t('settings.scheduler.fetchExtractLabel')}</label>
                  <Input
                    value={draft.fetchExtract}
                    placeholder={t('settings.scheduler.fetchExtractPlaceholder')}
                    onChange={(e) => setDraft({ ...draft, fetchExtract: e.target.value })}
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="text-xs font-medium">{t('settings.scheduler.webcheckUrlLabel')}</label>
                  <Input
                    value={draft.webcheckUrl}
                    placeholder={t('settings.scheduler.table.webcheckUrlPlaceholder')}
                    onChange={(e) => setDraft({ ...draft, webcheckUrl: e.target.value })}
                  />
                </div>
                <div className="flex gap-3">
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="radio"
                      checked={draft.webcheckCondition === 'status_200'}
                      onChange={() =>
                        setDraft({ ...draft, webcheckCondition: 'status_200' })
                      }
                    />
                    {t('settings.scheduler.table.webcheckConditionStatus200')}
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="radio"
                      checked={draft.webcheckCondition === 'contains_text'}
                      onChange={() =>
                        setDraft({ ...draft, webcheckCondition: 'contains_text' })
                      }
                    />
                    {t('settings.scheduler.table.webcheckConditionContainsText')}
                  </label>
                </div>
                {draft.webcheckCondition === 'contains_text' && (
                  <div>
                    <label className="text-xs font-medium">{t('settings.scheduler.webcheckExpectedLabel')}</label>
                    <Input
                      value={draft.webcheckExpected}
                      onChange={(e) => setDraft({ ...draft, webcheckExpected: e.target.value })}
                    />
                  </div>
                )}
              </>
            )}

            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={draft.notifyOnSuccess}
                  onCheckedChange={(v) => setDraft({ ...draft, notifyOnSuccess: v === true })}
                />
                {t('settings.scheduler.notifyOnSuccess')}
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={draft.notifyOnFailure}
                  onCheckedChange={(v) => setDraft({ ...draft, notifyOnFailure: v === true })}
                />
                {t('settings.scheduler.notifyOnFailure')}
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={draft.enabled}
                  onCheckedChange={(v) => setDraft({ ...draft, enabled: v === true })}
                />
                {t('settings.scheduler.enabled')}
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={busy}>
              {t('settings.scheduler.dialogCancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={busy}>
              {t('settings.scheduler.dialogSave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
