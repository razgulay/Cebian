import { useEffect, useCallback } from 'react';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  chatFontSize,
  chatFontFamily,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CHAT_FONT_FAMILY,
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_STEP,
  type ChatFontSize,
  type ChatFontFamilyId,
} from '@/lib/persistence/storage';

/**
 * Map legacy discrete font-size keys (from earlier installs, before the
 * slider) to their px equivalent. Read by `useChatFontSize` so old storage
 * values still land on a sensible slider position without a one-shot
 * migration (which would race with other tabs).
 */
const LEGACY_FONT_SIZE_PX: Record<string, ChatFontSize> = {
  xs: 14,
  sm: 14.25,
  md: 14.5,
  lg: 14.75,
  xl: 15,
};

/** Clamp + round to the slider step (default 0.1 px). */
export function clampChatFontSize(value: number): ChatFontSize {
  if (!Number.isFinite(value)) return DEFAULT_CHAT_FONT_SIZE;
  const rounded = Math.round(value / CHAT_FONT_SIZE_STEP) * CHAT_FONT_SIZE_STEP;
  // Floating-point rounding can drift by 1 ulp; fix to the step granularity.
  const fixed = Math.round(rounded * 100) / 100;
  return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, fixed));
}

function normalizeStoredFontSize(value: unknown): ChatFontSize {
  if (typeof value === 'number') return clampChatFontSize(value);
  if (typeof value === 'string' && value in LEGACY_FONT_SIZE_PX) {
    return LEGACY_FONT_SIZE_PX[value];
  }
  return DEFAULT_CHAT_FONT_SIZE;
}

function pxToRem(px: number): string {
  return `${px / 16}rem`;
}

function isFontFamilyId(v: unknown): v is ChatFontFamilyId {
  return v === 'geist' || v === 'inter' || v === 'roboto' || v === 'system';
}

/** Slider bounds re-exported for the settings UI. */
export const FONT_SIZE_RANGE = {
  min: CHAT_FONT_SIZE_MIN,
  max: CHAT_FONT_SIZE_MAX,
  step: CHAT_FONT_SIZE_STEP,
} as const;

/**
 * useChatFontSize — reads the user's chat font-size + font-family
 * preferences and applies them to the document root:
 *
 *  - size      → CSS variable `--chat-font-size` (consumed by
 *                `text-[length:var(--chat-font-size)]`)
 *  - family    → `data-chat-font="<id>"` attribute (consumed by CSS
 *                selectors in `assets/tailwind.css` that swap `--font-sans`)
 *
 * The hook is render-side-effect only: it doesn't render UI itself.
 * `AppearanceSection` calls it for the same setters and the current
 * value.
 */
export function useChatFontSize(): {
  fontSize: ChatFontSize;
  setFontSize: (next: ChatFontSize) => Promise<void>;
  fontFamily: ChatFontFamilyId;
  setFontFamily: (next: ChatFontFamilyId) => Promise<void>;
} {
  const [storedSize, setStoredSize] = useStorageItem(chatFontSize, DEFAULT_CHAT_FONT_SIZE);
  const [storedFamily, setStoredFamily] = useStorageItem(chatFontFamily, DEFAULT_CHAT_FONT_FAMILY);

  // Apply on every render where the value could differ (first mount +
  // subsequent updates). WXT storage may hand us a legacy string for the
  // size or an unknown id for the family — normalize before applying.
  const normalizedSize = normalizeStoredFontSize(storedSize);
  const normalizedFamily = isFontFamilyId(storedFamily) ? storedFamily : DEFAULT_CHAT_FONT_FAMILY;

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--chat-font-size', pxToRem(normalizedSize));
    root.setAttribute('data-chat-font', normalizedFamily);
  }, [normalizedSize, normalizedFamily]);

  const setFontSize = useCallback(
    async (next: ChatFontSize) => {
      await setStoredSize(clampChatFontSize(next));
    },
    [setStoredSize],
  );

  const setFontFamily = useCallback(
    async (next: ChatFontFamilyId) => {
      if (!isFontFamilyId(next)) return;
      await setStoredFamily(next);
    },
    [setStoredFamily],
  );

  return {
    fontSize: normalizedSize,
    setFontSize,
    fontFamily: normalizedFamily,
    setFontFamily,
  };
}