import { describe, it, expect } from 'vitest';
import { getCustomModels, isModelEnabled, mergeFetchedModels, toModel } from '@/lib/providers/custom-models';
import type { CustomModelDef, CustomProviderConfig } from '@/lib/persistence/storage';

const configured: CustomModelDef = {
  modelId: 'gpt-x',
  name: 'gpt-x',
  reasoning: true,
  image: true,
  contextWindow: 200000,
  maxTokens: 4096,
};

describe('mergeFetchedModels', () => {
  it('仍存在的模型保留既有配置', () => {
    expect(mergeFetchedModels([configured], ['gpt-x'])).toEqual([configured]);
  });

  it('新模型以默认值补入（启用 + 推理/多模态默认关闭）', () => {
    expect(mergeFetchedModels([], ['new'])).toEqual([
      { modelId: 'new', name: 'new', reasoning: false, image: false, enabled: true },
    ]);
  });

  it('混合：保留旧的、补入新的、丢弃远端已消失的，顺序跟随远端', () => {
    const other: CustomModelDef = { modelId: 'keep', name: 'keep', reasoning: false, image: false, enabled: true };
    expect(mergeFetchedModels([configured, other], ['new', 'gpt-x'])).toEqual([
      { modelId: 'new', name: 'new', reasoning: false, image: false, enabled: true },
      configured,
    ]);
  });

  it('远端重复 id 只取首个', () => {
    expect(mergeFetchedModels([configured], ['gpt-x', 'gpt-x'])).toEqual([configured]);
  });

  it('空远端 → 清空', () => {
    expect(mergeFetchedModels([configured], [])).toEqual([]);
  });
});

describe('toModel — headers', () => {
  const cfg: CustomProviderConfig = { id: 'p', name: 'P', baseUrl: 'https://x/v1', models: [] };
  const m: CustomModelDef = { modelId: 'm', name: 'm', reasoning: false };

  it('provider 有 headers → 并入 model.headers', () => {
    expect(toModel({ ...cfg, headers: { 'X-A': '1' } }, m).headers).toEqual({ 'X-A': '1' });
  });

  it('无 headers / 空 headers → model 不带 headers', () => {
    expect(toModel(cfg, m).headers).toBeUndefined();
    expect(toModel({ ...cfg, headers: {} }, m).headers).toBeUndefined();
  });
});

describe('isModelEnabled', () => {
  it('enabled 未设置（undefined） → 视为启用（向后兼容）', () => {
    expect(isModelEnabled({ modelId: 'a', name: 'a', reasoning: false })).toBe(true);
  });
  it('enabled: true → 启用', () => {
    expect(isModelEnabled({ modelId: 'a', name: 'a', reasoning: false, enabled: true })).toBe(true);
  });
  it('enabled: false → 隐藏', () => {
    expect(isModelEnabled({ modelId: 'a', name: 'a', reasoning: false, enabled: false })).toBe(false);
  });
});

describe('getCustomModels — enabled 过滤', () => {
  const cfg: CustomProviderConfig = { id: 'p', name: 'P', baseUrl: 'https://x/v1', models: [] };

  it('过滤掉 enabled: false 的模型，保留未设置 / enabled: true 的', () => {
    const config: CustomProviderConfig = {
      ...cfg,
      models: [
        { modelId: 'old', name: 'old', reasoning: false, image: false },           // undefined → 启用
        { modelId: 'on', name: 'on', reasoning: false, image: false, enabled: true },
        { modelId: 'off', name: 'off', reasoning: false, image: false, enabled: false },
      ],
    };
    const ids = getCustomModels(config).map(m => m.id);
    expect(ids).toEqual(['old', 'on']);
  });

  it('全部禁用 → 返回空数组（provider group 在 UI 中消失）', () => {
    const config: CustomProviderConfig = {
      ...cfg,
      models: [
        { modelId: 'a', name: 'a', reasoning: false, image: false, enabled: false },
        { modelId: 'b', name: 'b', reasoning: false, image: false, enabled: false },
      ],
    };
    expect(getCustomModels(config)).toEqual([]);
  });
});
