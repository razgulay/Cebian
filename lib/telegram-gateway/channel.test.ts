import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { telegramGatewayChannel } from './channel';
import type { InboundMessage, OutboundAction, OutboundResult } from './types';

const sampleInbound: InboundMessage = {
  kind: 'telegram_message',
  update_id: 1,
  message_id: 1,
  chat_id: 100,
  chat_type: 'private',
  text: 'hi',
  date: 1737000000,
  from: { id: 99 },
};

beforeEach(() => {
  telegramGatewayChannel.setOutboundSender(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('telegramGatewayChannel', () => {
  it('publishInbound fires all subscribers; subscribers can unsubscribe', () => {
    const a: InboundMessage[] = [];
    const b: InboundMessage[] = [];
    const unsubA = telegramGatewayChannel.subscribeInbound((m) => a.push(m));
    const unsubB = telegramGatewayChannel.subscribeInbound((m) => b.push(m));

    telegramGatewayChannel.publishInbound(sampleInbound);
    expect(a).toEqual([sampleInbound]);
    expect(b).toEqual([sampleInbound]);

    unsubA();
    telegramGatewayChannel.publishInbound(sampleInbound);
    expect(a).toEqual([sampleInbound]); // not appended after unsubscribe
    expect(b).toEqual([sampleInbound, sampleInbound]);
  });

  it('publishStatus fires only on transition (dedupe same value)', () => {
    const statuses: string[] = [];
    telegramGatewayChannel.subscribeStatus((s) => statuses.push(s));

    telegramGatewayChannel.publishStatus('connecting');
    telegramGatewayChannel.publishStatus('connecting'); // dedup
    telegramGatewayChannel.publishStatus('connected');
    telegramGatewayChannel.publishStatus('disconnected');

    expect(statuses).toEqual(['connecting', 'connected', 'disconnected']);
  });

  it('setOutboundSender(null) emits disconnected to status subscribers', () => {
    const seen: string[] = [];
    telegramGatewayChannel.subscribeStatus((s) => seen.push(s));

    // Start by emitting a non-default status so we can observe the transition
    // back to 'disconnected' when the sender is cleared (channel dedups same
    // status value).
    telegramGatewayChannel.publishStatus('connected');
    expect(seen).toEqual(['connected']);

    telegramGatewayChannel.setOutboundSender(null);
    expect(seen).toEqual(['connected', 'disconnected']);
  });

  it('sendOutbound throws when no sender registered', async () => {
    const action: OutboundAction = {
      kind: 'sendMessage',
      request_id: 'r1',
      chat_id: 100,
      text: 'x',
    };
    await expect(telegramGatewayChannel.sendOutbound(action)).rejects.toThrow(
      /not connected/,
    );
  });

  it('sendOutbound forwards to registered sender and returns its result', async () => {
    const reply: OutboundResult = {
      kind: 'sendMessage_result',
      request_id: 'r1',
      ok: true,
      message_id: 42,
    };
    const sender = vi.fn(async (action: OutboundAction) => {
      expect(action.chat_id).toBe(100);
      return reply;
    });
    telegramGatewayChannel.setOutboundSender(sender);

    const action: OutboundAction = {
      kind: 'sendMessage',
      request_id: 'r1',
      chat_id: 100,
      text: 'hello',
    };
    const result = await telegramGatewayChannel.sendOutbound(action);
    expect(sender).toHaveBeenCalledOnce();
    expect(result).toEqual(reply);
  });

  it('listener errors are swallowed (one bad subscriber does not break the rest)', () => {
    const seen: InboundMessage[] = [];
    telegramGatewayChannel.subscribeInbound(() => {
      throw new Error('subscriber broken');
    });
    telegramGatewayChannel.subscribeInbound((m) => seen.push(m));

    telegramGatewayChannel.publishInbound(sampleInbound);
    expect(seen).toEqual([sampleInbound]); // second subscriber still received
  });

  it('isConnected reflects sender presence', () => {
    expect(telegramGatewayChannel.isConnected()).toBe(false);
    telegramGatewayChannel.setOutboundSender(async () => ({
      kind: 'sendMessage_result',
      request_id: 'x',
      ok: true,
      message_id: 1,
    }));
    expect(telegramGatewayChannel.isConnected()).toBe(true);
    telegramGatewayChannel.setOutboundSender(null);
    expect(telegramGatewayChannel.isConnected()).toBe(false);
  });
});
