import { describe, expect, it } from 'vitest';
import { fsSaveUrlTool } from './fs-save-url';

function hasEmptyStringEnumValue(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (Array.isArray(schema)) return schema.some(hasEmptyStringEnumValue);

  const obj = schema as Record<string, unknown>;
  if (obj.const === '') return true;
  if (Array.isArray(obj.enum) && obj.enum.includes('')) return true;

  return Object.values(obj).some(hasEmptyStringEnumValue);
}

describe('fsSaveUrlTool schema', () => {
  it('does not expose an empty referrerPolicy enum value', () => {
    const referrerPolicy = (fsSaveUrlTool.parameters as any)
      .properties
      .init
      .properties
      .referrerPolicy;

    expect(hasEmptyStringEnumValue(referrerPolicy)).toBe(false);
  });
});
