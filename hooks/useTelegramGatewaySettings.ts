// useTelegramGatewaySettings — Settings → Telegram Gateway 区块用 React hook。
//
// 只暴露 `save` / `saving`：表单种子由 section 自己在挂载后用
// `telegramGatewayConfig.getValue()` 直读一次（useStorageItem 的异步首读与
// useState 的一次性 seed 相竞态，首 render 只拿到 fallback——详见
// TelegramGatewaySection 里的注释）。这里不再暴露 config / secrets，避免
// 调用方再用坏模式。

import { useCallback, useState } from 'react';
import {
  telegramGatewayConfig,
  telegramGatewaySecrets,
} from '@/lib/persistence/storage';
import type {
  TelegramGatewayConfig,
  TelegramGatewaySecret,
} from '@/lib/telegram-gateway/types';

export interface UseTelegramGatewaySettings {
  save: (config: TelegramGatewayConfig, secrets: TelegramGatewaySecret[]) => Promise<void>;
  saving: boolean;
}

export function useTelegramGatewaySettings(): UseTelegramGatewaySettings {
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    async (c: TelegramGatewayConfig, s: TelegramGatewaySecret[]) => {
      setSaving(true);
      try {
        await telegramGatewayConfig.setValue(c);
        await telegramGatewaySecrets.setValue(s);
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return { save, saving };
}
