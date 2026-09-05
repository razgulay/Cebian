import { useStorageItem } from '@/hooks/useStorageItem';
import { mcpServers } from '@/lib/persistence/storage';
import { MCPServerSortableList } from '@/components/settings/mcp/MCPServerSortableList';
import { MCPServerAddForm } from '@/components/settings/mcp/MCPServerForm';
import { t } from '@/lib/i18n';

/**
 * MCPSection — manage MCP server configurations.
 *
 * v1: list / add / edit / enable / disable / delete servers.
 * Connection lifecycle is handled by the background `MCPManager`; this
 * section only edits storage and reads status.
 *
 * Header 与 Worker team 保持视觉一致：标题旁挂 N / N 已配置的小徽标，下方一行描述。
 * Settings 页是全宽布局，不需要折叠 / 边距外壳（折叠外壳是 sidebar 抽屉专属）。
 */
export function MCPSection() {
  const [servers] = useStorageItem(mcpServers, []);
  const total = servers.length;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="space-y-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold">{t('settings.mcp.title')}</h2>
          <span className="text-[0.65rem] text-muted-foreground tabular-nums">
            {t('settings.mcp.header.configuredCount', [String(total), String(total)])}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.mcp.description')}</p>
      </div>

      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">{t('settings.mcp.empty.title')}</p>
          <p className="text-xs text-muted-foreground mt-1">{t('settings.mcp.empty.hint')}</p>
        </div>
      ) : (
        <MCPServerSortableList servers={servers} />
      )}

      <MCPServerAddForm />
    </div>
  );
}
