// Debug-log domain: bridge `debug_log_subscribe` / `debug_log_unsubscribe`
// to the in-process `subscribeLiveLog` so sidepanels can tail new entries
// in real time instead of polling IDB.
//
// We hold ONE live-log subscriber for the lifetime of the SW; that
// callback iterates a per-port subscription set and forwards each event.
// Per-port bookkeeping means we don't push log entries to ports that
// never asked for them (sidepanels without the dialog open stay quiet).

import type { ClientHandlerMap } from '../ipc/client-router';
import { post } from '../ipc/port-registry';
import { subscribeLiveLog, type DebugLogEntry } from '@/lib/debug/log';
import type { ServerMessage } from '@/lib/ipc/protocol';

const subscribedPorts = new Set<chrome.runtime.Port>();
let upstreamUnsub: (() => void) | null = null;

function ensureLiveBridge(): void {
  if (upstreamUnsub) return;
  // subscribeLiveLog runs in the BG context, which is also where the
  // console mirror pushes entries via `debugLog.*`. Sidepanels that
  // wrote log lines during their own turn will see them come back as
  // `debug_log_entry` — acceptable for the live view (it's a debug
  // surface, not a user-facing toast).
  upstreamUnsub = subscribeLiveLog((event) => {
    const msg: ServerMessage =
      event.kind === 'entry'
        ? { type: 'debug_log_entry', entry: event.entry as DebugLogEntry }
        : { type: 'debug_log_cleared' };
    for (const port of subscribedPorts) {
      try { post(port, msg); } catch { /* port closed mid-broadcast */ }
    }
  });
}

const debugLogClientHandlers: ClientHandlerMap = {
  debug_log_subscribe(port) {
    ensureLiveBridge();
    subscribedPorts.add(port);
  },
  debug_log_unsubscribe(port) {
    subscribedPorts.delete(port);
  },
};

export { debugLogClientHandlers, subscribedPorts };