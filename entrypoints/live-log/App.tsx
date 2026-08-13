import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Trash2, Filter, Download, Activity, Search, X, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLiveLog } from '@/hooks/useLiveLog';
import { downloadDebugLog } from '@/lib/debug/export';
import type { DebugLogEntry } from '@/lib/debug/log';
import { t } from '@/lib/i18n';
import { toast } from 'sonner';

const LEVEL_OPTIONS: Array<{ value: DebugLogEntry['level'] | 'all'; label: string }> = [
  { value: 'all', label: 'All Levels' },
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warn' },
  { value: 'info', label: 'Info' },
  { value: 'log', label: 'Log' },
  { value: 'debug', label: 'Debug' },
];

const LEVEL_CLASS: Record<DebugLogEntry['level'], string> = {
  error: 'text-red-400 bg-red-950/40 border-red-800/50',
  warn: 'text-amber-400 bg-amber-950/40 border-amber-800/50',
  info: 'text-sky-400 bg-sky-950/40 border-sky-800/50',
  log: 'text-zinc-300 bg-zinc-900/40 border-zinc-800/50',
  debug: 'text-zinc-500 bg-zinc-900/20 border-zinc-800/30',
};

const SOURCE_CLASS: Record<string, string> = {
  background: 'text-emerald-400 bg-emerald-950/30 border-emerald-800/40',
  sidepanel: 'text-violet-400 bg-violet-950/30 border-violet-800/40',
  hook: 'text-fuchsia-400 bg-fuchsia-950/30 border-fuchsia-800/40',
  agent: 'text-cyan-400 bg-cyan-950/30 border-cyan-800/40',
};

function colorClassFor(source: string): string {
  return SOURCE_CLASS[source] ?? 'text-zinc-400 bg-zinc-900/30 border-zinc-800/40';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export default function App() {
  const { entries, paused, setPaused, clearStore } = useLiveLog({ maxEntries: 2000, seedLimit: 500 });
  const [levelFilter, setLevelFilter] = useState<DebugLogEntry['level'] | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [exporting, setExporting] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((e) => {
      if (levelFilter !== 'all' && e.level !== levelFilter) return false;
      if (sourceFilter && e.source !== sourceFilter) return false;
      if (q) {
        const msgMatch = e.message.toLowerCase().includes(q);
        const dataMatch = e.data ? e.data.toLowerCase().includes(q) : false;
        const sourceMatch = e.source.toLowerCase().includes(q);
        if (!msgMatch && !dataMatch && !sourceMatch) return false;
      }
      return true;
    });
  }, [entries, levelFilter, sourceFilter, searchQuery]);

  useLayoutEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered, autoScroll, paused]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    const atBottom = distance < 20;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  };

  const knownSources = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.source);
    return Array.from(set).sort();
  }, [entries]);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const manifest = chrome.runtime.getManifest();
      await downloadDebugLog(manifest.version);
      toast.success('Exported debug log');
    } catch (err) {
      toast.error(`Export failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-zinc-100 font-sans select-none overflow-hidden">
      {/* Header Toolbar */}
      <header className="flex-none flex items-center justify-between gap-4 px-4 py-3 border-b border-zinc-800 bg-zinc-900/60 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <Terminal className="size-5 text-emerald-400" />
          <h1 className="text-sm font-semibold tracking-wide text-zinc-100">Cebian Live Debug Log</h1>
          <span className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-800/40">
            <span className={`size-1.5 rounded-full ${paused ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'}`} />
            {paused ? 'PAUSED' : 'LIVE'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused(!paused)}
            className="h-8 border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 gap-1.5"
          >
            {paused ? <Play className="size-3.5 text-emerald-400" /> : <Pause className="size-3.5 text-amber-400" />}
            <span>{paused ? t('settings.debugLog.live.resume') : t('settings.debugLog.live.pause')}</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exporting}
            className="h-8 border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 gap-1.5"
          >
            <Download className="size-3.5 text-sky-400" />
            <span>{t('settings.debugLog.export')}</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => void clearStore()}
            className="h-8 border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 gap-1.5 hover:text-red-400"
          >
            <Trash2 className="size-3.5" />
            <span>{t('settings.debugLog.clear')}</span>
          </Button>
        </div>
      </header>

      {/* Filters Bar */}
      <div className="flex-none flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-zinc-800/80 bg-zinc-900/30 text-xs">
        {/* Search input */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-zinc-500" />
          <input
            type="text"
            placeholder="Search logs or data..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-8 pr-7 bg-zinc-950 border border-zinc-800 rounded-md text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Level Selector */}
        <div className="flex items-center gap-1.5">
          <Filter className="size-3.5 text-zinc-500" />
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as DebugLogEntry['level'] | 'all')}
            className="h-8 bg-zinc-950 border border-zinc-800 rounded-md px-2 text-xs text-zinc-300 focus:outline-none focus:border-zinc-600"
          >
            {LEVEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Source Pills */}
        <div className="flex items-center gap-1">
          <span className="text-zinc-500 mr-1">Source:</span>
          {knownSources.map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(sourceFilter === s ? '' : s)}
              className={`h-7 px-2.5 rounded-md border text-xs font-mono transition-colors ${
                sourceFilter === s
                  ? 'border-zinc-500 bg-zinc-800 text-zinc-100 font-medium'
                  : 'border-zinc-800/80 bg-zinc-950/60 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Counter */}
        <div className="ml-auto flex items-center gap-2 text-zinc-500 font-mono">
          <span>{filtered.length} / {entries.length} entries</span>
          {!autoScroll && !paused && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }}
              className="px-2 py-0.5 rounded bg-sky-950/80 border border-sky-800/60 text-sky-300 text-[11px] hover:bg-sky-900"
            >
              ↓ Scroll to bottom
            </button>
          )}
        </div>
      </div>

      {/* Log Feed Table */}
      <main
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto font-mono text-[12px] leading-relaxed bg-zinc-950 p-2"
      >
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-2">
            <Activity className="size-8 text-zinc-700" />
            <p>{t('settings.debugLog.live.empty')}</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((e, idx) => (
              <div
                key={`${e.id ?? 'row'}-${e.timestamp}-${idx}`}
                className="flex items-start gap-2 px-2.5 py-1 rounded hover:bg-zinc-900/80 transition-colors group"
              >
                <span className="shrink-0 text-zinc-600 tabular-nums select-none w-20 text-[11px]">
                  {formatTime(e.timestamp)}
                </span>

                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider border select-none w-14 text-center ${
                    LEVEL_CLASS[e.level]
                  }`}
                >
                  {e.level}
                </span>

                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium border select-none w-24 truncate text-center ${colorClassFor(
                    e.source,
                  )}`}
                  title={e.source}
                >
                  {e.source}
                </span>

                <span className="flex-1 whitespace-pre-wrap break-all text-zinc-200 select-text">
                  {e.message}
                </span>

                {e.data && (
                  <span
                    className="shrink-0 max-w-xs truncate text-zinc-400 bg-zinc-900 border border-zinc-800/60 rounded px-1.5 py-0.5 text-[11px] select-text"
                    title={e.data}
                  >
                    {e.data}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
