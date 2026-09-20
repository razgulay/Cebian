import { Fragment } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Key, MessageSquare, FileText, Blocks, Brain, Plug, Info,
  Database, MousePointerClick, Sparkles, Sliders, Type,
  CalendarClock, BellRing, Send, User, Bot, Palette, LayoutTemplate,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

interface SectionNavItem {
  path: string;
  /**
   * Resolves the label at render time so locale changes (and tree-shaking
   * of unused i18n keys) work correctly. Use a function instead of a key
   * string because `@wxt-dev/i18n`'s overloaded `t` collapses
   * `Parameters<typeof t>[0]` to `never`.
   */
  getLabel: () => string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind color class applied to the icon at rest; active state inherits
   *  the same color (the bg-accent + bold-text styling does the rest). */
  iconClassName?: string;
}

interface SectionNavGroup {
  /** 分组标题，只在宽屏竖排导航里显示；横排导航用分隔线代替。 */
  getLabel: () => string;
  items: SectionNavItem[];
}

/**
 * 设置页导航 — Vertical master-detail，按用户意图分三组 15 mục：
 * - **Core & AI** (5): 模型接进来 + 助手本体（providers / persona / instructions /
 *   prompts / appearance）
 * - **Agent Capabilities** (5): 助手能干什么（skills / memory / RAG / MCP /
 *   page interaction）
 * - **System & Automation** (5): 数据 / 自动化 / 外部集成 / 信息（scheduler /
 *   notifications / telegram / data / advanced）
 *
 * 颜色：每个 icon 自身带 color class（active 时同色加深），active row 加
 * `bg-accent` + 左缘 2px color stripe。≤500px viewport 切换为 icon-only 模式
 * （`useIconsOnly` prop），每个 row 只剩 icon + 颜色 stripe + tooltip on hover。
 */
const SETTINGS_SECTION_GROUPS: SectionNavGroup[] = [
  {
    getLabel: () => t('settings.nav.group.core'),
    items: [
      { path: 'providers', getLabel: () => t('settings.nav.providers'), icon: Key, iconClassName: 'text-amber-500' },
      { path: 'persona', getLabel: () => t('settings.nav.persona'), icon: User, iconClassName: 'text-purple-500' },
      { path: 'instructions', getLabel: () => t('settings.nav.instructions'), icon: MessageSquare, iconClassName: 'text-blue-500' },
      { path: 'prompts', getLabel: () => t('settings.nav.prompts'), icon: FileText, iconClassName: 'text-lime-500' },
      { path: 'appearance', getLabel: () => t('settings.nav.appearance'), icon: Palette, iconClassName: 'text-zinc-400' },
    ],
  },
  {
    getLabel: () => t('settings.nav.group.agent'),
    items: [
      { path: 'skills', getLabel: () => t('settings.nav.skills'), icon: Blocks, iconClassName: 'text-orange-500' },
      { path: 'memory', getLabel: () => t('settings.nav.memory'), icon: Brain, iconClassName: 'text-pink-500' },
      { path: 'rag', getLabel: () => t('settings.nav.rag'), icon: Database, iconClassName: 'text-emerald-500' },
      { path: 'mcp', getLabel: () => t('settings.nav.mcp'), icon: Plug, iconClassName: 'text-green-500' },
      { path: 'page-interaction', getLabel: () => t('settings.nav.pageInteraction'), icon: MousePointerClick, iconClassName: 'text-cyan-500' },
    ],
  },
  {
    getLabel: () => t('settings.nav.group.system'),
    items: [
      { path: 'scheduler', getLabel: () => t('settings.nav.scheduler'), icon: CalendarClock, iconClassName: 'text-rose-500' },
      { path: 'notifications', getLabel: () => t('settings.nav.notifications'), icon: BellRing, iconClassName: 'text-yellow-500' },
      { path: 'telegram-gateway', getLabel: () => t('settings.nav.telegramGateway'), icon: Send, iconClassName: 'text-sky-500' },
      { path: 'data', getLabel: () => t('settings.nav.backup'), icon: Database, iconClassName: 'text-indigo-500' },
      { path: 'advanced', getLabel: () => t('settings.nav.advanced'), icon: Sliders, iconClassName: 'text-slate-400' },
    ],
  },
];

/** 扁平的全部入口，供路由校验等不关心分组的调用方使用。 */
export const SETTINGS_SECTIONS: SectionNavItem[] = SETTINGS_SECTION_GROUPS.flatMap((g) => g.items);

interface SectionNavProps {
  /** Absolute base path of the Settings hub (e.g. '/settings' in sidepanel, '' in tab page). */
  basePath: string;
  /**
   * Visual variant:
   * - `'labels'` (default): vertical sidebar ~180-200px wide, icon + label per
   *   row, group headers visible.
   * - `'pills'`: compact horizontal — used on narrow widths to keep nav
   *   scrollable in one row.
   */
  variant?: 'labels' | 'pills';
  /** Force icon-only mode regardless of variant. Used by SettingsLayout on
   *  very narrow viewports (<500px) so the vertical sidebar collapses to a
   *  narrow icon column with tooltips. */
  forceIconsOnly?: boolean;
}

const horizontalItem = 'flex items-center gap-1.5 h-8 rounded-md text-[13px] transition-colors whitespace-nowrap';
const activeColors = (isActive: boolean) =>
  isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground';

/** 横排导航里组与组之间的竖线。 */
function GroupSeparator() {
  return <li role="separator" className="w-px h-4 bg-border mx-1.5 shrink-0" />;
}

/**
 * SectionNav — navigation for Settings sections.
 *
 * Layout (vertical / labels variant):
 * - 180px wide column, `overflow-y-auto` independent of content scroll.
 * - Three labelled groups with sticky-to-non-sticky headers.
 * - Each row: colored icon + label; active row = bg-accent + 2px left border
 *   in the icon's color + bold text.
 * - On forceIconsOnly (≤500px) the row collapses to icon-only with the active
 *   stripe as the only visual indicator; tooltip on hover shows the label.
 */
export function SectionNav({ basePath, variant = 'labels', forceIconsOnly = false }: SectionNavProps) {
  if (variant === 'pills') {
    return (
      <nav
        aria-label={t('settings.nav.aria')}
        className="shrink-0 border-b border-border px-2 py-1.5 overflow-x-auto"
      >
        <ul className="flex items-center gap-0.5">
          {SETTINGS_SECTION_GROUPS.map((group, gi) => (
            <Fragment key={gi}>
              {gi > 0 && <GroupSeparator />}
              {group.items.map(({ path, getLabel, icon: Icon }) => {
                const label = getLabel();
                return (
                  <li key={path}>
                    <NavLink
                      to={`${basePath}/${path}`}
                      replace
                      title={label}
                      aria-label={label}
                      className={({ isActive }) =>
                        cn(horizontalItem, 'px-2.5', activeColors(isActive))
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon className="size-4 shrink-0" />
                          <span className={isActive ? 'font-medium' : ''}>{label}</span>
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>
      </nav>
    );
  }

  // variant === 'labels': vertical master-detail sidebar.
  // forceIconsOnly: collapse each row to icon-only (≤500px viewports).
  return (
    <nav
      aria-label={t('settings.nav.aria')}
      className={cn(
        'shrink-0 border-r border-border py-2 overflow-y-auto',
        forceIconsOnly ? 'w-14' : 'w-50',
      )}
    >
      {SETTINGS_SECTION_GROUPS.map((group, gi) => {
        const headingId = `settings-nav-group-${gi}`;
        return (
          <div key={gi} className={cn('px-2', gi > 0 && 'pt-3')}>
            {!forceIconsOnly && (
              <div
                id={headingId}
                className="px-3 pb-1.5 text-[11px] text-muted-foreground font-medium tracking-wide uppercase"
              >
                {group.getLabel()}
              </div>
            )}
            <ul aria-labelledby={forceIconsOnly ? undefined : headingId} className="flex flex-col gap-0.5">
              {group.items.map(({ path, getLabel, icon: Icon, iconClassName }) => {
                const label = getLabel();
                return (
                  <li key={path}>
                    <NavLink
                      to={`${basePath}/${path}`}
                      replace
                      title={label}
                      aria-label={label}
                      className={({ isActive }) =>
                        cn(
                          'relative flex items-center rounded-md text-sm transition-colors',
                          forceIconsOnly
                            ? 'justify-center size-9 mx-auto'
                            : 'gap-2 px-3 py-2',
                          isActive
                            ? cn('bg-accent text-accent-foreground font-medium', iconClassName?.replace(/-\d+$/, '-700'))
                            : cn('text-muted-foreground hover:bg-accent/50 hover:text-foreground'),
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon className={cn('size-4 shrink-0', isActive ? '' : iconClassName)} />
                          {!forceIconsOnly && <span className="truncate">{label}</span>}
                          {/* Active left stripe: 2px wide color bar at the row's
                              leading edge — visual "selected" indicator that
                              survives in icon-only mode where labels are hidden. */}
                          {isActive && (
                            <span
                              aria-hidden
                              className={cn(
                                'absolute inset-y-1 left-0 w-0.5 rounded-r',
                                iconClassName?.replace(/text-/, 'bg-') ?? 'bg-foreground/40',
                              )}
                            />
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
