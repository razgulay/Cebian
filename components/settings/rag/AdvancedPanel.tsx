//
// AdvancedPanel — 分块参数与 Contextual Retrieval。
//
// 这些是「设置一次就不再动」的旋钮：chunkSize / overlap 决定切分粒度，改了要
// 重索引才生效；Contextual Retrieval 是索引期的可选增强。它们与日常操作
// （看知识库、调检索）无关，所以单独成块。
//
// Contextual Retrieval 默认关闭——开启后每个 chunk 索引时多一次 LLM 调用。
//

import { Sparkles } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/i18n';
import type { RagSettings } from '@/lib/rag';

export interface AdvancedPanelProps {
  settings: RagSettings;
  onChange: (patch: Partial<RagSettings>) => void;
}

export function AdvancedPanel({ settings, onChange }: AdvancedPanelProps) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('settings.rag.chunkSize')}</Label>
          <Input
            type="number"
            min={100}
            max={4000}
            step={100}
            value={settings.chunkSize}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v >= 100) onChange({ chunkSize: v });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('settings.rag.chunkOverlap')}</Label>
          <Input
            type="number"
            min={0}
            max={1000}
            step={20}
            value={settings.chunkOverlap}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v >= 0) onChange({ chunkOverlap: v });
            }}
          />
        </div>
      </div>

      {/* Contextual Retrieval — off by default (Anthropic's recipe; one LLM
          call per chunk at index time). Same "toggle + collapsing inputs"
          shape as Rerank. */}
      <div className="space-y-3 rounded-md border border-border/60 p-3 pt-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <div>
              <h4 className="text-sm font-medium">
                {t('settings.rag.contextualRetrievalTitle')}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t('settings.rag.contextualRetrievalHint')}
              </p>
            </div>
          </div>
          <Switch
            checked={settings.contextualRetrievalEnabled}
            onCheckedChange={(v) => onChange({ contextualRetrievalEnabled: v })}
          />
        </div>

        {settings.contextualRetrievalEnabled && (
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="space-y-1.5 col-span-2">
              <Label className="text-xs">{t('settings.rag.contextualLlmBaseUrl')}</Label>
              <Input
                value={settings.contextualLlmBaseUrl}
                onChange={(e) => onChange({ contextualLlmBaseUrl: e.target.value })}
                placeholder="http://localhost:8317/v1"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('settings.rag.contextualLlmModel')}</Label>
              <Input
                value={settings.contextualLlmModel}
                onChange={(e) => onChange({ contextualLlmModel: e.target.value })}
                placeholder="gpt-4o-mini"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('settings.rag.contextualLlmApiKey')}</Label>
              <Input
                type="password"
                autoComplete="off"
                value={settings.contextualLlmApiKey}
                onChange={(e) => onChange({ contextualLlmApiKey: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
