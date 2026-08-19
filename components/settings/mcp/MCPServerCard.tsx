import { useState } from 'react';
import { Pencil, Trash2, GripVertical } from 'lucide-react';
import { toast } from 'sonner';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import type { MCPServerConfig } from '@/lib/persistence/storage';
import { setMCPServerEnabled, removeMCPServer } from '@/lib/mcp/store';
import { MCPServerEditForm } from './MCPServerForm';
import { useMCPStatus, type MCPStatusInfo } from '@/hooks/useMCPStatus';
import { cn } from '@/lib/utils';
import { showConfirm } from '@/lib/ui/dialog';
import { t } from '@/lib/i18n';

interface MCPServerCardProps {
  server: MCPServerConfig;
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
 * MCPServerCard — summary of one MCP server with enable/edit/delete actions.
 * Click the pencil icon to expand into an inline edit form.
 *
 * Drag-to-reorder: the parent mounts the card inside a SortableContext. We
 * only spread `attributes`/`listeners` on the grip handle (GripVertical),
 * so clicking the toggle / edit / delete buttons never starts a drag. The
 * outer wrapper carries `setNodeRef` + transform/transition so the reorder
 * animation slides the whole card, not just the handle.
 */
export function MCPServerCard({ server }: MCPServerCardProps) {
  const [editing, setEditing] = useState(false);
  const statusMap = useMCPStatus();
  const dot = getStatusDot(server, statusMap[server.id]);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: server.id });
  // useSortable is a hook that must run unconditionally across renders, so we
  // still call it when the card is in edit mode — but the form below returns
  // early before the ref/transform are attached to any DOM node, which leaves
  // the SortableContext item briefly unanchored. dnd-kit tolerates this; the
  // card just can't be dragged while editing, which is the desired UX anyway.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleToggle = async (enabled: boolean) => {
    try {
      await setMCPServerEnabled(server.id, enabled);
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
    return <MCPServerEditForm server={server} onDone={() => setEditing(false)} />;
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-lg border border-border p-3 space-y-2',
        isDragging && 'opacity-50 ring-2 ring-primary/40 cursor-grabbing',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={t('settings.mcp.actions.dragHandle')}
            className="shrink-0 -ml-1 p-0.5 text-muted-foreground/60 hover:text-foreground cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded transition-colors"
          >
            <GripVertical className="size-3.5" />
          </button>
          <span
            role="img"
            className={cn('size-2 rounded-full shrink-0', dot.className)}
            title={dot.label}
            aria-label={dot.label}
          />
          <span className="text-sm font-medium truncate">{server.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={server.enabled}
            onCheckedChange={handleToggle}
            aria-label={t('settings.mcp.actions.toggle')}
          />
          <div className="h-4 w-px bg-border mx-1" aria-hidden />
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={() => setEditing(true)}
            aria-label={t('settings.mcp.actions.edit')}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={handleDelete}
            aria-label={t('settings.mcp.actions.delete')}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
