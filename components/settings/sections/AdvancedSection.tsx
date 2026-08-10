import { Label } from '@/components/ui/label';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  compactionModel,
  domSubAgentModel,
  providerCredentials,
  customProviders as customProvidersStorage,
} from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';

/**
 * AdvancedSection — 高级设置。
 *
 * 1. 压缩模型：上下文压缩（摘要）专用模型。`null` = 跟随对话主模型（默认）；
 *    可选一个更小更省的模型专门跑后台摘要。
 * 2. DOM 子代理模型：专门给主代理委派「读网页/提取内容」重活的便宜模型。
 *    `null` = 关闭此功能（主代理看不到 delegate_dom 工具）。
 *
 * 两者复用聊天的 `ModelSelector`，通过 `inheritOption` 提供首项。
 */
export function AdvancedSection() {
  const [model, setModel] = useStorageItem(compactionModel, null);
  const [domSub, setDomSub] = useStorageItem(domSubAgentModel, null);
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.advanced.title')}</h2>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm">{t('settings.advanced.compaction.label')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.advanced.compaction.hint')}
          </p>
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

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm">{t('settings.advanced.domSubAgent.label')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.advanced.domSubAgent.hint')}
          </p>
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
    </div>
  );
}

