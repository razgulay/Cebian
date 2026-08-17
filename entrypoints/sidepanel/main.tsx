import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import App from './App.tsx';
import '@/assets/tailwind.css';

// Register all interactive tool UI components (side-effect)
import '@/components/chat/ui-registrations';
import { installConsoleMirror, debugLog } from '@/lib/debug/log';
import { bootstrapDebugLogSettings } from '@/lib/debug/log';

// Mirror every console.* call from the sidepanel (React render, hook
// effects, IPC handling) into the persistent IndexedDB log so users can
// "Export debug log" from settings without opening DevTools.
installConsoleMirror('sidepanel');

// One-shot: log the moment the sidepanel mounts. Helpful as the
// first entry in an exported log — if a user reports "nothing
// happens when I click the extension", the absence of this line
// confirms the SW didn't even reach the sidepanel mount.
debugLog.info('ui', 'sidepanel:mount');

// Pull debug-log settings so the verbose-filter is in effect before the
// first render fires any console calls. watch() re-syncs on toggle change.
// Deferred via setTimeout(0) so the call lands AFTER the rest of the
// module-init chain settles — in particular, after wxt's storage
// runtime is fully wired in the real extension. (The `wxt prepare`
// typegen worker evaluates this entrypoint in a sandbox where
// `browser.runtime` is incomplete, and an immediate call would
// produce a fatal unhandled rejection; deferring it lets the
// worker complete typegen without ever invoking the storage shim.)
if (typeof setTimeout === 'function') {
  setTimeout(() => {
    bootstrapDebugLogSettings().catch(() => {});
  }, 0);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={['/chat/new']}>
      <App />
    </MemoryRouter>
  </React.StrictMode>,
);

// MV3 forensic: log when the sidepanel window unloads. Counterpart to the
// `sidepanel:mount` line above so an exported log shows a paired mount/
// unmount lifecycle per open window. If a session write was in flight when
// the window closed, the gap between `mount` and `unmount` in the log
// tells you how long the user had the panel open.
window.addEventListener('beforeunload', () => {
  debugLog.info('ui', 'sidepanel:unmount');
});

// Dev-only UI feedback picker: Alt+hover to outline, Alt+click to copy a
// formatted prompt with selector + HTML + React component + source location.
// Tree-shaken from production builds by the `if (DEV)` guard.
if (import.meta.env.DEV) {
  void import('@/lib/devtools/picker').then(({ installDevPicker }) => installDevPicker());
}
