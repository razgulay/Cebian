// Channel config + secret validators — pure functions shared by BG IPC handlers
// (`scheduler_test_channel` ở N3) + Settings UI form 校验（ST-B4 之后的 UI）。
// 错误信息格式：`{ ok: true, value } | { ok: false, error }` —— 同 cron / runner
// 约定，不抛。

import type {
  ChannelConfig,
  ChannelKind,
  ChannelSecret,
} from './types';

/** ChannelConfig 形态校验：
 *  - name: 非空字符串，≤ 60 字符（与 cron task name 同长，符合 UI 习惯）
 *  - id: 非空字符串（UUID 由调用方生成；校验只兜底）
 *  - kind-specific 字段（topic / chatId）必填
 *  - secret 与 config 分开存储——这里只校验 config 自己的形状，secret 走
 *    `validateChannelSecret`。
 *  - URL scheme 限制交给 secret 校验（webhook URL 必须 http/https；ntfy endpoint
 *    同理；telegram token 不算 URL）。 */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateChannelConfig(input: unknown): ValidationResult<ChannelConfig> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'channel must be an object.' };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    return { ok: false, error: 'channel.id must be a non-empty string.' };
  }
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return { ok: false, error: 'channel.name must be a non-empty string.' };
  }
  if (obj.name.length > 60) {
    return { ok: false, error: 'channel.name must be ≤ 60 characters.' };
  }
  if (typeof obj.enabled !== 'boolean') {
    return { ok: false, error: 'channel.enabled must be a boolean.' };
  }
  if (typeof obj.notifyOnSuccess !== 'boolean' || typeof obj.notifyOnFailure !== 'boolean') {
    return { ok: false, error: 'channel.notifyOnSuccess / notifyOnFailure must both be booleans.' };
  }

  switch (obj.kind) {
    case 'ntfy': {
      if (typeof obj.topic !== 'string' || obj.topic.length === 0) {
        return { ok: false, error: 'ntfy channel.topic must be a non-empty string.' };
      }
      return {
        ok: true,
        value: {
          id: obj.id,
          kind: 'ntfy',
          name: obj.name,
          enabled: obj.enabled,
          notifyOnSuccess: obj.notifyOnSuccess,
          notifyOnFailure: obj.notifyOnFailure,
          topic: obj.topic,
        },
      };
    }
    case 'telegram': {
      if (typeof obj.chatId !== 'string' || obj.chatId.length === 0) {
        return { ok: false, error: 'telegram channel.chatId must be a non-empty string.' };
      }
      return {
        ok: true,
        value: {
          id: obj.id,
          kind: 'telegram',
          name: obj.name,
          enabled: obj.enabled,
          notifyOnSuccess: obj.notifyOnSuccess,
          notifyOnFailure: obj.notifyOnFailure,
          chatId: obj.chatId,
        },
      };
    }
    case 'webhook': {
      // webhook 没有 channel 级别的额外必填字段（URL 在 secret 里）。
      return {
        ok: true,
        value: {
          id: obj.id,
          kind: 'webhook',
          name: obj.name,
          enabled: obj.enabled,
          notifyOnSuccess: obj.notifyOnSuccess,
          notifyOnFailure: obj.notifyOnFailure,
        },
      };
    }
    default:
      return { ok: false, error: `unknown channel.kind: ${String(obj.kind)} (expected 'ntfy' | 'telegram' | 'webhook').` };
  }
}

/** ChannelSecret 形态校验：URL scheme 限制 + token 非空。
 *  URL 必须 http/https（防 file: / javascript: / data: 等本地协议注入）。
 *  Telegram token 不走 URL 检查，但要求非空字符串。 */
export function validateChannelSecret(input: unknown): ValidationResult<ChannelSecret> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'secret must be an object.' };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    return { ok: false, error: 'secret.id must be a non-empty string.' };
  }

  switch (obj.kind) {
    case 'ntfy': {
      if (obj.endpoint !== null && typeof obj.endpoint !== 'string') {
        return { ok: false, error: 'ntfy endpoint must be null (use ntfy.sh) or a string URL.' };
      }
      if (typeof obj.endpoint === 'string' && obj.endpoint.length > 0) {
        const r = validateHttpUrl('ntfy endpoint', obj.endpoint);
        if (!r.ok) return r;
      }
      return {
        ok: true,
        value: { id: obj.id, kind: 'ntfy', endpoint: (obj.endpoint as string | null) ?? null },
      };
    }
    case 'telegram': {
      if (typeof obj.token !== 'string' || obj.token.length === 0) {
        return { ok: false, error: 'telegram token must be a non-empty string.' };
      }
      return {
        ok: true,
        value: { id: obj.id, kind: 'telegram', token: obj.token },
      };
    }
    case 'webhook': {
      if (typeof obj.url !== 'string' || obj.url.length === 0) {
        return { ok: false, error: 'webhook url must be a non-empty string.' };
      }
      const r = validateHttpUrl('webhook url', obj.url);
      if (!r.ok) return r;
      return {
        ok: true,
        value: { id: obj.id, kind: 'webhook', url: obj.url },
      };
    }
    default:
      return { ok: false, error: `unknown secret.kind: ${String(obj.kind)}.` };
  }
}

/** URL 必须是合法 http/https——共用 helper 给 ntfy endpoint + webhook url。
 *  不重复实现 `URL` 构造 + protocol check（与 `lib/scheduler/validate.ts` 的
 *  `validateUrl` 行为一致；这里就地实现是因为 scheduler/notify-channels 是
 *  `lib/` 内部子目录，不应跨子目录 import lib/scheduler/validate）。 */
function validateHttpUrl(field: string, url: string): ValidationResult<string> {
  if (url.length === 0) return { ok: false, error: `${field} must be a non-empty string.` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `${field} is not a valid URL.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `${field} must use http or https scheme (got '${parsed.protocol}').` };
  }
  return { ok: true, value: url };
}

/** 完整「config + secret」对校验（BG IPC handler + UI 提交时同款）。
 *  secret 是可选的——channel 可能临时没 secret（比如新建还没填 token）。
 *  调用方决定怎么对待「config 合法但 secret 缺失」——通常允许 storage
 *  写入但 BG dispatch 时 channel 会报告 missing secret 错误。 */
export function validateChannelPair(
  configInput: unknown,
  secretInput: unknown,
): ValidationResult<{ config: ChannelConfig; secret: ChannelSecret | null }> {
  const configResult = validateChannelConfig(configInput);
  if (!configResult.ok) return configResult;
  // secret 可选（null = 还没填 / 删了）。
  let secret: ChannelSecret | null = null;
  if (secretInput !== null && secretInput !== undefined) {
    const secretResult = validateChannelSecret(secretInput);
    if (!secretResult.ok) return secretResult;
    secret = secretResult.value;
  }
  return { ok: true, value: { config: configResult.value, secret } };
}
