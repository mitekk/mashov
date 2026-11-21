import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TelegramLinkService } from './telegram-link.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelegramClient } from './telegram.client';
import type { TelegramSender } from '../digest/senders/telegram.sender';

const NOW = new Date('2026-11-21T10:00:00Z');

interface HarnessOptions {
  /** studentGuid -> the connections that list the child. */
  links?: { studentGuid: string; householdConnectionId: string }[];
  /** The caller's own active connections. */
  connections?: string[];
  hasToken?: boolean;
  env?: Record<string, string>;
  /** What `telegramLinkCode.findFirst` answers with. */
  codeRow?: unknown;
  recipientCount?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const links = options.links ?? [
    { studentGuid: 'stu-1', householdConnectionId: 'conn-1' },
    { studentGuid: 'stu-2', householdConnectionId: 'conn-1' },
  ];
  const connections = options.connections ?? ['conn-1'];

  const codeCreate = jest
    .fn()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'code-row-1',
      ...data,
    }));
  const codeFindFirst = jest.fn().mockResolvedValue(options.codeRow ?? null);
  const codeUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const codeDeleteMany = jest.fn().mockResolvedValue({ count: 2 });
  const recipientDeleteMany = jest.fn().mockResolvedValue({ count: 3 });
  const recipientCount = jest.fn().mockResolvedValue(options.recipientCount ?? 2);
  const recipientUpsert = jest.fn().mockResolvedValue({ id: 'rec-1' });

  const prisma = {
    studentConnection: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: { where: { studentGuid: string } }) =>
          links.filter((link) => link.studentGuid === where.studentGuid),
        ),
    },
    householdConnection: {
      findMany: jest.fn().mockResolvedValue(connections.map((id) => ({ id }))),
    },
    telegramLinkCode: {
      create: codeCreate,
      findFirst: codeFindFirst,
      updateMany: codeUpdateMany,
      update: jest.fn().mockResolvedValue({}),
      deleteMany: codeDeleteMany,
    },
    digestRecipient: {
      upsert: recipientUpsert,
      count: recipientCount,
      deleteMany: recipientDeleteMany,
    },
  } as unknown as PrismaService;

  const config = {
    get: jest.fn((key: string) => (options.env ?? {})[key]),
  } as unknown as ConfigService;

  const getMe = jest.fn().mockResolvedValue('mashov_bot');
  const client = {
    hasToken: jest.fn().mockReturnValue(options.hasToken ?? true),
    getMe,
  } as unknown as TelegramClient;

  const send = jest.fn().mockResolvedValue(undefined);
  const sender = { channel: 'telegram', send } as unknown as TelegramSender;

  return {
    prisma,
    config,
    client,
    sender,
    getMe,
    send,
    codeCreate,
    codeFindFirst,
    codeUpdateMany,
    codeDeleteMany,
    recipientUpsert,
    recipientCount,
    recipientDeleteMany,
    service: new TelegramLinkService(prisma, config, client, sender),
  };
}

describe('TelegramLinkService.mint', () => {
  it('mints a code and the deep link the parent taps', async () => {
    const harness = makeHarness();

    const minted = await harness.service.mint('user-1', ['stu-1', 'stu-2'], NOW);

    expect(minted.botUsername).toBe('mashov_bot');
    expect(minted.deepLink).toBe(`https://t.me/mashov_bot?start=${minted.code}`);
  });

  it('mints 16 random bytes, because the code is a credential', async () => {
    // A guessed code binds the guesser's own chat to a victim's userId, and
    // they would then receive that family's children's behaviour reports.
    const harness = makeHarness();

    const minted = await harness.service.mint('user-1', ['stu-1'], NOW);

    expect(minted.code).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives each mint a different code', async () => {
    const harness = makeHarness();

    const first = await harness.service.mint('user-1', ['stu-1'], NOW);
    const second = await harness.service.mint('user-1', ['stu-1'], NOW);

    expect(first.code).not.toBe(second.code);
  });

  it('expires the code 15 minutes out by default', async () => {
    const harness = makeHarness();

    const minted = await harness.service.mint('user-1', ['stu-1'], NOW);

    expect(minted.expiresAt).toEqual(new Date('2026-11-21T10:15:00Z'));
  });

  it('honours a configured TTL', async () => {
    const harness = makeHarness({ env: { TELEGRAM_LINK_CODE_TTL_MINUTES: '5' } });

    const minted = await harness.service.mint('user-1', ['stu-1'], NOW);

    expect(minted.expiresAt).toEqual(new Date('2026-11-21T10:05:00Z'));
  });

  it('ignores a TTL that is not a positive number', async () => {
    const harness = makeHarness({ env: { TELEGRAM_LINK_CODE_TTL_MINUTES: 'soon' } });

    const minted = await harness.service.mint('user-1', ['stu-1'], NOW);

    expect(minted.expiresAt).toEqual(new Date('2026-11-21T10:15:00Z'));
  });

  it('stores the chosen children on the row', async () => {
    // Step 2's choice is client state, but the START arrives server-side with
    // no browser attached, so the intent has to travel on the code's row.
    const harness = makeHarness();

    await harness.service.mint('user-1', ['stu-1', 'stu-2'], NOW);

    expect(harness.codeCreate.mock.calls[0][0].data).toMatchObject({
      userId: 'user-1',
      studentGuids: ['stu-1', 'stu-2'],
    });
  });

  it('collapses a guid the client sent twice', async () => {
    const harness = makeHarness();

    await harness.service.mint('user-1', ['stu-1', 'stu-1'], NOW);

    expect(harness.codeCreate.mock.calls[0][0].data.studentGuids).toEqual(['stu-1']);
  });

  it('refuses a child the caller cannot see', async () => {
    const harness = makeHarness({
      links: [{ studentGuid: 'stu-1', householdConnectionId: 'someone-elses-conn' }],
    });

    await expect(harness.service.mint('user-1', ['stu-1'], NOW)).rejects.toThrow(
      ForbiddenException,
    );
    expect(harness.codeCreate).not.toHaveBeenCalled();
  });

  it('refuses the whole mint when one of several children is not visible', async () => {
    // Not a partial mint: at mint time there is a parent on the other end who
    // can be told, unlike at consume time.
    const harness = makeHarness({
      links: [
        { studentGuid: 'stu-1', householdConnectionId: 'conn-1' },
        { studentGuid: 'stu-2', householdConnectionId: 'someone-elses-conn' },
      ],
    });

    await expect(harness.service.mint('user-1', ['stu-1', 'stu-2'], NOW)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses an empty list of children', async () => {
    const harness = makeHarness();

    await expect(harness.service.mint('user-1', [], NOW)).rejects.toThrow(BadRequestException);
  });

  it('refuses a list that is only blank strings', async () => {
    const harness = makeHarness();

    await expect(harness.service.mint('user-1', ['  '], NOW)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('answers 503 rather than a t.me/undefined link when no bot is configured', async () => {
    // The default deployment has no token. Rendering a dead deep link would
    // send the parent to Telegram to be told the bot does not exist.
    const harness = makeHarness({ hasToken: false });

    await expect(harness.service.mint('user-1', ['stu-1'], NOW)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(harness.getMe).not.toHaveBeenCalled();
    expect(harness.codeCreate).not.toHaveBeenCalled();
  });

  it('writes no code row when Telegram cannot tell us the bot username', async () => {
    const harness = makeHarness();
    harness.getMe.mockRejectedValue(new Error('socket hang up'));

    await expect(harness.service.mint('user-1', ['stu-1'], NOW)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(harness.codeCreate).not.toHaveBeenCalled();
  });
});

describe('TelegramLinkService.statusFor', () => {
  const PENDING = {
    id: 'code-row-1',
    code: 'abc',
    userId: 'user-1',
    studentGuids: ['stu-1'],
    expiresAt: new Date('2026-11-21T10:15:00Z'),
    consumedAt: null,
    chatId: null,
    confirmationSentAt: null,
    confirmationError: null,
  };

  it('reports a fresh unused code as pending', async () => {
    const harness = makeHarness({ codeRow: PENDING });

    const state = await harness.service.statusFor('user-1', 'abc', NOW);

    expect(state.status).toBe('pending');
    expect(state.linkedAt).toBeNull();
  });

  it('reports a code past its expiry as expired', async () => {
    const harness = makeHarness({ codeRow: PENDING });

    const state = await harness.service.statusFor(
      'user-1',
      'abc',
      new Date('2026-11-21T10:16:00Z'),
    );

    expect(state.status).toBe('expired');
  });

  it('reports a consumed code as linked even once its expiry has passed', async () => {
    // The wizard polls after the START landed; a link that worked must not
    // start reading as expired a quarter of an hour later.
    const harness = makeHarness({
      codeRow: {
        ...PENDING,
        consumedAt: new Date('2026-11-21T10:05:00Z'),
        chatId: '98765',
        confirmationSentAt: new Date('2026-11-21T10:05:01Z'),
      },
    });

    const state = await harness.service.statusFor(
      'user-1',
      'abc',
      new Date('2026-11-21T11:00:00Z'),
    );

    expect(state.status).toBe('linked');
    expect(state.linkedAt).toEqual(new Date('2026-11-21T10:05:00Z'));
    expect(state.confirmationSent).toBe(true);
  });

  it('counts the children now subscribed on that chat', async () => {
    const harness = makeHarness({
      codeRow: { ...PENDING, consumedAt: NOW, chatId: '98765' },
      recipientCount: 2,
    });

    const state = await harness.service.statusFor('user-1', 'abc', NOW);

    expect(state.recipientCount).toBe(2);
    expect(harness.recipientCount.mock.calls[0][0].where).toMatchObject({
      userId: 'user-1',
      channel: 'telegram',
      address: '98765',
    });
  });

  it('surfaces a confirmation that could not be delivered', async () => {
    const harness = makeHarness({
      codeRow: {
        ...PENDING,
        consumedAt: NOW,
        chatId: '98765',
        confirmationError: 'bot was blocked by the user',
      },
    });

    const state = await harness.service.statusFor('user-1', 'abc', NOW);

    expect(state.confirmationSent).toBe(false);
    expect(state.confirmationError).toBe('bot was blocked by the user');
  });

  it("scopes the lookup to the caller, so a code is not another user's bearer token", async () => {
    const harness = makeHarness({ codeRow: null });

    await expect(harness.service.statusFor('user-2', 'abc', NOW)).rejects.toThrow(
      NotFoundException,
    );
    expect(harness.codeFindFirst.mock.calls[0][0].where).toMatchObject({
      code: 'abc',
      userId: 'user-2',
    });
  });

  it('says delivery is off when DIGEST_ENABLED is not set', async () => {
    // Step 4 must not promise briefings the server will never send. The flag
    // lives on the server, so the status response is the only way the browser
    // can know.
    const harness = makeHarness({ codeRow: { ...PENDING, consumedAt: NOW, chatId: '1' } });

    const state = await harness.service.statusFor('user-1', 'abc', NOW);

    expect(state.deliveryEnabled).toBe(false);
  });

  it('says delivery is off when it is enabled but still a dry run', async () => {
    const harness = makeHarness({
      codeRow: { ...PENDING, consumedAt: NOW, chatId: '1' },
      env: { DIGEST_ENABLED: 'true' },
    });

    const state = await harness.service.statusFor('user-1', 'abc', NOW);

    expect(state.deliveryEnabled).toBe(false);
  });

  it('says delivery is on only when enabled and not a dry run', async () => {
    const harness = makeHarness({
      codeRow: { ...PENDING, consumedAt: NOW, chatId: '1' },
      env: { DIGEST_ENABLED: 'true', DIGEST_DRY_RUN: 'false' },
    });

    const state = await harness.service.statusFor('user-1', 'abc', NOW);

    expect(state.deliveryEnabled).toBe(true);
  });
});

describe('TelegramLinkService.disconnect', () => {
  it("removes every one of the caller's telegram recipient rows", async () => {
    const harness = makeHarness();

    const removed = await harness.service.disconnect('user-1');

    expect(removed).toBe(3);
    expect(harness.recipientDeleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', channel: 'telegram' },
    });
  });

  it('leaves no live codes behind that could re-bind the chat', async () => {
    const harness = makeHarness();

    await harness.service.disconnect('user-1');

    expect(harness.codeDeleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('leaves other channels alone', async () => {
    // 'log' rows are a dev affordance, not a Telegram subscription.
    const harness = makeHarness();

    await harness.service.disconnect('user-1');

    expect(harness.recipientDeleteMany.mock.calls[0][0].where.channel).toBe('telegram');
  });
});
