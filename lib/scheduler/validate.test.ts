// Unit tests for lib/scheduler/validate.ts.
//
// AGENTS.md 「Not every file needs a test — only cover high-risk pure logic」
// ——validate.ts là pure input validation: malformed input / wrong scheme / 错配
// shape 会让 LLM 工具调用返回「看起来 OK 但其实没写入 task」的 silent fail。
// 全覆盖：URL scheme / cron / schedule discriminated union / action.kind 分支 /
// extract wildcard 拒绝 / webcheck.expected 要求 / patch 至少一字段。

import { describe, expect, it } from 'vitest';
import {
  validateNewTaskInput,
  validateTaskPatchInput,
  validateUrl,
} from './validate';

describe('validateUrl', () => {
  it('accepts http / https', () => {
    expect(validateUrl('url', 'https://example.com/foo')).toEqual({ ok: true, value: 'https://example.com/foo' });
    expect(validateUrl('url', 'http://example.com')).toEqual({ ok: true, value: 'http://example.com' });
  });

  it('rejects empty / non-string', () => {
    expect(validateUrl('url', '').ok).toBe(false);
    expect(validateUrl('url', null).ok).toBe(false);
    expect(validateUrl('url', undefined).ok).toBe(false);
    expect(validateUrl('url', 42).ok).toBe(false);
  });

  it('rejects malformed URL', () => {
    const result = validateUrl('url', 'not a url');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not a valid URL');
  });

  it('rejects non-http(s) schemes (file:, javascript:, data:, ftp:)', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'ftp://x.test/']) {
      const r = validateUrl('url', url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('http or https');
    }
  });

  it('includes field name in error path for debugging', () => {
    const r = validateUrl('task.action.url', 'ftp://x.test/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('task.action.url');
  });
});

describe('validateNewTaskInput', () => {
  const valid = () => ({
    name: 'Smoke test',
    schedule: { kind: 'interval' as const, minutes: 15 },
    action: { kind: 'fetch' as const, url: 'https://example.com/api' },
    notify: { onSuccess: true, onFailure: true },
    enabled: true,
    createdAt: 1700000000000,
  });

  it('accepts a valid minimal input (interval + fetch)', () => {
    expect(validateNewTaskInput(valid())).toEqual({ ok: true, value: valid() });
  });

  it('accepts cron schedule + webcheck action', () => {
    const input = {
      ...valid(),
      schedule: { kind: 'cron' as const, expr: '*/15 * * * *' },
      action: { kind: 'webcheck' as const, url: 'https://x.test/', condition: 'status_200' as const },
    };
    const r = validateNewTaskInput(input);
    expect(r.ok).toBe(true);
  });

  it('accepts webcheck with contains_text + expected', () => {
    const input = {
      ...valid(),
      action: { kind: 'webcheck' as const, url: 'https://x.test/', condition: 'contains_text' as const, expected: 'healthy' },
    };
    expect(validateNewTaskInput(input).ok).toBe(true);
  });

  it('accepts fetch with extract (simple dot path)', () => {
    const input = {
      ...valid(),
      action: { kind: 'fetch' as const, url: 'https://x.test/', extract: 'data.user.name' },
    };
    expect(validateNewTaskInput(input).ok).toBe(true);
  });

  it('rejects fetch.extract with wildcard / bracket syntax', () => {
    for (const extract of ['items[*].name', 'data[0]', 'user.*', 'name?']) {
      const input = { ...valid(), action: { kind: 'fetch' as const, url: 'https://x.test/', extract } };
      const r = validateNewTaskInput(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('dot paths');
    }
  });

  it('rejects empty / over-60 name', () => {
    expect(validateNewTaskInput({ ...valid(), name: '' }).ok).toBe(false);
    expect(validateNewTaskInput({ ...valid(), name: 'x'.repeat(61) }).ok).toBe(false);
  });

  it('rejects cron with invalid expression', () => {
    const r = validateNewTaskInput({ ...valid(), schedule: { kind: 'cron', expr: 'not a cron' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('schedule.expr');
  });

  it('rejects interval with minutes < 1 (chrome.alarms floor)', () => {
    for (const minutes of [0, -5, 0.5]) {
      const r = validateNewTaskInput({ ...valid(), schedule: { kind: 'interval', minutes } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('integer ≥ 1');
    }
  });

  it('rejects webcheck with contains_text but no expected', () => {
    const input = {
      ...valid(),
      action: { kind: 'webcheck' as const, url: 'https://x.test/', condition: 'contains_text' as const },
    };
    const r = validateNewTaskInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('expected');
  });

  it('rejects empty-string expected (text.includes("") is always true)', () => {
    const input = {
      ...valid(),
      action: { kind: 'webcheck' as const, url: 'https://x.test/', condition: 'contains_text' as const, expected: '' },
    };
    const r = validateNewTaskInput(input);
    expect(r.ok).toBe(false);
  });

  it('rejects unknown action.kind', () => {
    const input = {
      ...valid(),
      action: { kind: 'unknown', url: 'https://x.test/' },
    };
    const r = validateNewTaskInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'fetch' or 'webcheck'");
  });

  it('rejects non-boolean enabled / notify flags', () => {
    expect(validateNewTaskInput({ ...valid(), enabled: 'yes' as unknown as boolean }).ok).toBe(false);
    expect(validateNewTaskInput({ ...valid(), notify: { onSuccess: 'yes' as unknown as boolean, onFailure: false } }).ok).toBe(false);
  });

  it('rejects non-finite createdAt', () => {
    expect(validateNewTaskInput({ ...valid(), createdAt: NaN }).ok).toBe(false);
    expect(validateNewTaskInput({ ...valid(), createdAt: 'now' as unknown as number }).ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateNewTaskInput(null).ok).toBe(false);
    expect(validateNewTaskInput('task').ok).toBe(false);
    expect(validateNewTaskInput(undefined).ok).toBe(false);
  });
});

describe('validateTaskPatchInput', () => {
  it('accepts single-field patches', () => {
    for (const patch of [
      { name: 'New name' },
      { schedule: { kind: 'interval', minutes: 30 } },
      { enabled: false },
      { notify: { onSuccess: false, onFailure: true } },
    ]) {
      expect(validateTaskPatchInput(patch).ok).toBe(true);
    }
  });

  it('rejects empty patch (no fields present)', () => {
    const r = validateTaskPatchInput({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('at least one');
  });

  it('rejects patch with only unknown fields (whitelisted keys required)', () => {
    const r = validateTaskPatchInput({ unknownField: 'x' });
    expect(r.ok).toBe(false);
  });

  it('validates nested fields when present', () => {
    // 包含 schedule 但 cron 表达式无效
    const badSchedule = validateTaskPatchInput({ schedule: { kind: 'cron', expr: 'not cron' } });
    expect(badSchedule.ok).toBe(false);
    if (!badSchedule.ok) expect(badSchedule.error).toContain('schedule.expr');

    // 包含 action 但 url 不合法
    const badAction = validateTaskPatchInput({ action: { kind: 'fetch', url: 'ftp://x' } });
    expect(badAction.ok).toBe(false);
    if (!badAction.ok) expect(badAction.error).toContain('http or https');
  });

  it('accepts a multi-field patch', () => {
    const r = validateTaskPatchInput({
      name: 'Updated',
      enabled: false,
      schedule: { kind: 'cron', expr: '0 12 * * *' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('Updated');
      expect(r.value.enabled).toBe(false);
    }
  });
});
