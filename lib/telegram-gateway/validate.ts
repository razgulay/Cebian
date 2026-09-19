// Telegram gateway — chat_id whitelist + payload validation.
//
// Defense-in-depth: Worker side already validates against its `ALLOWED_CHAT_IDS`
// env var; this module adds extension-side whitelist enforcement so a stolen
// Worker URL (without the `ALLOWED_CHAT_IDS` config) still can't reach the
// agent pipeline from a rogue chat_id.
//
// v1 only enforces chat_id — full payload shape validation (length, URL regex,
// markdown injection) deferred to v2. Telegram itself rate-limits by chat_id so
// spamming is constrained regardless.

import type { InboundMessage } from './types';

export type WhitelistResult = { ok: true } | { ok: false; error: string };

/** Build a Set<number> from a comma-separated string (mirrors the storage
 *  value the Settings UI writes). Whitespace-tolerant; non-numeric tokens
 *  silently dropped (UI prevents that, but defensive). */
export function parseChatIdWhitelist(csv: string): Set<number> {
  const out = new Set<number>();
  for (const raw of csv.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const id = Number(trimmed);
    if (Number.isFinite(id)) out.add(id);
  }
  return out;
}

/** Returns `ok: true` when `chat_id` is in the whitelist (or whitelist is
 *  empty — fail-open default lets user disable filter). Returns `ok: false`
 *  with a precise error message for the sidepanel to display. */
export function validateChatId(chat_id: number, whitelist: Set<number>): WhitelistResult {
  if (whitelist.size === 0) return { ok: true }; // empty whitelist → allow all
  if (!Number.isFinite(chat_id)) {
    return { ok: false, error: `chat_id ${chat_id} is not a valid Telegram chat id.` };
  }
  if (!whitelist.has(chat_id)) {
    return { ok: false, error: `chat_id ${chat_id} not in whitelist (allowed: ${[...whitelist].join(', ')}).` };
  }
  return { ok: true };
}

/** Convenience validator for a full inbound message — combines chat_id whitelist
 *  check with a length cap so a malicious payload (4 MB+) can't OOM BG. */
export function validateInbound(msg: InboundMessage, whitelist: Set<number>): WhitelistResult {
  const idCheck = validateChatId(msg.chat_id, whitelist);
  if (!idCheck.ok) return idCheck;
  // Telegram text messages cap at 4096 chars. Reject early to keep payload small.
  if (msg.text.length > 4096) {
    return { ok: false, error: `message text too long (${msg.text.length} > 4096).` };
  }
  return { ok: true };
}
