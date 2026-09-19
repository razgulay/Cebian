// TelegramGatewaySection — Settings → Telegram Gateway 区块。
//
// 配置 Worker URL / bot token / secret / allowed chat ids / interactive mode
// toggle。Save 直接写 `local:telegramGatewayConfig` / `local:telegramGatewaySecrets`
// （BG bootstrapTelegramGateway 侧读同一批 item），成功后弹 toast。

import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTelegramGatewaySettings } from '@/hooks/useTelegramGatewaySettings';
import { telegramGatewayConfig, telegramGatewaySecrets } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';

export function TelegramGatewaySection() {
  const { save, saving } = useTelegramGatewaySettings();
  const [workerUrl, setWorkerUrl] = useState('');
  const [botToken, setBotToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [wsAuthToken, setWsAuthToken] = useState('');
  const [allowedChatIdsCsv, setAllowedChatIdsCsv] = useState('');
  const [interactiveMode, setInteractiveMode] = useState(false);

  // 挂载后直读一次 storage 做表单种子。不能写 `useState(config.workerUrl)`：
  // useStorageItem 的首读是异步的，首个 render 只拿到 fallback（空串），等
  // 真值到达时 useState 已经定型——表单会永远显示空值，切设置页回来也一样
  // （Save 其实写进去了，用户却以为丢了）。直读 getValue 拿到的就是落盘值，
  // 时序竞态不复存在；种子只灌一次，之后用户编辑不会被 storage watch 覆盖。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [cfg, secs] = await Promise.all([
        telegramGatewayConfig.getValue(),
        telegramGatewaySecrets.getValue(),
      ]);
      if (cancelled) return;
      setWorkerUrl(cfg.workerUrl);
      setAllowedChatIdsCsv(cfg.allowedChatIdsCsv);
      setInteractiveMode(cfg.interactiveMode);
      setBotToken(secs[0]?.botToken ?? '');
      setWebhookSecret(secs[0]?.webhookSecret ?? '');
      setWsAuthToken(secs[0]?.wsAuthToken ?? '');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    if (saving) return;
    await save(
      { workerUrl, allowedChatIdsCsv, interactiveMode },
      [{ id: 'default', botToken, webhookSecret, wsAuthToken }],
    );
    toast.success(t('settings.telegramGateway.saved'));
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-medium">{t('settings.telegramGateway.title')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.telegramGateway.description')}</p>

      <div>
        <label className="text-xs font-medium">{t('settings.telegramGateway.workerUrl')}</label>
        <Input
          value={workerUrl}
          placeholder="https://cebian-gateway.your-sub.workers.dev"
          onChange={(e) => setWorkerUrl(e.target.value)}
        />
      </div>

      <div>
        <label className="text-xs font-medium">{t('settings.telegramGateway.botToken')}</label>
        <PasswordInput value={botToken} onChange={(e) => setBotToken(e.target.value)} />
      </div>

      <div>
        <label className="text-xs font-medium">{t('settings.telegramGateway.webhookSecret')}</label>
        <PasswordInput value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
      </div>

      <div>
        <label className="text-xs font-medium">{t('settings.telegramGateway.wsAuthToken')}</label>
        <PasswordInput value={wsAuthToken} onChange={(e) => setWsAuthToken(e.target.value)} />
      </div>

      <div>
        <label className="text-xs font-medium">{t('settings.telegramGateway.allowedChatIds')}</label>
        <Input
          value={allowedChatIdsCsv}
          placeholder="123456789,-100100987654321"
          onChange={(e) => setAllowedChatIdsCsv(e.target.value)}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="mt-1 cursor-help text-[10px] text-muted-foreground">
              {t('settings.telegramGateway.chatIdHint')}
            </p>
          </TooltipTrigger>
          <TooltipContent>{t('settings.telegramGateway.chatIdHint')}</TooltipContent>
        </Tooltip>
      </div>

      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={interactiveMode}
          onCheckedChange={(v) => setInteractiveMode(v === true)}
        />
        {t('settings.telegramGateway.interactiveMode')}
      </label>

      <Button size="sm" onClick={handleSave} disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        {t('settings.telegramGateway.save')}
      </Button>
    </div>
  );
}
