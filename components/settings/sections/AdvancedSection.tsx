import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  compactionModel,
  domSubAgentModel,
  providerCredentials,
  customProviders as customProvidersStorage,
  workerModels,
  workerTeamEnabled,
  workerRoleTimeouts,
  type ModelIdentity,
  type WorkerRole,
} from '@/lib/persistence/storage';
import { resolveWorkerRoleTimeoutMs, WORKER_ROLES } from '@/lib/agent/worker-roles';
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

// 本组件 UI 用的 4 个 role 渲染表——只关心 labelKey / hintKey（i18n 键），
// 跟 lib/agent/worker-roles.ts 的 `WORKER_ROLES`（registry 配置，含
// systemPrompt / toolWhitelist / timeoutMs）是两个不同物体。重名 import 会
// TS2440 直接撞，rename 成 UI_DOMAINS 让两边职责清晰。
const UI_DOMAINS = [
  { key: 'content_writer', labelKey: 'settings.advanced.workers.content_writer.label', hintKey: 'settings.advanced.workers.content_writer.hint' },
  { key: 'frontend_coder', labelKey: 'settings.advanced.workers.frontend_coder.label', hintKey: 'settings.advanced.workers.frontend_coder.hint' },
  { key: 'reviewer', labelKey: 'settings.advanced.workers.reviewer.label', hintKey: 'settings.advanced.workers.reviewer.hint' },
  { key: 'researcher', labelKey: 'settings.advanced.workers.researcher.label', hintKey: 'settings.advanced.workers.researcher.hint' },
] as const satisfies ReadonlyArray<{ key: WorkerRole; labelKey: string; hintKey: string }>;

// Per-role attempt timeout 4 档 preset。值是 ms（与 storage / helper 同单位）。
// 60s = 极短任务（reviewer quick read）；120s = 默认 cap（registry.content_writer）；
// 5 min = 长任务（frontend_coder 大文件）；10 min = 极端 cap（手动开给巨大生成）。
// 不暴露「任意数字」输入——4 档覆盖 99% 场景，「自定义」会让 helper 的 `> 0`
// 守卫变难测，也模糊「Default」的语义。Storage 永远是 number | undefined，UI
// 显示用 i18n label 渲染。
const TIMEOUT_PRESETS = [
  { value: 60_000, key: 'settings.advanced.workers.timeout.preset60' },
  { value: 120_000, key: 'settings.advanced.workers.timeout.preset120' },
  { value: 300_000, key: 'settings.advanced.workers.timeout.preset300' },
  { value: 600_000, key: 'settings.advanced.workers.timeout.preset600' },
] as const;

export function AdvancedSection() {
  const [model, setModel] = useStorageItem(compactionModel, null);
  const [domSub, setDomSub] = useStorageItem(domSubAgentModel, null);
  const [workerMap, setWorkerMap] = useStorageItem(workerModels, {});
  const [timeoutMap, setTimeoutMap] = useStorageItem(workerRoleTimeouts, {});
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

  // Per-role 超时覆盖。`null` = 走 role registry 默认（resolve 时落到
  // `WORKER_ROLES[role].timeoutMs` 或 `WORKER_TIMEOUT_MS` 兜底）。Setter
  // 形态 mirror `setRoleModel`：传 null 即 delete（storage 不留 `null`/undefined
  // 歧义）。给 BG runner 的 `workerRoleTimeouts` storage 单一事实源——sidepanel
  // 与 runner 共享同一份决议，UI 改 → 下一 attempt 即生效（attempt 内不重读）。
  const setRoleTimeout = (role: WorkerRole, ms: number | null) => {
    const next = { ...timeoutMap };
    if (ms === null) {
      delete next[role];
    } else {
      next[role] = ms;
    }
    void setTimeoutMap(next);
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

        {UI_DOMAINS.map(({ key, labelKey, hintKey }) => {
          const activeModel = workerMap[key] ?? null;
          // 当前显示给用户的有效 ceiling：override 优先 → registry 默认 → 全局兜底。
          // 「Default」选项的展示文案要写真实默认值，避免 UI 跟 runner 实际值漂移。
          const effectiveMs = resolveWorkerRoleTimeoutMs(key, timeoutMap);
          const registryDefaultMs = WORKER_ROLES[key]?.timeoutMs;
          const currentValue =
            timeoutMap[key] !== undefined
              ? String(timeoutMap[key])
              : ''; // empty string = Default (matches the RadioGroup item value)
          return (
            <div key={key} className="space-y-2 pt-1">
              <div className="flex items-center justify-between gap-4">
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
              {/* Per-role attempt timeout picker (Phase 1.5). Compact horizontal
                  RadioGroup: 4 presets (60s / 2min / 5min / 10min) + Default (=
                  role registry default; UI shows the actual default cap so it
                  matches what the runner resolves to). `effectiveMs` only
                  feeds the activeHint text — it does NOT drive RadioGroup's
                  controlled value, which strictly mirrors `timeoutMap[key]`
                  (empty string = Default). Avoids hint vs selected-chip
                  mismatch when user has overridden to, say, 300s and the
                  hint says "300s ceiling" while the chip lights up at 300s. */}
              <div className="flex items-center gap-2 pl-1">
                <span className="text-xs text-muted-foreground shrink-0">
                  {t('settings.advanced.workers.timeout.label')}
                </span>
                <RadioGroup
                  // a11y: link the RadioGroup context to the role label sitting
                  // above so screen readers announce "Content writer timeout"
                  // instead of just listing radio options. Pattern mirrors
                  // `CreateBackupDialog`'s `aria-label={t('...mode')}`.
                  aria-label={`${t(labelKey)} ${t('settings.advanced.workers.timeout.label')}`}
                  value={currentValue}
                  onValueChange={(v) =>
                    setRoleTimeout(key, v === '' ? null : Number(v))
                  }
                  className="flex flex-row flex-wrap gap-x-3 gap-y-1"
                >
                  <Label className="flex items-center gap-1 text-xs font-normal cursor-pointer">
                    <RadioGroupItem value="" />
                    {t('settings.advanced.workers.timeout.default')}
                    {registryDefaultMs !== undefined && (
                      <span className="text-muted-foreground">
                        ({Math.round(registryDefaultMs / 1000)}s)
                      </span>
                    )}
                  </Label>
                  {TIMEOUT_PRESETS.map((p) => (
                    <Label
                      key={p.value}
                      className="flex items-center gap-1 text-xs font-normal cursor-pointer"
                    >
                      <RadioGroupItem value={String(p.value)} />
                      {t(p.key)}
                    </Label>
                  ))}
                </RadioGroup>
                <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                  {t('settings.advanced.workers.timeout.activeHint', [
                    Math.round(effectiveMs / 1000),
                  ])}
                </span>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

