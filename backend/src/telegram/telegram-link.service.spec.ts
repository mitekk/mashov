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
  /** How many rows the conditional consume-update claimed. */
  claimed?: number;
  /** The children the roster knows about, by guid. */
  students?: { studentGuid: string; privateName: string }[];
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
  const codeUpdateMany = jest.fn().mockResolvedValue({ count: options.claimed ?? 1 });
  const codeUpdate = jest.fn().mockResolvedValue({});
  const codeDeleteMany = jest.fn().mockResolvedValue({ count: 2 });
  const studentFindMany = jest
    .fn()
    .mockResolvedValue(
      options.students ?? [
        { studentGuid: 'stu-1', privateName: 'מיקה' },
        { studentGuid: 'stu-2', privateName: 'יואב' },
      ],
    );
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
    student: { findMany: studentFindMany },
    telegramLinkCode: {
      create: codeCreate,
      findFirst: codeFindFirst,
      updateMany: codeUpdateMany,
      update: codeUpdate,
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
    codeUpdate,
    codeDeleteMany,
    studentFindMany,
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

describe('TelegramLinkService.consume', () => {
  const LIVE = {
    id: 'code-row-1',
    code: 'abc',
    userId: 'user-1',
    studentGuids: ['stu-1', 'stu-2'],
    expiresAt: new Date('2026-11-21T10:15:00Z'),
    consumedAt: null,
    chatId: null,
    confirmationSentAt: null,
    confirmationError: null,
  };

  function start(payload?: string, chatId: number | string = 98765) {
    return {
      update_id: 11,
      message: {
        chat: { id: chatId },
        text: payload === undefined ? '/start' : `/start ${payload}`,
      },
    };
  }

  it('binds the chat to the code and subscribes the chosen children', async () => {
    const harness = makeHarness({ codeRow: LIVE });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.codeUpdateMany.mock.calls[0][0].data).toMatchObject({
      chatId: '98765',
      consumedAt: NOW,
    });
    expect(harness.recipientUpsert).toHaveBeenCalledTimes(2);
    const [first] = harness.recipientUpsert.mock.calls[0];
    expect(first.create).toMatchObject({
      userId: 'user-1',
      studentGuid: 'stu-1',
      channel: 'telegram',
      address: '98765',
    });
  });

  it('claims the code only while it is unconsumed and unexpired', async () => {
    // Checking consumedAt in the same conditional update is what makes a
    // replayed START a no-op instead of a second binding.
    const harness = makeHarness({ codeRow: LIVE });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.codeUpdateMany.mock.calls[0][0].where).toMatchObject({
      code: 'abc',
      consumedAt: null,
      expiresAt: { gt: NOW },
    });
  });

  it('sends the confirmation at the moment the chat is proven reachable', async () => {
    const harness = makeHarness({ codeRow: LIVE });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.send).toHaveBeenCalledTimes(1);
    const [address, text] = harness.send.mock.calls[0];
    expect(address).toBe('98765');
    expect(text).toContain('מיקה');
    expect(text).toContain('יואב');
  });

  it('records that the confirmation was sent', async () => {
    const harness = makeHarness({ codeRow: LIVE });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.codeUpdate.mock.calls[0][0].data).toEqual({
      confirmationSentAt: NOW,
      confirmationError: null,
    });
  });

  it('records a confirmation that could not be delivered, without throwing', async () => {
    // The rows are already written and the code already spent. A failed
    // confirmation is something the wizard must be able to show the parent, not
    // something that unwinds the link.
    const harness = makeHarness({ codeRow: LIVE });
    harness.send.mockRejectedValue(new Error('Telegram send failed: chat not found'));

    await expect(harness.service.consume(start('abc'), NOW)).resolves.toBeUndefined();

    expect(harness.codeUpdate.mock.calls[0][0].data).toMatchObject({
      confirmationSentAt: null,
      confirmationError: expect.stringContaining('chat not found'),
    });
  });

  it('subscribes nobody and claims nothing for an unknown code', async () => {
    const harness = makeHarness({ codeRow: null });

    await harness.service.consume(start('nosuchcode'), NOW);

    expect(harness.codeUpdateMany).not.toHaveBeenCalled();
    expect(harness.recipientUpsert).not.toHaveBeenCalled();
  });

  it('tells the chat plainly when the code is unknown', async () => {
    // Pressing a stale link must not leave a parent staring at silence.
    const harness = makeHarness({ codeRow: null });

    await harness.service.consume(start('nosuchcode'), NOW);

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send.mock.calls[0][0]).toBe('98765');
  });

  it('subscribes nobody when the code has expired', async () => {
    const harness = makeHarness({ codeRow: LIVE, claimed: 0 });

    await harness.service.consume(start('abc'), new Date('2026-11-21T10:16:00Z'));

    expect(harness.recipientUpsert).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the same chat replays a START it already used', async () => {
    // Telegram retains unconfirmed updates for 24 hours, so a restarted poller
    // is handed them again. Reprocessing has to be safe by construction.
    const harness = makeHarness({
      codeRow: { ...LIVE, consumedAt: new Date('2026-11-21T10:05:00Z'), chatId: '98765' },
      claimed: 0,
    });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.recipientUpsert).not.toHaveBeenCalled();
    expect(harness.codeUpdate).not.toHaveBeenCalled();
  });

  it('answers a replayed START with a friendly already-connected note', async () => {
    const harness = makeHarness({
      codeRow: { ...LIVE, consumedAt: new Date('2026-11-21T10:05:00Z'), chatId: '98765' },
      claimed: 0,
    });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send.mock.calls[0][1]).toMatch(/מחובר/);
  });

  it('does not bind a second chat to a code the first chat already used', async () => {
    const harness = makeHarness({
      codeRow: { ...LIVE, consumedAt: new Date('2026-11-21T10:05:00Z'), chatId: '11111' },
      claimed: 0,
    });

    await harness.service.consume(start('abc', 22222), NOW);

    expect(harness.recipientUpsert).not.toHaveBeenCalled();
  });

  it('points a bare START back at the app rather than guessing who it is', async () => {
    const harness = makeHarness();

    await harness.service.consume(start(), NOW);

    expect(harness.codeFindFirst).not.toHaveBeenCalled();
    expect(harness.recipientUpsert).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('skips a child that is no longer visible rather than failing the whole link', async () => {
    // The roster can change between minting and START, so the guids are
    // re-validated here. One child having left must not cost the parent the
    // other child's updates.
    const harness = makeHarness({
      codeRow: LIVE,
      links: [
        { studentGuid: 'stu-1', householdConnectionId: 'conn-1' },
        { studentGuid: 'stu-2', householdConnectionId: 'someone-elses-conn' },
      ],
    });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.recipientUpsert).toHaveBeenCalledTimes(1);
    expect(harness.recipientUpsert.mock.calls[0][0].create.studentGuid).toBe('stu-1');
  });

  it('still confirms when every chosen child has gone, rather than going silent', async () => {
    const harness = makeHarness({
      codeRow: LIVE,
      links: [
        { studentGuid: 'stu-1', householdConnectionId: 'someone-elses-conn' },
        { studentGuid: 'stu-2', householdConnectionId: 'someone-elses-conn' },
      ],
    });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.recipientUpsert).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('re-enables a child the parent had previously toggled off', async () => {
    const harness = makeHarness({ codeRow: LIVE });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.recipientUpsert.mock.calls[0][0].update).toEqual({ enabled: true });
  });

  it('ignores an update that is not a message at all', async () => {
    const harness = makeHarness();

    await harness.service.consume({ update_id: 12 }, NOW);

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.codeFindFirst).not.toHaveBeenCalled();
  });

  it('ignores ordinary chatter that is not a START', async () => {
    const harness = makeHarness();

    await harness.service.consume(
      { update_id: 13, message: { chat: { id: 98765 }, text: 'שלום' } },
      NOW,
    );

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('accepts the group-chat form of the command', async () => {
    const harness = makeHarness({ codeRow: LIVE });

    await harness.service.consume(
      { update_id: 14, message: { chat: { id: 98765 }, text: '/start@mashov_bot abc' } },
      NOW,
    );

    expect(harness.codeUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('ignores a message with no chat id to answer', async () => {
    const harness = makeHarness();

    await harness.service.consume({ update_id: 15, message: { text: '/start abc' } }, NOW);

    expect(harness.codeFindFirst).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });
});
