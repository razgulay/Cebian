import React from 'react';
import ReactDOM from 'react-dom/client';
import { VfsExplorer } from './VfsExplorer.tsx';
import '@/assets/tailwind.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <VfsExplorer />
  </React.StrictMode>,
);
