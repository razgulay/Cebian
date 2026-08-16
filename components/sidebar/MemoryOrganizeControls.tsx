// 整理控制区：手动「整理」按钮 + 整理用模型选择 + 上次整理结果。
// 只在记忆开启时渲染。用户配置读 / 写 memorySettings.organize；运行结果读 memoryOrganizeState。
//
// 从 components/settings/sections/MemorySection.tsx 抽出，行为完全一致——既给
// /settings/memory 用，也给 SidebarPanel 里的 Memory khu vực用，避免两边各自复制 ~120 行
// 配置面板 JSX。配置存储位置不变（memorySettings / memoryOrganizeState / providerCredentials），
// 写入通过 setSettings 回调落到同一 storage 项，所以一处改动另一处实时同步。
import { ModelSelector } from '@/components/chat/ModelSelector';
import {
  memoryOrganizeState,
  providerCredentials,
  customProviders,
  resolveOrganizeSettings,
  type MemorySettings,
  type ModelIdentity,
} from '@/lib/persistence/storage';
import { useStorageItem } from '@/hooks/useStorageItem';
import { useMemoryOrganize } from '@/hooks/useMemoryOrganize';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/lib/i18n';

export function MemoryOrganizeControls({
  settings,
  setSettings,
  onOrganized,
}: {
  settings: MemorySettings;
  setSettings: (s: MemorySettings) => void;
  onOrganized: () => void;
}) {
  const organize = resolveOrganizeSettings(settings);
  const [state] = useStorageItem(memoryOrganizeState, {});
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProviders, []);
  const { running, trigger } = useMemoryOrganize(onOrganized);

  const setModel = (model: ModelIdentity | undefined) =>
    setSettings({ ...settings, organize: { ...organize, model } });
  const setAuto = (auto: boolean) =>
    setSettings({ ...settings, organize: { ...organize, auto } });
  const setIntervalDays = (intervalDays: number) =>
    setSettings({ ...settings, organize: { ...organize, intervalDays } });
  const setMinNewMemories = (minNewMemories: number) =>
    setSettings({ ...settings, organize: { ...organize, minNewMemories } });

  return (
    <div className="mt-4 rounded-md border border-border p-3 space-y-2.5">
      {/* Title row — the Organize button sits inline with the
          "Organize memory" title (no longer pushed to the right via
          justify-between). The user wanted the button visually attached
          to the section title. The hint goes full-width on its own line
          below so the long description doesn't squeeze the row in the
          narrow sidebar. flex-wrap keeps the layout from overflowing
          when the lastRun timestamp is long. */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">{t('settings.memory.organize.title')}</span>
        <Button size="sm" variant="outline" disabled={running} onClick={trigger} className="shrink-0">
          {running ? t('settings.memory.organize.running') : t('settings.memory.organize.button')}
        </Button>
        {state.lastRunAt && (
          <span className="text-xs text-muted-foreground">
            {t('settings.memory.organize.lastRun', [new Date(state.lastRunAt).toLocaleString()])}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.memory.organize.hint')}</p>

      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs text-muted-foreground shrink-0">
          {t('settings.memory.organize.model')}
        </Label>
        <ModelSelector
          activeModel={organize.model ?? null}
          configuredProviders={providers}
          customProviders={customProviderList}
          onSelect={(provider, modelId) => setModel({ provider, modelId })}
          inheritOption={{
            label: t('settings.memory.organize.followActive'),
            onSelect: () => setModel(undefined),
          }}
        />
      </div>

      {/* Auto-organize row — toggle sits on the top row next to the label
          (mirrors the parent MemorySection's title + toggle layout). The
          hint goes full-width on its own line below so the long
          description doesn't squeeze the row in the narrow sidebar. */}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between gap-3">
          <Label
            htmlFor="memory-organize-auto"
            className="text-xs text-muted-foreground"
          >
            {t('settings.memory.organize.auto')}
          </Label>
          <Switch
            id="memory-organize-auto"
            checked={organize.auto}
            onCheckedChange={setAuto}
            className="shrink-0"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t('settings.memory.organize.autoHint')}
        </p>
      </div>

      {organize.auto && (
        // Two separate rows for the numeric inputs. Sidebar is too
        // narrow to fit both labels + inputs on one row without the
        // inputs getting squeezed below a usable width (the user
        // pushed back on a combined-row layout). Each input uses
        // justify-between (label left, input right) like the Model
        // row above for visual consistency.
        <>
          <div className="flex items-center justify-between gap-3">
            <Label
              htmlFor="memory-organize-interval"
              className="text-xs text-muted-foreground shrink-0"
            >
              {t('settings.memory.organize.intervalLabel')}
            </Label>
            <Input
              id="memory-organize-interval"
              type="number"
              min={0}
              value={organize.intervalDays}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                if (Number.isFinite(n)) setIntervalDays(Math.max(0, n));
              }}
              className="h-8 w-20 text-xs"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label
              htmlFor="memory-organize-threshold"
              className="text-xs text-muted-foreground shrink-0"
            >
              {t('settings.memory.organize.thresholdLabel')}
            </Label>
            <Input
              id="memory-organize-threshold"
              type="number"
              min={1}
              value={organize.minNewMemories}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                if (Number.isFinite(n)) setMinNewMemories(Math.max(1, n));
              }}
              className="h-8 w-20 text-xs"
            />
          </div>
        </>
      )}
    </div>
  );
}