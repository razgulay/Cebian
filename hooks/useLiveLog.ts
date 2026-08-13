/**
 * useLiveLog — subscribe to the background's debug-log stream.
 *
 * The BG broadcasts every new `DebugLogEntry` (and a `cleared` signal) to
 * any port that sent `debug_log_subscribe`. This hook attaches to the
 * sidepanel's existing AGENT_PORT and surfaces them as a growing buffer.
 *
 * Behaviour notes:
 *  - Auto-unsubscribes on unmount so a closed dialog stops the stream.
 *  - Caps the in-memory buffer at `maxEntries` (default 1000) so a long
 *    session with verbose logging doesn't blow up React's render tree.
 *    Older entries are dropped from the head.
 *  - The buffer is append-only while subscribed; on `cleared` the
 *    consumer's tail is also wiped (in case the user clears from
 *    settings while the dialog is open).
 *  - Replays the last `seedLimit` entries (default 200) from IDB on
 *    mount so opening the dialog doesn't start from empty.
 *
 * Returns a stable `clearLocalBuffer()` for the consumer's "clear" button
 * — it just wipes the in-memory tail; the BG's store is cleared via
 * `clearStore()`.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { readRecentEntries, clearEntries, type DebugLogEntry } from '@/lib/debug/log';
import { CLIENT_PORT, type ClientMessage, type ServerMessage } from '@/lib/ipc/protocol';

export interface UseLiveLogOptions {
  /** Cap on the in-memory tail. Older entries are dropped from the head. */
  maxEntries?: number;
  /** Number of recent entries to replay from IDB on mount. */
  seedLimit?: number;
}

export interface UseLiveLogResult {
  entries: DebugLogEntry[];
  paused: boolean;
  setPaused: (paused: boolean) => void;
  clearLocalBuffer: () => void;
  clearStore: () => Promise<void>;
}

export function useLiveLog(options: UseLiveLogOptions = {}): UseLiveLogResult {
  const { maxEntries = 1000, seedLimit = 200 } = options;
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  // Keep `paused` readable from the message handler without re-binding
  // the effect on every toggle.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const clearLocalBuffer = useCallback(() => setEntries([]), []);

  const clearStore = useCallback(async () => {
    await clearEntries();
    // The BG will also fire `debug_log_cleared` which wipes us too, but
    // doing it locally gives instant feedback (avoids a one-tick gap).
    setEntries([]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let port: chrome.runtime.Port | null = null;
    let detachHandler: (() => void) | null = null;

    const commit = (next: DebugLogEntry[]) => {
      if (cancelled) return;
      setEntries(next.length > maxEntries ? next.slice(next.length - maxEntries) : next);
    };

    void (async () => {
      // Seed from IDB so the dialog isn't empty when first opened.
      try {
        const seed = await readRecentEntries(seedLimit);
        if (cancelled) return;
        commit(seed);
      } catch {
        if (!cancelled) commit([]);
      }

      if (cancelled) return;

      try {
        port = chrome.runtime.connect({ name: CLIENT_PORT });
      } catch {
        // Port connect can throw in test / detached contexts. The seed
        // still shows, but no live updates will arrive.
        return;
      }
      if (cancelled) {
        try { port.disconnect(); } catch { /* already gone */ }
        return;
      }

      const handler = (msg: ServerMessage) => {
        if (msg.type === 'debug_log_entry') {
          if (pausedRef.current) return;
          setEntries((prev) => {
            const next = [...prev, msg.entry];
            return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
          });
        } else if (msg.type === 'debug_log_cleared') {
          commit([]);
        }
      };
      port.onMessage.addListener(handler);

      const send = (msg: ClientMessage) => {
        try { port!.postMessage(msg); } catch { /* port closed */ }
      };

      // hello so the BG treats us like any other sidepanel (also keeps
      // the recorder's owner-port guards happy if a recorder message
      // races in).
      send({ type: 'hello', instanceId: `live-log-${Date.now()}` });
      send({ type: 'debug_log_subscribe' });

      detachHandler = () => {
        try { send({ type: 'debug_log_unsubscribe' }); } catch { /* port may be gone */ }
        try { port?.disconnect(); } catch { /* already disconnected */ }
      };
    })();

    return () => {
      cancelled = true;
      detachHandler?.();
    };
  }, [maxEntries, seedLimit]);

  return { entries, paused, setPaused, clearLocalBuffer, clearStore };
}
