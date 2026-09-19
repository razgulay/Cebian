// Telegram Bot API 适配器。
//
// POST 到 `https://api.telegram.org/bot<token>/sendMessage`，body JSON：
//   { chat_id, text, parse_mode }
// markdown 内容用 `MarkdownV2`（escaping 严格）或 `Markdown`（宽松）。我们用
// `Markdown`——escape 规则太复杂，title 与 summary 都是用户/LLM 生成的
// 自由文本，宽松 parse_mode 更稳。失败时降级到 plain text 重发一次。
//
// timeout 5s（per-channel cap）。

import type { ChannelSecret, NotifyPayload, NotifyResult } from './types';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const REQUEST_TIMEOUT_MS = 5_000;

function telegramTitle(payload: NotifyPayload): string {
  const flag = payload.ok ? '✅' : '✗';
  // Telegram Markdown 解析：`*text*` = bold，`_text_` = italic，`` `code` ``。
  // 我们把整个 title 包成 bold；emoji 保留原文（Markdown 不解析）。
  return `*${flag} ${payload.taskName}*`;
}

function telegramBody(payload: NotifyPayload): string {
  // 用 escape 过的代码块包 summary：若内容含 `*` / `_` / `` ` `` / `[` 等
  // Markdown 保留字符，宽松 `Markdown` parse_mode 仍可能乱渲染。代码块（```）
  // 完全不走 Markdown 解析，安全。
  return '```\n' + payload.summary + '\n```';
}

/** 拼接 bot endpoint URL；URL 不暴露 token（错误日志只记 host path）。 */
function telegramEndpoint(token: string): string {
  return `${TELEGRAM_API_BASE}${token}/sendMessage`;
}

function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid-url>';
  }
}

/** Telegram Markdown 保留字符 escape（保守——`Markdown` parse_mode 也只对
 *  `_` `*` `` ` `` `[` `]` `(` `)` `~` `\`` `#` `+` `-` `=` `|` `{` `}` `.` `!` 这些
 *  在 Markdown 里有时有特殊含义做基础 escape，避免用户内容里的 `_` 被当 italic）。
 *  用 code block 包裹后理论上不需要 escape，但兜底一下。 */
function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*`\[\]()~\\#+=|{}.!])/g, '\\$1');
}

async function sendOnce(
  endpoint: string,
  body: { chat_id: string; text: string; parse_mode: 'Markdown' | undefined },
  startedAt: number,
): Promise<{ ok: boolean; status: number; errorMessage?: string }> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (res.ok) return { ok: true, status: res.status };
    let detail = '';
    try {
      const data = (await res.json()) as { description?: string };
      detail = data.description ?? '';
    } catch {
      // body 不是 JSON；忽略。
    }
    return { ok: false, status: res.status, errorMessage: detail };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const message = isTimeout
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, status: 0, errorMessage: message };
  }
}

export async function sendTelegram(
  payload: NotifyPayload,
  config: { id: string; name: string; chatId: string },
  secret: Extract<ChannelSecret, { kind: 'telegram' }> | null,
): Promise<NotifyResult> {
  const startedAt = performance.now();
  if (!secret) {
    // 没 token —— 配置缺失，不当作 network failure。
    return {
      channelId: config.id,
      channelKind: 'telegram',
      success: false,
      latencyMs: 0,
      error: 'telegram channel missing bot token',
    };
  }

  const endpoint = telegramEndpoint(secret.token);

  // 第一发：Markdown parse_mode；title bold + summary 在 code block 内避免
  // Markdown 注入问题。
  const firstBody = {
    chat_id: config.chatId,
    text: `${escapeTelegramMarkdown(telegramTitle(payload))}\n\n${telegramBody(payload)}`,
    parse_mode: 'Markdown' as const,
  };
  const first = await sendOnce(endpoint, firstBody, startedAt);
  if (first.ok) {
    const latencyMs = Math.round(performance.now() - startedAt);
    return {
      channelId: config.id,
      channelKind: 'telegram',
      success: true,
      latencyMs,
    };
  }

  // Markdown 失败很可能是解析错误（用户的 `_` 没 escape 干净）。降级到
  // plain text 重发一次，确保用户至少能看到消息。
  // 仅 400 走降级路径——5xx 是服务端问题，重发也不会好。
  if (first.status !== 400) {
    const latencyMs = Math.round(performance.now() - startedAt);
    return {
      channelId: config.id,
      channelKind: 'telegram',
      success: false,
      latencyMs,
      error: `telegram ${hostOnly(endpoint)} returned status ${first.status}: ${first.errorMessage ?? 'unknown'}`,
    };
  }

  const retryStart = performance.now();
  const fallbackBody = {
    chat_id: config.chatId,
    text: `${telegramTitle(payload)}\n\n${payload.summary}`,
    parse_mode: undefined,
  };
  const second = await sendOnce(endpoint, fallbackBody, retryStart);
  const latencyMs = Math.round(performance.now() - startedAt);
  if (second.ok) {
    return {
      channelId: config.id,
      channelKind: 'telegram',
      success: true,
      latencyMs,
    };
  }
  return {
    channelId: config.id,
    channelKind: 'telegram',
    success: false,
    latencyMs,
    error: `telegram ${hostOnly(endpoint)} failed (markdown 400 + plain retry ${second.status}: ${second.errorMessage ?? 'unknown'})`,
  };
}
