// Generic Webhook 适配器。
//
// POST 到任意 URL（Discord incoming webhook、Slack incoming webhook、
// Gotify、自托管 listener 等），body 是结构化 JSON：
//   {
//     "source": "cebian-scheduler",
//     "taskName": "...",
//     "ok": true | false,
//     "summary": "...",
//     "at": 1737000000000
//   }
// 兼容 Discord / Slack 的 `content` 字段（用 `summary`）；其它平台靠结构化
// JSON 自己解析。
//
// 5s timeout。catch 块的错误日志只记 host，不记完整 URL（防 token in path）。

import type { ChannelSecret, NotifyPayload, NotifyResult } from './types';

const REQUEST_TIMEOUT_MS = 5_000;
const SOURCE_TAG = 'cebian-scheduler';

function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid-url>';
  }
}

interface WebhookPayload {
  source: typeof SOURCE_TAG;
  taskName: string;
  ok: boolean;
  summary: string;
  at: number;
}

export async function sendWebhook(
  payload: NotifyPayload,
  config: { id: string; name: string },
  secret: Extract<ChannelSecret, { kind: 'webhook' }> | null,
): Promise<NotifyResult> {
  const startedAt = performance.now();
  if (!secret) {
    // 没 URL —— 配置缺失，不当作 network failure。
    return {
      channelId: config.id,
      channelKind: 'webhook',
      success: false,
      latencyMs: 0,
      error: 'webhook channel missing URL',
    };
  }

  const body: WebhookPayload = {
    source: SOURCE_TAG,
    taskName: payload.taskName,
    ok: payload.ok,
    summary: payload.summary,
    at: payload.at,
  };

  try {
    const res = await fetch(secret.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (res.ok) {
      return {
        channelId: config.id,
        channelKind: 'webhook',
        success: true,
        latencyMs,
      };
    }
    return {
      channelId: config.id,
      channelKind: 'webhook',
      success: false,
      latencyMs,
      error: `webhook ${hostOnly(secret.url)} returned status ${res.status}`,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const message = isTimeout
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      channelId: config.id,
      channelKind: 'webhook',
      success: false,
      latencyMs,
      error: isTimeout
        ? `webhook ${hostOnly(secret.url)} ${message}`
        : `webhook ${hostOnly(secret.url)} failed: ${message}`,
    };
  }
}
