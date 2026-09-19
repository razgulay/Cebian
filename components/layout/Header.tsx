import { Sun, Moon, SunMoon, Settings, SquarePen, PanelLeft, Eye, EyeOff, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { debugLog } from '@/lib/debug/log';
import { useTelegramGatewayStatus } from '@/hooks/useTelegramGatewayStatus';
import { cn } from '@/lib/utils';

interface HeaderProps {
  title?: string;
  /** 是否处于新会话路由（/chat/new）。新会话且无标题时，标题位回落显示品牌名。 */
  isNewChat?: boolean;
  theme: 'dark' | 'light' | 'system';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onOpenSidebar: () => void;
  /** Canvas pane 是否处于展开态 —— 决定 Eye/EyeOff 图标。 */
  canvasOpen: boolean;
  onToggleCanvas: () => void;
}

export function Header({
  title,
  isNewChat,
  theme,
  onToggleTheme,
  onOpenSettings,
  onNewChat,
  onOpenSidebar,
  canvasOpen,
  onToggleCanvas,
}: HeaderProps) {
  const telegramStatus = useTelegramGatewayStatus();
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
  const handleToggleCanvas = () => {
    debugLog.info('ui', 'header:canvas:toggle', { from: canvasOpen });
    onToggleCanvas();
  };

  return (
    <header className="flex flex-col bg-background/80 backdrop-blur-xl z-10">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={handleOpenSidebar}>
                <PanelLeft className="size-4.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('common.sidebar')}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" onClick={handleNewChat}>
                <SquarePen className="size-4.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('common.newChat')}</TooltipContent>
          </Tooltip>
        </div>

        <span className="flex-1 text-center text-sm font-medium truncate px-2">
          {title || (isNewChat ? 'Cebian' : '')}
        </span>

        <div className="flex gap-2">
          {/* Telegram Gateway badge — hidden when disconnected (noisy for users
              who never configured the gateway). Green = live, amber = connecting
              or reconnecting, gray = offline. */}
          {telegramStatus !== 'disconnected' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'flex items-center gap-1 px-1.5 rounded-md text-[10px] font-medium',
                    telegramStatus === 'connected' && 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40',
                    telegramStatus === 'connecting' && 'text-amber-600 bg-amber-50 dark:bg-amber-950/40',
                    telegramStatus === 'reconnecting' && 'text-amber-600 bg-amber-50 dark:bg-amber-950/40',
                  )}
                  aria-label={`Telegram ${telegramStatus}`}
                >
                  <Send className="size-3" />
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      telegramStatus === 'connected' && 'bg-emerald-500',
                      (telegramStatus === 'connecting' || telegramStatus === 'reconnecting') && 'bg-amber-500 animate-pulse',
                    )}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>Telegram {telegramStatus}</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={canvasOpen ? t('canvas.header.closeAria') : t('canvas.header.openAria')}
                onClick={handleToggleCanvas}
              >
                {canvasOpen ? <EyeOff className="size-4.5" /> : <Eye className="size-4.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{canvasOpen ? t('canvas.header.closeAria') : t('canvas.header.openAria')}</TooltipContent>
          </Tooltip>

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
