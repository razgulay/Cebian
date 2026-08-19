// MCPSection — SidebarPanel 内的 MCP 服务器列表。
// 与 /settings/mcp 共享同一个 storage（mcpServers）和同一个 UI 组件
// （MCPServerCard / MCPServerAddForm / MCPServerSortableList）。两边写入即互相同步。
//
// 与 /settings/mcp 的唯一差别：标题/描述用更紧凑的样式（h3 而非 h2，p 而非额外 description），
// 以适配 sidebar 抽屉宽度；其它交互完全一致。
import { useStorageItem } from '@/hooks/useStorageItem';
import { mcpServers } from '@/lib/persistence/storage';
import { MCPServerSortableList } from '@/components/settings/mcp/MCPServerSortableList';
import { MCPServerAddForm } from '@/components/settings/mcp/MCPServerForm';
import { t } from '@/lib/i18n';

export function MCPSection() {
  const [servers] = useStorageItem(mcpServers, []);

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t('settings.mcp.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.mcp.description')}</p>
      </div>

      {servers.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">{t('settings.mcp.empty.title')}</p>
          <p className="text-xs text-muted-foreground mt-1">{t('settings.mcp.empty.hint')}</p>
        </div>
      ) : (
        <MCPServerSortableList servers={servers} />
      )}

      <MCPServerAddForm />
    </section>
  );
}