// Telegram Gateway BG client handlers — `telegram_gateway_config_get/set/send`。
// CRUD + outbound bridge：UI sidepanel 的 channel 实例不持有 outbound sender，
// 主动回复走 `telegram_gateway_send` ClientMessage → 本处理器用 bootstrap
// 持有的 WS 客户端代理。WS 连线由 manager.ts 负责（watch 同一批 storage item）。

import type { ServerMessage } from '@/lib/ipc/protocol';
import {
  telegramGatewayConfig,
  telegramGatewaySecrets,
} from '@/lib/persistence/storage';
import type {
  TelegramGatewayConfig,
  TelegramGatewaySecret,
} from '@/lib/telegram-gateway/types';
import type { OutboundAction } from '@/lib/telegram-gateway/types';
import { post } from '../ipc/port-registry';
import { registerClientHandlers, type ClientHandlerMap } from '../ipc/client-router';
import { getBootstrapHandle, triggerTelegramGatewaySync } from './manager';

const telegramGatewayClientHandlers: ClientHandlerMap = {
  async telegram_gateway_config_get(port) {
    const [config, secrets] = await Promise.all([
      telegramGatewayConfig.getValue(),
      telegramGatewaySecrets.getValue(),
    ]);
    post(port, {
      type: 'telegram_gateway_config_get_result',
      config: config as unknown,
      secrets: secrets as unknown,
    } satisfies ServerMessage);
  },

  async telegram_gateway_config_set(port, msg) {
    try {
      await telegramGatewayConfig.setValue(msg.config as TelegramGatewayConfig);
      await telegramGatewaySecrets.setValue(msg.secrets as TelegramGatewaySecret[]);
      // 保存成功 → 立即触发一次 sync，省掉 watch + 100ms 去抖的等待，
      // 给用户「刚按 Save 就连上」的即时反馈。manager 里的 syncGateway 内部
      // 先 teardown 旧 handle 再按新值 bootstrap，多次触发天然幂等。
      triggerTelegramGatewaySync();
      post(port, { type: 'telegram_gateway_config_get_result', config: msg.config, secrets: msg.secrets } satisfies ServerMessage);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      post(port, { type: 'error', sessionId: null, error: `telegram_gateway_config_set: ${message}` } satisfies ServerMessage);
    }
  },

  async telegram_gateway_send(_port, msg) {
    if (typeof msg.action !== 'object' || msg.action === null) {
      throw new Error('telegram_gateway_send: action must be an object.');
    }
    const action = msg.action as OutboundAction;
    const handle = getBootstrapHandle();
    if (!handle) {
      throw new Error('telegram_gateway_send: gateway not connected.');
    }
    await handle.client.sendOutbound(action);
  },
};

export function setupTelegramGatewayClientHandlers(): void {
  registerClientHandlers(telegramGatewayClientHandlers);
}

export { telegramGatewayClientHandlers };
