import { Sun, Moon, SunMoon, Settings, SquarePen, History, GitFork } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
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
  /** Snapshot of the source conversation this chat was forked from. When set,
   *  renders a "Forked from: <title>" badge below the title with a 1-click
   *  back link to /chat/<sourceId>. Null/undefined hides the badge — used for
   *  brand-new chats and the original of any fork chain. */
  forkedFrom?: { sessionId: string; title: string } | null;
  theme: 'dark' | 'light' | 'system';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onOpenHistory: () => void;
  /** Fires when the user clicks the back-link inside the fork badge. App
   *  clears `chatForkedFrom` here BEFORE navigating to the source session
   *  so the badge disappears instantly (instead of lingering for the
   *  async `session_loaded` roundtrip to fire and set it to null). */
  onBackToOriginal?: (sourceSessionId: string) => void;
}

export function Header({ title, isNewChat, forkedFrom, theme, onToggleTheme, onOpenSettings, onNewChat, onOpenHistory, onBackToOriginal }: HeaderProps) {
  const navigate = useNavigate();
  // Display title for the badge — fall back to a localized "Untitled" hint if
  // the source snapshot had an empty title (pre-feature sessions, races where
  // source was deleted before snapshot).
  const sourceLabel = forkedFrom?.title || t('common.newChat');

  const handleNewChat = () => {
    debugLog.info('ui', 'header:new_chat');
    onNewChat();
  };
  const handleOpenHistory = () => {
    debugLog.info('ui', 'header:history:open');
    onOpenHistory();
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
              <Button variant="ghost" size="icon-xs" onClick={handleOpenHistory}>
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

      {forkedFrom && (
        <div className="flex items-center justify-center gap-1.5 pb-1.5 text-xs text-muted-foreground">
          <GitFork className="size-3 shrink-0" />
          <span className="shrink-0">{t('chat.fork.badgeLabel')}</span>
          {/* Use a native `title` attribute for the tooltip — wrapping the
              link in Radix `TooltipTrigger asChild` was silently swallowing
              the click event (mousedown preventDefault on the inner button)
              and the back link did nothing. title attr keeps the affordance
              without breaking the click. */}
          <button
            type="button"
            onClick={() => {
              if (onBackToOriginal) {
                onBackToOriginal(forkedFrom.sessionId);
              } else {
                navigate(`/chat/${forkedFrom.sessionId}`);
              }
            }}
            title={t('chat.fork.backTooltip')}
            className="font-medium text-foreground hover:underline truncate max-w-[40ch] cursor-pointer"
          >
            {sourceLabel}
          </button>
        </div>
      )}
    </header>
  );
}
