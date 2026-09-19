// ntfy.sh 通知通道适配器。
//
// API 极简：POST 到 `<endpoint or ntfy.sh>/<topic>` —— body 是消息 plain text，
// headers 带 Title / Priority / Tags（emoji 列表，逗号分隔）。无需 auth（公开
// server）或自托管 server 设 Basic Auth 头。零依赖 + 单次 fetch。
//
// timeout 5s（per-channel cap）——与 dispatcher 的「不阻塞 BG tick」约束配套。

import type { ChannelSecret, NotifyPayload, NotifyResult } from './types';

const NTFY_DEFAULT_HOST = 'ntfy.sh';
const REQUEST_TIMEOUT_MS = 5_000;

/** ntfy 不接 priority 名字（用 `min`/`low`/`default`/`high`/`urgent` 五个档）。
 *  把 scheduler 的 `ok` 映到默认档：成功 high、失败 urgent——让 mobile 推
 *  notification 显眼一些。v1 不暴露 priority 配置，简单硬编码。 */
function ntfyPriority(ok: boolean): string {
  return ok ? 'high' : 'urgent';
}

/** Title 文本：v1 把 taskName 摆前面，OK/✗ 标志 emoji 区分；summary 接在换行后。
 *  ntfy mobile 通知显示 Title，body 是 detail。 */
function ntfyTitle(payload: NotifyPayload): string {
  const flag = payload.ok ? '✅' : '✗';
  return `${flag} ${payload.taskName}`;
}

function ntfyBody(payload: NotifyPayload): string {
  // ntfy 支持 markdown 但用 plain text 在 mobile notification 里更可读。
  return payload.summary;
}

/** Extract 纯 host（scheme + host），用于 catch 块的错误日志 —— 避免把含
 *  token / 路径的原始 URL 写进 console。 */
function hostOnly(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid-url>';
  }
}

export async function sendNtfy(
  payload: NotifyPayload,
  config: { id: string; name: string; topic: string },
  secret: Extract<ChannelSecret, { kind: 'ntfy' }> | null,
): Promise<NotifyResult> {
  const startedAt = performance.now();
  const endpoint = secret?.endpoint ?? null;
  // URL 构造：endpoint 已含 host 与可选 path（用户可填 `https://ntfy.sh` /
  // `https://self-host.example.com/ntfy`），topic 拼在 path 后或作为 query？
  // ——ntfy 官方约定是 path-style：`POST https://<host>/<topic>`。所以如果 endpoint
  // 的 path 已带尾部 slash，先剥；topic 不带前导 slash。
  let url: string;
  if (endpoint) {
    const base = endpoint.replace(/\/$/, '');
    const topic = config.topic.replace(/^\//, '');
    url = `${base}/${topic}`;
  } else {
    url = `https://${NTFY_DEFAULT_HOST}/${config.topic.replace(/^\//, '')}`;
  }

  const headers: Record<string, string> = {
    Title: ntfyTitle(payload),
    Priority: ntfyPriority(payload.ok),
    // 'robot' tag 让 ntfy mobile 把 notification 标为自动化来源（可选）。
    Tags: 'robot',
  };

  // 自托管 ntfy 支持 Basic Auth：`Authorization: Basic base64(user:pass)`。
  // v1 仅在 endpoint 含 `?user=<user>&pass=<pass>` query 时填 header（避免
  // 把 username/password 暴露在 endpoint 字段本身里）。更稳的方案走 OAuth，
  // 但 v1 不要新增依赖、不动 OAuth 流程。
  if (endpoint) {
    try {
      const parsed = new URL(endpoint);
      const user = parsed.searchParams.get('user');
      const pass = parsed.searchParams.get('pass');
      if (user && pass) {
        headers.Authorization = 'Basic ' + btoa(`${user}:${pass}`);
      }
    } catch {
      // endpoint 无效 —— 会在 fetch 阶段抛错，错误日志用 hostOnly 兜底。
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: ntfyBody(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (!res.ok) {
      return {
        channelId: config.id,
        channelKind: 'ntfy',
        success: false,
        latencyMs,
        error: `ntfy ${hostOnly(url)} returned status ${res.status}`,
      };
    }
    return {
      channelId: config.id,
      channelKind: 'ntfy',
      success: true,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const message = err instanceof Error ? err.message : String(err);
    // AbortError 是 timeout 触发的；其他是网络 / DNS / TLS / CORS 失败。
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return {
      channelId: config.id,
      channelKind: 'ntfy',
      success: false,
      latencyMs,
      error: isTimeout
        ? `ntfy ${hostOnly(url)} timed out after ${REQUEST_TIMEOUT_MS}ms`
        : `ntfy ${hostOnly(url)} failed: ${message}`,
    };
  }
}
