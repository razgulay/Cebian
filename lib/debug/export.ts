/**
 * Export the persistent debug log as a downloadable JSON file.
 *
 * Filename is timestamped so multiple exports from the same session
 * don't clobber each other. JSON shape is intentionally flat — a single
 * array of entries plus a tiny metadata header so consumers (human or
 * LLM) don't have to navigate a tree to find the events.
 */
import { readAllEntries, type DebugLogEntry } from './log';

export interface DebugLogExport {
  /** ISO timestamp when the export was generated. */
  exportedAt: string;
  /** Cebian extension version at export time. */
  version: string;
  /** Number of entries in the export (after any truncation). */
  count: number;
  /** Truncated tail — older entries dropped if over the cap. */
  entries: DebugLogEntry[];
}

const FILENAME_PREFIX = 'cebian-debug-';

/** Build a `Blob` containing the full debug log as JSON. Pure (no
 *  download side effect) so callers can either trigger a download or
 *  inspect the payload. */
export async function buildDebugLogExport(version: string): Promise<DebugLogExport> {
  const entries = await readAllEntries();
  return {
    exportedAt: new Date().toISOString(),
    version,
    count: entries.length,
    entries,
  };
}

/** Build the export and trigger a browser download via a temporary
 *  `<a download>` link. Service workers don't have DOM access, so this
 *  must be called from the sidepanel / options page. */
export async function downloadDebugLog(version: string): Promise<void> {
  const payload = await buildDebugLogExport(version);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${FILENAME_PREFIX}${formatTimestamp(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the click so the download has a chance to start —
  // modern browsers keep the blob alive until the download begins.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}