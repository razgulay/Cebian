// MCPSection — Sidebar drawer 内的 MCP 服务器列表，与 Worker team 折叠面板视觉一致。
//
// 与 /settings/mcp 共享同一个 storage（mcpServers）和同一组 UI 组件
// （MCPServerRow / MCPServerAddForm / MCPServerSortableList）。两边写入即互相同步。
//
// 与 /settings/mcp 的差异：抽屉宽度更窄，外壳采用 WorkerTeamRoster 同款的
// rounded-lg border + mx-3 mt-3 overflow-hidden；header 是带 chevron 的按钮，点击
// 折叠整个 section，省纵向空间；不显示额外的描述行（描述已嵌入 settings.mcp.title
// 旁的徽标语义）。
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useStorageItem } from '@/hooks/useStorageItem';
import { mcpServers } from '@/lib/persistence/storage';
import { MCPServerSortableList } from '@/components/settings/mcp/MCPServerSortableList';
import { MCPServerAddForm } from '@/components/settings/mcp/MCPServerForm';
import { t } from '@/lib/i18n';

export function MCPSection() {
  const [servers] = useStorageItem(mcpServers, []);
  // 折叠状态为纯 UI 本地态，不持久化——与 WorkerTeamRoster 对齐。
  const [collapsed, setCollapsed] = useState(false);

  const total = servers.length;

  return (
    <section className="rounded-lg border border-border mx-3 mt-3 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={!collapsed}
        aria-label={
          collapsed
            ? t('settings.mcp.header.expand')
            : t('settings.mcp.header.collapse')
        }
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="text-xs font-medium flex-1 truncate">
          {t('settings.mcp.title')}
        </span>
        <span className="text-[0.65rem] text-muted-foreground tabular-nums shrink-0">
          {t('settings.mcp.header.configuredCount', [String(total), String(total)])}
        </span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-3 border-t border-border">
          {total === 0 ? (
            <div className="mt-3 rounded-md border border-dashed border-border p-4 text-center">
              <p className="text-xs text-muted-foreground">
                {t('settings.mcp.empty.title')}
              </p>
              <p className="text-[0.7rem] text-muted-foreground mt-1">
                {t('settings.mcp.empty.hint')}
              </p>
            </div>
          ) : (
            <MCPServerSortableList servers={servers} />
          )}

          <MCPServerAddForm />
        </div>
      )}
    </section>
  );
}
