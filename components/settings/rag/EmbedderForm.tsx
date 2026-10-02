//
// EmbedderForm — 嵌入端点的配置。
//
// 从 Card 1 里拆出来，让「连接数据库」与「配置嵌入模型」各自成块。两者是独立的
// 故障源：数据库连不上与嵌入模型配错需要分开排查，健康条上也各有一枚 pill。
//
// `embedderDim` 是手填数字，可能与模型实际输出不符——健康条的 Embedder 检查
// 会探测真实宽度并在不符时给出提示（不自动改写）。
//

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/lib/i18n';
import type { RagSettings } from '@/lib/rag';

export interface EmbedderFormProps {
  settings: RagSettings;
  onChange: (patch: Partial<RagSettings>) => void;
}

export function EmbedderForm({ settings, onChange }: EmbedderFormProps) {
  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3 pt-2">
      <h4 className="text-sm font-medium">{t('settings.rag.embedderTitle')}</h4>
      <p className="text-xs text-muted-foreground">{t('settings.rag.embedderHint')}</p>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5 col-span-2">
          <Label className="text-xs">{t('settings.rag.embedderBaseUrl')}</Label>
          <Input
            value={settings.embedderBaseUrl}
            onChange={(e) => onChange({ embedderBaseUrl: e.target.value })}
            placeholder="http://localhost:8317/v1"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('settings.rag.embedderApiKey')}</Label>
          <Input
            type="password"
            autoComplete="off"
            value={settings.embedderApiKey}
            onChange={(e) => onChange({ embedderApiKey: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('settings.rag.embedderDim')}</Label>
          <Input
            type="number"
            min={1}
            max={4096}
            value={settings.embedderDim}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v > 0) onChange({ embedderDim: v });
            }}
          />
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label className="text-xs">{t('settings.rag.embedderModel')}</Label>
          <Input
            value={settings.defaultEmbedModel}
            onChange={(e) => onChange({ defaultEmbedModel: e.target.value })}
            placeholder="text-embedding-3-small"
          />
        </div>
      </div>
    </div>
  );
}
