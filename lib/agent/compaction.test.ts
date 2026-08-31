import { describe, it, expect } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  buildArchiveFilename,
  buildCompactionArchiveEntry,
  isStructuredSummary,
  parseStructuredSummary,
  stripMarkdownFence,
  usableCompactionTarget,
  type CompactionArchiveEntry,
  type StructuredSummary,
  type CompactionTarget,
} from '@/lib/agent/compaction';

/** 构造一个最小可辨识的 Model：只需 id / provider 用于断言「选中了哪个」。 */
function fakeModel(id: string, provider: string): Model<Api> {
  return { id, provider } as unknown as Model<Api>;
}

const smallModel = fakeModel('small', 'custom:cheap');

describe('usableCompactionTarget', () => {
  it('未配置压缩模型（configured 为 null）→ null（回退主模型）', () => {
    expect(usableCompactionTarget(null)).toBeNull();
  });

  it('配置了压缩模型且凭证可用 → 原样返回该目标', () => {
    const configured: CompactionTarget = { model: smallModel, apiKey: 'small-key' };
    expect(usableCompactionTarget(configured)).toBe(configured);
  });

  it('配置了压缩模型但无凭证（apiKey undefined）→ null（回退主模型）', () => {
    const configured: CompactionTarget = { model: smallModel, apiKey: undefined };
    expect(usableCompactionTarget(configured)).toBeNull();
  });

  it('配置了压缩模型但 apiKey 为空串 → null（回退主模型）', () => {
    const configured: CompactionTarget = { model: smallModel, apiKey: '' };
    expect(usableCompactionTarget(configured)).toBeNull();
  });
});

// ─── Subtask 4：结构化摘要解析 + VFS 归档 ───

const SAMPLE_SUMMARY: StructuredSummary = {
  schema_version: 1,
  goal: '实现登录页',
  constraints: ['必须支持 SSO', '无外网依赖'],
  progress: {
    done: ['搭好表单骨架', '接到 mock API'],
    in_progress: ['样式调优'],
    blocked: [],
  },
  decisions: [{ decision: '用 react-hook-form', rationale: '已迁移的新项目统一走 form lib' }],
  next_steps: ['接真实 API', '写单测'],
  critical_context: ['mock 在 401 时返回 `{"code":"unauth"}`'],
};

function buildValidJsonBlock(summary: StructuredSummary = SAMPLE_SUMMARY): string {
  return '```json\n' + JSON.stringify(summary, null, 2) + '\n```';
}

describe('stripMarkdownFence', () => {
  it('带语言标签的 json 围栏 → 内部内容并去首尾空白', () => {
    const inner = '{"a":1}';
    expect(stripMarkdownFence('```json\n' + inner + '\n```')).toBe(inner);
  });

  it('不带语言标签的围栏 → 内部内容并去首尾空白', () => {
    const inner = '{"a":1}';
    expect(stripMarkdownFence('```\n' + inner + '\n```')).toBe(inner);
  });

  it('无围栏 → 原文（去首尾空白）', () => {
    expect(stripMarkdownFence('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('围栏内首尾有多余空白 → 仍正确剥离', () => {
    expect(stripMarkdownFence('```json\n\n  {"a":1}  \n\n```')).toBe('{"a":1}');
  });
});

describe('parseStructuredSummary', () => {
  it('Markdown + 末尾围栏 JSON → 解析成功', () => {
    const md = '## Goal\n实现登录页\n\n```json\n' + JSON.stringify(SAMPLE_SUMMARY) + '\n```';
    expect(parseStructuredSummary(md)).toEqual(SAMPLE_SUMMARY);
  });

  it('无围栏的纯 JSON → 仍能解析', () => {
    expect(parseStructuredSummary(JSON.stringify(SAMPLE_SUMMARY))).toEqual(SAMPLE_SUMMARY);
  });

  it('围栏存在但 JSON 格式坏（尾逗号）→ 返回 null', () => {
    const bad = '```json\n{"schema_version":1,"goal":"x",}\n```';
    expect(parseStructuredSummary(bad)).toBeNull();
  });

  it('围栏存在但 schema_version=2 → 返回 null', () => {
    const v2 = { ...SAMPLE_SUMMARY, schema_version: 2 };
    expect(parseStructuredSummary('```json\n' + JSON.stringify(v2) + '\n```')).toBeNull();
  });

  it('纯 Markdown（无任何围栏）→ 返回 null', () => {
    expect(parseStructuredSummary('## Goal\nno json here')).toBeNull();
  });

  it('多个围栏 → 取最后一个能通过 schema 守门的', () => {
    const bogus = '```json\n{"unrelated":"thing"}\n```';
    const md = bogus + '\n\n## 摘要\n\n' + buildValidJsonBlock();
    expect(parseStructuredSummary(md)).toEqual(SAMPLE_SUMMARY);
  });

  it('空字符串 → 返回 null，不抛', () => {
    expect(parseStructuredSummary('')).toBeNull();
  });

  it('isStructuredSummary：缺字段 → false', () => {
    const { goal, ...rest } = SAMPLE_SUMMARY;
    expect(isStructuredSummary(rest)).toBe(false);
  });

  it('isStructuredSummary：decisions[i] 缺 rationale → false', () => {
    const bad = { ...SAMPLE_SUMMARY, decisions: [{ decision: 'x' }] };
    expect(isStructuredSummary(bad)).toBe(false);
  });

  it('isStructuredSummary：decisions[i] 非对象 → false', () => {
    const bad = { ...SAMPLE_SUMMARY, decisions: ['not an object'] };
    expect(isStructuredSummary(bad)).toBe(false);
  });

  it('isStructuredSummary：progress 是字符串而非对象 → false', () => {
    const bad = { ...SAMPLE_SUMMARY, progress: 'not an object' };
    expect(isStructuredSummary(bad)).toBe(false);
  });

  it('isStructuredSummary：decisions 非数组 → false', () => {
    const bad = { ...SAMPLE_SUMMARY, decisions: 'not an array' };
    expect(isStructuredSummary(bad)).toBe(false);
  });

  it('isStructuredSummary：schema_version=2 → false（V2 走另一条路径）', () => {
    const v2 = { ...SAMPLE_SUMMARY, schema_version: 2 };
    expect(isStructuredSummary(v2)).toBe(false);
  });

  it('parseStructuredSummary：大写 ```JSON 围栏仍能解析', () => {
    const raw = '## Goal\nx\n\n```JSON\n' + JSON.stringify(SAMPLE_SUMMARY) + '\n```';
    expect(parseStructuredSummary(raw)).toEqual(SAMPLE_SUMMARY);
  });
});

describe('buildArchiveFilename', () => {
  it('ISO 时间戳前缀由 compactAt 决定', () => {
    const f = buildArchiveFilename(1700000000000, () => 0);
    expect(f.startsWith('2023-11-14T22-13-20-000Z-')).toBe(true);
    expect(f.endsWith('.json')).toBe(true);
  });

  it('同 compactAt + 固定 rng → 确定性后缀（000000）', () => {
    expect(buildArchiveFilename(1700000000000, () => 0)).toBe(
      '2023-11-14T22-13-20-000Z-000000.json',
    );
  });

  it('文件名不含会破坏 VFS normalize 的特殊字符（除扩展名 .）', () => {
    const f = buildArchiveFilename(Date.now(), () => 0.5);
    // 只允许一次 '.'（扩展名前缀部分）外加末尾的 '.json'
    const dotCount = (f.match(/\./g) ?? []).length;
    expect(dotCount).toBe(1);
    expect(f.includes(':')).toBe(false);
  });
});

describe('buildCompactionArchiveEntry', () => {
  const baseInput = {
    sessionId: '11111111-2222-3333-4444-555555555555',
    compactedAt: 1700000000000,
    tokensBefore: 12345,
    messagesSummarized: 8,
    compactingModel: smallModel,
  };

  it('JSON 围栏解析成功 → structured 填好、parseError 缺席', () => {
    const entry = buildCompactionArchiveEntry({
      ...baseInput,
      llmOutput: '## Goal\nx\n\n' + buildValidJsonBlock(),
    });
    expect(entry.structured).toEqual(SAMPLE_SUMMARY);
    expect(entry.parseError).toBeUndefined();
  });

  it('纯 Markdown（无 JSON）→ structured=null + parseError 设置', () => {
    const entry = buildCompactionArchiveEntry({
      ...baseInput,
      llmOutput: '## Goal\nno json',
    });
    expect(entry.structured).toBeNull();
    expect(entry.parseError).toBe('parseStructuredSummary returned null');
  });

  it('compactingModel 渲染为 "provider/id"', () => {
    const entry = buildCompactionArchiveEntry({
      ...baseInput,
      llmOutput: 'no json',
    });
    expect(entry.compactingModel).toBe('custom:cheap/small');
  });

  it('rawOutput 是 LLM 原始输出（不做变换）', () => {
    const raw = '## Goal\nx\n\n' + buildValidJsonBlock();
    const entry = buildCompactionArchiveEntry({ ...baseInput, llmOutput: raw });
    expect(entry.rawOutput).toBe(raw);
  });

  it('整条 entry 经 JSON.stringify → JSON.parse 完整 round-trip', () => {
    const entry = buildCompactionArchiveEntry({
      ...baseInput,
      llmOutput: '## Goal\nx\n\n' + buildValidJsonBlock(),
    });
    const round: CompactionArchiveEntry = JSON.parse(JSON.stringify(entry));
    expect(round).toEqual(entry);
  });
});
