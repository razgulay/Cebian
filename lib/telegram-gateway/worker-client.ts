// lib/telegram-gateway/worker-client.ts — browser-native WS client for the
// Cebian Telegram Gateway. Zero runtime deps: only `globalThis.WebSocket`.
//
// Lifecycle:
//   1. `connecting`  — opening socket to `<workerUrl>?token=<authToken>`
//   2. `connected`   — `open` event fires; flush queued outbound messages
//   3. `reconnecting` — `close` / `error` fires; exponential backoff 1s→30s, retry
//   4. `disconnected` — `close()` called or `signal.aborted`
//
// Outbound during outage: messages queued in memory and flushed on reconnect
// (no persistence — v1 keeps the client stateless; if the BG SW is killed mid-
// outage the queue is lost). For the scheduler use case (BG already runs every
// minute with `acquireKeepalive`) the queue depth is small and short-lived.
//
// Injectable `WebSocketCtor` for tests — production code passes `globalThis.WebSocket`.

import type {
  AgentStateFrame,
  ConnectionStatus,
  InboundMessage,
  OutboundAction,
  OutboundActionResult,
  TelegramCallback,
} from './types';

export interface WorkerClientOptions {
  /** Worker URL — token is appended as `?token=<authToken>` query param. */
  url: string;
  token: string;
  /** First reconnect delay in ms. Default 1000. */
  initialBackoffMs?: number;
  /** Max reconnect delay in ms. Default 30000 (cap). */
  maxBackoffMs?: number;
  /** AbortSignal to stop the reconnect loop. */
  signal?: AbortSignal;
  /** Override WebSocket constructor for tests. Default `globalThis.WebSocket`. */
  WebSocketCtor?: new (url: string, protocols?: string | string[]) => WebSocket;
}

export interface WorkerClientHandle {
  /** Subscribe to inbound messages. Returns unsubscribe. */
  onMessage(cb: (msg: InboundMessage) => void): () => void;
  /** Subscribe to inbound inline-keyboard callbacks（`/tabs` 命令生成的
   *  keyboard 按钮点击）。Gateway 在转发本 frame 前已 answerCallbackQuery
   *  —— extension 不得再次 answer（Telegram 对同一 callback_query_id 只
   *  允许一次 answer）；所有反馈走 editMessage。 */
  onTelegramCallback(cb: (msg: TelegramCallback) => void): () => void;
  /** Subscribe to connection-status transitions. Returns unsubscribe. */
  onStatus(cb: (status: ConnectionStatus) => void): () => void;
  /** Send an action to the Worker. Resolves with the matched
   *  `OutboundActionResult` (or rejects on `close()` / `signal.abort` if the
   *  WS was already gone). */
  sendOutbound(action: OutboundAction): Promise<OutboundActionResult>;
  /** One-way telemetry（`agent_state`）：fire-and-forget，**无 ack**。WS 未 OPEN
   *  时静默丢弃——排队旧状态跨重连重放会乱序，下一个 transition 自然带来新状态。
   *  不要用 `sendOutbound` 发送本 frame：gateway 永不 reply，pendingAcks 会
   *  永久 pending。 */
  sendState(frame: AgentStateFrame): void;
  /** Stop reconnect + close any open socket. Idempotent. */
  close(): void;
  /** Sync read of current status (cheap). */
  getStatus(): ConnectionStatus;
}

/** Numeric readyState constants — mirrors the standard WebSocket constants
 *  (OPEN = 1, CLOSED = 3) without relying on the enum which TS sometimes
 *  narrows to the wrong type when the value comes from a mock socket. */
const WS_OPEN = 1;
const WS_CLOSED = 3;

export function createWorkerClient(opts: WorkerClientOptions): WorkerClientHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctor = (opts.WebSocketCtor ?? (globalThis as any).WebSocket) as new (
    url: string,
    protocols?: string | string[],
  ) => WebSocket;
  const initialBackoff = opts.initialBackoffMs ?? 1_000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;

  let ws: WebSocket | null = null;
  let status: ConnectionStatus = 'connecting';
  let closed = false;
  let currentBackoff = initialBackoff;
  let lastPongAt = Date.now();
  /** Per-WS lifecycle token — incremented every (re)open. Stale callbacks from a
   *  previous attempt that arrive after a reconnect must be ignored (avoid stale
   *  listeners firing on the wrong instance). */
  let attemptToken = 0;

  const messageListeners = new Set<(msg: InboundMessage) => void>();
  const telegramCallbackListeners = new Set<(msg: TelegramCallback) => void>();
  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  /** request_id → resolver/rejecter for outstanding outbound. */
  const pendingAcks = new Map<string, { resolve: (r: OutboundActionResult) => void; reject: (e: Error) => void }>();
  /** Outbound queue — messages sent while WS is not OPEN. Flushed on `open`. */
  const outboundQueue: OutboundAction[] = [];

  function emitStatus(s: ConnectionStatus): void {
    if (s === status) return;
    status = s;
    for (const cb of statusListeners) {
      try { cb(s); } catch { /* ignore listener errors */ }
    }
  }

  function flushQueue(): void {
    if (!ws || ws.readyState !== WS_OPEN) return;
    while (outboundQueue.length > 0) {
      const msg = outboundQueue.shift()!;
      try { ws.send(JSON.stringify(msg)); } catch { /* connection died mid-flush */ }
    }
  }

  /** Schedule the next reconnect after `delay` ms. No-op if already closed
   *  or aborted. Uses `setTimeout` to avoid blocking the event loop. */
  function scheduleReconnect(delay: number): void {
    if (closed || opts.signal?.aborted) return;
    setTimeout(() => {
      if (closed || opts.signal?.aborted) return;
      attemptToken++;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closed || opts.signal?.aborted) return;
    const myToken = attemptToken;
    emitStatus(status === 'connected' ? 'reconnecting' : 'connecting');

    // 协议兜底：用户在 Settings 经常把 Worker URL 填成 https://（HTTP URL 形态），
    // 但 `new WebSocket('https://...')` 会抛 SyntaxError——下面的 try/catch 会吃掉，
    // 表面看是「连不上」但完全不知道原因。这里主动把 http(s):// 提升成 ws(s)://，
    // 并在控制台打一行 warn 提示让用户能感知。
    let baseUrl = opts.url.trim();
    const promoted = baseUrl
      .replace(/^http:\/\//i, 'ws://')
      .replace(/^https:\/\//i, 'wss://');
    if (promoted !== baseUrl) {
      console.warn(
        `[telegram-gateway] Worker URL used http(s):// scheme; auto-promoted to ${promoted} for WebSocket connection. ` +
        `Use wss:// (or ws://) in Settings to avoid this message.`,
      );
      baseUrl = promoted;
    }
    if (!/^wss?:\/\//i.test(baseUrl)) {
      console.error(
        '[telegram-gateway] Worker URL must start with ws:// or wss://; got:',
        baseUrl,
      );
      // 不合法的 URL 重试也没用——长退避后再试，留给用户改完 Settings 再 Save。
      scheduleReconnect(Math.max(maxBackoff, currentBackoff));
      return;
    }

    const fullUrl = `${baseUrl}?token=${encodeURIComponent(opts.token)}`;
    let sock: WebSocket;
    try {
      sock = new ctor(fullUrl);
    } catch {
      // ctor threw synchronously (rare — invalid URL etc.) — schedule retry
      scheduleReconnect(currentBackoff);
      return;
    }
    ws = sock;
    sock.addEventListener('open', () => {
      if (myToken !== attemptToken) return; // stale callback from prior attempt
      currentBackoff = initialBackoff; // reset on successful connect
      emitStatus('connected');
      flushQueue();
      // 应用层 heartbeat：每 15 秒发 {kind:'ping'} — gateway 回 {kind:'pong'}。
      // **双向** heartbeat 解决 TCP half-open 问题：之前是 1- chiều（extension
      // 发 space，gateway 不 respond）→ gateway→extension 方向死了 extension
      // 也不知道。现在 track lastPongAt —— >45s（3 个心跳间隔）没 pong 就
      // 判定连接死亡 → force close + reconnect。15s 间隔也是为了 MV3 SW
      // idle timeout（~30s）之前反复唤醒 SW。
      lastPongAt = Date.now();
      const ping = setInterval(() => {
        if (myToken !== attemptToken || !ws || ws.readyState !== WS_OPEN) {
          clearInterval(ping);
          return;
        }
        try {
          ws.send(JSON.stringify({ kind: 'ping', ts: Date.now() }));
        } catch {
          /* socket died mid-tick — close handler will clean up */
          return;
        }
        // 半开检测：send 成功不保证 gateway 真的收到。pong 超时 → 强制断线重连。
        if (Date.now() - lastPongAt > 45_000) {
          console.warn('[telegram-gateway] heartbeat: no pong for >45s — forcing reconnect');
          try { ws.close(); } catch { /* ignore */ }
          clearInterval(ping);
        }
      }, 15_000);
      sock.addEventListener('close', () => clearInterval(ping), { once: true });
      sock.addEventListener('error', () => clearInterval(ping), { once: true });
    });
    sock.addEventListener('message', (ev: MessageEvent) => {
      if (myToken !== attemptToken) return; // stale
      let data: unknown;
      try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (!data || typeof data !== 'object') return;
      const m = data as { kind?: string } & Record<string, unknown>;
      if (m.kind === 'pong') {
        lastPongAt = Date.now();
        return;
      }
      if (m.kind === 'telegram_message') {
        for (const cb of messageListeners) {
          try { cb(m as unknown as InboundMessage); } catch { /* ignore */ }
        }
      } else if (m.kind === 'telegram_callback') {
        // /tabs 诊断：log frame 入口 + reply-correlate，方便在 `chrome://extensions`
        // → Service Worker → Console 看 capture flow 死在哪一步。
        try {
          console.log('[worker-client] telegram_callback received', {
            cb_id: (m as { callback_query_id?: string }).callback_query_id,
            data: (m as { data?: string }).data,
          });
        } catch { /* ignore logging errors */ }
        for (const cb of telegramCallbackListeners) {
          try { cb(m as unknown as TelegramCallback); } catch { /* ignore */ }
        }
      } else if (m.kind === 'sendMessage_result' || m.kind === 'gateway_result') {
        const pending = pendingAcks.get(m.request_id as string);
        if (pending) {
          pendingAcks.delete(m.request_id as string);
          pending.resolve(m as unknown as OutboundActionResult);
        }
      }
    });
    const onEnd = () => {
      if (myToken !== attemptToken) return; // stale
      // Idempotency guard: 'close' and 'error' often fire together (WebSocket
      // spec); onEnd may be invoked twice for the same attempt. Check
      // `ws === null` to skip the second invocation's side-effects (already
      // nulled by the first call's `ws = null`).
      const wasOpen = ws !== null;
      ws = null;
      if (closed || opts.signal?.aborted) {
        emitStatus('disconnected');
        return;
      }
      if (!wasOpen) return; // already handled by first onEnd call
      emitStatus('reconnecting');
      const delay = currentBackoff;
      currentBackoff = Math.min(currentBackoff * 2, maxBackoff);
      scheduleReconnect(delay);
    };
    sock.addEventListener('close', onEnd);
    sock.addEventListener('error', onEnd);
  }

  function sendOutbound(action: OutboundAction): Promise<OutboundActionResult> {
    return new Promise<OutboundActionResult>((resolve, reject) => {
      if (closed) {
        reject(new Error('client closed'));
        return;
      }
      pendingAcks.set(action.request_id, { resolve, reject });
      if (ws && ws.readyState === WS_OPEN) {
        try {
          ws.send(JSON.stringify(action));
        } catch {
          // connection died between readyState check and send — queue it
          outboundQueue.push(action);
        }
      } else {
        outboundQueue.push(action);
      }
    });
  }

  // Kick off the connection loop.
  connect();

  if (opts.signal) {
    const onAbort = () => {
      closed = true;
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
      // Reject any in-flight acks so callers don't hang.
      for (const [, pending] of pendingAcks) {
        pending.reject(new Error('aborted'));
      }
      pendingAcks.clear();
      emitStatus('disconnected');
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    onMessage(cb) {
      messageListeners.add(cb);
      return () => { messageListeners.delete(cb); };
    },
    onTelegramCallback(cb) {
      telegramCallbackListeners.add(cb);
      return () => { telegramCallbackListeners.delete(cb); };
    },
    onStatus(cb) {
      statusListeners.add(cb);
      return () => { statusListeners.delete(cb); };
    },
    sendOutbound,
    sendState(frame) {
      // 未连接 → 丢弃（见接口注释）
      if (!ws || ws.readyState !== WS_OPEN) return;
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        /* socket died mid-send — close handler will clean up */
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
      for (const [, pending] of pendingAcks) {
        pending.reject(new Error('closed'));
      }
      pendingAcks.clear();
      emitStatus('disconnected');
    },
    getStatus: () => status,
  };
}
