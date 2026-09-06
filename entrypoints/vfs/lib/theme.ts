// Theme glue for the VFS entrypoint. Kept local to this entrypoint —
// settings/sidepanel have their own more elaborate versions (with the
// `useIsDark` hook etc.), and pulling them into a single shared source
// is its own refactor.

export function resolveTheme(pref: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(resolved: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', resolved);
}
