import { HashRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ConfirmOutlet } from '@/components/dialogs/confirm-outlet';
import { SettingsRoutes } from '@/entrypoints/sidepanel/pages/settings';
import { useApplyThemePreference, resolveTheme } from '@/hooks/useApplyThemePreference';

/**
 * Standalone Settings tab page.
 *
 * Hosts the full Settings hub at `/settings.html#/<section>[/<file>]`.
 * Uses HashRouter so deep-links like `#/skills/foo/SKILL.md` survive
 * navigation and can be opened from the sidepanel's "open in new tab" button.
 */
export default function App() {
  const [theme, themeReady] = useApplyThemePreference();

  if (!themeReady) return null;

  // 设置页里的保存失败等提示走 sonner；独立标签页也要有出口，不然只在侧边栏看得到。
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen bg-background text-foreground">
        <HashRouter>
          <SettingsRoutes basePath="" />
        </HashRouter>
        <Toaster theme={resolveTheme(theme)} />
        <ConfirmOutlet />
      </div>
    </TooltipProvider>
  );
}
