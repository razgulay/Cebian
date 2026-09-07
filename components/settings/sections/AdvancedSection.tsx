import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  compactionModel,
  domSubAgentModel,
  providerCredentials,
  customProviders as customProvidersStorage,
  workerModels,
  workerTeamEnabled,
  type ModelIdentity,
  type WorkerRole,
} from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';
import { Sparkles, MousePointerClick, Users } from 'lucide-react';

/**
 * AdvancedSection — 高级设置。
 *
 * 1. 压缩模型：上下文压缩（摘要）专用模型。`null` = 跟随对话主模型（默认）；
 *    可选一个更小更省的模型专门跑后台摘要。
 * 2. DOM 子代理模型：专门给主代理委派「读网页/提取内容」重活的便宜模型。
 *    `null` = 关闭此功能（主代理看不到 delegate_dom 工具）。
 * 3. Worker 模型（多代理委派）：4 个固定 worker role 各配一个专用模型。
 *    `null` = 关闭该 role（main agent 仍可调用 delegate_task，但 runner 回退主会话模型）。
 *    与 Settings → Advanced 共用同一个 `local:workerModels` storage；Sidebar Team Roster
 *    widget 也是同一份，两边实时同步。
 *
 * 全部复用聊天的 `ModelSelector`，通过 `inheritOption` 提供首项（"跟随对话模型" / "关闭"）。
 */

const WORKER_ROLES = [
  { key: 'content_writer', labelKey: 'settings.advanced.workers.content_writer.label', hintKey: 'settings.advanced.workers.content_writer.hint' },
  { key: 'frontend_coder', labelKey: 'settings.advanced.workers.frontend_coder.label', hintKey: 'settings.advanced.workers.frontend_coder.hint' },
  { key: 'reviewer', labelKey: 'settings.advanced.workers.reviewer.label', hintKey: 'settings.advanced.workers.reviewer.hint' },
  { key: 'researcher', labelKey: 'settings.advanced.workers.researcher.label', hintKey: 'settings.advanced.workers.researcher.hint' },
] as const satisfies ReadonlyArray<{ key: WorkerRole; labelKey: string; hintKey: string }>;

export function AdvancedSection() {
  const [model, setModel] = useStorageItem(compactionModel, null);
  const [domSub, setDomSub] = useStorageItem(domSubAgentModel, null);
  const [workerMap, setWorkerMap] = useStorageItem(workerModels, {});
  const [teamEnabled, setTeamEnabled] = useStorageItem(workerTeamEnabled, true);
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);

  // Partial<Record> 存的 model identity 是 optional 的；读时统一转 `ModelIdentity | null`
  // 形式以匹配 ModelSelector 的 `activeModel` prop 类型。Setter 反向：传 null 即视为
  // 「删除该 role 的配置」（避免 `undefined` 跟 `null` 在 JSON 里不一致）。
  const setRoleModel = (role: WorkerRole, identity: ModelIdentity | null) => {
    const next = { ...workerMap };
    if (identity === null) {
      delete next[role];
    } else {
      next[role] = identity;
    }
    void setWorkerMap(next);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.advanced.title')}</h2>

      {/* ─── Card: Compaction model ─── */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span aria-hidden className="inline-flex size-9 items-center justify-center rounded-md bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400 shrink-0">
              <Sparkles className="size-4" />
            </span>
            <div className="min-w-0 space-y-1">
              <Label className="text-sm">{t('settings.advanced.compaction.label')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('settings.advanced.compaction.hint')}
              </p>
            </div>
          </div>
          <div className="shrink-0">
            <ModelSelector
              activeModel={model}
              configuredProviders={providers}
              customProviders={customProviderList}
              onSelect={(provider, modelId) => setModel({ provider, modelId })}
              inheritOption={{
                label: t('settings.advanced.compaction.followMain'),
                onSelect: () => setModel(null),
              }}
            />
          </div>
        </div>
      </section>

      {/* ─── Card: DOM sub-agent model ─── */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <span aria-hidden className="inline-flex size-9 items-center justify-center rounded-md bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400 shrink-0">
              <MousePointerClick className="size-4" />
            </span>
            <div className="min-w-0 space-y-1">
              <Label className="text-sm">{t('settings.advanced.domSubAgent.label')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('settings.advanced.domSubAgent.hint')}
              </p>
            </div>
          </div>
          <div className="shrink-0">
            <ModelSelector
              activeModel={domSub}
              configuredProviders={providers}
              customProviders={customProviderList}
              onSelect={(provider, modelId) => setDomSub({ provider, modelId })}
              inheritOption={{
                label: t('settings.advanced.domSubAgent.off'),
                onSelect: () => setDomSub(null),
              }}
            />
          </div>
        </div>
      </section>

      {/* ─── Card: Worker team (multi-agent delegation) ─── */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <span aria-hidden className="inline-flex size-9 items-center justify-center rounded-md bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400">
            <Users className="size-4" />
          </span>
          {t('settings.advanced.workers.title')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t('settings.advanced.workers.hint')}
        </p>

        {/* Master switch: controls whether the main agent delegates via
            `delegate_task`. When OFF the four role pickers below stay
            visible (so users can preconfigure role models and flip the
            switch later) but don't take effect — the tool and system
            prompt block are both withdrawn in lockstep. This Switch
            shares its storage key with the ⚡Fast / 👥Team chip next
            to the composer (`useStorageItem`'s watch keeps both sides
            in sync). */}
        <div className="flex items-center justify-between gap-4 pt-2 pb-3 border-b border-border/50">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="worker-team-enabled" className="text-sm">
              {t('settings.advanced.workers.enabled')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.advanced.workers.enabledHint')}
            </p>
          </div>
          <Switch
            id="worker-team-enabled"
            checked={teamEnabled}
            onCheckedChange={(v) => void setTeamEnabled(v)}
            className="shrink-0"
          />
        </div>

        {WORKER_ROLES.map(({ key, labelKey, hintKey }) => {
          const activeModel = workerMap[key] ?? null;
          return (
            <div key={key} className="flex items-center justify-between gap-4 pt-1">
              <div className="min-w-0 space-y-1">
                <Label className="text-sm">{t(labelKey)}</Label>
                <p className="text-xs text-muted-foreground">{t(hintKey)}</p>
              </div>
              <div className="shrink-0">
                <ModelSelector
                  activeModel={activeModel}
                  configuredProviders={providers}
                  customProviders={customProviderList}
                  onSelect={(provider, modelId) => setRoleModel(key, { provider, modelId })}
                  inheritOption={{
                    label: t('settings.advanced.workers.followMain'),
                    onSelect: () => setRoleModel(key, null),
                  }}
                />
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

