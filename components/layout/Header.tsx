import { Sun, Moon, SunMoon, Settings, SquarePen, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { debugLog } from '@/lib/debug/log';

interface HeaderProps {
  title?: string;
  /** 是否处于新会话路由（/chat/new）。新会话且无标题时，标题位回落显示品牌名。 */
  isNewChat?: boolean;
  theme: 'dark' | 'light' | 'system';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onOpenSidebar: () => void;
}

export function Header({ title, isNewChat, theme, onToggleTheme, onOpenSettings, onNewChat, onOpenSidebar }: HeaderProps) {
  const handleNewChat = () => {
    debugLog.info('ui', 'header:new_chat');
    onNewChat();
  };
  const handleOpenSidebar = () => {
    debugLog.info('ui', 'header:sidebar:open');
    onOpenSidebar();
  };
  const handleToggleTheme = () => {
    debugLog.info('ui', 'header:theme:toggle', { from: theme });
    onToggleTheme();
  };
  const handleOpenSettings = () => {
    debugLog.info('ui', 'header:settings:open');
    onOpenSettings();
  };

  return (
    <header className="flex flex-col bg-background/80 backdrop-blur-xl z-10">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={handleNewChat}>
                <SquarePen className="size-4.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('common.newChat')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={handleOpenSidebar}>
                <History className="size-4.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('common.history')}</TooltipContent>
          </Tooltip>
        </div>

        <span className="flex-1 text-center text-sm font-medium truncate px-2">
          {title || (isNewChat ? 'Cebian' : '')}
        </span>

        <div className="flex gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleToggleTheme}
              >
                {theme === 'system' ? <SunMoon className="size-4.5" /> : theme === 'dark' ? <Moon className="size-4.5" /> : <Sun className="size-4.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('common.toggleTheme')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleOpenSettings}
              >
                <Settings className="size-4.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('common.settings')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
