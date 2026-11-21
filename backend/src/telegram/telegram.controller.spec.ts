import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { TelegramController } from './telegram.controller';
import type { TelegramLinkService } from './telegram-link.service';

const EXPIRES = new Date('2026-11-21T10:15:00Z');

function makeHarness() {
  const mint = jest.fn().mockResolvedValue({
    code: 'deadbeef',
    deepLink: 'https://t.me/mashov_bot?start=deadbeef',
    botUsername: 'mashov_bot',
    expiresAt: EXPIRES,
  });
  const statusFor = jest.fn().mockResolvedValue({
    status: 'pending',
    linkedAt: null,
    recipientCount: 0,
    confirmationSent: false,
    confirmationError: null,
    deliveryEnabled: false,
  });
  const disconnect = jest.fn().mockResolvedValue(2);

  const links = { mint, statusFor, disconnect } as unknown as TelegramLinkService;
  return { mint, statusFor, disconnect, controller: new TelegramController(links) };
}

const AUTHED = { user: { userId: 'user-1' } } as unknown as Request;
const ANONYMOUS = {} as unknown as Request;

describe('TelegramController', () => {
  it('mints a link for the authenticated caller', async () => {
    const harness = makeHarness();

    const response = await harness.controller.createLink(AUTHED, {
      studentGuids: ['stu-1', 'stu-2'],
    });

    expect(harness.mint).toHaveBeenCalledWith('user-1', ['stu-1', 'stu-2']);
    expect(response.data).toMatchObject({ botUsername: 'mashov_bot', expiresAt: EXPIRES });
  });

  it('refuses to mint for a request with no session', async () => {
    const harness = makeHarness();

    await expect(
      harness.controller.createLink(ANONYMOUS, { studentGuids: ['stu-1'] }),
    ).rejects.toThrow(UnauthorizedException);
    expect(harness.mint).not.toHaveBeenCalled();
  });

  it('scopes a status read to the caller, not to the code alone', async () => {
    // Otherwise a code would be a bearer token for another user's link status.
    const harness = makeHarness();

    await harness.controller.readLink(AUTHED, 'deadbeef');

    expect(harness.statusFor).toHaveBeenCalledWith('user-1', 'deadbeef');
  });

  it('returns the link state under a data envelope', async () => {
    const harness = makeHarness();

    const response = await harness.controller.readLink(AUTHED, 'deadbeef');

    expect(response.data.status).toBe('pending');
  });

  it('disconnects the caller and answers with no body', async () => {
    const harness = makeHarness();

    const response = await harness.controller.deleteLinks(AUTHED);

    expect(harness.disconnect).toHaveBeenCalledWith('user-1');
    expect(response).toBeUndefined();
  });

  it('refuses to disconnect for a request with no session', async () => {
    const harness = makeHarness();

    await expect(harness.controller.deleteLinks(ANONYMOUS)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(harness.disconnect).not.toHaveBeenCalled();
  });
});
