/**
 * StorageSection — 虚拟文件系统（VFS）的存储概览。
 *
 * 只读视角：显示 VFS 已用空间，并提供一个按钮在侧边栏内直接打开文件浏览器
 * （侧边栏下是 VfsExplorer 直挂路由，所以是「在面板内导航」；standalone settings
 * tab 没有该路由，回落到新标签页 /vfs.html#/workspaces 保留旧行为）。VFS 浏览器本身
 * 是只读的，这里刻意不提供删除 / 清空——需要导出时用浏览器自带的下载。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Loader2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { vfs } from '@/lib/persistence/vfs';
import { formatBytes } from '@/lib/utils';

function openInNewTab(): void {
  const url = browser.runtime.getURL('/vfs.html' as never) + '#/workspaces';
  void browser.tabs.create({ url });
}

export function StorageSection() {
  // 侧边栏 (MemoryRouter) 有 /vfs 路由，goto('/vfs') 在面板内切换；standalone settings
  // tab (HashRouter + basePath '') 没这条路由，回落到开新标签页。让组件同时支持两个
  // host 端的关键就是 pathname 末段——'sidepanel.html' 才是侧边栏。
  const navigate = useNavigate();
  const isSidepanel = window.location.pathname.endsWith('sidepanel.html');

  function openFileBrowser(): void {
    if (isSidepanel) {
      navigate('/vfs');
      return;
    }
    openInNewTab();
  }
  // null = 计算中；number = 已用字节数；'error' = 计算失败（与「空」区分，避免误报 0 B）。
  const [usage, setUsage] = useState<number | 'error' | null>(null);

  useEffect(() => {
    let alive = true;
    // 递归累加全树文件大小（lightning-fs 的 du），进入本节时算一次。
    vfs.du('/').then(
      (bytes) => { if (alive) setUsage(bytes); },
      () => { if (alive) setUsage('error'); },
    );
    return () => { alive = false; };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.storage.title')}</h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <span className="text-sm text-muted-foreground">{t('settings.storage.used')}</span>
          {usage === null ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : usage === 'error' ? (
            <span className="text-sm text-muted-foreground">{t('settings.storage.usedError')}</span>
          ) : (
            <span className="text-sm font-medium tabular-nums">{formatBytes(usage)}</span>
          )}
        </div>

        <div className="space-y-2">
          <Button variant="outline" onClick={openFileBrowser}>
            <FolderOpen className="size-4" />
            {t('settings.storage.openBrowser')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('settings.storage.description')}</p>
        </div>
      </div>
    </div>
  );
}
