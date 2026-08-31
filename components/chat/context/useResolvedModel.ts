// useResolvedModel — 把 ModelIdentity 解析成 pi-ai Model 的共享 hook。
//
// 之前 ChatInput（composer）和 useContextUsage（context pill）各自读
// providerCredentials / customProviders storage + 各自调 resolveModel()——
// 两条 useStorageItem 监听、两次 resolveModel、两个独立的 cache；用户切
// provider 时两个消费者各自重渲染。本 hook 抽出这条「resolveModel + 监听」
// 路径，让两个消费方共用同一份结果：
// - 一次 storage 订阅（两个 useStorageItem 调用都在这里）
// - 一次 useMemo 解析（resolveModel 在此调一次）
// - ChatInput 与 useContextUsage 都只取最终值，不再各自读 storage
//
// ChatInput 仍保留自己的 useStorageItem(providerCredentials) 用于 ModelSelector
// （modelSelector 自己也要列可用模型组，跟 resolveModel 是两条独立的查询）
// ——useResolvedModel 不替 ModelSelector 收尾，那不是它的职责。

import { useMemo } from 'react';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelIdentity } from '@/lib/persistence/storage';
import {
  providerCredentials,
  customProviders as customProvidersStorage,
} from '@/lib/persistence/storage';
import { resolveModel } from '@/lib/providers/resolve-model';
import { useStorageItem } from '@/hooks/useStorageItem';

export interface ResolvedModel {
  /** 解析出的 pi-ai Model 对象，null 表示无身份 / 解析失败（自定义模型被删、
   *  内置 provider 未注册等）。ChatInput 用它做图片 / 思考档能力派生；
   *  useContextUsage 主要看 contextWindow。 */
  model: Model<Api> | null;
  /** 解析出的 contextWindow。无 model 时与 model.contextWindow 缺失时都为 null。
   *  Pill / Popover 据此判断「未知」态（不显示占位）。 */
  contextWindow: number | null;
}

/** 把 ModelIdentity 解析成 `Model<Api> | null`，并派生 contextWindow。
 *  入参 null（用户尚未选模型）→ 返回 `{ model: null, contextWindow: null }`。 */
export function useResolvedModel(modelIdentity: ModelIdentity | null): ResolvedModel {
  const [creds] = useStorageItem(providerCredentials, {});
  const [customProviders] = useStorageItem(customProvidersStorage, []);

  return useMemo<ResolvedModel>(() => {
    if (!modelIdentity) return { model: null, contextWindow: null };
    const model = resolveModel(modelIdentity, creds, customProviders);
    return {
      model,
      contextWindow: model?.contextWindow ?? null,
    };
  }, [modelIdentity, creds, customProviders]);
}