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
  /** The guids on the active roster. */
  roster?: string[];
  /** studentGuid -> the connections that list the child. */
  links?: { studentGuid: string; householdConnectionId: string }[];
  /** The caller's own active connections. */
  connections?: string[];
  hasToken?: boolean;
  env?: Record<string, string>;
  /** What `telegramLinkCode.findFirst` answers with. */
  codeRow?: unknown;
  recipientCount?: number;
  /** The guids `digestRecipient.findMany` reports as subscribed. */
  subscribed?: string[];
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
  const reportedDeleteMany = jest.fn().mockResolvedValue({ count: 7 });
  const deliveryDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const recipientCount = jest.fn().mockResolvedValue(options.recipientCount ?? 2);
  const recipientFindMany = jest
    .fn()
    .mockResolvedValue(
      (options.subscribed ?? ['stu-1', 'stu-2']).map((studentGuid) => ({ studentGuid })),
    );
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
    student: {
      findMany: studentFindMany,
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { studentGuid: string } }) =>
          (options.roster ?? ['stu-1', 'stu-2']).includes(where.studentGuid)
            ? { studentGuid: where.studentGuid }
            : null,
        ),
    },
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
      findMany: recipientFindMany,
      deleteMany: recipientDeleteMany,
    },
    digestReportedItem: { deleteMany: reportedDeleteMany },
    digestDelivery: { deleteMany: deliveryDeleteMany },
    // One transaction, so a crash cannot leave the subscriptions gone and the
    // ledger behind.
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
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
    reportedDeleteMany,
    deliveryDeleteMany,
    recipientCount,
    recipientFindMany,
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
      subscribed: ['stu-1'],
    });

    const state = await harness.service.statusFor('user-1', 'abc', NOW);

    expect(state.recipientCount).toBe(1);
    expect(harness.recipientFindMany.mock.calls[0][0].where).toMatchObject({
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

  it('drops the dedup ledger the subscriptions it removed belonged to', async () => {
    // The unlink path deletes the ledger with the subscription for a reason
    // that applies here too: left behind, a re-link finds every item it had
    // already reported still in the ledger and silently says nothing about
    // them. "ניתוק" then looks like it changed nothing.
    const harness = makeHarness();

    await harness.service.disconnect('user-1');

    expect(harness.reportedDeleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', studentGuid: { in: ['stu-1', 'stu-2'] } },
    });
  });

  it('keeps the delivery history, which holds no chat id', async () => {
    // Unlike the unlink path, the child and the connection survive here --
    // the parent has only turned Telegram off. Their own run history is
    // readable through GET /digest/deliveries and carries no chat id, so
    // there is nothing to erase and no reason to erase it.
    const harness = makeHarness();

    await harness.service.disconnect('user-1');

    expect(harness.deliveryDeleteMany).not.toHaveBeenCalled();
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

  it('matches the subscription on the parent as well as the chat', async () => {
    // Two parents can legitimately link the same chat for the same child --
    // one family, one group chat. Keyed without the userId, the second
    // parent's START found the FIRST parent's row and only flipped
    // `enabled: true` on it: the second parent got no row at all, so their
    // wizard reported a link with zero children, their per-child toggles
    // changed nothing and their disconnect could not remove it.
    const harness = makeHarness({ codeRow: LIVE });

    await harness.service.consume(start('abc'), NOW);

    expect(harness.recipientUpsert.mock.calls[0][0].where).toEqual({
      userId_studentGuid_channel_address: {
        userId: 'user-1',
        studentGuid: 'stu-1',
        channel: 'telegram',
        address: '98765',
      },
    });
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

describe('TelegramLinkService — review findings', () => {
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

  describe('an unattributed child is not mintable (finding 1)', () => {
    it('refuses a child no connection lists at all', async () => {
      // canSeeStudent admits an unlinked child, and must, so that a roster
      // that has not been attributed does not empty the app. Here the cost of
      // being wrong is another family's conduct reports on a stranger's phone,
      // so this path needs the stricter question.
      const harness = makeHarness({ links: [] });

      await expect(harness.service.mint('user-1', ['stu-1'], NOW)).rejects.toThrow(
        ForbiddenException,
      );
      expect(harness.codeCreate).not.toHaveBeenCalled();
    });

    it('skips an unattributed child at consume time rather than subscribing them', async () => {
      const harness = makeHarness({ codeRow: LIVE, links: [] });

      await harness.service.consume(
        { update_id: 1, message: { chat: { id: 98765, type: 'private' }, text: '/start abc' } },
        NOW,
      );

      expect(harness.recipientUpsert).not.toHaveBeenCalled();
    });
  });

  describe('the roster is checked, as POST /digest/recipients checks it (finding 2)', () => {
    it('refuses a guid that names no student at all', async () => {
      // digest_recipient has no FK on studentGuid, so without this the link
      // route creates rows the documented route would answer 400 for.
      const harness = makeHarness({ roster: [] });

      await expect(harness.service.mint('user-1', ['not-a-student'], NOW)).rejects.toThrow(
        BadRequestException,
      );
      expect(harness.codeCreate).not.toHaveBeenCalled();
    });

    it('refuses a child who has left the school', async () => {
      const harness = makeHarness({ roster: ['stu-2'] });

      await expect(harness.service.mint('user-1', ['stu-1'], NOW)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('skips a child retired from the roster between minting and START', async () => {
      const harness = makeHarness({ codeRow: LIVE, roster: ['stu-1'] });

      await harness.service.consume(
        { update_id: 1, message: { chat: { id: 98765, type: 'private' }, text: '/start abc' } },
        NOW,
      );

      expect(harness.recipientUpsert).toHaveBeenCalledTimes(1);
      expect(harness.recipientUpsert.mock.calls[0][0].create.studentGuid).toBe('stu-1');
    });
  });

  describe('only a private chat may be bound (finding 3)', () => {
    it('refuses to bind a group chat', async () => {
      // The deep link can be forwarded into a class group the bot is in. Every
      // future digest -- a named child's conduct remarks -- would go to the
      // whole group, and nothing in /more would show it had happened.
      const harness = makeHarness({ codeRow: LIVE });

      await harness.service.consume(
        {
          update_id: 1,
          message: {
            chat: { id: -1001234567890, type: 'supergroup' },
            text: '/start@mashov_bot abc',
          },
        },
        NOW,
      );

      expect(harness.codeUpdateMany).not.toHaveBeenCalled();
      expect(harness.recipientUpsert).not.toHaveBeenCalled();
    });

    it('tells the group it is the wrong place rather than going silent', async () => {
      const harness = makeHarness({ codeRow: LIVE });

      await harness.service.consume(
        {
          update_id: 1,
          message: { chat: { id: -1001234567890, type: 'group' }, text: '/start abc' },
        },
        NOW,
      );

      expect(harness.send).toHaveBeenCalledTimes(1);
      expect(harness.send.mock.calls[0][0]).toBe('-1001234567890');
    });

    it('still binds a private chat that sent the @botname form', async () => {
      const harness = makeHarness({ codeRow: LIVE });

      await harness.service.consume(
        {
          update_id: 1,
          message: { chat: { id: 98765, type: 'private' }, text: '/start@mashov_bot abc' },
        },
        NOW,
      );

      expect(harness.codeUpdateMany).toHaveBeenCalledTimes(1);
    });

    it('binds a chat whose type Telegram did not state', async () => {
      // Defensive, not permissive: every real private START carries
      // type: 'private'. An update with no type at all is only ever a
      // hand-built one, and the specs above depend on it staying bindable.
      const harness = makeHarness({ codeRow: LIVE });

      await harness.service.consume(
        { update_id: 1, message: { chat: { id: 98765 }, text: '/start abc' } },
        NOW,
      );

      expect(harness.codeUpdateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('the wizard can tell "not yet sent" from "failed" (finding 4)', () => {
    it('reports the confirmation as still pending in the window before it is sent', async () => {
      // consume() writes consumedAt first, then runs visibility checks, N
      // upserts and a round trip to api.telegram.org before recording the
      // confirmation. A poll landing inside that window used to read as a
      // failure, and the wizard stopped polling and said so in red, forever.
      const harness = makeHarness({
        codeRow: { ...LIVE, consumedAt: NOW, chatId: '98765' },
      });

      const state = await harness.service.statusFor('user-1', 'abc', NOW);

      expect(state.status).toBe('linked');
      expect(state.confirmationSent).toBe(false);
      expect(state.confirmationPending).toBe(true);
    });

    it('is no longer pending once the send has succeeded', async () => {
      const harness = makeHarness({
        codeRow: { ...LIVE, consumedAt: NOW, chatId: '98765', confirmationSentAt: NOW },
      });

      const state = await harness.service.statusFor('user-1', 'abc', NOW);

      expect(state.confirmationPending).toBe(false);
    });

    it('is no longer pending once the send has failed', async () => {
      const harness = makeHarness({
        codeRow: {
          ...LIVE,
          consumedAt: NOW,
          chatId: '98765',
          confirmationError: 'bot was blocked by the user',
        },
      });

      const state = await harness.service.statusFor('user-1', 'abc', NOW);

      expect(state.confirmationPending).toBe(false);
    });
  });

  describe('the wizard names the children the server actually subscribed (finding 5)', () => {
    it('reports the guids now receiving updates on that chat', async () => {
      const harness = makeHarness({
        codeRow: { ...LIVE, consumedAt: NOW, chatId: '98765' },
      });
      (harness.prisma.digestRecipient.findMany as jest.Mock).mockResolvedValue([
        { studentGuid: 'stu-1' },
      ]);

      const state = await harness.service.statusFor('user-1', 'abc', NOW);

      expect(state.subscribedGuids).toEqual(['stu-1']);
      expect(state.recipientCount).toBe(1);
    });

    it('counts only the children still switched on', async () => {
      const harness = makeHarness({
        codeRow: { ...LIVE, consumedAt: NOW, chatId: '98765' },
      });

      await harness.service.statusFor('user-1', 'abc', NOW);

      expect(
        (harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where,
      ).toMatchObject({
        userId: 'user-1',
        channel: 'telegram',
        address: '98765',
        enabled: true,
        studentGuid: { in: LIVE.studentGuids },
      });
    });

    it('reports nothing subscribed while the code is still unused', async () => {
      const harness = makeHarness({ codeRow: LIVE });

      const state = await harness.service.statusFor('user-1', 'abc', NOW);

      expect(state.subscribedGuids).toEqual([]);
    });
  });
});
