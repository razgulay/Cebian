// Telegram gateway channel — BG-internal pub/sub bridge.
//
// Mirror pattern of `lib/scheduler/sidepanel-channel.ts` (scheduler publish)
// and `lib/canvas/sidepanel-channel.ts` (canvas publish) — but instead of
// Port-based delivery (BG → sidepanel), this channel bridges via a `worker-client`
// instance owned by BG (D3 bootstrap) and consumed by UI hook (D4 chat sync).
//
// Why no Port: Telegram inbound is a *pull* model via WS, not BG-initiated
// push. The BG publishes inbound messages into the channel after the worker-client
// fires its `onMessage` callback; the channel fans them out to subscribers
// (UI hook + any future test).

import type {
  ConnectionStatus,
  InboundMessage,
  OutboundAction,
  OutboundResult,
} from './types';

/** BG-side setter — the worker-client instance (from D2 `createWorkerClient`)
 *  must be injected here so outbound calls route through it. Null when not
 *  connected. */
type OutboundSender = (action: OutboundAction) => Promise<OutboundResult>;

export interface TelegramGatewayChannel {
  /** BG-side: hand the channel the worker-client's sendOutbound function so
   *  `sendOutbound()` here can route through it. Pass `null` on disconnect. */
  setOutboundSender(sender: OutboundSender | null): void;
  /** BG-side: feed an inbound message received from worker-client into the
   *  channel — fans out to all subscribers. No-op when there are no subscribers
   *  (BG doesn't care). */
  publishInbound(msg: InboundMessage): void;
  /** BG-side: publish a connection-status change (Connecting / Connected / etc.). */
  publishStatus(status: ConnectionStatus): void;
  /** UI-side: subscribe to inbound messages. Returns unsubscribe. */
  subscribeInbound(fn: (msg: InboundMessage) => void): () => void;
  /** UI-side: subscribe to status changes. Returns unsubscribe. */
  subscribeStatus(fn: (status: ConnectionStatus) => void): () => void;
  /** UI-side: send an action back through the worker-client (which proxies to
   *  Telegram via Worker). Resolves with the Worker reply or rejects if not
   *  connected. */
  sendOutbound(action: OutboundAction): Promise<OutboundResult>;
  /** UI-side: sync read of current status. */
  getStatus(): ConnectionStatus;
  /** UI-side: whether an outbound sender is currently registered (i.e. WS up). */
  isConnected(): boolean;
}

export const telegramGatewayChannel: TelegramGatewayChannel = (() => {
  let outboundSender: OutboundSender | null = null;
  let status: ConnectionStatus = 'disconnected';
  const inboundListeners = new Set<(m: InboundMessage) => void>();
  const statusListeners = new Set<(s: ConnectionStatus) => void>();

  function emitStatus(s: ConnectionStatus): void {
    if (s === status) return;
    status = s;
    for (const cb of statusListeners) {
      try { cb(s); } catch { /* ignore listener errors */ }
    }
  }

  return {
    setOutboundSender(sender) {
      outboundSender = sender;
      // Re-emit current status so the UI sees the truth on connect/disconnect.
      if (sender) emitStatus('connected');
      else emitStatus('disconnected');
    },
    publishInbound(msg) {
      for (const cb of inboundListeners) {
        try { cb(msg); } catch { /* ignore */ }
      }
    },
    publishStatus(s) {
      emitStatus(s);
    },
    subscribeInbound(cb) {
      inboundListeners.add(cb);
      return () => { inboundListeners.delete(cb); };
    },
    subscribeStatus(cb) {
      statusListeners.add(cb);
      return () => { statusListeners.delete(cb); };
    },
    async sendOutbound(action) {
      if (!outboundSender) {
        throw new Error('telegram gateway not connected');
      }
      return outboundSender(action);
    },
    getStatus() {
      return status;
    },
    isConnected() {
      return outboundSender !== null;
    },
  };
})();
