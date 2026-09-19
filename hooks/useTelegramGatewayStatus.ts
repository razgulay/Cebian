// useTelegramGatewayStatus — Header badge: reads live connection status from
// `telegramGatewayChannel`. BG bootstrap (D3) publishes status transitions; this
// hook just mirrors them into React state for the badge to render.

import { useEffect, useState } from 'react';
import { telegramGatewayChannel } from '@/lib/telegram-gateway/channel';
import type { ConnectionStatus } from '@/lib/telegram-gateway/types';

export function useTelegramGatewayStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() => telegramGatewayChannel.getStatus());

  useEffect(() => {
    const unsub = telegramGatewayChannel.subscribeStatus((s) => setStatus(s));
    return unsub;
  }, []);

  return status;
}
