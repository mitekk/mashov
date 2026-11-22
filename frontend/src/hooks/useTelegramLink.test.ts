import { describe, expect, it } from 'vitest';
import type { TelegramLinkState } from '@/types/api';
import { TELEGRAM_LINK_POLL_MS, telegramLinkPollInterval } from './useTelegramLink';

function state(overrides: Partial<TelegramLinkState>): TelegramLinkState {
  return {
    status: 'pending',
    linkedAt: null,
    recipientCount: 0,
    confirmationSent: false,
    confirmationPending: false,
    confirmationError: null,
    subscribedGuids: [],
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

  it('stops once the chat is linked and the confirmation has settled', () => {
    // The wizard advances to its last step off this; leaving the interval on
    // would be a request every two seconds for as long as the tab is open.
    expect(
      telegramLinkPollInterval(state({ status: 'linked', confirmationSent: true })),
    ).toBe(false);
  });

  it('keeps polling a linked code whose confirmation is still in flight', () => {
    // The backend marks the code consumed before it has tried to send, so
    // stopping here would freeze the screen on an ambiguous
    // not-sent-and-no-error pair -- which the UI then read as a failure.
    expect(
      telegramLinkPollInterval(state({ status: 'linked', confirmationPending: true })),
    ).toBe(TELEGRAM_LINK_POLL_MS);
  });

  it('stops on a linked code whose confirmation failed, since nothing will change', () => {
    expect(
      telegramLinkPollInterval(
        state({ status: 'linked', confirmationError: 'bot was blocked by the user' }),
      ),
    ).toBe(false);
  });

  it('stops once the code has expired, since nothing more can happen to it', () => {
    expect(telegramLinkPollInterval(state({ status: 'expired' }))).toBe(false);
  });
});
