// lib/telegram-gateway/types.ts — wire types shared between Worker (Phase D / D1)
// and extension client (D2). Worker constructs `InboundMessage` from Telegram
// Update; extension constructs `OutboundAction` to send back via Worker.
//
// These types live in lib/ so the extension client (hooks/, lib/) can import
// without crossing the lib → entrypoints boundary. The Worker file
// (gateway/worker.ts) re-defines an inline structural copy to avoid pulling
// this lib path into the CF Worker bundle — single-source-of-truth lives here.

/** Inbound wire message — Worker → extension. Telegram webhook update
 *  normalized to our domain shape (drops Telegram-specific fields we don't
 *  need). */
export interface InboundMessage {
  kind: 'telegram_message';
  /** Telegram's monotonically-increasing update_id; client tracks the
   *  highest seen for backfill ordering (v1: backfill deferred — see D2 plan). */
  update_id: number;
  message_id: number;
  chat_id: number;
  chat_type: 'private' | 'group' | 'supergroup' | 'channel';
  text: string;
  /** Unix seconds. */
  date: number;
  from: { id: number; username?: string } | null;
}

/** Outbound wire message — extension → Worker → Telegram Bot API.
 *  `request_id` correlates with the reply (`OutboundResult` / `GatewayResult`)
 *  so the extension can match response to in-flight request.
 *
 *  - sendMessage    : 发消息（reply 带 `message_id`）。可选字段均由 relay 原样
 *    透传 Bot API：`parse_mode`（Markdown 块）、`reply_to_message_id`（Block 1
 *    回链用户消息）、`disable_notification`（Block 2+ 静默）、
 *    `disable_link_preview`（→ link_preview_options.is_disabled，Block 2+ 防
 *    预览卡片刷屏）
 *  - sendChatAction : typing 指示器（Telegram ~5s 自动过期 → 每 4s 重发）
 *  - editMessage    : editMessageText——parse_mode 只在最后一次 edit 打开
 *    （stream 进行中 markdown 未闭合会 400；'message is not modified' 由
 *    server-side 吞掉——见 gateway/server.js）
 *  - setMessageReaction : 给消息贴 / 换 / 清 emoji reaction（`emoji` 省略 =
 *    清空）。Step-Progress 的 👀 / 👌 / ❌ 生命周期走这里——reaction 动画是
 *    Telegram client 原生渲染（is_big），零 edit 成本
 *  - deleteMessage  : 刪除訊息——Step-Progress 的工具狀態行收尾用（正式回覆
 *    落位前刪掉臨時狀態行，聊天窗不留作業殘渣）。'message to delete not
 *    found' 由 server-side 吞掉（冪等——重複刪除不報錯） */
export type OutboundAction =
  | {
      kind: 'sendMessage';
      request_id: string;
      chat_id: number;
      text: string;
      parse_mode?: 'Markdown';
      reply_to_message_id?: number;
      disable_notification?: boolean;
      disable_link_preview?: boolean;
    }
  | { kind: 'sendChatAction'; request_id: string; chat_id: number; action: 'typing' }
  | { kind: 'editMessage'; request_id: string; chat_id: number; message_id: number; text: string; parse_mode?: 'Markdown' }
  | { kind: 'setMessageReaction'; request_id: string; chat_id: number; message_id: number; emoji?: string }
  | { kind: 'deleteMessage'; request_id: string; chat_id: number; message_id: number };

/** Outbound wire reply — Worker → extension (cho `sendMessage`). */
export type OutboundResult =
  | {
      kind: 'sendMessage_result';
      request_id: string;
      ok: true;
      message_id: number;
    }
  | {
      kind: 'sendMessage_result';
      request_id: string;
      ok: false;
      error: string;
    };

/** sendChatAction / editMessage 的 wire reply（不带 message_id）。 */
export type GatewayResult =
  | { kind: 'gateway_result'; request_id: string; ok: true }
  | { kind: 'gateway_result'; request_id: string; ok: false; error: string };

/** 所有 reply 都用 request_id correlate——worker-client 按此 union resolve。 */
export type OutboundActionResult = OutboundResult | GatewayResult;

/** Connection state the extension client emits as it transitions through
 *  reconnect lifecycle. UI uses this to drive the header badge. */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** Settings (visible / non-secret) for Telegram Gateway — stored at
 *  `local:telegramGatewayConfig`. Worker URL + chat_id whitelist CSV +
 *  interactive mode toggle. `workerUrl` must be the bare WS endpoint (e.g.
 *  `https://<worker>/ws`) — the client appends `?token=<wsAuthToken>` itself;
 *  a URL that already carries a query string would corrupt that append and
 *  fail the Worker's token check.
 *
 *  `allowedChatIdsCsv` is stored as a CSV string to match the Settings UI
 *  form (single textarea); BG splits on parse. Empty CSV = fail-open default
 *  (mirrors `notifyChannelSecrets` whitelist behavior). */
export interface TelegramGatewayConfig {
  workerUrl: string;
  allowedChatIdsCsv: string;
  interactiveMode: boolean;
}

/** Secrets (credentials class) — stored at `local:telegramGatewaySecrets`,
 *  split out via backup registry so bot tokens never appear in config.json.
 *  Keyed by channel id (currently only one channel: "default"). v1: only bot
 *  token + WS auth token + shared secret. */
export interface TelegramGatewaySecret {
  id: string;
  botToken: string;
  /** Shared secret between extension ↔ Worker; the Worker verifies the inbound
   *  Telegram `X-Telegram-Bot-Api-Secret-Token` header matches this (set in Worker
   *  env `TELEGRAM_WEBHOOK_SECRET`). */
  webhookSecret: string;
  /** WS auth — extension presents this as `?token=<wsAuthToken>` on Worker
   *  upgrade. */
  wsAuthToken: string;
}

export type WorkerClientMessage = InboundMessage | OutboundResult | GatewayResult;
export type WorkerClientAction = OutboundAction;
