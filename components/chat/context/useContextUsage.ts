// useContextUsage — 给 chat 表面的 ContextUsagePill / Popover / CompactNowButton
// 用的「context window 占用情况」组合 hook。
//
// 与 useBackgroundAgent 的关系（AGENTS.md §"Cohesion, coupling"）：
// - useBackgroundAgent 是「端口 + agent 状态」的单例 owner，保留 storage 无关
//   的纯净——本 hook 不参与端口/订阅生命周期，只消费它的状态、调用它的 action。
// - 本 hook 通过 `setContextWindow` 把权威数字喂回 hook state。
// - CompactNowButton / Pill 各自只是视图层；本 hook 是它们的唯一真相源。
//
// 阈值表见 `./severity.ts`——本 hook 不重复持有阈值，只把 estimate / window
// 翻译成档位再交给 UI。
//
// 「ModelIdentity → contextWindow」这条解析管线抽到 `./useResolvedModel` 里
// 共用，ChatInput 走同一条——避免两份 useStorageItem + resolveModel。

import { useEffect, useMemo } from 'react';
import type { ModelIdentity } from '@/lib/persistence/storage';
import type { UseBackgroundAgentReturn } from '@/hooks/useBackgroundAgent';
import { getUsageSeverity, type UsageSeverity, type UsageAssessment } from '@/components/chat/context/severity';
import { useResolvedModel } from '@/components/chat/context/useResolvedModel';

/** `useContextUsage` 给消费组件的统一返回形状。扁平、组件友好：pill 只看
 *  `percent` + `severity`，popover 多看 `headroomTokens`，CompactNowButton
 *  看 `canCompact` + `isCompacting` + `compactNow`。 */
export interface ContextUsage {
  /** Used/total ratio clamped to [0, 1]。未知态（contextWindow 为 null / 0）
   *  返回 0——和 `percent === 0` 保持一致，UI 据此隐藏整张 pill。 */
  ratio: number;
  /** 0-100 整数显示百分比（已 round）。 */
  percent: number;
  severity: UsageSeverity;
  /** contextWindow - tokens，floored at 0。未知态返回 0（不显示「-12k」）。 */
  headroomTokens: number;
  /** 透传给组件做「自由空间展示」用的原始值（K / M 格式化）。 */
  contextTokenEstimate: number;
  contextWindow: number | null;
  /** True when no usable context window can be derived（无模型、解析失败、
   *  storage 未就绪）。Component 据此返回 null，不显示占位。 */
  unknown: boolean;
  /** True iff `state.messages.length >= 2`（至少一对 user + assistant）。
   *  CompactNowButton 的 disabled tooltip 文案与它对齐：「Need at least 2
   *  turns to compact」——单条 user 切点无效。 */
  canCompact: boolean;
  /** true 期间 CompactNowButton 显示 spinner，与 isAgentRunning 二选一覆盖。 */
  isCompacting: boolean;
  isAgentRunning: boolean;
  /** `modelIdentity` 非 null。`unknown === true` 时仍可能 true——表示有模型
   *  选择但解析失败（例如 custom model 被删了），pill 仍应隐藏但应展示错误
   *  提示。 */
  hasModel: boolean;
  /** Fire-and-forget。busy session 上 BG 抛错并通过 `error` ServerMessage 反馈，
   *  调用方负责在 button 上退掉 loading 态。 */
  compactNow: () => void;
}

/**
 * 给 chat 表面提供 context-usage 数据。`modelIdentity` 由调用方传入（chat 页
 * 已经有 provider / modelId 选择，不需要本 hook 再读一遍 storage）。
 *
 * `agent` 是 `useBackgroundAgent()` 的返回值——由调用方提供，避免本 hook 自己
 * 启动第二个 port。
 */
export function useContextUsage(
  agent: UseBackgroundAgentReturn,
  modelIdentity: ModelIdentity | null,
): ContextUsage {
  // `agent` 必须来自调用方当次渲染的 `useBackgroundAgent()`——重复调用 hook
  // 会启动第二个 port，造成状态漂移；注释里点一下避免误用。
  const { state, setContextWindow, compactNow } = agent;
  const { messages, isCompacting, isAgentRunning, contextWindow, contextTokenEstimate } = state;

  // 解析管线走 `./useResolvedModel`——ChatInput 也用同一份，共用 storage 订阅
  // 与 resolveModel 结果。无身份 / 解析失败 → contextWindow = null。
  const { contextWindow: resolvedWindow } = useResolvedModel(modelIdentity);

  // 把权威 window 喂回 hook state，让 `agent.state.contextWindow` 与
  // `useContextUsage().contextWindow` 始终对齐。`===` 比对避免每帧重渲染。
  useEffect(() => {
    setContextWindow(resolvedWindow);
  }, [resolvedWindow, setContextWindow]);

  // severity 单点计算——把三个分支（severity / percent / ratio）一次算齐。
  // ratio 直接透出，UI 想要 SVG 弧长动画就用 ratio 而非 percent。
  const sevResult: UsageAssessment = useMemo(
    () => getUsageSeverity(contextTokenEstimate, contextWindow ?? 0),
    [contextTokenEstimate, contextWindow],
  );

  // headroom = window - tokens。未知态（null/0）时返回 0；UI 据此不显示
  // 「-12k」这种 ghost 数字。
  const headroomTokens = useMemo(() => {
    if (contextWindow === null || contextWindow <= 0) return 0;
    return Math.max(0, contextWindow - contextTokenEstimate);
  }, [contextWindow, contextTokenEstimate]);

  const unknown = contextWindow === null || contextWindow <= 0;
  // 至少需要一对 user + assistant 才能安全切点（单 user 切点无效，
  //  findCompactionCutPoint 退化为 0 → BG 走 compaction_skipped）。
  const canCompact = messages.length >= 2;

  return {
    ratio: sevResult.ratio,
    percent: sevResult.percent,
    severity: sevResult.severity,
    headroomTokens,
    contextTokenEstimate,
    contextWindow,
    unknown,
    canCompact,
    isCompacting,
    isAgentRunning,
    hasModel: modelIdentity !== null,
    compactNow,
  };
}