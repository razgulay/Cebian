// Telegram gateway bootstrap — BG-side startup helper.
//
// Creates a worker-client (WebSocket to Cloudflare Worker relay) and bridges
// its events to the rest of the extension via port broadcasts:
//
//   worker-client inbound → broadcastAll `telegram_gateway_inbound`
//   worker-client status  → broadcastAll `telegram_gateway_status`
//
// 跨 context 桥：bootstrap 在 BG SW 里跑、`telegramGatewayChannel` 的模块单例
// 在每个 JS context 各持一份，BG 侧 publishInbound/publishStatus 永远到不了
// sidepanel 的 channel 实例——必须经 port 走 useBackgroundAgent.handleMessage
// 桥接到 sidepanel 的 channel（与 scheduler/canvas 同款模式）。
//
// Outbound 由 BG 侧 client-handlers 处理（`telegram_gateway_send` ClientMessage
// 转发到这里），不再走 channel.sendOutbound：sidepanel 实例的 outboundSender
// 永远为 null。

import { acquireKeepAlive, releaseKeepAlive } from '@/entrypoints/background/lifecycle/keepalive';
import { broadcastAll } from '@/entrypoints/background/ipc/port-registry';
import { createWorkerClient, type WorkerClientHandle } from './worker-client';
import type { ConnectionStatus, InboundMessage, OutboundAction, OutboundActionResult } from './types';

export interface BootstrapOptions {
  url: string;
  token: string;
  /** Outbound action handler — defaults to `sendMessage` via the Worker. BG
   *  side only needs to override this if it wants to log every outbound call. */
  onOutbound?: (action: OutboundAction) => Promise<OutboundActionResult>;
  /** Forwarded to the worker-client. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  signal?: AbortSignal;
}

export interface BootstrapHandle {
  client: WorkerClientHandle;
  /** Call once on extension unload (BG `beforeUnload` listener). */
  teardown: () => void;
}

export function bootstrapTelegramGateway(opts: BootstrapOptions): BootstrapHandle {
  // Wrap outbound: by default forward to worker-client's sendOutbound (which
  // routes to Worker → Telegram). The optional `onOutbound` is a hook for BG-side
  // observability (logs / metrics) — the default path is the canonical one.
  const client: WorkerClientHandle = createWorkerClient({
    url: opts.url,
    token: opts.token,
    initialBackoffMs: opts.initialBackoffMs,
    maxBackoffMs: opts.maxBackoffMs,
    signal: opts.signal,
  });

  const innerSend: (action: OutboundAction) => Promise<OutboundActionResult> = opts.onOutbound
    ?? ((action) => client.sendOutbound(action));

  // Acquire keepalive once at boot — keepalive holds a refcount across reconnects
  // so the SW doesn't get killed mid-reconnect-cycle. Release on teardown.
  acquireKeepAlive();

  let teardownDone = false;
  const inboundUnsub = client.onMessage((msg: InboundMessage) => {
    broadcastAll({ type: 'telegram_gateway_inbound', message: msg });
  });
  const statusUnsub = client.onStatus((s: ConnectionStatus) => {
    broadcastAll({ type: 'telegram_gateway_status', status: s });
  });

  const teardown = () => {
    if (teardownDone) return;
    teardownDone = true;
    inboundUnsub();
    statusUnsub();
    client.close();
    releaseKeepAlive();
  };

  return { client, teardown };
}
