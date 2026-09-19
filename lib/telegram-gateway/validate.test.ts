import { describe, expect, it } from 'vitest';
import { parseChatIdWhitelist, validateChatId, validateInbound } from './validate';

describe('parseChatIdWhitelist', () => {
  it('empty string returns empty Set', () => {
    expect(parseChatIdWhitelist('')).toEqual(new Set());
  });
  it('single number', () => {
    expect(parseChatIdWhitelist('123')).toEqual(new Set([123]));
  });
  it('multiple numbers, whitespace-tolerant', () => {
    expect(parseChatIdWhitelist('1, 2 ,3 , 4')).toEqual(new Set([1, 2, 3, 4]));
  });
  it('drops non-numeric tokens silently (UI prevents but defensive)', () => {
    expect(parseChatIdWhitelist('123, abc, , -5')).toEqual(new Set([123, -5]));
  });
});

describe('validateChatId', () => {
  it('in whitelist → ok', () => {
    expect(validateChatId(123, new Set([123, 456]))).toEqual({ ok: true });
  });
  it('not in whitelist → fail with descriptive error', () => {
    const r = validateChatId(999, new Set([123, 456]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('999');
      expect(r.error).toContain('not in whitelist');
    }
  });
  it('empty whitelist → ok (fail-open default lets user disable filter)', () => {
    expect(validateChatId(999, new Set())).toEqual({ ok: true });
  });
  it('non-finite chat_id → fail', () => {
    const r = validateChatId(Number.NaN, new Set([123]));
    expect(r.ok).toBe(false);
  });
  it('zero chat_id is rejected if not whitelisted (defensive — 0 is valid Telegram group id but)', () => {
    const r = validateChatId(0, new Set());
    expect(r.ok).toBe(true); // empty whitelist → allow all
    const r2 = validateChatId(0, new Set([123]));
    expect(r2.ok).toBe(false);
  });
});

describe('validateInbound', () => {
  const baseInbound = {
    kind: 'telegram_message' as const,
    update_id: 1,
    message_id: 1,
    chat_id: 123,
    chat_type: 'private' as const,
    text: 'hello',
    date: 1737000000,
    from: { id: 99 },
  };

  it('happy path (chat_id ok, text short)', () => {
    expect(validateInbound(baseInbound, new Set([123]))).toEqual({ ok: true });
  });

  it('chat_id not in whitelist → fail (chat_id checked first)', () => {
    const r = validateInbound(baseInbound, new Set([456]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('123');
  });

  it('text > 4096 chars → fail with size info', () => {
    const r = validateInbound({ ...baseInbound, text: 'x'.repeat(4097) }, new Set([123]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('4097');
      expect(r.error).toContain('4096');
    }
  });

  it('text exactly 4096 → ok (boundary inclusive)', () => {
    expect(validateInbound({ ...baseInbound, text: 'x'.repeat(4096) }, new Set([123]))).toEqual({ ok: true });
  });
});
