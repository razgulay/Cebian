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
import type { MCPServerConfig } from '@/lib/persistence/storage';
import { reorderMCPServers } from '@/lib/mcp/store';
import { MCPServerCard } from './MCPServerCard';

/**
 * MCPServerSortableList — wraps `MCPServerCard` in a DndContext +
 * SortableContext so the card grip-handles can drive reorder. Lives in
 * its own component because both Settings (`/settings/mcp`) and the
 * Sidebar drawer render the same MCP server list and need the same drag
 * wiring; duplicating the DndContext plumbing in two files would drift.
 *
 * Drag flow:
 * - PointerSensor uses a small distance threshold so a stray click on
 *   the grip never starts a drag, but a real press-and-move does. Both
 *   touch and mouse go through this sensor.
 * - KeyboardSensor + `sortableKeyboardCoordinates` enables keyboard
 *   reorder: Tab to the grip → Space to "pick up" → Arrow keys to move
 *   → Space again to drop, Escape to cancel. `attributes` / `listeners`
 *   on the card's grip button are what make this work.
 *
 * Reorder persistence: `onDragEnd` reads the current order from the array
 * we already rendered (no extra fetch), passes the old/new indices to
 * `reorderMCPServers`, and the helper writes back atomically. We don't
 * keep a local React copy of the order — the storage item's `watch`
 * callback in `useStorageItem` will push the new order into the parent
 * list and the cards re-render in their new position. This matches how
 * the rest of the MCP section reads/writes: single source of truth is
 * the storage item, not React state.
 */
export function MCPServerSortableList({ servers }: { servers: MCPServerConfig[] }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Pre-compute the ids array — passing a stable reference to
  // SortableContext.items avoids an unnecessary effect run inside dnd-kit.
  const itemIds = useMemo(() => servers.map((s) => s.id), [servers]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = itemIds.indexOf(String(active.id));
      const toIndex = itemIds.indexOf(String(over.id));
      if (fromIndex === -1 || toIndex === -1) return;
      reorderMCPServers(fromIndex, toIndex).catch((err) => {
        // Mirror the error-handling pattern used by setMCPServerEnabled /
        // removeMCPServer on MCPServerCard — storage IO failures shouldn't
        // leave the user with a card that silently snapped back.
        console.error('[mcp] failed to reorder servers:', err);
        toast.error(err instanceof Error ? err.message : String(err));
      });
    },
    [itemIds],
  );

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {servers.map((s) => (
            <MCPServerCard key={s.id} server={s} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
