// Schema validation helper 单测 —— 覆盖 `parseExpectedSchema` 与 `checkSchema`
// 两档：合法 JSON / 合法 JSON.parse + Value.Check pass/fail / malformed schema
// 兜底。Mirror worker-runner.test.ts 的"assembleHandoff 走 schema 分支"用例
// 形态，但这里只测 pure helper 的契约，不测 runner wiring（runner wiring 走
// dom-sub-agent-runner.test.ts 的 describe('schema validation')）。

import { describe, it, expect } from 'vitest';
import {
  parseExpectedSchema,
  checkSchema,
  REVIEWER_HANDOFF_SCHEMA,
  REVIEWER_CHECKLIST_ITEM_IDS,
} from '@/lib/agent/schema-validate';

// Helper: build a TypeBox schema literal. We cast to `any` to avoid importing
// `Type` / `TypeBox` just for fixture construction — `Value.Check` accepts any
// shape at runtime, typing is only a compile-time assertion.
const anySchema = (shape: unknown) => shape as Parameters<typeof checkSchema>[0];

describe('parseExpectedSchema', () => {
  it('valid JSON object → returns the parsed value', () => {
    expect(parseExpectedSchema('{"type":"object","required":["status"]}')).toEqual({
      type: 'object',
      required: ['status'],
    });
  });

  it('valid JSON array → returns the parsed array', () => {
    expect(parseExpectedSchema('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('valid JSON primitive (null) → returns null', () => {
    // `null` is valid JSON. parseExpectedSchema returns whatever JSON.parse
    // gives back — including `null`. Caller must distinguish "no schema
    // provided" (undefined) from "schema is null literal" (parsed null).
    // runner logic only calls this when caller supplied a non-empty string,
    // and a `null` schema is treated as "no schema to check against" — see
    // runner's `parsedSchema !== undefined` guard.
    expect(parseExpectedSchema('null')).toBeNull();
  });

  it('malformed JSON (missing closing brace) → null', () => {
    expect(parseExpectedSchema('{ "type": "object" ')).toBeNull();
  });

  it('malformed JSON (random text) → null', () => {
    expect(parseExpectedSchema('this is not json at all')).toBeNull();
  });

  it('empty string → null', () => {
    expect(parseExpectedSchema('')).toBeNull();
  });
});

describe('checkSchema', () => {
  it('matching object → null (pass)', () => {
    const schema = anySchema({
      type: 'object',
      required: ['status'],
      properties: { status: { const: 'success' } },
    });
    expect(checkSchema(schema, { status: 'success' })).toBeNull();
  });

  it('required field missing → returns first error with instancePath', () => {
    const schema = anySchema({
      type: 'object',
      required: ['status', 'required_field'],
      properties: {
        status: { const: 'success' },
        required_field: { type: 'string' },
      },
    });
    const err = checkSchema(schema, { status: 'success' });
    expect(err).not.toBeNull();
    // Format mirrors `lib/mcp/client.ts:113-115`: `${instancePath}: ${message}`.
    expect(err).toMatch(/: /);
  });

  it('wrong type (string vs expected number) → returns error', () => {
    const schema = anySchema({
      type: 'object',
      properties: { count: { type: 'number' } },
    });
    const err = checkSchema(schema, { count: 'five' });
    expect(err).not.toBeNull();
    expect(err).toMatch(/count/);
  });

  it('extra fields allowed (TypeBox default is `additionalProperties: true`)', () => {
    // Verifies we don't over-reject — extra fields shouldn't fail validation.
    // If a future stricter contract is needed, callers can pass
    // `additionalProperties: false` in their schema.
    const schema = anySchema({
      type: 'object',
      required: ['status'],
      properties: { status: { const: 'success' } },
    });
    expect(checkSchema(schema, { status: 'success', extra_field: 'ignored' })).toBeNull();
  });

  it('non-object value vs object schema → returns error', () => {
    const schema = anySchema({ type: 'object' });
    expect(checkSchema(schema, 'a string')).not.toBeNull();
    expect(checkSchema(schema, 42)).not.toBeNull();
    expect(checkSchema(schema, null)).not.toBeNull();
  });

  it('unprocessable schema (TypeBox throws) → null + lenient pass', () => {
    // TypeBox throws on shapes it can't evaluate (e.g. non-object schemas
    // where its internal `HasPropertyKey` lookup expects a `type` key). The
    // contract is "lenient pass + warn" so a malformed caller schema doesn't
    // break the whole pipeline. We feed a plain string — Value.Check throws
    // `Cannot use 'in' operator to search for 'type' in not a schema`, the
    // catch branch swallows it, and `checkSchema` returns null.
    const err = checkSchema('not a schema' as Parameters<typeof checkSchema>[0], { a: 1 });
    expect(err).toBeNull();
  });
});

// ─── Subtask 2.2: REVIEWER_HANDOFF_SCHEMA + REVIEWER_CHECKLIST_ITEM_IDS ───
//
// Reviewer handoff schema 的纯合约测试 —— 校验 15 条 checklist item 形状。
// 这里 pin 的 substring / 数值是 reviewer prompt ↔ schema ↔ DelegationCard
// mini-table（Subtask 2.3）三方共用的 source of truth。改 schema 时必须同步
// 改 prompt + 这个 describe 块 + DelegationCard 渲染逻辑。
describe('REVIEWER_HANDOFF_SCHEMA (Subtask 2.2 reviewer handoff contract)', () => {
  // ── Schema shape pins ─────────────────────────────────────────
  it('顶层 required 字段是 status / output_file / summary / handoff_notes / checklist', () => {
    // 5 个 required 字段是 reviewer handoff 的「必须 emit」清单，漏一个
    // schema fail → reviewer 重试一次。`checklist` 是 Subtask 2.2 新增的核心
    // 字段，缺它 = reviewer 没按结构化 emit = schema 拒绝。
    expect(REVIEWER_HANDOFF_SCHEMA.required).toEqual([
      'status',
      'output_file',
      'summary',
      'handoff_notes',
      'checklist',
    ]);
  });

  it('顶层 status enum 是 success / failed / partial（与 WorkerHandoff.status 对齐）', () => {
    const statusSchema = REVIEWER_HANDOFF_SCHEMA.properties.status as { enum: readonly string[] };
    expect(statusSchema.enum).toEqual(['success', 'failed', 'partial']);
  });

  it('顶层 summary maxLength = 200（防止 LLM 写长 summary 撑爆主代理 context）', () => {
    const summarySchema = REVIEWER_HANDOFF_SCHEMA.properties.summary as {
      maxLength?: number;
    };
    expect(summarySchema.maxLength).toBe(200);
  });

  it('顶层 additionalProperties = false（防 reviewer 把 extra 字段塞进 handoff）', () => {
    expect(REVIEWER_HANDOFF_SCHEMA.additionalProperties).toBe(false);
  });

  // ── Checklist shape pins ──────────────────────────────────────
  it('checklist 数组 minItems = 1（强制 reviewer 至少 emit 1 条）', () => {
    const checklistSchema = REVIEWER_HANDOFF_SCHEMA.properties.checklist as {
      minItems?: number;
    };
    expect(checklistSchema.minItems).toBe(1);
  });

  it('checklist item required 字段是 item / status / evidence', () => {
    const items = (REVIEWER_HANDOFF_SCHEMA.properties.checklist as { items: { required: readonly string[] } }).items;
    expect(items.required).toEqual(['item', 'status', 'evidence']);
  });

  it('checklist item status enum 是 pass / fail / warn（区别于顶层 success/failed/partial）', () => {
    const items = (REVIEWER_HANDOFF_SCHEMA.properties.checklist as { items: { properties: { status: { enum: readonly string[] } } } }).items;
    expect(items.properties.status.enum).toEqual(['pass', 'fail', 'warn']);
  });

  it('checklist item id 走 kebab-case pattern ^[a-z][a-z0-9-]*$（不接受 numeric (1)..(15)）', () => {
    const items = (REVIEWER_HANDOFF_SCHEMA.properties.checklist as { items: { properties: { item: { pattern: string } } } }).items;
    expect(items.properties.item.pattern).toBe('^[a-z][a-z0-9-]*$');
  });

  it('checklist item evidence maxLength = 200（保持单个 item 紧凑）', () => {
    const items = (REVIEWER_HANDOFF_SCHEMA.properties.checklist as { items: { properties: { evidence: { maxLength?: number } } } }).items;
    expect(items.properties.evidence.maxLength).toBe(200);
  });

  it('checklist item additionalProperties = false（防 reviewer 塞 ragit 字段如 line / severity）', () => {
    const items = (REVIEWER_HANDOFF_SCHEMA.properties.checklist as { items: { additionalProperties?: boolean } }).items;
    expect(items.additionalProperties).toBe(false);
  });

  // ── Schema validation behavior ────────────────────────────────
  it('valid handoff (15 items) → checkSchema pass', () => {
    // 完整 15 条 checklist 全 pass —— reviewer emit "all-clear" audit。
    const validHandoff = {
      status: 'success',
      output_file: null,
      summary: 'All 15 items pass.',
      handoff_notes: 'Audit clean.',
      checklist: REVIEWER_CHECKLIST_ITEM_IDS.map((id) => ({
        item: id,
        status: 'pass' as const,
        evidence: `line 1: ${id} ok`,
      })),
    };
    const err = checkSchema(
      REVIEWER_HANDOFF_SCHEMA as Parameters<typeof checkSchema>[0],
      validHandoff,
    );
    expect(err).toBeNull();
  });

  it('valid handoff (mixed fail/warn/pass) → checkSchema pass', () => {
    // 现实场景：reviewer 报 2 fail + 1 warn + 12 pass 的混合 audit。
    const mixedHandoff = {
      status: 'partial',
      output_file: null,
      summary: '2 fail, 1 warn, 12 pass',
      handoff_notes: '',
      checklist: [
        { item: 'no-localstorage', status: 'fail', evidence: 'line 42: localStorage.setItem' },
        { item: 'overflow-x-auto', status: 'fail', evidence: 'table on line 200 missing overflow-x' },
        { item: 'no-indexeddb', status: 'warn', evidence: 'indexedDB.open on line 15' },
        ...REVIEWER_CHECKLIST_ITEM_IDS.slice(3, 15).map((id) => ({
          item: id,
          status: 'pass' as const,
          evidence: `${id} not present`,
        })),
      ],
    };
    const err = checkSchema(
      REVIEWER_HANDOFF_SCHEMA as Parameters<typeof checkSchema>[0],
      mixedHandoff,
    );
    expect(err).toBeNull();
  });

  it('missing checklist field → checkSchema fail（required gate）', () => {
    // reviewer 漏 emit checklist = 整个 handoff 拒收 → retryable。
    const noChecklist = {
      status: 'success',
      output_file: null,
      summary: 'ok',
      handoff_notes: '',
    };
    const err = checkSchema(
      REVIEWER_HANDOFF_SCHEMA as Parameters<typeof checkSchema>[0],
      noChecklist,
    );
    expect(err).not.toBeNull();
    expect(err).toMatch(/checklist/);
  });

  it('empty checklist array → checkSchema fail（minItems: 1 强制至少 1 条）', () => {
    // reviewer emit 空数组 = 「忘了 emit」语义错误，必须 fail。
    const emptyChecklist = {
      status: 'success',
      output_file: null,
      summary: 'ok',
      handoff_notes: '',
      checklist: [],
    };
    const err = checkSchema(
      REVIEWER_HANDOFF_SCHEMA as Parameters<typeof checkSchema>[0],
      emptyChecklist,
    );
    expect(err).not.toBeNull();
    expect(err).toMatch(/checklist/);
  });

  it('checklist item id 格式错（numeric "(1)" 或含空格）→ checkSchema fail', () => {
    // 接受 prompt 里 `(1)..(15)` 数字 label，但 schema 只接受 kebab-case。
    // LLM 用 "(1)" emit 会被 schema reject → retry。校验两种常见错：
    const cases: unknown[] = [
      {
        status: 'success',
        output_file: null,
        summary: 'ok',
        handoff_notes: '',
        checklist: [{ item: '(1)', status: 'pass', evidence: 'ok' }],
      },
      {
        status: 'success',
        output_file: null,
        summary: 'ok',
        handoff_notes: '',
        checklist: [{ item: 'no localStorage', status: 'pass', evidence: 'ok' }],
      },
      {
        status: 'success',
        output_file: null,
        summary: 'ok',
        handoff_notes: '',
        checklist: [{ item: 'No-LocalStorage', status: 'pass', evidence: 'ok' }],
      },
    ];
    for (const c of cases) {
      const err = checkSchema(
        REVIEWER_HANDOFF_SCHEMA as Parameters<typeof checkSchema>[0],
        c,
      );
      expect(
        err,
        `case should fail: ${JSON.stringify((c as { checklist: unknown }).checklist)}`,
      ).not.toBeNull();
    }
  });

  it('checklist item status enum 错（"passed" / "PASS"）→ checkSchema fail', () => {
    const cases: unknown[] = [
      {
        status: 'success',
        output_file: null,
        summary: 'ok',
        handoff_notes: '',
        checklist: [{ item: 'no-localstorage', status: 'passed', evidence: 'ok' }],
      },
      {
        status: 'success',
        output_file: null,
        summary: 'ok',
        handoff_notes: '',
        checklist: [{ item: 'no-localstorage', status: 'PASS', evidence: 'ok' }],
      },
    ];
    for (const c of cases) {
      const err = checkSchema(
        REVIEWER_HANDOFF_SCHEMA as Parameters<typeof checkSchema>[0],
        c,
      );
      expect(
        err,
        `case should fail: ${JSON.stringify((c as { checklist: unknown }).checklist)}`,
      ).not.toBeNull();
    }
  });

  it('checklist item evidence 超 200 chars → checkSchema fail', () => {
    const tooLong = 'x'.repeat(201);
    const bad = {
      status: 'success',
      output_file: null,
      summary: 'ok',
      handoff_notes: '',
      checklist: [{ item: 'no-localstorage', status: 'fail', evidence: tooLong }],
    };
    const err = checkSchema(
      REVIEWER_HANDOFF_SCHEMA as Parameters<typeof checkSchema>[0],
      bad,
    );
    expect(err).not.toBeNull();
  });

  it('顶层额外字段（如 `extra: "..."`）→ checkSchema fail（additionalProperties:false）', () => {
    const extra = {
      status: 'success',
      output_file: null,
      summary: 'ok',
      handoff_notes: '',
      checklist: [{ item: 'no-localstorage', status: 'pass', evidence: 'ok' }],
      extra_field: 'should not be here',
    };
    const err = checkSchema(
      REVIEWER_HANDOFF_SCHEMA as Parameters<typeof checkSchema>[0],
      extra,
    );
    expect(err).not.toBeNull();
  });

  // ── REVIEWER_CHECKLIST_ITEM_IDS pins ──────────────────────────
  it('REVIEWER_CHECKLIST_ITEM_IDS 长度 = 15（与 Subtask 2.1 prompt (1)..(15) 一一对应）', () => {
    expect(REVIEWER_CHECKLIST_ITEM_IDS).toHaveLength(15);
  });

  it('REVIEWER_CHECKLIST_ITEM_IDS 所有 id 满足 kebab-case pattern', () => {
    const kebabRe = /^[a-z][a-z0-9-]*$/;
    for (const id of REVIEWER_CHECKLIST_ITEM_IDS) {
      expect(id, `id "${id}" should match kebab-case`).toMatch(kebabRe);
    }
  });

  it('REVIEWER_CHECKLIST_ITEM_IDS 无重复', () => {
    expect(new Set(REVIEWER_CHECKLIST_ITEM_IDS).size).toBe(REVIEWER_CHECKLIST_ITEM_IDS.length);
  });

  it('REVIEWER_CHECKLIST_ITEM_IDS 顺序与 reviewer systemPrompt (1)..(15) 一致', () => {
    // 把 id 拼成 prompt 注释块（与 worker-roles.ts reviewer systemPrompt 一致）。
    // 这里只 pin 顺序：id[0] 对应 (1) no-localstorage, id[14] 对应 (15) overflow-x-auto。
    expect(REVIEWER_CHECKLIST_ITEM_IDS[0]).toBe('no-localstorage');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[1]).toBe('no-sessionstorage');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[2]).toBe('no-document-cookie');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[3]).toBe('no-indexeddb');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[4]).toBe('https-only-script-src');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[5]).toBe('https-only-link-href');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[6]).toBe('root-color-tokens');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[7]).toBe('prefers-color-scheme');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[8]).toBe('grid-or-flexbox');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[9]).toBe('viewport-meta');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[10]).toBe('title-present');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[11]).toBe('img-alt-attr');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[12]).toBe('prefers-reduced-motion');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[13]).toBe('no-inline-event-handlers');
    expect(REVIEWER_CHECKLIST_ITEM_IDS[14]).toBe('overflow-x-auto');
  });
});
