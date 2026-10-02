//
// RetrievalPanel — 检索与排序，加上 agentic 搜索工具开关。
//
// 三组控件，各自对应一个正交的选择：
//   • 检索模式（dense 或 dense+sparse 融合）
//   • Rerank（可选的重排层）
//   • agentic `rag_search` 工具（让 agent 在对话中自己发起检索）
//
// **这里没有相关性阈值控件。** 阈值已从 UI 撤下：分数标尺随模式变化
// （cosine 0–1 对 RRF 0–0.033），不存在两种模式都正确的默认值，旧的 0.35
// 是 cosine 时代的数字，切到 hybrid 后会静默过滤掉全部结果。过滤职责交给
// Rerank。`RetrieveOptions.minScore` 与 `RagSettings.pinMinScore` 保留，
// 默认 0 = 不过滤。
//

import { Bot, SlidersHorizontal, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { RagSettings } from '@/lib/rag';

export interface RetrievalPanelProps {
  settings: RagSettings;
  onChange: (patch: Partial<RagSettings>) => void;
}

export function RetrievalPanel({ settings, onChange }: RetrievalPanelProps) {
  return (
    <>
      <section className="space-y-4 rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <span
            aria-hidden
            className="inline-flex size-9 items-center justify-center rounded-md bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400"
          >
            <SlidersHorizontal className="size-4" />
          </span>
          {t('settings.rag.retrievalRankingTitle')}
        </h3>

        {/* Retrieval mode. Hybrid is the recommended default; Vector-only
            is the same radio group. */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">{t('settings.rag.retrievalMode')}</h4>
          <RadioGroup
            value={settings.retrievalMode}
            onValueChange={(v) => onChange({ retrievalMode: v as 'vector' | 'hybrid' })}
            className="gap-2"
          >
            <label
              className={cn(
                'flex w-full items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors',
                settings.retrievalMode === 'hybrid'
                  ? 'border-emerald-500 bg-emerald-50/30 ring-1 ring-emerald-500/20 dark:bg-emerald-950/20'
                  : 'border-border hover:bg-accent/50',
              )}
            >
              <RadioGroupItem value="hybrid" className="mt-0.5" />
              <span className="flex-1 space-y-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {t('settings.rag.retrievalModeHybrid')}
                  </span>
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400 text-[0.65rem] h-4 px-1.5"
                  >
                    {t('settings.rag.retrievalModeRecommendedBadge')}
                  </Badge>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t('settings.rag.retrievalModeHybridSubLabel')}
                </span>
              </span>
            </label>
            <label
              className={cn(
                'flex w-full items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors',
                settings.retrievalMode === 'vector'
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                  : 'border-border hover:bg-accent/50',
              )}
            >
              <RadioGroupItem value="vector" className="mt-0.5" />
              <span className="flex-1 space-y-1">
                <span className="block text-sm font-medium">
                  {t('settings.rag.retrievalModeVector')}
                </span>
              </span>
            </label>
          </RadioGroup>
        </div>

        {/* Rerank — the optional re-ranking layer. When off, only the title
            row shows and the inputs collapse. */}
        <div className="space-y-3 rounded-md border border-border/60 p-3 pt-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" />
              <div>
                <h4 className="text-sm font-medium">{t('settings.rag.rerankTitle')}</h4>
                <p className="text-xs text-muted-foreground">{t('settings.rag.rerankHint')}</p>
              </div>
            </div>
            <Switch
              checked={settings.rerankEnabled}
              onCheckedChange={(v) => onChange({ rerankEnabled: v })}
            />
          </div>

          {settings.rerankEnabled && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs">{t('settings.rag.rerankBaseUrl')}</Label>
                <Input
                  value={settings.rerankBaseUrl}
                  onChange={(e) => onChange({ rerankBaseUrl: e.target.value })}
                  placeholder="http://localhost:8317/v1"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('settings.rag.rerankModel')}</Label>
                <Input
                  value={settings.rerankModel}
                  onChange={(e) => onChange({ rerankModel: e.target.value })}
                  placeholder="rerank-english-v3.0"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('settings.rag.rerankTopN')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={settings.rerankTopN}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isFinite(v) && v > 0) onChange({ rerankTopN: v });
                  }}
                />
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label className="text-xs">{t('settings.rag.rerankApiKey')}</Label>
                <Input
                  type="password"
                  autoComplete="off"
                  value={settings.rerankApiKey}
                  onChange={(e) => onChange({ rerankApiKey: e.target.value })}
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* The agentic `rag_search` tool — it governs retrieval behaviour too,
          so it lives beside the retrieval settings. */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-flex size-9 items-center justify-center rounded-md bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400 shrink-0"
            >
              <Bot className="size-4" />
            </span>
            <div>
              <h3 className="text-sm font-medium">{t('settings.rag.ragSearchTitle')}</h3>
              <p className="text-xs text-muted-foreground">{t('settings.rag.ragSearchHint')}</p>
            </div>
          </div>
          <Switch
            checked={settings.ragSearchEnabled}
            onCheckedChange={(v) => onChange({ ragSearchEnabled: v })}
          />
        </div>
      </section>
    </>
  );
}
