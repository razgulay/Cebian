import { useEffect, useState } from 'react';
import { useStorageItem } from './useStorageItem';
import { themePreference } from '@/lib/persistence/storage';

/**
 * 解析存储里的主题偏好：
 * - 'dark' / 'light' → 原样返回。
 * - 'system' → 读取 OS 当前的 `prefers-color-scheme`，dark 优先。
 */
export function resolveTheme(pref: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 把解析后的主题写入 document root，Tailwind/全局 token 通过 data-theme 切换。 */
function applyTheme(resolved: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', resolved);
}

/**
 * 统一的主题挂载钩子，取代三个 entrypoint 各自手写的 useEffect 三件套。
 *
 * 行为契约（与原先各 entrypoint 的内联实现对齐，回归测试依据）：
 * 1. mount 时先 `await themePreference.getValue()`，再用 resolved 值 apply 一次；同步
 *    把 `themeReady` 置 true 后才允许子树渲染，避免出现「亮一下主题再切回」的闪烁。
 * 2. 后续偏好变更（用户在设置页改 / 跨窗口同步）触发的 `theme` 更新，会同步到 document。
 * 3. 当偏好为 'system' 时，订阅 OS `prefers-color-scheme` 变化；其它偏好下不订阅，避免浪费。
 *
 * 返回值是 `[theme, themeReady, setTheme]`：
 * - `theme` 是当前持久化偏好（含 'system'），与 `useIsDark` 共享同一份 storage item。
 * - `themeReady` 仅在首次挂载并解析过存储值后变 true；调用方可据此 gate 渲染。
 * - `setTheme` 透传自 `useStorageItem`，写完会通过 storage watch 触发现成订阅者。
 */
export function useApplyThemePreference(): readonly [
  'dark' | 'light' | 'system',
  boolean,
  (value: 'dark' | 'light' | 'system') => Promise<void>,
] {
  const [theme, setTheme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);

  // 首次挂载：从存储读出偏好并立即应用到 document，再放开渲染闸门。
  useEffect(() => {
    themePreference.getValue().then((val) => {
      applyTheme(resolveTheme(val ?? 'system'));
      setThemeReady(true);
    });
  }, []);

  // 后续偏好变更：仅在首次挂载完成后才生效，避免和首次挂载的 apply 重复覆盖。
  useEffect(() => {
    if (!themeReady) return;
    applyTheme(resolveTheme(theme));
  }, [theme, themeReady]);

  // system 模式下监听 OS 主题变化；其他模式无 listener，省去无谓订阅。
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  return [theme, themeReady, setTheme] as const;
}