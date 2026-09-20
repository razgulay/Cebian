import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { SectionNav } from './SectionNav';
import { lastSettingsSection } from '@/lib/persistence/storage';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { t } from '@/lib/i18n';

/** Breakpoints for the Settings hub layout (vertical master-detail). */
const COMPACT_MAX = 500;   // below: icon-only sidebar (56px), labels on hover
/** Above COMPACT_MAX we always use the vertical labels sidebar (≥500px). */

export type SettingsBreakpoint = 'compact' | 'wide';

function resolveBreakpoint(width: number | null): SettingsBreakpoint {
  if (width === null || width >= COMPACT_MAX) return 'wide';
  return 'compact';
}

interface SettingsLayoutProps {
  /** Absolute base path of the Settings hub (e.g. '/settings' in sidepanel). */
  basePath: string;
  /** Show the back button in the top bar (sidepanel only). */
  showBackButton?: boolean;
  /** Show the "open in new tab" button. True in sidepanel only. */
  showOpenInTab?: boolean;
  /** 返回回调；传入时由它决定退出设置后去哪（回到进设置前的聊天）。缺省退回 /chat/new。 */
  onBack?: () => void;
}

/**
 * SettingsLayout - shell for the Settings hub (vertical master-detail).
 *
 * - wide (≥500px): left labeled sidebar (180px wide, 3 grouped sections with
 *   colored icons + text labels) + Outlet on the right with its own
 *   overflow-y-auto.
 * - compact (<500px): left icon-only sidebar (56px wide, no group labels,
 *   tooltips on hover) + Outlet on the right. Same horizontal split, just
 *   narrower — avoids the horizontal-pills row entirely so the user never
 *   has to scroll the nav on a phone-portrait viewport.
 */
export function SettingsLayout({ basePath, showBackButton = false, showOpenInTab = false, onBack }: SettingsLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  const breakpoint = resolveBreakpoint(width);
  const forceIconsOnly = breakpoint === 'compact';

  // Persist current section (path segment after basePath) so reopening lands here.
  const relative = location.pathname.startsWith(basePath)
    ? location.pathname.slice(basePath.length).replace(/^\//, '')
    : '';
  const section = relative.split('/')[0];
  // Only persist the landing section when running inside the sidepanel
  // (showBackButton is our proxy for that). The tab page is deep-linkable via
  // hash and should not influence which section the sidepanel opens to next.
  useEffect(() => {
    if (section && showBackButton) lastSettingsSection.setValue(section);
  }, [section, showBackButton]);

  // 返回键一步退出设置：优先回到进设置前的聊天路由（onBack），缺省回新对话。
  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    navigate('/chat/new', { replace: true });
  }, [onBack, navigate]);

  // Open the current Settings path in the standalone tab page.
  const handleOpenInTab = useCallback(() => {
    const url = browser.runtime.getURL('/settings.html') + '#/' + relative;
    void browser.tabs.create({ url });
  }, [relative]);

  const outletCtx: SettingsOutletContext = { basePath, breakpoint };

  return (
    <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        {showBackButton && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleBack}
            aria-label={t('common.back')}
          >
            <ArrowLeft className="size-4.5" />
          </Button>
        )}
        <h1 className="font-semibold text-sm">{t('common.settings')}</h1>
        {showOpenInTab && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleOpenInTab}
            aria-label={t('common.openInNewTab')}
            title={t('common.openInNewTab')}
            className="ml-auto"
          >
            <ExternalLink className="size-4" />
          </Button>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        <SectionNav basePath={basePath} variant="labels" forceIconsOnly={forceIconsOnly} />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-y-auto">
          <Outlet context={outletCtx} />
        </div>
      </div>
    </div>
  );
}

/** Shared context passed from SettingsLayout to each section via <Outlet>. */
export interface SettingsOutletContext {
  /** Absolute base path of the Settings hub (e.g. '/settings'). */
  basePath: string;
  /** Resolved responsive breakpoint of the Settings container. */
  breakpoint: SettingsBreakpoint;
}
