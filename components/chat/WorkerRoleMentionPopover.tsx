// WorkerRoleMentionPopover —— `@` 在 textarea 触发时浮现的 worker 角色选择器。
//
// 设计要点：
//   - 焦点保持在 textarea 上——自定义 listbox（不用 Radix Popover 的 focus
//     trap，行为适合 inline 候选）。ArrowUp/Down/Enter/Esc 由父组件在 textarea
//     的 onKeyDown 中拦截（preventDefault），不在 popover 内偷焦点。
//   - 列表渲染位置由父组件的 anchor（textarea 的 ref）通过 fixed 定位算
//     `bottom + height + 4px`，浮动在 textarea 正上方，避免遮住用户的 @ 输入。
//   - 角色 + hint 全部由父组件解析后传入（caption = 仓库的角色 i18n 名，
//     hint = workerTeamRoster.role.<role> 单一事实源），本组件只做展示 + 选中事件。

import { useEffect, useRef, useState } from 'react';
import { UserSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { WorkerRole } from '@/lib/persistence/storage';

export interface WorkerRoleOption {
  /** 角色 id（'content_writer' 等）。 */
  role: WorkerRole;
  /** 显示名（已 i18n 解析，如 "Content Writer"）。 */
  label: string;
  /** 简短提示（已 i18n 解析），可空。 */
  hint?: string;
}

export interface WorkerRoleMentionPopoverProps {
  /** 当前光标是否在 @-token 上——true 时渲染 popover，否则 null。 */
  open: boolean;
  /** 过滤 + 排序后的可选列表。 */
  options: WorkerRoleOption[];
  /** 当前键盘焦点项的索引。 */
  activeIndex: number;
  /** popover 浮动的锚点（textarea 的 ref）；用于 fixed 定位。 */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** 选中事件——父组件据此插入 @<role> + 加 chip。 */
  onSelect: (role: WorkerRole) => void;
  /** Esc 按下关闭 popover（父组件的 onKeyDown 也已处理，这里兜底）。 */
  onClose: () => void;
}

export function WorkerRoleMentionPopover({
  open,
  options,
  activeIndex,
  anchorRef,
  onSelect,
  onClose,
}: WorkerRoleMentionPopoverProps) {
  // 计算定位（popover 高度也参与——用 ref 测量后调整避免被底部裁切）。
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const a = anchor.getBoundingClientRect();
    const p = popover.getBoundingClientRect();
    const margin = 6;
    // 默认浮在 textarea 正上方——若空间不够（光标靠近页面顶），翻转到下方。
    const wouldOverflowTop = a.top - p.height - margin < 0;
    const bottom = wouldOverflowTop
      ? Math.round(window.innerHeight - a.bottom + margin)
      : Math.round(window.innerHeight - a.top + margin);
    let left = Math.round(a.left);
    // 右边界保护：若 popover 宽度超出 viewport 右沿，左移到底边
    const overflowRight = left + p.width - (window.innerWidth - 8);
    if (overflowRight > 0) left = Math.max(8, left - overflowRight);
    setPos({ bottom, left });
  }, [open, anchorRef, options.length]);

  if (!open) return null;

  return (
    <div
      ref={popoverRef}
      role="listbox"
      data-worker-role-popover="root"
      aria-label={t('chat.composer.workerRoleMention.popoverTitle')}
      style={pos ? { bottom: pos.bottom, left: pos.left } : { visibility: 'hidden', bottom: 0, left: 0 }}
      className={cn(
        'fixed z-50 min-w-[16rem] max-w-[20rem] rounded-md border border-border bg-popover shadow-md',
        'py-1 text-xs text-popover-foreground',
      )}
      onMouseDown={(e) => {
        // 防止 textarea 失焦——父组件保持光标在 textarea
        e.preventDefault();
      }}
    >
      {options.length === 0 ? (
        <div className="px-3 py-2 text-muted-foreground italic">{t('chat.composer.workerRoleMention.noMatches')}</div>
      ) : (
        options.map((opt, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={opt.role}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => onSelect(opt.role)}
              className={cn(
                'w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors',
                active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
              )}
            >
              <UserSquare
                className={cn(
                  'size-3.5 mt-0.5 shrink-0',
                  active ? 'text-accent-foreground' : 'text-indigo-400',
                )}
              />
              <span className="flex flex-col min-w-0">
                <span className="font-mono">@{opt.role}</span>
                {opt.hint && (
                  <span className="text-[0.65rem] text-muted-foreground truncate">{opt.hint}</span>
                )}
              </span>
            </button>
          );
        })
      )}
      <div className="border-t border-border/60 px-2 py-1 text-[0.6rem] text-muted-foreground flex justify-between">
        <span>↑↓ {t('chat.composer.workerRoleMention.nav')}</span>
        <span>⏎ {t('chat.composer.workerRoleMention.select')}</span>
        <span>Esc {t('chat.composer.workerRoleMention.closeHint')}</span>
        <button
          type="button"
          onClick={onClose}
          className="underline-offset-2 hover:underline"
          aria-label={t('chat.composer.workerRoleMention.close')}
        >
          {t('chat.composer.workerRoleMention.close')}
        </button>
      </div>
    </div>
  );
}
