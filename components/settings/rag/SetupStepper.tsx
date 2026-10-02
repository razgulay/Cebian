//
// SetupStepper — 三步上手指引。
//
// 只在**还没有任何知识库**时出现。一旦有了 collection，说明数据库与嵌入端点都已
// 经跑通过（否则索引不可能成功），引导的使命就结束了——所以判断条件只看
// `collections.length`，不再另外检查 DB/embedder 状态：那两项是被蕴含的。
//
// 「已填写」标记来自设置里的实际值，不是用户点过的痕迹——这样重装、恢复备份、
// 换机器之后不需要重新「走过一遍」。
//
// 注意措辞：这个标记只表示**填了**，不表示**连得上**。真正的连通性由上方健康条的
// 检查给出（那是唯一会真的发起请求的地方）。所以用中性的对勾与灰底，而不是
// 绿色「成功」样式——否则用户会以为已经验证过了。
//

import { Check } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { RagSettings } from '@/lib/rag';

export interface SetupStepperProps {
  settings: RagSettings;
  collectionCount: number;
}

export function SetupStepper({ settings, collectionCount }: SetupStepperProps) {
  // 已有知识库 = 上手完成，整块不再出现。
  if (collectionCount > 0) return null;

  const steps = [
    {
      label: t('settings.rag.stepConnect'),
      filled: !!settings.neonConnectionString,
    },
    {
      label: t('settings.rag.stepEmbedder'),
      filled: !!settings.defaultEmbedModel && !!settings.embedderBaseUrl,
    },
    {
      label: t('settings.rag.stepCollection'),
      // Always false here — the whole block is hidden once a collection exists.
      filled: false,
    },
  ];

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <p className="mb-2 text-xs font-medium">{t('settings.rag.setupTitle')}</p>
      <ol className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        {steps.map((s, i) => (
          <li key={s.label} className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-medium',
                s.filled ? 'bg-muted-foreground/15 text-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              {s.filled ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0 truncate text-xs">{s.label}</span>
            {i < steps.length - 1 && (
              <span aria-hidden className="hidden text-muted-foreground sm:inline">
                ›
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
