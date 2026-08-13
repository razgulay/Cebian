import { HashRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfirmOutlet } from '@/components/dialogs/confirm-outlet';
import { SettingsRoutes } from '@/entrypoints/sidepanel/pages/settings';
import { useApplyThemePreference } from '@/hooks/useApplyThemePreference';

/**
 * Standalone Settings tab page.
 *
 * Hosts the full Settings hub at `/settings.html#/<section>[/<file>]`.
 * Uses HashRouter so deep-links like `#/skills/foo/SKILL.md` survive
 * navigation and can be opened from the sidepanel's "open in new tab" button.
 */
export default function App() {
  const [, themeReady] = useApplyThemePreference();

  if (!themeReady) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen bg-background text-foreground">
        <HashRouter>
          <SettingsRoutes basePath="" />
        </HashRouter>
        <ConfirmOutlet />
      </div>
    </TooltipProvider>
  );
}
