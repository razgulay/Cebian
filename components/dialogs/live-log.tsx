/**
 * LiveLogDialog — real-time debug log viewer.
 *
 * Opens a scrollable, color-coded view of recent log entries and streams
 * new ones as they happen. Auto-scrolls to the bottom unless the user
 * scrolls up to read history (then pauses auto-scroll until they scroll
 * back to the bottom).
 *
 * Backed by `useLiveLog` (subscribes to the BG's debug-log stream) and
 * `clearEntries` (wipes the persistent IDB store, which the BG broadcasts
 * so the dialog clears too).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Trash2, Filter, X, ExternalLink } from 'lucide-react';
import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useLiveLog } from '@/hooks/useLiveLog';
import type { DebugLogEntry } from '@/lib/debug/log';
import { t } from '@/lib/i18n';

const LEVEL_OPTIONS: Array<{ value: DebugLogEntry['level'] | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warn' },
  { value: 'info', label: 'Info' },
  { value: 'log', label: 'Log' },
  { value: 'debug', label: 'Debug' },
];

const LEVEL_CLASS: Record<DebugLogEntry['level'], string> = {
  error: 'text-red-500',
  warn: 'text-amber-500',
  info: 'text-sky-500',
  log: 'text-foreground/80',
  debug: 'text-muted-foreground/70',
};

const SOURCE_CLASS: Record<string, string> = {
  background: 'text-emerald-500',
  sidepanel: 'text-violet-500',
  hook: 'text-fuchsia-500',
  agent: 'text-cyan-500',
};

function colorClassFor(source: string): string {
  return SOURCE_CLASS[source] ?? 'text-muted-foreground';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

interface LiveLogDialogOptions {
  /** Optional cap on rows kept in memory. Defaults to 1000. */
  maxEntries?: number;
}

export function LiveLogDialog({ maxEntries = 1000 }: LiveLogDialogOptions = {}) {
  const { entries, paused, setPaused, clearStore } = useLiveLog({ maxEntries });
  const [levelFilter, setLevelFilter] = useState<DebugLogEntry['level'] | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // `autoScroll` flips off the moment the user scrolls up, and back on
  // when they hit the bottom again. We measure the gap between the
  // scroll position and the bottom on every scroll event.
  const [autoScroll, setAutoScroll] = useState(true);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (levelFilter !== 'all' && e.level !== levelFilter) return false;
      if (sourceFilter && !e.source.includes(sourceFilter)) return false;
      return true;
    });
  }, [entries, levelFilter, sourceFilter]);

  // Auto-scroll on new entries (or un-pause) unless the user has
  // scrolled away from the bottom. Doing this in useLayoutEffect so the
  // paint doesn't visibly jump after the new row mounts.
  useLayoutEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered, autoScroll, paused]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 16px slop accounts for sub-pixel scroll positions and the
    // horizontal scrollbar's contribution to scrollHeight.
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    const atBottom = distance < 16;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  };

  // Reset autoscroll + filters when the dialog first opens.
  useEffect(() => {
    setAutoScroll(true);
  }, []);

  // Distinct source list for the filter dropdown — derived from the
  // current buffer so we don't need a separate schema for it.
  const knownSources = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.source);
    return Array.from(set).sort();
  }, [entries]);

  return (
    <>
      <DialogHeader className="shrink-0 p-4 pb-3 border-b">
        <div className="flex items-center justify-between gap-2">
          <DialogTitle>{t('settings.debugLog.live.label')}</DialogTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void chrome.tabs.create({ url: browser.runtime.getURL('/live-log.html') });
              }}
              title="Open in new tab"
            >
              <ExternalLink className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPaused(!paused)}
              title={paused ? t('settings.debugLog.live.resume') : t('settings.debugLog.live.pause')}
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { void clearStore(); }}
              title={t('settings.debugLog.clear')}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
          <Filter className="size-3 text-muted-foreground" />
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as DebugLogEntry['level'] | 'all')}
            className="bg-background border border-border rounded px-1.5 py-0.5 text-xs"
          >
            {LEVEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {sourceFilter && (
            <span className="inline-flex items-center gap-1 bg-accent/40 rounded px-1.5 py-0.5">
              <span className={colorClassFor(sourceFilter)}>{sourceFilter}</span>
              <button
                onClick={() => setSourceFilter('')}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('settings.debugLog.live.close')}
              >
                <X className="size-3" />
              </button>
            </span>
          )}

          <div className="flex flex-wrap items-center gap-1">
            {knownSources.map((s) => (
              <button
                key={s}
                onClick={() => setSourceFilter(sourceFilter === s ? '' : s)}
                className={[
                  'rounded px-1.5 py-0.5 border',
                  sourceFilter === s
                    ? 'border-foreground/40 bg-accent/40'
                    : 'border-transparent hover:bg-accent/30',
                  colorClassFor(s),
                ].join(' ')}
              >
                {s}
              </button>
            ))}
          </div>

          <span className="ml-auto text-muted-foreground">
            {filtered.length} / {entries.length}
            {paused && ' · paused'}
            {!autoScroll && !paused && ' · scroll up to read'}
          </span>
        </div>
      </DialogHeader>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto font-mono text-[11px] leading-tight bg-zinc-950 text-zinc-100"
      >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-500 text-xs p-6">
            {t('settings.debugLog.live.empty')}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-900">
            {filtered.map((e, i) => (
              <li key={`${e.id ?? 't'}-${e.timestamp}-${i}`} className="px-3 py-1 flex gap-2 hover:bg-zinc-900/60">
                <span className="shrink-0 text-zinc-500 tabular-nums">{formatTime(e.timestamp)}</span>
                <span className={['shrink-0 w-12 uppercase', LEVEL_CLASS[e.level]].join(' ')}>{e.level}</span>
                <span className={['shrink-0 w-20 truncate', colorClassFor(e.source)].join(' ')} title={e.source}>
                  {e.source}
                </span>
                <span className="whitespace-pre-wrap break-words min-w-0 flex-1">{e.message}</span>
                {e.data && (
                  <span className="shrink-0 text-zinc-500 max-w-[40%] truncate" title={e.data}>
                    {e.data}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
