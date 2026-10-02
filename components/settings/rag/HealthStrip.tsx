//
// HealthStrip — 顶部三枚健康指示 pill：Database / Embedder / Collections。
//
// 每枚 pill 有自己的 dot 与 Check 按钮，对应三类彼此独立的故障：
//   • Database    — 连接串与 pgvector（`testConnection` + `bootstrapSchema`）
//   • Embedder    — 端点可达性与真实向量宽度（`probeEmbedder`）
//   • Collections — 本地 metadata 的 chunkCount 与 Neon 实际行数是否一致
//
// **三枚都只在点击后发起网络请求，绝不自动跑。** 这些检查各自都是一次真实的
// Neon / HTTP 往返，Neon 免费版冷启动要几秒；如果开页就跑，每次进设置页都会
// 打一串请求。dot 的初始态是 `idle`（未检查），只有点过才变成 ok/warn/error。
//
// 为什么拆出 Database 与 Embedder 两枚：以前只有 Connection 有 Test 按钮，
// 而 Embedding model 没有——尽管 `probeEmbedder` 正是为它写的。模型配错
// （端点不通、宽度不符）和数据库连不上是两回事，混在一个按钮里无法区分。
//

import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { StatusDot, type StatusTone } from './StatusDot';

/** 单个检查的状态。`idle` = 尚未点过 Check。 */
export type HealthState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; detail: string }
  | { kind: 'warn'; detail: string }
  | { kind: 'error'; detail: string };

function toneOf(state: HealthState): StatusTone {
  switch (state.kind) {
    case 'ok':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    case 'checking':
      return 'busy';
    case 'idle':
      return 'idle';
  }
}

function detailOf(state: HealthState): string {
  switch (state.kind) {
    case 'ok':
    case 'warn':
    case 'error':
      return state.detail;
    case 'checking':
      return t('settings.rag.healthChecking');
    case 'idle':
      return t('settings.rag.healthNotChecked');
  }
}

/** 一枚 pill：dot + 名称 + 状态文字 + Check 按钮。 */
function HealthPill({
  label,
  state,
  disabled,
  onCheck,
}: {
  label: string;
  state: HealthState;
  disabled?: boolean;
  onCheck: () => void;
}) {
  const checking = state.kind === 'checking';
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border px-3 py-2">
      <StatusDot tone={toneOf(state)} label={detailOf(state)} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate">{label}</p>
        <p
          className={cn(
            'text-[0.7rem] truncate',
            state.kind === 'error' && 'text-destructive',
            state.kind === 'warn' && 'text-amber-700 dark:text-amber-400',
            (state.kind === 'ok' || state.kind === 'idle' || checking) &&
              'text-muted-foreground',
          )}
          title={detailOf(state)}
        >
          {detailOf(state)}
        </p>
      </div>
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || checking}
        onClick={onCheck}
        aria-label={t('settings.rag.healthCheckAria', [label])}
      >
        {checking ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
        {t('settings.rag.healthCheck')}
      </Button>
    </div>
  );
}

/** 三枚 pill 的状态与回调。由页面持有状态（见 `RagSection`），本组件只负责呈现。 */
export interface HealthStripProps {
  database: HealthState;
  embedder: HealthState;
  collections: HealthState;
  /** Database 与 Collections 两枚的禁用条件（连接串为空时没有目标可查）。
   *  Embedder 不受它影响——探测嵌入端点根本不需要 Neon。 */
  dbDisabled?: boolean;
  onCheckDatabase: () => void;
  onCheckEmbedder: () => void;
  onCheckCollections: () => void;
}

export function HealthStrip({
  database,
  embedder,
  collections,
  dbDisabled,
  onCheckDatabase,
  onCheckEmbedder,
  onCheckCollections,
}: HealthStripProps) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <HealthPill
        label={t('settings.rag.healthDatabase')}
        state={database}
        disabled={dbDisabled}
        onCheck={onCheckDatabase}
      />
      {/* Not gated on the connection string: the embedding endpoint and Neon
          are unrelated. */}
      <HealthPill
        label={t('settings.rag.healthEmbedder')}
        state={embedder}
        onCheck={onCheckEmbedder}
      />
      <HealthPill
        label={t('settings.rag.healthCollections')}
        state={collections}
        disabled={dbDisabled}
        onCheck={onCheckCollections}
      />
    </div>
  );
}
