import { describe, expect, it } from 'vitest';
import type { TelegramLinkState } from '@/types/api';
import { TELEGRAM_LINK_POLL_MS, telegramLinkPollInterval } from './useTelegramLink';

function state(overrides: Partial<TelegramLinkState>): TelegramLinkState {
  return {
    status: 'pending',
    linkedAt: null,
    recipientCount: 0,
    confirmationSent: false,
    confirmationError: null,
    deliveryEnabled: false,
    ...overrides,
  };
}

describe('telegramLinkPollInterval', () => {
  it('keeps polling while the parent has not pressed START yet', () => {
    expect(telegramLinkPollInterval(state({ status: 'pending' }))).toBe(TELEGRAM_LINK_POLL_MS);
  });

  it('keeps polling before the first answer has arrived', () => {
    expect(telegramLinkPollInterval(undefined)).toBe(TELEGRAM_LINK_POLL_MS);
  });

  it('stops the moment the chat is linked', () => {
    // The wizard advances to its last step off this; leaving the interval on
    // would be a request every two seconds for as long as the tab is open.
    expect(telegramLinkPollInterval(state({ status: 'linked' }))).toBe(false);
  });

  it('stops once the code has expired, since nothing more can happen to it', () => {
    expect(telegramLinkPollInterval(state({ status: 'expired' }))).toBe(false);
  });
});
