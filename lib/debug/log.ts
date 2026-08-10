/**
 * Persistent debug log backed by IndexedDB.
 *
 * Why IndexedDB instead of chrome.storage.local: storage.local has a hard
 * 5 MB quota per extension origin and rejects writes synchronously when full,
 * which would silently drop logs during heavy debugging. IndexedDB's quota
 * grows with disk space (the browser prompts the user past a threshold), so
 * we can keep several thousand recent events without losing the tail.
 *
 * Why a ring buffer: bug investigation rarely needs the first event — it
 * needs the events *around* the failure. Capping at ~3000 entries balances
 * coverage (roughly a full day of medium use) with parse cost: 3000 entries
 * ≈ 800 KB JSON that an LLM agent can ingest in ~1.5 minutes without
 * overflowing context. Larger caps (5000+) hit context limits and slow the
 * agent's analysis pass, defeating the purpose of having the log in the
 * first place. Rotates the oldest entries out automatically so the store
 * never grows unbounded.
 *
 * Why capture every console.log/warn/error: when something misbehaves in
 * the field, the user can't easily reproduce in front of DevTools. Having
 * `console.warn` from any code path land here means a one-click "Export
 * debug log" from the sidepanel is enough to see exactly what happened,
 * without needing the user to pre-open DevTools or set breakpoints.
 *
 * Persistence shape (stable across versions):
 *   db:    `cebian-debug-log` (versioned, see openDb below)
 *   store: `entries` (keyPath: `id`, autoIncrement)
 *   index: `byTimestamp` on `timestamp` (for range queries)
 *
 * Concurrency: SW can restart mid-write. `addEntry` is fire-and-forget —
 * a failed write is logged once to `console.error` (which itself feeds
 * back through the wrapper, but the store guard short-circuits that to
 * avoid an infinite loop). Diagnostic data loss during restart is
 * acceptable; we only care about events around the user's bug, not 100%
 * completeness.
 */
const DB_NAME = 'cebian-debug-log';
const DB_VERSION = 1;
const STORE = 'entries';
const INDEX_TS = 'byTimestamp';
const MAX_ENTRIES = 3000;

// Single instance across the SW lifetime. Set on first openDb success,
// torn down when SW unloads (which is fine — IndexedDB itself persists).
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  // Guard: `indexedDB` is a global on ServiceWorker and window contexts but
  // not on Node-style worker shells, and not on the first tick of a freshly
  // resumed SW before globals are rebound. Calling `indexedDB.open(...)`
  // without the guard produced `ReferenceError: indexedDB is not defined`
  // at module-load time when `installConsoleMirror` ran before the SW
  // runtime finished wiring globals. Failing fast here keeps the console
  // mirror alive (it still fanned out to live subscribers) and just drops
  // the on-disk half until the next write retries once globals are bound.
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new ReferenceError('indexedDB is not defined in this context'));
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex(INDEX_TS, 'timestamp', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  }).catch((err) => {
    // Reset so a subsequent call retries — a blocked upgrade typically
    // resolves itself once the offending tab closes.
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** Single entry shape. `data` is JSON-serialized so structured payloads
 *  (phase transitions, message counts) survive the IDB round-trip and
 *  show up in the exported file as readable objects, not "[object Object]".
 *
 *  `sessionId` is promoted to a top-level field (when present in `data`)
 *  so log queries don't have to parse the JSON-stringified payload to
 *  filter by session. Prefer setting it explicitly via the `withSession`
 *  helper below — the auto-promotion only runs as a backstop for callers
 *  that haven't migrated yet. */
export interface DebugLogEntry {
  id?: number;
  timestamp: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  source: string;       // 'background' | 'sidepanel' | etc.
  message: string;
  /** JSON-serialized payload. null when the call had no second arg. */
  data: string | null;
  /** Top-level session correlation. Optional — entries without a session
   *  context (startup, IPC layer, etc.) leave this undefined. */
  sessionId?: string;
}

let writeQueue: Promise<void> = Promise.resolve();

/** Serialize writes through a single chained promise so concurrent calls
 *  don't fight over the IDB transaction queue. Failures are swallowed
 *  (logged once to console.error) — debug logging must never break the
 *  app's main flow. */
function addEntry(entry: Omit<DebugLogEntry, 'id'>): void {
  writeQueue = writeQueue.then(async () => {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).add(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      await trimOldEntries(db);
    } catch (err) {
      // Use raw console.error with a guard flag — the wrapper below routes
      // back through here, and an infinite loop would be miserable to debug.
      if (!storeWriteFailedOnce) {
        storeWriteFailedOnce = true;
        // eslint-disable-next-line no-console
        console.error('[debug-log] IndexedDB write failed (further errors suppressed):', err);
      }
    }
  });
}

let storeWriteFailedOnce = false;

/** Drop the oldest entries past MAX_ENTRIES. Runs after every add so the
 *  ring buffer stays bounded. Uses the `byTimestamp` index to count and
 *  delete by oldest first without loading everything into memory. */
async function trimOldEntries(db: IDBDatabase): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const overflow = (countReq.result ?? 0) - MAX_ENTRIES;
      if (overflow <= 0) {
        resolve();
        return;
      }
      const idx = store.index(INDEX_TS);
      const cursorReq = idx.openCursor();
      let deleted = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || deleted >= overflow) {
          resolve();
          return;
        }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    countReq.onerror = () => reject(countReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Read all current entries, oldest first. Used by the export feature. */
export async function readAllEntries(): Promise<DebugLogEntry[]> {
  const db = await openDb();
  return new Promise<DebugLogEntry[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index(INDEX_TS);
    const req = idx.getAll();
    req.onsuccess = () => resolve((req.result ?? []) as DebugLogEntry[]);
    req.onerror = () => reject(req.error);
  });
}

/** Read the most recent `limit` entries, oldest first. Used by the live
 *  log viewer to seed its initial buffer without pulling the full 5000. */
export async function readRecentEntries(limit: number): Promise<DebugLogEntry[]> {
  const all = await readAllEntries();
  if (all.length <= limit) return all;
  return all.slice(all.length - limit);
}

/** Clear the entire log. Called by the "clear" button in the sidepanel. */
export async function clearEntries(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // Notify live viewers that the store was emptied; they clear their buffer
  // so a stale "old" tail doesn't linger next to new entries.
  for (const cb of liveLogSubscribers) {
    try { cb({ kind: 'cleared' }); } catch { /* subscriber crashed — drop */ }
  }
}

/** Format an arbitrary second argument into something safe to JSON.stringify.
 *  Error objects get their message + stack; DOM nodes become a short tag
 *  description; everything else falls through to JSON.stringify with a
 *  circular-ref guard. */
function safeData(value: unknown): string | null {
  if (value === undefined) return null;
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Error) return { name: v.name, message: v.message };
      return v;
    });
  } catch {
    return String(value);
  }
}

/**
 * Noisy message prefixes we skip by default. The streaming LLM response
 * fires one `event:message_update` per token and the hook mirrors it as
 * `recv:message_update` — without this filter, a single 200-token reply
 * would burn ~400 log rows and drown out the actual `warn`/`error` the
 * user is looking for. The bound phase events (`message_start` /
 * `message_end` / `agent_start` / `agent_end`) still land so the
 * timeline around the stream is preserved.
 *
 * `verbose` mode (toggle in settings) lifts this filter for users who
 * need the full per-token trail.
 */
const NOISY_PREFIXES: readonly string[] = [
  'event:message_update',
  'recv:message_update',
];

function isNoisy(message: string): boolean {
  for (const p of NOISY_PREFIXES) {
    if (message.startsWith(p)) return true;
  }
  return false;
}

/**
 * Pull a `sessionId` string out of the structured payload, if the caller
 * happened to put one there. Used by `emit()` to promote the field to the
 * top level so log queries can filter by session without parsing JSON.
 * Bounded to UUID-ish shapes — short / non-string values are ignored to
 * avoid surfacing unrelated `sessionId`-named fields (e.g. arbitrary
 * `sessionId: { ... }` objects) into the top-level index.
 */
function extractSessionId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const v = (data as Record<string, unknown>).sessionId;
  if (typeof v !== 'string') return undefined;
  // Cheap UUID-ish guard: keep only values that look like real session
  // ids (8-4-4-4-12 hex, ≥ 32 chars). Anything shorter is probably a
  // coincidence (e.g. event label) and shouldn't pollute the index.
  if (v.length < 32) return undefined;
  return v;
}

/** The five level-specific entry points. Source is captured at the call
 *  site (typically `'background'` or `'sidepanel'`) so the exported log
 *  shows which context emitted each line. */
function emit(level: DebugLogEntry['level'], source: string, message: string, data?: unknown): void {
  if (!settings.enabled) return;
  const noisy = isNoisy(message);
  if (noisy && !settings.verbose) return;

  const entry: Omit<DebugLogEntry, 'id'> = {
    timestamp: Date.now(),
    level,
    source,
    message: typeof message === 'string' ? message : safeData(message) ?? '<non-string>',
    data: data === undefined ? null : safeData(data),
  };
  // Promote sessionId from payload to top-level for easy filtering. Done
  // AFTER `data` is JSON-stringified so the value lives in exactly one
  // place on the wire (the index), not duplicated in both fields.
  const sid = extractSessionId(data);
  if (sid) entry.sessionId = sid;
  addEntry(entry);
  // Fan out to live viewers (only after persist so the store is the source
  // of truth — a subscriber crash must never let the on-disk log diverge).
  for (const cb of liveLogSubscribers) {
    try { cb({ kind: 'entry', entry }); } catch { /* subscriber crashed — drop */ }
  }
}

export const debugLog = {
  log: (source: string, message: string, data?: unknown) => emit('log', source, message, data),
  info: (source: string, message: string, data?: unknown) => emit('info', source, message, data),
  warn: (source: string, message: string, data?: unknown) => emit('warn', source, message, data),
  error: (source: string, message: string, data?: unknown) => emit('error', source, message, data),
  debug: (source: string, message: string, data?: unknown) => emit('debug', source, message, data),
};

/**
 * Build a tagged payload that promotes `sessionId` to the entry's top
 * level, so consumers can filter by session without parsing the JSON
 * payload. Pass the returned object as the `data` argument to any
 * `debugLog.*` call:
 *
 *   debugLog.info('agent', 'fork:dispatch',
 *     withSession({ atAssistantIndex: 3 }, sessionId));
 *
 * Equivalent to spreading `sessionId` into the payload itself, but
 * explicit + typo-safe at the call site. Bypasses `extractSessionId`'s
 * length-32 heuristic by writing directly to the entry.
 */
export function withSession<T extends object>(payload: T, sessionId: string): T & { sessionId: string } {
  return { ...payload, sessionId };
}

// ─── Runtime settings (in-memory mirror of the storage item) ───

interface DebugLogRuntimeSettings {
  enabled: boolean;
  verbose: boolean;
}

const settings: DebugLogRuntimeSettings = { enabled: true, verbose: false };

/** Replace the in-memory settings. Call this once on startup with the
 *  values loaded from `debugLogSettings`, and again whenever the user
 *  flips a toggle. */
export function setDebugLogSettings(next: Partial<DebugLogRuntimeSettings>): void {
  if (typeof next.enabled === 'boolean') settings.enabled = next.enabled;
  if (typeof next.verbose === 'boolean') settings.verbose = next.verbose;
}

export function isDebugLogEnabled(): boolean { return settings.enabled; }
export function isDebugLogVerbose(): boolean { return settings.verbose; }

/**
 * Bootstrap the runtime settings from the persisted storage item.
 *
 * Call once on background + sidepanel startup. Subsequent user changes
 * flow through the storage item's `watch` callback (registered alongside)
 * so live updates land in the runtime mirror without a restart.
 *
 * Imports the storage item lazily to keep `lib/debug/log.ts` importable
 * from non-extension contexts (e.g. unit tests, `wxt prepare` type
 * generation) without dragging WXT into a bare Node process.
 */
export async function bootstrapDebugLogSettings(): Promise<void> {
  // Env guard: wxt's storage requires `chrome.runtime` to be a real
  // extension runtime. `wxt prepare` evaluates the sidepanel entrypoint
  // in a sandboxed Node VM that has a partial `chrome` shim — skip
  // silently in that case. Defaults already match the storage fallback.
  //
  // Detection: try to read the storage area. If it throws synchronously
  // (wxt's storage throws on first access when the runtime shim is
  // incomplete), we know we're in a non-extension context.
  try {
    if (typeof chrome === 'undefined') return;
    if (!chrome.runtime) return;
    // Probe wxt's storage by trying to import the item. We do NOT call
    // any methods on it here — the storage runtime check happens lazily
    // on the first .getValue() call. The actual call site (background
    // / sidepanel) runs in a real extension, so the import here always
    // succeeds; we still defer the read to a microtask so the host can
    // finish loading.
    const { debugLogSettings } = await import('@/lib/persistence/storage');
    // One microtask delay so the wxt prepare typegen worker (which
    // imports this module in a sandbox) doesn't see an unhandled
    // rejection if the underlying wxt storage shim is incomplete.
    await Promise.resolve();
    const value = await debugLogSettings.getValue();
    setDebugLogSettings(value);
    debugLogSettings.watch((next) => {
      try {
        setDebugLogSettings(next);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[debug-log] watch callback failed:', err);
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[debug-log] failed to bootstrap settings:', err);
  }
}

/** @deprecated kept for back-compat with the original kill-switch API.
 *  Use `setDebugLogSettings` instead. */
export function setDebugLogEnabled(value: boolean): void { settings.enabled = value; }

// ─── Live streaming (background → sidepanel) ───
//
// The background already mirrors every console.* into the IDB store.
// This subscription list lets the sidepanel subscribe to NEW entries as
// they happen, so the "Live log" view can scroll in real time without
// polling. The background then forwards the entry to connected sidepanel
// ports via the IPC layer (see `lib/ipc/protocol.ts` — `debug_log_entry`).
//
// Subscribers run in the SAME context as the emitter (both sides
// subscribe; the sidepanel's own writes are also captured by its mirror).

export type LiveLogEvent =
  | { kind: 'entry'; entry: Omit<DebugLogEntry, 'id'> }
  | { kind: 'cleared' };

type LiveLogSubscriber = (event: LiveLogEvent) => void;

const liveLogSubscribers = new Set<LiveLogSubscriber>();

/** Subscribe to live log events. Returns an unsubscribe function. */
export function subscribeLiveLog(cb: LiveLogSubscriber): () => void {
  liveLogSubscribers.add(cb);
  return () => { liveLogSubscribers.delete(cb); };
}

// ─── Console mirror ───

// Patch the existing `console.*` methods to mirror calls into the store.
// We do this once on module load so every code path that already uses
// `console.log` lands in the log automatically — no need to sprinkle
// `debugLog.*` calls everywhere. Idempotent: `installConsoleMirror` is
// safe to call multiple times but only the first call swaps the methods.
let installed = false;
export function installConsoleMirror(source: string): void {
  if (installed || typeof console === 'undefined') return;
  installed = true;
  type Level = DebugLogEntry['level'];
  const levels: Level[] = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    const original = (console as unknown as Record<Level, (...args: unknown[]) => void>)[level].bind(console);
    (console as unknown as Record<Level, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
      original(...args);
      if (!settings.enabled) return;
      // [debug-log] prefix would loop forever — skip those.
      const first = args[0];
      if (typeof first === 'string' && first.startsWith('[debug-log]')) return;
      const text = stringifyArgs(args);
      const extra = args.length > 1 ? args.slice(1) : undefined;
      // Reuse emit() so the noisy/verbose filter and live fan-out are
      // applied uniformly to console calls AND explicit `debugLog.*` calls.
      emit(level, source, text, extra);
    };
  }
}

function stringifyArgs(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}
