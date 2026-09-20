// Sidebar Team Roster — 固定 4 种 worker role 的 compact 模型切换器。
//
// 与 Settings → Advanced 共享同一个 `local:workerModels` storage；两边写入即互相
// 同步（用 `useStorageItem` 自带的 watch 监听）。本组件不维护额外本地 state——只做
// UI 投影。
//
// 位置：Sidebar drawer 顶部 brand header 下方、Collections 之上。Worker team 是 session
// 全局配置，与具体 session / collection 无关，放最上面让用户随时可见。
//
// 交互：
//   - 每行：role icon + 简短 role 名 + ModelSelector（compact variant，无 label/hint）
//   - 顶部 collapse toggle：把 4 row 折成 1 行 icon 节省纵向空间（当用户在翻 VFS 时
//     不需要一直看到 worker 配置）
//   - 全 4 role 都未配置时显示 banner 引导用户去 Settings → Advanced

import { useState } from 'react';
import { PenLine, Code2, Eye, BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  workerModels,
  providerCredentials,
  customProviders as customProvidersStorage,
  type ModelIdentity,
  type WorkerRole,
} from '@/lib/persistence/storage';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const ROLES = [
  { key: 'content_writer', Icon: PenLine, labelKey: 'chat.workerTeamRoster.role.content_writer', iconClassName: 'text-amber-500' },
  { key: 'frontend_coder', Icon: Code2, labelKey: 'chat.workerTeamRoster.role.frontend_coder', iconClassName: 'text-sky-500' },
  { key: 'reviewer', Icon: Eye, labelKey: 'chat.workerTeamRoster.role.reviewer', iconClassName: 'text-violet-500' },
  { key: 'researcher', Icon: BookOpen, labelKey: 'chat.workerTeamRoster.role.researcher', iconClassName: 'text-emerald-500' },
] as const satisfies ReadonlyArray<{ key: WorkerRole; labelKey: string; iconClassName: string; Icon: typeof PenLine }>;

/**
 * WorkerTeamRoster — Sidebar widget for per-role model quick-toggle.
 *
 * Shares `workerModels` storage with Settings → Advanced. Collapsed state is
 * ephemeral (not persisted) — re-opening the sidebar starts expanded.
 */
export function WorkerTeamRoster() {
  const [workerMap, setWorkerMap] = useStorageItem(workerModels, {});
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);
  const [collapsed, setCollapsed] = useState(false);

  // Partial<Record> → ModelIdentity | null 投影。传 null 等价于「删除该 role 的配置」，
  // 避免 `undefined` 与 `null` 在 JSON 序列化里出现不一致（`JSON.stringify` 会丢 undefined）。
  const setRoleModel = (role: WorkerRole, identity: ModelIdentity | null) => {
    const next = { ...workerMap };
    if (identity === null) {
      delete next[role];
    } else {
      next[role] = identity;
    }
    void setWorkerMap(next);
  };

  // Unconfigured = map 中 4 个 role 全部为 undefined。此时显示 banner
  // 引导用户去 Settings → Advanced。
  const configuredCount = ROLES.filter((r) => workerMap[r.key] != null).length;
  const allUnconfigured = configuredCount === 0;

  return (
    <section className="rounded-lg border border-border mx-3 mt-3 overflow-hidden">
      {/* Header — always visible. Click anywhere on the row to toggle collapse;
          the chevron button has its own handler for keyboard / a11y. */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('chat.workerTeamRoster.expand') : t('chat.workerTeamRoster.collapse')}
      >
        {collapsed ? (
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="text-xs font-medium flex-1 truncate">
          {t('chat.workerTeamRoster.title')}
        </span>
        <span className="text-[0.65rem] text-muted-foreground tabular-nums shrink-0">
          {t('chat.workerTeamRoster.configuredCount', [String(configuredCount), String(ROLES.length)])}
        </span>
      </button>

      {/* Collapsed: only the unconfigured banner is shown. Expanded: 4 row pickers. */}
      {!collapsed && (
        <div className="px-3 pb-3 space-y-2 border-t border-border">
          {allUnconfigured ? (
            <div className="mt-3 rounded-md border border-dashed border-border py-3 px-2 text-center">
              <p className="text-[0.7rem] text-muted-foreground leading-snug">
                {t('chat.workerTeamRoster.unconfigured')}
              </p>
            </div>
          ) : (
            <ul className="pt-2 space-y-1.5">
              {ROLES.map(({ key, Icon, labelKey, iconClassName }) => {
                const activeModel = workerMap[key] ?? null;
                return (
                  <li key={key} className="flex items-center gap-2 min-w-0">
                    <Icon className={cn('size-3.5 shrink-0', iconClassName)} aria-hidden />
                    <span className="text-xs text-foreground/80 truncate flex-1 min-w-0">
                      {t(labelKey)}
                    </span>
                    <ModelSelector
                      activeModel={activeModel}
                      configuredProviders={providers}
                      customProviders={customProviderList}
                      onSelect={(provider, modelId) =>
                        setRoleModel(key, { provider, modelId })
                      }
                      inheritOption={{
                        label: t('chat.workerTeamRoster.false'),
                        onSelect: () => setRoleModel(key, null),
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
