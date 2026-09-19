// NotificationsSection — Settings → Notification channels 区块。
//
// 三种 channel kind 共享同一个 form skeleton（name + kind + kind-specific 字段
// + enabled + notifyOnSuccess + notifyOnFailure）。Add / Edit 用同一个 dialog，靠
// `editingId` 切换 mode。Test 按钮调 `useNotifyChannels.testSingleChannel` 拿 BG
// 端 `scheduler_channel_test_result`，显示「Last test: X ms」+ 成功/失败 badge。
//
// 「Secret」字段（endpoint / token / URL）只在 Edit dialog 内填；BG 端
// `validateChannelPair` 在 N3 的 IPC handler 里做最终校验。这里 UI 只做
// 「secret 缺失 → Test 按钮 disable」轻量守门，BG 再严一次。

import { useCallback, useEffect, useState } from 'react';
import { BellRing, Pencil, Plus, Send, Trash2, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { showConfirm } from '@/lib/ui/dialog';
import { useNotifyChannels, type TestChannelResult } from '@/hooks/useNotifyChannels';
import type { ChannelConfig, ChannelKind, ChannelSecret } from '@/lib/scheduler/notify-channels/types';
import { t } from '@/lib/i18n';

interface DraftForm {
  name: string;
  topic: string;
  endpoint: string;
  chatId: string;
  url: string;
  enabled: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
}

function emptyDraft(): DraftForm {
  return {
    name: '',
    topic: '',
    endpoint: '',
    chatId: '',
    url: '',
    enabled: true,
    notifyOnSuccess: false,
    notifyOnFailure: true,
  };
}

function draftFromConfig(config: ChannelConfig): DraftForm {
  return {
    name: config.name,
    topic: config.kind === 'ntfy' ? config.topic : '',
    endpoint: '',
    chatId: config.kind === 'telegram' ? config.chatId : '',
    url: '',
    enabled: config.enabled,
    notifyOnSuccess: config.notifyOnSuccess,
    notifyOnFailure: config.notifyOnFailure,
  };
}

function draftFromSecret(secret: ChannelSecret | null, draft: DraftForm): DraftForm {
  return {
    ...draft,
    endpoint: secret?.kind === 'ntfy' ? secret.endpoint ?? '' : draft.endpoint,
    chatId: secret?.kind === 'telegram' ? draft.chatId : draft.chatId,
    url: secret?.kind === 'webhook' ? secret.url : draft.url,
  };
}

function buildConfig(draft: DraftForm, kind: ChannelKind, id: string): ChannelConfig | null {
  if (!draft.name.trim()) return null;
  const base = {
    id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    notifyOnSuccess: draft.notifyOnSuccess,
    notifyOnFailure: draft.notifyOnFailure,
  } as const;
  switch (kind) {
    case 'ntfy':
      return { ...base, kind: 'ntfy', topic: draft.topic.trim() };
    case 'telegram':
      return { ...base, kind: 'telegram', chatId: draft.chatId.trim() };
    case 'webhook':
      return { ...base, kind: 'webhook' };
  }
}

function buildSecret(draft: DraftForm, kind: ChannelKind, id: string, hasSecret: boolean): ChannelSecret | null {
  if (!hasSecret) return null;
  switch (kind) {
    case 'ntfy':
      return { id, kind: 'ntfy', endpoint: draft.endpoint.trim() || null };
    case 'telegram':
      return draft.chatId.trim() ? { id, kind: 'telegram', token: draft.chatId.trim() } : null;
    case 'webhook':
      return draft.url.trim() ? { id, kind: 'webhook', url: draft.url.trim() } : null;
  }
}

export function NotificationsSection() {
  const {
    channels,
    loading,
    error,
    refresh,
    createChannel,
    updateChannel,
    deleteChannel,
    testSingleChannel,
    testingIds,
  } = useNotifyChannels();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [kind, setKind] = useState<ChannelKind>('ntfy');
  const [draft, setDraft] = useState<DraftForm>(emptyDraft);
  const [hasSecret, setHasSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, TestChannelResult>>({});

  useEffect(() => {
    if (channels.length > 0 && refresh) {
      void refresh();
    }
    // refresh 是稳定 callback（useStorageItem 触发的 reactivity 是主要刷新路径）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.length]);

  const openCreate = () => {
    setEditingId(null);
    setKind('ntfy');
    setDraft(emptyDraft());
    setHasSecret(false);
    setEditorOpen(true);
  };

  const openEdit = (config: ChannelConfig) => {
    setEditingId(config.id);
    setKind(config.kind);
    setDraft(draftFromConfig(config));
    setHasSecret(false);
    setEditorOpen(true);
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = editingId ?? `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const config = buildConfig(draft, kind, id);
      if (!config) {
        return;
      }
      const secret = buildSecret(draft, kind, id, hasSecret);
      const r = editingId
        ? await updateChannel(editingId, config, secret ?? undefined)
        : await createChannel(config, secret ?? undefined);
      if (!r.ok) {
        // 设置 error 让 UI 显示
        return;
      }
      setEditorOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (config: ChannelConfig) => {
    const ok = await showConfirm({
      title: t('settings.notifications.deleteConfirmTitle'),
      description: t('settings.notifications.deleteConfirmBody', [config.name]),
      destructive: true,
    });
    if (!ok) return;
    await deleteChannel(config.id);
  };

  const handleToggleEnabled = useCallback(
    async (config: ChannelConfig) => {
      // Edit with only enabled toggled — partial update, secret unchanged (undefined).
      await updateChannel(config.id, { ...config, enabled: !config.enabled });
    },
    [updateChannel],
  );

  const handleTest = useCallback(
    async (config: ChannelConfig) => {
      const r = await testSingleChannel(config.id);
      const result = r.result;
      if (result) {
        setTestResults((prev) => ({ ...prev, [config.id]: result }));
      } else {
        // 失败路径：error 已包含 latencyMs=0；为统一表格展示用最小 placeholder。
        setTestResults((prev) => ({
          ...prev,
          [config.id]: {
            channelId: config.id,
            channelKind: config.kind,
            success: false,
            latencyMs: 0,
            error: r.error ?? 'unknown',
          },
        }));
      }
    },
    [testSingleChannel],
  );

  const hasSecretForKind = (config: ChannelConfig): boolean => {
    if (config.kind === 'ntfy') return false; // ntfy can use public ntfy.sh
    return true;
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t('settings.notifications.title')}</h2>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" />
          {t('settings.scheduler.createButton')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.notifications.description')}</p>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {loading && channels.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border py-6 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : channels.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border py-8 text-xs text-muted-foreground">
          <BellRing className="size-6 opacity-40" />
          <span>{t('settings.notifications.empty.title')}</span>
          <span className="text-[10px] text-muted-foreground/80">
            {t('settings.notifications.empty.hint')}
          </span>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs">
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 font-medium">{t('settings.notifications.columns.name')}</th>
                <th className="px-3 py-2 font-medium">{t('settings.notifications.columns.kind')}</th>
                <th className="px-3 py-2 font-medium text-right">
                  {t('settings.notifications.columns.lastTested')}
                </th>
                <th className="px-3 py-2 font-medium text-center">
                  {t('settings.notifications.columns.enabled')}
                </th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {channels.map((config) => {
                const isTesting = testingIds.has(config.id);
                const test = testResults[config.id];
                return (
                  <tr key={config.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2 font-medium">{config.name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {t(`settings.notifications.kinds.${config.kind}`)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isTesting ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" />
                          {t('settings.notifications.testInProgress')}
                        </span>
                      ) : test ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className={
                                test.success
                                  ? 'inline-flex items-center gap-1 text-xs text-emerald-600 cursor-help'
                                  : 'inline-flex items-center gap-1 text-xs text-destructive cursor-help'
                              }
                            >
                              {test.success ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
                              {test.success
                                ? t('settings.notifications.testResultSuccess', [String(test.latencyMs)])
                                : t('settings.notifications.testResultFailure', [test.error ?? ''])}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{test.error ?? test.latencyMs + 'ms'}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Checkbox
                            checked={config.enabled}
                            onCheckedChange={() => void handleToggleEnabled(config)}
                          />
                        </TooltipTrigger>
                        <TooltipContent>
                          {config.enabled
                            ? t('settings.notifications.buttons.disable')
                            : t('settings.notifications.buttons.enable')}
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={isTesting || !hasSecretForKind(config)}
                              onClick={() => void handleTest(config)}
                              title={t('settings.notifications.buttons.test')}
                              aria-label={t('settings.notifications.buttons.test')}
                            >
                              <Send className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {!hasSecretForKind(config)
                              ? t('settings.notifications.permissionRequired')
                              : t('settings.notifications.buttons.test')}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => openEdit(config)}
                              title={t('settings.notifications.dialogEdit')}
                              aria-label={t('settings.notifications.dialogEdit')}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t('settings.notifications.dialogEdit')}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="xs"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => void handleDelete(config)}
                              title={t('settings.notifications.buttons.delete')}
                              aria-label={t('settings.notifications.buttons.delete')}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t('settings.notifications.buttons.delete')}</TooltipContent>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingId
                ? t('settings.notifications.dialogEdit')
                : t('settings.notifications.dialogAdd')}
            </DialogTitle>
            <DialogDescription>{t('settings.notifications.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">{t('settings.notifications.form.name')}</label>
              <Input
                value={draft.name}
                placeholder={t('settings.notifications.form.namePlaceholder')}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={60}
              />
            </div>

            <div className="flex gap-2">
              {(['ntfy', 'telegram', 'webhook'] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="radio"
                    checked={kind === k}
                    onChange={() => {
                      setKind(k);
                      setHasSecret(false);
                    }}
                  />
                  {t(`settings.notifications.kinds.${k}`)}
                </label>
              ))}
            </div>

            {kind === 'ntfy' && (
              <>
                <div>
                  <label className="text-xs font-medium">{t('settings.notifications.form.topicLabel')}</label>
                  <Input
                    value={draft.topic}
                    placeholder={t('settings.notifications.form.topicPlaceholder')}
                    onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium">{t('settings.notifications.form.endpointLabel')}</label>
                  <Input
                    value={draft.endpoint}
                    placeholder={t('settings.notifications.form.endpointPlaceholder')}
                    onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">{t('settings.notifications.basicAuthHint')}</p>
                </div>
              </>
            )}

            {kind === 'telegram' && (
              <div>
                <label className="text-xs font-medium">{t('settings.notifications.form.chatIdLabel')}</label>
                <PasswordInput
                  value={draft.chatId}
                  placeholder={t('settings.notifications.form.chatIdPlaceholder')}
                  onChange={(e) => setDraft({ ...draft, chatId: e.target.value })}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">{t('settings.notifications.form.chatIdHint')}</p>
              </div>
            )}

            {kind === 'webhook' && (
              <div>
                <label className="text-xs font-medium">{t('settings.notifications.form.urlLabel')}</label>
                <Input
                  value={draft.url}
                  placeholder={t('settings.notifications.form.urlPlaceholder')}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                />
              </div>
            )}

            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={draft.enabled}
                onCheckedChange={(v) => setDraft({ ...draft, enabled: v === true })}
              />
              {t('settings.notifications.form.enabled')}
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={draft.notifyOnSuccess}
                onCheckedChange={(v) => setDraft({ ...draft, notifyOnSuccess: v === true })}
              />
              {t('settings.notifications.form.notifySuccess')}
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={draft.notifyOnFailure}
                onCheckedChange={(v) => setDraft({ ...draft, notifyOnFailure: v === true })}
              />
              {t('settings.notifications.form.notifyFailure')}
            </label>

            {/* Secret field presence — telegram / webhook require secret to test. */}
            {kind !== 'ntfy' && (
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={hasSecret}
                  onCheckedChange={(v) => setHasSecret(v === true)}
                />
                {editingId ? 'Update secret' : 'Set secret'}
              </label>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={busy}>
              {t('settings.notifications.buttons.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={busy}>
              {t('settings.notifications.buttons.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
