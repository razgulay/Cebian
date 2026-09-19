// Multi-Channel Outbound Notification Gateway — types.
//
// 形状是 Phase C plan §N1 的最小集合：每个 channel 一个 `ChannelKind`
// discriminator + 对应 config variant；NotifyResult 与 NotifyPayload 跨
// channel 共用。所有字段都在 BG 域（`entrypoints/background/scheduler/`）使用，
// 不入 chrome.* / React。

/** Per-channel discriminator。增加 channel 时：先在这里加字面量，再写
 *  `lib/scheduler/notify-channels/<kind>.ts` 的 `send<Kind>` 函数，
 *  并把该 channel 名字加进 `dispatcher.ts` 的 switch map。 */
export type ChannelKind = 'ntfy' | 'telegram' | 'webhook';

/** Channel config（settings class，存到 `local:notifyChannels`）。
 *  secret — token / URL 中需要保密的部分——单独存到 `local:notifyChannelSecrets`
 *  （credentials class）以走 backup registry 的 splitSecret 路径。 */
export type ChannelConfig =
  | {
      id: string;
      kind: 'ntfy';
      name: string;
      enabled: boolean;
      notifyOnSuccess: boolean;
      notifyOnFailure: boolean;
      /** ntfy topic 名（不带 host 前缀）。endpoint secret 持有 host 前缀
       *  （可空，默认 ntfy.sh），URL 拼法：`<endpoint or ntfy.sh>/<topic>`。 */
      topic: string;
    }
  | {
      id: string;
      kind: 'telegram';
      name: string;
      enabled: boolean;
      notifyOnSuccess: boolean;
      notifyOnFailure: boolean;
      /** Telegram 目标 chat id（数字，或 @channelname 公开 channel）。非 secret——
       *  公开 channel 的 username 不算机密；私人 chat id 也已通过 BotFather
       *  公开在 Telegram 基础设施中。secret 字段只存 bot token。 */
      chatId: string;
    }
  | {
      id: string;
      kind: 'webhook';
      name: string;
      enabled: boolean;
      notifyOnSuccess: boolean;
      notifyOnFailure: boolean;
    };

/** Channel secret 与 ChannelConfig 一一对应，由 channel id 索引。
 *  `ntfy` 与 `webhook` 实际就是 url（可能含 token query param 或自托管 host）；
 *  `telegram` 是 bot token。其它 secret 不收——v1 不做签名、HMAC、OAuth 等。
 *  URL 单独存而不是 inline 在 config 里，方便 rotate token 不动其它字段。 */
export type ChannelSecret =
  | { id: string; kind: 'ntfy'; endpoint: string | null }
  | { id: string; kind: 'telegram'; token: string }
  | { id: string; kind: 'webhook'; url: string };

/** 单 channel 单次发送结果。`latencyMs` 始终记录——UI 展示 test 按钮响应
 *  时长，BG 端 debug 也用得到。`error` 只在 success=false 时存在；类型上
 *  union 强制 discriminator 保证 caller 不能误访问。 */
export type NotifyResult =
  | {
      channelId: string;
      channelKind: ChannelKind;
      success: true;
      latencyMs: number;
    }
  | {
      channelId: string;
      channelKind: ChannelKind;
      success: false;
      latencyMs: number;
      error: string;
    };

/** 单次通知的 payload（dispatcher 内部由 BG RunResult 派生）。
 *  `ok` 让通道能区分 success/failure 文案 / emoji；`summary` 已经是 ≤80 字符的
 *  截断结果（runner 那边处理过）。`taskName` 用于消息标题前缀。 */
export interface NotifyPayload {
  taskName: string;
  ok: boolean;
  summary: string;
  /** ISO 时间戳，让 ntfy / Telegram / webhook 都拿到同一时刻的标记。 */
  at: number;
}
