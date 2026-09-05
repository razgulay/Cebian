import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AccordionItem, AccordionContent, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import type { MCPServerConfig } from '@/lib/persistence/storage';
import { setMCPServerEnabled, removeMCPServer } from '@/lib/mcp/store';
import { type MCPStatusInfo } from '@/hooks/useMCPStatus';
import { MCPServerEditForm } from './MCPServerForm';
import { cn } from '@/lib/utils';
import { showConfirm } from '@/lib/ui/dialog';
import { t } from '@/lib/i18n';

interface MCPServerRowProps {
  server: MCPServerConfig;
  statusMap: Record<string, MCPStatusInfo>;
}

interface StatusDotMeta {
  className: string;
  label: string;
}

function getStatusDot(server: MCPServerConfig, info: MCPStatusInfo | undefined): StatusDotMeta {
  if (!server.enabled) {
    return { className: 'bg-muted-foreground/30', label: t('settings.mcp.status.disabled') };
  }
  if (!info) {
    return { className: 'bg-sky-500', label: t('settings.mcp.status.idle') };
  }
  if (info.breaker === 'OPEN') {
    return { className: 'bg-red-500', label: t('settings.mcp.status.circuitOpen') };
  }
  if (info.breaker === 'HALF_OPEN') {
    return { className: 'bg-amber-500', label: t('settings.mcp.status.probing') };
  }
  if (info.connected) {
    return { className: 'bg-emerald-500', label: t('settings.mcp.status.connected') };
  }
  return { className: 'bg-sky-500/60', label: t('settings.mcp.status.disconnected') };
}

/**
 * MCPServerRow — 单条 MCP 服务器的紧凑行，与 Worker team 一行式布局保持一致。
 *
 * - 折叠态：状态点 + 名称 + 右侧展开箭头（一行）。
 * - 展开态：传输协议 pill、URL、Auth、Status 三行文本 + 底部 Disable/Edit/Delete 操作按钮。
 *
 * 拖拽：父级 MCPServerSortableList 在 Accordion 外层包 DndContext + SortableContext，整行
 * 本身就是 drag handle（无需独立 grip）。PointerSensor 5px 阈值让普通点击仍然走展开按钮，
 * 仅在按住并位移时才触发拖拽。键盘拖拽由 dnd-kit 的 KeyboardSensor + sortableKeyboardCoordinates
 * 提供，Tab 进入行后按 Space 拾起，方向键移动，再 Space 落下。
 *
 * 编辑态：editing 为 true 时返回 MCPServerEditForm，外层仍保留 setNodeRef / attributes，让
 * SortableContext.items 在编辑期间保持有效。
 */
export function MCPServerRow({ server, statusMap }: MCPServerRowProps) {
  const [editing, setEditing] = useState(false);
  const dot = getStatusDot(server, statusMap[server.id]);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: server.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleToggle = async () => {
    try {
      await setMCPServerEnabled(server.id, !server.enabled);
    } catch (err) {
      console.error('[mcp] failed to toggle server:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    const ok = await showConfirm({
      title: t('settings.mcp.actions.deleteConfirmTitle'),
      description: t('settings.mcp.actions.deleteConfirmDescription', [server.name]),
      destructive: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await removeMCPServer(server.id);
    } catch (err) {
      console.error('[mcp] failed to remove server:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (editing) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        // Wrapper hosts interactive form buttons; override dnd-kit's button role
        // to avoid screen readers announcing a button-inside-button.
        role="group"
        className={cn(isDragging && 'opacity-50')}
      >
        <MCPServerEditForm server={server} onDone={() => setEditing(false)} />
      </div>
    );
  }

  const transportKey = server.transport.type === 'sse' ? 'sse' : 'streamableHttp';

  return (
    <AccordionItem value={server.id} className="border-0">
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        // Wrapper contains an AccordionTrigger <button>; override dnd-kit's
        // role="button" so screen readers do not announce a button-inside-button.
        role="group"
        className={cn(
          'flex items-center gap-2 min-w-0 text-xs py-1.5',
          isDragging && 'opacity-50',
          !server.enabled && 'opacity-60',
        )}
      >
        <span
          role="img"
          className={cn('size-2 rounded-full shrink-0', dot.className)}
          title={dot.label}
          aria-label={dot.label}
        />
        <span className="flex-1 min-w-0 text-foreground/80 truncate">{server.name}</span>
        <AccordionTrigger
          aria-label={t('settings.mcp.row.aria', [server.name])}
          className="py-0 px-1 flex-none gap-0 hover:no-underline [&>svg]:size-3.5"
        />
      </div>

      <AccordionContent className="pb-2">
        <div className="rounded-md bg-muted/30 p-2 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="rounded bg-background border border-border px-1.5 py-0.5 font-mono text-[0.7rem]">
              {t(`settings.mcp.row.transportType.${transportKey}`)}
            </span>
            <span className="font-mono text-muted-foreground text-[0.7rem] truncate min-w-0 flex-1">
              {server.transport.url}
            </span>
          </div>

          <div className="text-muted-foreground">
            <span className="text-foreground/70">{t('settings.mcp.row.auth')}: </span>
            {server.auth.type === 'bearer'
              ? t('settings.mcp.row.authBearer')
              : t('settings.mcp.row.authNone')}
          </div>

          <div className="text-muted-foreground">
            <span className="text-foreground/70">{t('settings.mcp.row.status')}: </span>
            {dot.label}
          </div>

          <div className="flex items-center justify-end gap-1 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={handleToggle}
              aria-label={
                server.enabled ? t('common.disable') : t('common.enable')
              }
            >
              {server.enabled ? t('common.disable') : t('common.enable')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => setEditing(true)}
              aria-label={t('common.edit')}
            >
              <Pencil className="size-3" />
              {t('common.edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
              onClick={handleDelete}
              aria-label={t('common.delete')}
            >
              <Trash2 className="size-3" />
              {t('common.delete')}
            </Button>
          </div>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
