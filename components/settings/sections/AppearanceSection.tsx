/**
 * AppearanceSection — chat appearance settings.
 *
 * Exposes:
 *  - Chat font size: continuous slider 14–15 px (step 0.1), default 14.
 *  - Chat font family: 4 common sans-serifs (Geist, Inter, Roboto, System).
 *
 * Both values are persisted via `chatFontSize` / `chatFontFamily` and
 * applied to the document root by `useChatFontSize` (CSS variable
 * `--chat-font-size` + `data-chat-font="<id>"` attribute). The preview line
 * below the controls reflects both settings live.
 */
import { Type } from 'lucide-react';
import { useChatFontSize, FONT_SIZE_RANGE, clampChatFontSize } from '@/hooks/useChatFontSize';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { ChatFontFamilyId } from '@/lib/persistence/storage';

const FONT_FAMILY_OPTIONS: ReadonlyArray<{
  id: ChatFontFamilyId;
  /** i18n key resolved at render time. */
  labelKey: string;
  /** Per-option font-family stack so the radio label previews the look. */
  stack: string;
}> = [
  { id: 'geist', labelKey: 'settings.appearance.fontFamily.geist', stack: "'Geist', system-ui, sans-serif" },
  { id: 'inter', labelKey: 'settings.appearance.fontFamily.inter', stack: "'Inter', system-ui, sans-serif" },
  { id: 'roboto', labelKey: 'settings.appearance.fontFamily.roboto', stack: "'Roboto', system-ui, sans-serif" },
  { id: 'system', labelKey: 'settings.appearance.fontFamily.system', stack: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif' },
];

export function AppearanceSection() {
  const { fontSize, setFontSize, fontFamily, setFontFamily } = useChatFontSize();

  // Stack used by the preview line — same cascade as the document root for
  // the currently selected family.
  const previewStack = FONT_FAMILY_OPTIONS.find((o) => o.id === fontFamily)?.stack
    ?? FONT_FAMILY_OPTIONS[0].stack;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.appearance.title')}</h2>

      {/* ─── Font size ─── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Type className="size-3.5 text-muted-foreground" />
            <h3 className="text-sm font-medium">{t('settings.appearance.fontSize.label')}</h3>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground font-mono">
            {fontSize.toFixed(1)} px
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('settings.appearance.fontSize.hint')}
        </p>
        <div className="pt-2 px-1">
          <input
            type="range"
            min={FONT_SIZE_RANGE.min}
            max={FONT_SIZE_RANGE.max}
            step={FONT_SIZE_RANGE.step}
            value={fontSize}
            onChange={(e) => void setFontSize(clampChatFontSize(parseFloat(e.currentTarget.value)))}
            aria-label={t('settings.appearance.fontSize.label')}
            className={cn(
              'w-full h-2 rounded-full appearance-none cursor-pointer',
              'bg-muted',
              // WebKit thumb
              '[&::-webkit-slider-thumb]:appearance-none',
              '[&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4',
              '[&::-webkit-slider-thumb]:rounded-full',
              '[&::-webkit-slider-thumb]:bg-primary',
              '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background',
              '[&::-webkit-slider-thumb]:shadow-sm',
              '[&::-webkit-slider-thumb]:transition-transform',
              '[&::-webkit-slider-thumb]:hover:scale-110',
              // Firefox thumb
              '[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4',
              '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-primary',
              '[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background',
            )}
          />
          <div className="flex justify-between text-[0.65rem] text-muted-foreground/70 font-mono tabular-nums pt-1">
            <span>{FONT_SIZE_RANGE.min.toFixed(1)}</span>
            <span>{((FONT_SIZE_RANGE.min + FONT_SIZE_RANGE.max) / 2).toFixed(1)}</span>
            <span>{FONT_SIZE_RANGE.max.toFixed(1)}</span>
          </div>
        </div>
        <p
          className="text-xs text-muted-foreground pt-2 leading-relaxed"
          style={{ fontSize: `var(--chat-font-size)`, fontFamily: previewStack }}
        >
          {t('settings.appearance.fontSize.preview')}
        </p>
      </div>

      {/* ─── Font family ─── */}
      <div className="space-y-2 pt-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{t('settings.appearance.fontFamily.label')}</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('settings.appearance.fontFamily.hint')}
        </p>
        <div className="grid grid-cols-2 gap-2 pt-2">
          {FONT_FAMILY_OPTIONS.map((opt) => {
            const isActive = fontFamily === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => void setFontFamily(opt.id)}
                aria-pressed={isActive}
                className={cn(
                  'flex flex-col items-start gap-1 h-auto py-2.5 px-3 rounded-md border transition-colors text-left',
                  isActive
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border bg-background hover:bg-accent/40 text-muted-foreground',
                )}
              >
                <span
                  className="text-base font-medium leading-none"
                  style={{ fontFamily: opt.stack }}
                >
                  Aa
                </span>
                <span className="text-xs font-medium">{t(opt.labelKey as never)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}