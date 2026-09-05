import { useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Accordion } from '@/components/ui/accordion';
import type { MCPServerConfig } from '@/lib/persistence/storage';
import { reorderMCPServers } from '@/lib/mcp/store';
import { useMCPStatus } from '@/hooks/useMCPStatus';
import { MCPServerRow } from './MCPServerRow';

/**
 * MCPServerSortableList — Settings (`/settings/mcp`) 与 Sidebar 抽屉共用的 MCP 服务器列表。
 *
 * 把 DndContext + SortableContext + Accordion 三层嵌套集中在一处，避免在两个调用点复制拖拽与展开状态管理。
 * useMCPStatus 在此提升调用一次，statusMap 通过 prop 下发到每行；每行 5s 轮询会浪费 N 倍的消息往返。
 *
 * 拖拽流程：
 * - PointerSensor 距离阈值 5px → 普通点击不触发拖拽，按住并位移才进入拖动。
 * - KeyboardSensor + sortableKeyboardCoordinates → Tab 到行后 Space 拾起，方向键移动，Space 落下 / Esc 取消。
 * - onDragEnd 直接调用 reorderMCPServers 由 storage 写回，useStorageItem 的 watch 回调会触发父列表重渲染。
 *
 * 展开：Accordion type="multiple"，每行独立 open 状态，可同时展开多行。
 */
export function MCPServerSortableList({ servers }: { servers: MCPServerConfig[] }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 一次轮询，多行共享；useMCPStatus 自身 5s 间隔。
  const statusMap = useMCPStatus();

  const itemIds = useMemo(() => servers.map((s) => s.id), [servers]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = itemIds.indexOf(String(active.id));
      const toIndex = itemIds.indexOf(String(over.id));
      if (fromIndex === -1 || toIndex === -1) return;
      reorderMCPServers(fromIndex, toIndex).catch((err) => {
        // 与 setMCPServerEnabled / removeMCPServer 错误处理保持一致：storage IO 失败时显式 toast，
        // 不让行"看似拖回去了"。
        console.error('[mcp] failed to reorder servers:', err);
        toast.error(err instanceof Error ? err.message : String(err));
      });
    },
    [itemIds],
  );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <Accordion type="multiple" className="divide-y divide-border/50">
          {servers.map((s) => (
            <MCPServerRow key={s.id} server={s} statusMap={statusMap} />
          ))}
        </Accordion>
      </SortableContext>
    </DndContext>
  );
}
