import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import '@/assets/tailwind.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Dev-only UI feedback picker: Alt+hover to outline, Alt+click to copy a
// formatted prompt with selector + HTML + React component + source location.
// Tree-shaken from production builds by the `if (DEV)` guard.
if (import.meta.env.DEV) {
  void import('@/lib/devtools/picker').then(({ installDevPicker }) => installDevPicker());
}
