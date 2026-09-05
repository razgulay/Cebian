// Schema validation helper 单测 —— 覆盖 `parseExpectedSchema` 与 `checkSchema`
// 两档：合法 JSON / 合法 JSON.parse + Value.Check pass/fail / malformed schema
// 兜底。Mirror worker-runner.test.ts 的"assembleHandoff 走 schema 分支"用例
// 形态，但这里只测 pure helper 的契约，不测 runner wiring（runner wiring 走
// dom-sub-agent-runner.test.ts 的 describe('schema validation')）。

import { describe, it, expect } from 'vitest';
import { parseExpectedSchema, checkSchema } from '@/lib/agent/schema-validate';

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
