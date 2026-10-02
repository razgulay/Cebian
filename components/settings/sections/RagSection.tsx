//
// RagSection — settings UI for the RAG (knowledge base) system.
//
// 页面顺序（自上而下，按使用频率排）：
//   1. Health strip        — 三枚状态指示，各有独立的检查按钮（`rag/HealthStrip`）
//   2. Setup stepper       — 三步引导，有知识库后自动消失（`rag/SetupStepper`）
//   3. Collections         — 知识库列表，日常操作的对象（`rag/CollectionList`）
//   4. Retrieval & ranking — 检索模式 + Rerank + `rag_search` 开关（`rag/RetrievalPanel`）
//   5. Data sources        — 连接串 + 嵌入模型，**默认折叠**（`rag/EmbedderForm`）
//   6. Advanced            — 分块与 Contextual Retrieval，**默认折叠**（`rag/AdvancedPanel`）
//
// 第 5、6 项是「设置一次就不再动」的旋钮，所以折叠并排在日常操作之后。
//
// 这里只剩**页面级**状态与装配；各部分已拆到 `components/settings/rag/`。
//
// 三处刻意的行为约束：
//   • 健康检查**只在点击时**发起请求，开页不跑（每项检查都是一次真实往返）。
//   • 知识库的源是**只读**的：改磁盘上的文件再 Reindex，UI 不提供增删改源。
//   • 检查（Check）是只读的：探测到嵌入宽度与设置不符时只提示，不代改设置。
//
// 改名已从本页移除——名字在创建时由文件夹名推导，改名会让名字与磁盘不符。
// 相关性阈值也已移除：两种模式的分数刻度不同，见 `rag/RetrievalPanel` 的说明。
//
// New-collection flow opens a modal with: folder picker, file picker
// (multi-file + folder), inline contextual-hint when CR is on, and a
// live progress bar during indexing.
//

import { useCallback, useState } from 'react';
import {
  Database,
  Folder,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showConfirm } from '@/lib/ui/dialog';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  bootstrapSchema,
  countCollectionChunks,
  deleteCollectionChunks,
  ragCollections,
  ragSettings,
  removeCollectionMeta,
  testConnection,
  probeEmbedder,
  updateRagSettings,
  type BootstrapWarning,
  type RagCollection,
  type RagSettings,
} from '@/lib/rag';
import { HealthStrip, type HealthState } from '@/components/settings/rag/HealthStrip';
import { CollectionList } from '@/components/settings/rag/CollectionList';
import { EmbedderForm } from '@/components/settings/rag/EmbedderForm';
import { AdvancedPanel } from '@/components/settings/rag/AdvancedPanel';
import { RetrievalPanel } from '@/components/settings/rag/RetrievalPanel';
import { SetupStepper } from '@/components/settings/rag/SetupStepper';
import { CollapsibleSection } from '@/components/settings/rag/CollapsibleSection';
import { CollectionDialog } from '@/components/settings/rag/CollectionDialog';
import { t } from '@/lib/i18n';
import { debugLog } from '@/lib/debug/log';

/** 探测嵌入端点的外层上限。`postEmbeddings` 自身每次尝试已有 15s 超时，但那是
 *  **单次**的——3 次尝试加退避最坏可拖到约 48s。这里给整个调用一个总上限，免得
 *  端点挂住时按钮一直转。 */
const EMBEDDER_PROBE_TIMEOUT_MS = 15_000;

/** 把 `BootstrapWarning` 映射成面向用户的文案。`code` 分支在这里——新增
 *  一个 code 却沿用 HNSW 的文案，是那种不会报错的静默错误。 */
function bootstrapWarningText(w: BootstrapWarning): string {
  switch (w.code) {
    case 'hnsw-index-failed':
      return t('settings.rag.bootstrapWarningHnsw', [w.detail]);
    case 'embedder-probe-failed':
      return t('settings.rag.embedderProbeFailed', [w.detail]);
  }
}

export function RagSection() {
  const [settings, setSettings] = useStorageItem(ragSettings, {
    neonConnectionString: '',
    embedderBaseUrl: 'http://localhost:8317/v1',
    embedderApiKey: '',
    defaultEmbedModel: 'text-embedding-3-small',
    embedderDim: 1536,
    chunkSize: 800,
    chunkOverlap: 100,
    // Subtask 2 — default Hybrid per UI spec; can flip to 'vector' via Card 3 radio.
    retrievalMode: 'hybrid',
    // Subtask 3 — opt-in. Storage layer also seeds these from
    // `DEFAULT_RAG_SETTINGS` on first read, but listing them explicitly
    // keeps the `as RagSettings` cast honest and the renderer typesafe.
    contextualRetrievalEnabled: false,
    contextualLlmBaseUrl: 'http://localhost:8317/v1',
    contextualLlmApiKey: '',
    contextualLlmModel: 'gpt-4o-mini',
    rerankEnabled: false,
    rerankBaseUrl: 'http://localhost:8317/v1',
    rerankApiKey: '',
    rerankModel: 'rerank-english-v3.0',
    rerankTopN: 3,
    pinMinScore: 0,
    // Subtask 4 — off by default so the tool isn't shipped unless the
    // user opts in. Storage layer (`ragSettings`) seeds the missing
    // fields from `DEFAULT_RAG_SETTINGS` on first read, so omitting
    // this here would still resolve to `false` at runtime, but listing
    // it explicitly keeps the `as RagSettings` cast honest.
    ragSearchEnabled: false,
  } as RagSettings);
  const [collections, setCollections] = useStorageItem(ragCollections, [] as RagCollection[]);

  /** 探测到的宽度与已保存值不符时置位。Test 只读，所以这里只**提示**；
   *  用户点按钮才写回设置。 */
  const [dimSuggestion, setDimSuggestion] = useState<
    { probed: number; configured: number } | null
  >(null);

  // New-collection modal
  const [newOpen, setNewOpen] = useState(false);

  /** 顶部三枚健康 pill 的状态。初始 `idle`——**开页不发任何请求**。
   *  每次检查都是一次真实的 Neon / HTTP 往返，Neon 免费版冷启动要几秒，
   *  所以只在用户点 Check 时才跑。 */
  const [healthDb, setHealthDb] = useState<HealthState>({ kind: 'idle' });
  const [healthEmbedder, setHealthEmbedder] = useState<HealthState>({ kind: 'idle' });
  const [healthCollections, setHealthCollections] = useState<HealthState>({ kind: 'idle' });

  /** 对账：本地 metadata 的 chunkCount vs Neon 实际行数。
   *
   *  从前这件事在 mount 时自动做（对每个 collection fan-out 一次查询）。
   *  改成按需触发：进设置页不再打一串 Neon 请求，代价是数字可能显示为上次
   *  索引时的值，直到用户主动核对。 */
  const checkCollections = useCallback(async () => {
    if (!settings.neonConnectionString) return;
    setHealthCollections({ kind: 'checking' });
    const stored = await ragCollections.getValue();
    if (stored.length === 0) {
      setHealthCollections({ kind: 'ok', detail: t('settings.rag.healthCollectionsEmpty') });
      return;
    }
    const settled = await Promise.allSettled(
      stored.map(async (c) => ({
        name: c.name,
        live: await countCollectionChunks(settings.neonConnectionString, c.name),
      })),
    );
    const updates = new Map<string, number>();
    let failures = 0;
    settled.forEach((r, i) => {
      const c = stored[i];
      if (!c) return;
      if (r.status === 'fulfilled') {
        if (r.value.live !== c.chunkCount) updates.set(c.name, r.value.live);
      } else {
        failures++;
        debugLog.warn('rag', 'count-chunks-failed', {
          collection: c.name,
          error: String(r.reason),
        });
      }
    });
    if (failures === settled.length) {
      setHealthCollections({ kind: 'error', detail: t('settings.rag.healthCollectionsError') });
      return;
    }
    // 对上了就顺手把本地数字修正——这正是这次检查的目的。
    //
    // **写入前重新读一次**，只把对上的计数并进去，而不是回写探测开始时那份快照。
    // 中间隔着 N 次网络往返（Neon 冷启动要几秒），期间用户完全可能删掉或重命名
    // 某个 collection；回写旧快照会把已删的 collection **复活**。旧实现在 effect
    // 里至少有个 `cancelled` 守卫，换成按钮触发后连那个也没有了。
    if (updates.size > 0) {
      const fresh = await ragCollections.getValue();
      setCollections(
        fresh.map((p) => (updates.has(p.name) ? { ...p, chunkCount: updates.get(p.name)! } : p)),
      );
    }
    setHealthCollections(
      updates.size > 0
        ? { kind: 'warn', detail: t('settings.rag.healthCollectionsDrift', [String(updates.size)]) }
        : { kind: 'ok', detail: t('settings.rag.healthCollectionsOk') },
    );
  }, [settings.neonConnectionString, setCollections]);

  /** Check Database：连得上吗、pgvector 在不在、schema 是否就绪。
   *
   *  仍会跑 `bootstrapSchema`（幂等），因为它需要真实宽度才能建列——而宽度
   *  来自 Embedder 那枚 pill 的探测。这里用探测值（失败则回退到已保存值），
   *  并把探测结果作为「嵌入端点不可达」的附加提示带出来，而不是静默吞掉。 */
  const checkDatabase = useCallback(async () => {
    setHealthDb({ kind: 'checking' });
    // 建议先清空，免得它比产生它的那次探测活得更久。
    setDimSuggestion(null);
    const result = await testConnection(settings.neonConnectionString);
    if (!result.ok) {
      setHealthDb({ kind: 'error', detail: result.error ?? 'Unknown error' });
      return;
    }
    if (!result.pgvector) {
      setHealthDb({ kind: 'warn', detail: t('settings.rag.healthDbNoVector') });
      return;
    }

    // 探测真实宽度：列一旦建成 `vector(n)`，宽度不符的数据就再也写不进去，
    // 所以列宽必须跟着模型走。探测失败则回退到已保存值，让数据库检查继续。
    const probe = await probeEmbedder(settings, AbortSignal.timeout(EMBEDDER_PROBE_TIMEOUT_MS));
    const dim = probe.ok ? probe.dim : settings.embedderDim;

    try {
      const { warnings } = await bootstrapSchema(settings.neonConnectionString, dim);
      // 探测结果与已保存值不符时**只提示，不代改**——Check 是只读的，静默改写
      // 用户设置是意外契约。用户点按钮才写。
      if (probe.ok && probe.dim !== settings.embedderDim) {
        setDimSuggestion({ probed: probe.dim, configured: settings.embedderDim });
      }
      const notices: BootstrapWarning[] = [...warnings];
      if (!probe.ok) {
        notices.push({ code: 'embedder-probe-failed', detail: probe.error ?? 'unknown error' });
      }
      if (notices.length > 0) {
        // 非致命问题就地展示——service worker 里的 console.warn 基本看不见。
        setHealthDb({
          kind: 'warn',
          detail: notices.map((n) => bootstrapWarningText(n)).join(' '),
        });
      } else {
        setHealthDb({ kind: 'ok', detail: t('settings.rag.healthDbOk', [result.version]) });
      }
    } catch (err) {
      setHealthDb({ kind: 'error', detail: (err as Error).message });
    }
  }, [
    settings.neonConnectionString,
    settings.embedderBaseUrl,
    settings.embedderApiKey,
    settings.defaultEmbedModel,
    settings.embedderDim,
  ]);

  /** Check Embedder：端点可达吗、模型真实输出多宽。与数据库检查彼此独立——
   *  模型配错和数据库连不上是两回事，混在一个按钮里无法区分。 */
  const checkEmbedder = useCallback(async () => {
    setHealthEmbedder({ kind: 'checking' });
    // 与 checkDatabase 一样先清空：否则上一次留下的建议会活过一次结果不同的检查，
    // 提示用户「改用 N」——而 N 可能已经是他手上就有的值。
    setDimSuggestion(null);
    const probe = await probeEmbedder(settings, AbortSignal.timeout(EMBEDDER_PROBE_TIMEOUT_MS));
    if (!probe.ok) {
      setHealthEmbedder({ kind: 'error', detail: probe.error ?? t('settings.rag.healthEmbedderError') });
      return;
    }
    const mismatch = probe.dim !== settings.embedderDim;
    setHealthEmbedder({
      kind: mismatch ? 'warn' : 'ok',
      // 宽度不符时必须**在这里**说清楚。一键采纳的横幅在「数据来源」折叠块里，
      // 而那个块默认关着——只靠一个琥珀色圆点，用户看不到该怎么办。
      detail: mismatch
        ? t('settings.rag.healthEmbedderDimMismatch', [
            String(settings.embedderDim),
            String(probe.dim),
          ])
        : t('settings.rag.healthEmbedderOk', [probe.model, String(probe.dim)]),
    });
    // 宽度不符时给出与 Database 检查一致的一键采纳入口。
    if (mismatch) {
      setDimSuggestion({ probed: probe.dim, configured: settings.embedderDim });
    }
  }, [
    settings.embedderBaseUrl,
    settings.embedderApiKey,
    settings.defaultEmbedModel,
    settings.embedderDim,
  ]);

  /** 采纳探测到的宽度。只由显式按钮调用——检查本身是只读的，见
   *  `checkDatabase` / `checkEmbedder` 里的说明。 */
  const adoptProbedDim = useCallback(async () => {
    if (!dimSuggestion) return;
    const next = await updateRagSettings({ embedderDim: dimSuggestion.probed });
    setSettings(next);
    setDimSuggestion(null);
    toast.success(t('settings.rag.dimCorrected', [String(dimSuggestion.probed)]));
  }, [dimSuggestion, setSettings]);

  /** 面板共用的写入入口：合并一个 patch 到当前 settings 再写回。
   *  三个面板都只改自己那几个字段，不需要各自 setSettings({...settings, x})。 */
  const patchSettings = useCallback(
    (patch: Partial<RagSettings>) => setSettings({ ...settings, ...patch }),
    [settings, setSettings],
  );

  /** 索引完成后刷新列表。对话框内部已经 upsert 过，这里只是从存储重读一遍
   *  以确保与其它上下文一致。 */
  const refreshCollections = useCallback(async () => {
    const next = await ragCollections.getValue();
    setCollections(next);
  }, [setCollections]);

  const handleDeleteCollection = useCallback(
    async (c: RagCollection) => {
      const ok = await showConfirm({
        title: t('settings.rag.confirmDeleteTitle'),
        description: t('settings.rag.confirmDelete', [c.name, String(c.chunkCount)]),
        destructive: true,
      });
      if (!ok) return;
      try {
        if (settings.neonConnectionString) {
          await deleteCollectionChunks(settings.neonConnectionString, c.name);
        }
        const next = await removeCollectionMeta(c.name);
        setCollections(next);
        toast.success(t('settings.rag.deleteSuccess', [c.name]));
      } catch (err) {
        toast.error(`${t('settings.rag.deleteFailed')}: ${(err as Error).message}`);
      }
    },
    [settings.neonConnectionString, setCollections],
  );

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.rag.title')}</h2>

      {/* 1. Health strip — three status indicators, each with its own check. */}
      <HealthStrip
        database={healthDb}
        embedder={healthEmbedder}
        collections={healthCollections}
        dbDisabled={!settings.neonConnectionString}
        onCheckDatabase={() => void checkDatabase()}
        onCheckEmbedder={() => void checkEmbedder()}
        onCheckCollections={() => void checkCollections()}
      />

      {/* 2. Setup guide — only while there are no collections yet. Sits right
             under the health strip: it disappears the moment you have one, so
             it never affects the everyday order. */}
      <SetupStepper settings={settings} collectionCount={collections.length} />

      {/* 3. Collections — the day-to-day surface, so it comes first.
             The heading row (icon + title + count badge + two hint lines)
             lives here; the list body (`CollectionList`) is shared with the
             sidebar — same shape as MCP: different shells, one list. */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-flex size-9 items-center justify-center rounded-md bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400 shrink-0"
          >
            <Folder className="size-4" />
          </span>
          <div>
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-medium">{t('settings.rag.collections')}</h3>
              <span className="text-[0.65rem] text-muted-foreground tabular-nums">
                {t('settings.rag.collectionsCount', [
                  String(collections.length),
                  String(collections.length),
                ])}
              </span>
            </div>
            {/* Two lines, both load-bearing: the first says how to USE a
                collection in chat, the second says where the data actually
                comes from (and that editing happens on disk, not here). */}
            <p className="text-xs text-muted-foreground">{t('settings.rag.collectionsHint')}</p>
            <p className="text-xs text-muted-foreground">
              {t('settings.rag.collectionsSourceHint')}
            </p>
          </div>
        </div>

        <CollectionList
          collections={collections}
          currentModel={settings.defaultEmbedModel}
          settings={settings}
          onIndexed={refreshCollections}
          onDelete={handleDeleteCollection}
        />

        <div className="flex justify-center">
          <Button
            size="sm"
            disabled={!settings.neonConnectionString}
            onClick={() => setNewOpen(true)}
          >
            <Plus className="size-3.5" />
            {t('settings.rag.newCollection')}
          </Button>
        </div>
      </section>

      {/* 4. Retrieval & ranking. */}
      <RetrievalPanel settings={settings} onChange={patchSettings} />

      {/* 5. Data sources — connection + embedder. Set once, so it is collapsed
             and sits below the things you touch daily. */}
      <CollapsibleSection
        title={t('settings.rag.dataSourcesTitle')}
        hint={t('settings.rag.dataSourcesHint')}
      >
        <div className="space-y-3">
          <div className="space-y-3 rounded-md border border-border/60 p-3 pt-2">
            <div className="flex items-center gap-2">
              <Database className="size-4 text-muted-foreground" />
              <h4 className="text-sm font-medium">{t('settings.rag.connectionTitle')}</h4>
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.rag.connectionHint')}</p>

            <div className="space-y-1.5">
              <Label htmlFor="rag-neon" className="text-xs">
                {t('settings.rag.connectionLabel')}
              </Label>
              <Input
                id="rag-neon"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="postgresql://user:pass@host/db?sslmode=require"
                value={settings.neonConnectionString}
                onChange={(e) => patchSettings({ neonConnectionString: e.target.value })}
              />
            </div>

            {/* Probe width differs from the saved value — warn and offer an
                explicit adopt button. Checking is read-only; it never rewrites
                the user's settings on its own. */}
            {dimSuggestion && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                <p className="flex-1 text-xs text-amber-700 dark:text-amber-400">
                  {t('settings.rag.dimMismatch', [
                    String(dimSuggestion.configured),
                    String(dimSuggestion.probed),
                  ])}
                </p>
                <Button size="xs" variant="outline" onClick={() => void adoptProbedDim()}>
                  {t('settings.rag.dimMismatchUse', [String(dimSuggestion.probed)])}
                </Button>
              </div>
            )}
          </div>

          <EmbedderForm settings={settings} onChange={patchSettings} />
        </div>
      </CollapsibleSection>

      {/* 6. Advanced — set-once knobs, collapsed by default. */}
      <CollapsibleSection
        title={t('settings.rag.advancedTitle')}
        hint={t('settings.rag.advancedHint')}
      >
        <AdvancedPanel settings={settings} onChange={patchSettings} />
      </CollapsibleSection>

      <CollectionDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        settings={settings}
        existingNames={collections.map((c) => c.name)}
        mode={{ kind: 'create' }}
        onIndexed={refreshCollections}
      />
    </div>
  );
}
