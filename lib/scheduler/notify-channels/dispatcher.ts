// Multi-channel dispatcher — `Promise.allSettled()` parallel dispatch.
//
// 设计选择（Phase C plan §N1）：
//   1. **allSettled 而非 Promise.all**——一个 channel 失败 / 超时不影响其它。
//   2. **per-channel 5s timeout 已下沉到各 adapter 内部**——dispatcher 只
//      等最慢的 adapter 跑完自己的 timeout 窗口。
//   3. **filter 顺序：enabled → onSuccess / onFailure**——BG 调本函数前
//      已根据 task.notify + result.ok 决定调不调；这里再过一次 channel 级
//      toggle 是「双保险」。
//   4. **never throws**——每个 adapter 内部已经 wrap 成 NotifyResult；dispatcher
//      仅做路由 + 并发。BG tick 不该因为通知失败而失败。
//   5. **missing secret 视为 failure**（不是 throw）——配置缺失是用户行为，
//      结果里写 error 让 BG debug 日志可见。

import type {
  ChannelConfig,
  ChannelKind,
  ChannelSecret,
  NotifyPayload,
  NotifyResult,
} from './types';
import { sendNtfy } from './ntfy';
import { sendTelegram } from './telegram';
import { sendWebhook } from './webhook';

/** 过滤后的「可发送 channel」对子：channel config + 对应 secret（可能 null）。 */
interface DispatchableChannel {
  config: ChannelConfig;
  secret: ChannelSecret | null;
}

/** 把 (config, secret[]) → 待发送列表。secret 数组可能比 config 长（历史
 *  配置有 channel 但被删 secret）——按 id 配对，找不到 secret 视为 secret=null
 *  （让 adapter 自己报告 missing secret 错误）。 */
function pairWithSecrets(
  channels: ChannelConfig[],
  secrets: ChannelSecret[],
): DispatchableChannel[] {
  const byId = new Map<string, ChannelSecret>();
  for (const s of secrets) byId.set(s.id, s);
  return channels.map((config) => ({
    config,
    secret: byId.get(config.id) ?? null,
  }));
}

function shouldNotify(channel: ChannelConfig, ok: boolean): boolean {
  // enabled 是 master switch；notifyOnSuccess / notifyOnFailure 是 per-outcome
  // 子开关。两者都过才送。
  if (!channel.enabled) return false;
  return ok ? channel.notifyOnSuccess : channel.notifyOnFailure;
}

async function dispatchOne(channel: DispatchableChannel, payload: NotifyPayload): Promise<NotifyResult> {
  switch (channel.config.kind) {
    case 'ntfy':
      return sendNtfy(
        payload,
        {
          id: channel.config.id,
          name: channel.config.name,
          topic: channel.config.topic,
        },
        channel.secret?.kind === 'ntfy' ? channel.secret : null,
      );
    case 'telegram':
      return sendTelegram(
        payload,
        {
          id: channel.config.id,
          name: channel.config.name,
          chatId: channel.config.chatId,
        },
        channel.secret?.kind === 'telegram' ? channel.secret : null,
      );
    case 'webhook':
      return sendWebhook(
        payload,
        {
          id: channel.config.id,
          name: channel.config.name,
        },
        channel.secret?.kind === 'webhook' ? channel.secret : null,
      );
    default: {
      // TS exhaustiveness check——ChannelKind 加新成员时这里会红。
      const _exhaustive: never = channel.config;
      const id = (_exhaustive as { id?: string }).id ?? '<unknown>';
      return {
        channelId: id,
        channelKind: 'webhook',
        success: false,
        latencyMs: 0,
        error: `unknown channel kind: ${JSON.stringify(_exhaustive)}`,
      };
    }
  }
}

/** Public API。BG 域调用：传入「enabled + onSuccess/onFailure 与 result 一致」的
 *  channel 列表 + 对应 secrets。永远不抛——所有错误以 NotifyResult 形式返回。 */
export async function dispatchExternalNotifications(
  payload: NotifyPayload,
  channels: ChannelConfig[],
  secrets: ChannelSecret[],
): Promise<NotifyResult[]> {
  const dispatchable = pairWithSecrets(channels, secrets).filter((c) =>
    shouldNotify(c.config, payload.ok),
  );
  if (dispatchable.length === 0) return [];
  // Promise.allSettled 而不是 Promise.all——一个失败不影响其它。
  const settled = await Promise.allSettled(
    dispatchable.map((c) => dispatchOne(c, payload)),
  );
  return settled.map((s, i) => {
    const channel = dispatchable[i]!;
    if (s.status === 'fulfilled') return s.value;
    // rejected 路径理论上不应该触发（每个 adapter 内部 catch），但万一
    // dispatchOne 自己 throw 了——fallback 一个 failure 形态，保留 channelId。
    const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
    return {
      channelId: channel.config.id,
      channelKind: channel.config.kind,
      success: false,
      latencyMs: 0,
      error: `dispatcher unexpected rejection: ${reason}`,
    };
  });
}

/** 单 channel test endpoint（BG `scheduler_test_channel` IPC handler 用）。
 *  与 `dispatchExternalNotifications` 共用同一组 adapter，但只跑单 channel
 *  ——BG 端拿到 `channelId` 后过滤 channels 列表，再调本函数。 */
export async function dispatchSingleChannelTest(
  payload: NotifyPayload,
  channel: ChannelConfig,
  secret: ChannelSecret | null,
): Promise<NotifyResult> {
  return dispatchOne({ config: channel, secret }, payload);
}
