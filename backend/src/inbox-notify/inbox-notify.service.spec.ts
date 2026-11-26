import { InboxNotifyService } from './inbox-notify.service';
import { STALE_CLAIM_MS } from '../digest/digest-checker.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { DigestSender } from '../digest/senders/digest-sender.interface';
import type { MediaDelivery } from '../telegram-media/media-delivery.interface';

/** 15:00 Jerusalem on 2026-11-17, well outside the quiet window. */
const NOW = new Date('2026-11-17T13:00:00Z');
const TODAY = new Date('2026-11-17T00:00:00Z');
const AN_HOUR_AGO = new Date('2026-11-17T12:00:00Z');
const LAST_WEEK = new Date('2026-11-10T09:00:00Z');

const USER_A = 'user-a';
const CONNECTION = { id: 'conn-1', upstreamUserId: 'parent-upstream' };

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-1',
    subject: 'יום ספורט ביום חמישי',
    householdConnectionId: 'conn-1',
    labels: [] as string[],
    locallyReadThroughAt: null as Date | null,
    sendTime: AN_HOUR_AGO,
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'school-secretary',
    senderName: 'מזכירות בית הספר',
    subject: 'יום ספורט ביום חמישי',
    bodyHtmlSanitized: '<p>נבקש להביא בגדי ספורט.</p>',
    bodyTextPreview: null as string | null,
    sendTime: AN_HOUR_AGO,
    isNew: true,
    householdConnectionId: 'conn-1',
    files: [] as unknown[],
    ...overrides,
  };
}

interface HarnessOptions {
  conversations?: Record<string, unknown>[];
  messages?: Record<string, unknown>[];
  connections?: { id: string; upstreamUserId: string | null }[];
  recipients?: {
    userId: string;
    studentGuid: string;
    channel: string;
    address: string;
    enabled: boolean;
    activeFrom: Date;
  }[];
  /** Which claimed rows the read-back says this run owns. */
  ownedMessageIds?: string[];
  sendImpl?: jest.Mock;
  env?: Record<string, string>;
  media?: Partial<MediaDelivery>;
  hydrate?: jest.Mock;
}

function makeHarness(options: HarnessOptions = {}) {
  const recipients = options.recipients ?? [
    {
      userId: USER_A,
      studentGuid: 'stu-1',
      channel: 'telegram',
      address: '12345',
      enabled: true,
      activeFrom: new Date('2026-09-01T00:00:00Z'),
    },
  ];
  const conversations = options.conversations ?? [conversationRow()];
  const messages = options.messages ?? [messageRow()];
  const connections = options.connections ?? [CONNECTION];

  // The ledger stands in for Postgres: createMany records what was claimed,
  // and the read-back answers with the rows this run owns -- carrying the real
  // content hashes the service computed, because those are what it filters on.
  let claimed: { messageId: string; contentHash: string }[] = [];
  const createMany = jest.fn().mockImplementation(({ data }) => {
    claimed = data as { messageId: string; contentHash: string }[];
    return Promise.resolve({ count: data.length });
  });
  const notifiedUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
  const notifiedDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const owned = options.ownedMessageIds ?? messages.map((m) => m.messageId as string);
  const notifiedFindMany = jest
    .fn()
    .mockImplementation(() => claimed.filter((row) => owned.includes(row.messageId)));

  const deliveryCreate = jest.fn().mockImplementation(({ data }) => ({ id: 'del-1', ...data }));
  const recipientUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

  const prisma = {
    householdConnection: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(where?.userId === undefined || where.userId === USER_A ? connections : []),
      ),
    },
    // Honours the scope, the archived label and the sendTime floor, as
    // Postgres would: a mock that ignored them would report the selection
    // rules as working while every row came back regardless.
    mailConversation: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          conversations.filter((row) => {
            // The notifier reads only rows stamped to the parent's own
            // connections -- no NULL arm, unlike every other mail read.
            const ownIds: string[] = where?.householdConnectionId?.in ?? [];
            const stamp = row.householdConnectionId as string | null;
            if (stamp === null || !ownIds.includes(stamp)) return false;
            const archived = (row.labels as string[]).includes('archived');
            if (where?.NOT && archived) return false;
            const floor = where?.sendTime?.gte as Date | undefined;
            if (floor && (row.sendTime as Date) < floor) return false;
            return true;
          }),
        ),
      ),
    },
    mailMessage: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          messages.filter((row) => {
            const ids: string[] = where?.conversationId?.in ?? [];
            if (!ids.includes(row.conversationId as string)) return false;
            const floor = where?.sendTime?.gte as Date | undefined;
            return !floor || (row.sendTime as Date) >= floor;
          }),
        ),
      ),
    },
    mailNotifiedMessage: {
      createMany,
      updateMany: notifiedUpdateMany,
      deleteMany: notifiedDeleteMany,
      findMany: notifiedFindMany,
    },
    digestRecipient: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          recipients.filter(
            (row) =>
              (where?.enabled === undefined || row.enabled === where.enabled) &&
              (where?.userId === undefined || row.userId === where.userId),
          ),
        ),
      ),
      updateMany: recipientUpdateMany,
    },
    digestDelivery: { create: deliveryCreate },
  } as unknown as PrismaService;

  const config = {
    get: jest.fn((key: string) => ({
      DIGEST_TIMEZONE: 'Asia/Jerusalem',
      INBOX_NOTIFY_DRY_RUN: 'false',
      ...options.env,
    })[key]),
  } as unknown as ConfigService;

  const send = options.sendImpl ?? jest.fn().mockResolvedValue(undefined);
  const telegram = { channel: 'telegram', send } as unknown as DigestSender;

  const mediaFetch = jest.fn().mockImplementation((_userId, refs) => ({
    items: refs.map((ref: unknown) => ({ ref, file: { fileName: 'f', buffer: Buffer.alloc(4), contentType: null } })),
    remainingBytes: 1000,
  }));
  const mediaSend = jest.fn().mockResolvedValue({ sent: 1, notes: [] });
  const media = {
    enabled: true,
    budgetBytes: () => 50 * 1024 * 1024,
    fetch: mediaFetch,
    send: mediaSend,
    ...options.media,
  } as unknown as MediaDelivery;

  const hydrate = options.hydrate ?? jest.fn().mockResolvedValue(undefined);
  const upstreamMail = { enabled: true, hydrateConversation: hydrate };

  return {
    service: new InboxNotifyService(prisma, config, telegram, media, upstreamMail),
    hydrate,
    send,
    mediaFetch,
    mediaSend,
    createMany,
    notifiedUpdateMany,
    notifiedDeleteMany,
    notifiedFindMany,
    deliveryCreate,
    recipientUpdateMany,
    prisma,
  };
}

describe('InboxNotifyService.notifyAll', () => {
  it('sends one Telegram message per new mail message', async () => {
    const harness = makeHarness();

    const results = await harness.service.notifyAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(1);
    const [address, text] = harness.send.mock.calls[0];
    expect(address).toBe('12345');
    expect(text).toContain('דואר חדש מבית הספר');
    expect(text).toContain('יום ספורט ביום חמישי');
    expect(results[0]).toMatchObject({ status: 'sent', messageCount: 1, address: '12345' });
  });

  it('sends once to a chat a parent linked for three children', async () => {
    // Mail is household-scoped: three subscriptions to one chat is still one
    // inbox, and three copies of the same message is what a parent reads as
    // the feature being broken.
    const harness = makeHarness({
      recipients: ['stu-1', 'stu-2', 'stu-3'].map((studentGuid) => ({
        userId: USER_A,
        studentGuid,
        channel: 'telegram',
        address: '12345',
        enabled: true,
        activeFrom: new Date('2026-09-01T00:00:00Z'),
      })),
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('sends to every chat the parent has linked', async () => {
    const harness = makeHarness({
      recipients: ['12345', '67890'].map((address) => ({
        userId: USER_A,
        studentGuid: 'stu-1',
        channel: 'telegram',
        address,
        enabled: true,
        activeFrom: new Date('2026-09-01T00:00:00Z'),
      })),
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send.mock.calls.map((call) => call[0]).sort()).toEqual(['12345', '67890']);
  });

  it('ignores a disabled subscription', async () => {
    const harness = makeHarness({
      recipients: [
        {
          userId: USER_A,
          studentGuid: 'stu-1',
          channel: 'telegram',
          address: '12345',
          enabled: false,
          activeFrom: new Date('2026-09-01T00:00:00Z'),
        },
      ],
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('ignores mail older than the lookback window', async () => {
    const harness = makeHarness({
      conversations: [conversationRow({ sendTime: LAST_WEEK })],
      messages: [messageRow({ sendTime: LAST_WEEK })],
    });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(harness.send).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('ignores mail that predates the subscription, so signing up sends no backlog', async () => {
    const harness = makeHarness({
      env: { INBOX_NOTIFY_LOOKBACK_HOURS: '720' },
      recipients: [
        {
          userId: USER_A,
          studentGuid: 'stu-1',
          channel: 'telegram',
          address: '12345',
          enabled: true,
          // Linked ten minutes ago; the message arrived an hour ago.
          activeFrom: new Date('2026-11-17T12:50:00Z'),
        },
      ],
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('does not notify about a conversation already read in the app', async () => {
    const harness = makeHarness({
      conversations: [conversationRow({ locallyReadThroughAt: NOW })],
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('notifies when mail arrived after the parent marked the thread read', async () => {
    const harness = makeHarness({
      conversations: [
        conversationRow({ locallyReadThroughAt: new Date('2026-11-17T10:00:00Z') }),
      ],
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('does not notify about an archived conversation', async () => {
    const harness = makeHarness({
      conversations: [conversationRow({ labels: ['archived'] })],
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('does not notify a parent about their own reply', async () => {
    const harness = makeHarness({
      messages: [messageRow({ senderId: CONNECTION.upstreamUserId })],
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('falls back to isNew when the connection has no upstream user id', async () => {
    const quiet = makeHarness({
      connections: [{ id: 'conn-1', upstreamUserId: null }],
      messages: [messageRow({ isNew: false })],
    });
    await quiet.service.notifyAll({ now: NOW });
    expect(quiet.send).not.toHaveBeenCalled();

    const loud = makeHarness({
      connections: [{ id: 'conn-1', upstreamUserId: null }],
      messages: [messageRow({ isNew: true })],
    });
    await loud.service.notifyAll({ now: NOW });
    expect(loud.send).toHaveBeenCalledTimes(1);
  });

  it('reads only the mailboxes the parent owns', async () => {
    const harness = makeHarness({
      conversations: [conversationRow({ householdConnectionId: 'someone-elses' })],
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it('does not push an unattributed conversation into a chat', async () => {
    // The read scope admits `householdConnectionId: null` to EVERY caller by
    // design, because NULL means "ownership unknown" and hiding those rows
    // would empty the inbox on a deployment that has not re-synced. That rule
    // is right for a list view the parent chose to open. It is wrong for
    // outbound egress: two households both see the row, so a shared chat gets
    // the same mail twice, and in the worst case a stranger's mail is pushed
    // into a parent's Telegram -- which is forwardable and permanent in a way
    // a list view is not.
    const harness = makeHarness({
      conversations: [conversationRow({ householdConnectionId: null })],
      messages: [messageRow({ householdConnectionId: null })],
    });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(harness.send).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('reads only conversations stamped to the parent’s own connections', async () => {
    const harness = makeHarness();

    await harness.service.notifyAll({ now: NOW });

    const where = (harness.prisma.mailConversation.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.householdConnectionId).toEqual({ in: ['conn-1'] });
    expect(JSON.stringify(where)).not.toContain('null');
  });

  it('claims before sending and confirms afterwards', async () => {
    const harness = makeHarness();

    await harness.service.notifyAll({ now: NOW });

    expect(harness.createMany).toHaveBeenCalledTimes(1);
    const claimed = harness.createMany.mock.calls[0][0];
    expect(claimed.skipDuplicates).toBe(true);
    expect(claimed.data[0]).toMatchObject({
      userId: USER_A,
      channel: 'telegram',
      address: '12345',
      messageId: 'msg-1',
      conversationId: 'conv-1',
      notifiedFor: TODAY,
    });
    expect(claimed.data[0].contentHash).toEqual(expect.any(String));

    const confirms = harness.notifiedUpdateMany.mock.calls.filter(
      (call) => call[0].data.confirmedAt instanceof Date,
    );
    expect(confirms).toHaveLength(1);
    expect(confirms[0][0].where).toMatchObject({ userId: USER_A, address: '12345' });
    expect(confirms[0][0].data.claimedBy).toBeNull();
  });

  it('releases the claim when the send fails, so the next run retries', async () => {
    const harness = makeHarness({
      sendImpl: jest.fn().mockRejectedValue(new Error('Telegram send failed: HTTP 502')),
    });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(harness.notifiedDeleteMany).toHaveBeenCalledTimes(1);
    expect(
      harness.notifiedUpdateMany.mock.calls.filter(
        (call) => call[0].data.confirmedAt instanceof Date,
      ),
    ).toHaveLength(0);
    expect(results[0].status).toBe('failed');
  });

  it('keeps the messages it already delivered when a later one fails', async () => {
    // The whole batch used to be released on any failure, so the next tick
    // re-sent the ones that had already arrived -- every ten minutes, for as
    // long as a sustained 429 or an upstream 5xx window lasted.
    const messages = ['a', 'b', 'c', 'd'].map((id) => messageRow({ messageId: id }));
    let calls = 0;
    const harness = makeHarness({
      messages,
      sendImpl: jest.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 3) throw new Error('Telegram send failed: HTTP 500');
        return Promise.resolve();
      }),
    });

    await harness.service.notifyAll({ now: NOW });

    // Two arrived before the failure; both must stay confirmed.
    const confirms = harness.notifiedUpdateMany.mock.calls.filter(
      (call) => call[0].data.confirmedAt instanceof Date,
    );
    expect(confirms).toHaveLength(1);
    expect(confirms[0][0].where.contentHash.in).toHaveLength(2);
    // Only the two that never arrived are released.
    expect(harness.notifiedDeleteMany).toHaveBeenCalledTimes(1);
    expect(harness.notifiedDeleteMany.mock.calls[0][0].where.contentHash.in).toHaveLength(2);
  });

  it('releases the whole batch when the very first send fails', async () => {
    const messages = ['a', 'b'].map((id) => messageRow({ messageId: id }));
    const harness = makeHarness({
      messages,
      sendImpl: jest.fn().mockRejectedValue(new Error('Telegram send failed: HTTP 502')),
    });

    await harness.service.notifyAll({ now: NOW });

    expect(
      harness.notifiedUpdateMany.mock.calls.filter(
        (call) => call[0].data.confirmedAt instanceof Date,
      ),
    ).toHaveLength(0);
    expect(harness.notifiedDeleteMany.mock.calls[0][0].where.contentHash.in).toHaveLength(2);
  });

  it('counts the summary from what it owns, not from what it saw', async () => {
    // Six candidates, three of them owned by a concurrent run: telling the
    // parent "6 new messages" and logging text that was never sent is a
    // factually wrong message and a misleading run log.
    const messages = Array.from({ length: 6 }, (_, i) => messageRow({ messageId: `m${i}` }));
    const harness = makeHarness({
      messages,
      ownedMessageIds: ['m0', 'm1', 'm2'],
      env: { INBOX_NOTIFY_MAX_PER_RUN: '2' },
    });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(harness.send.mock.calls[0][1]).toContain('3');
    expect(harness.send.mock.calls[0][1]).not.toContain('6');
    expect(results[0].messageCount).toBe(3);
  });

  it('sends the messages themselves when the owned count is under the ceiling', async () => {
    // Six seen but three owned, with a ceiling of 5: summarizing on the seen
    // count would replace three perfectly sendable messages with a summary.
    const messages = Array.from({ length: 6 }, (_, i) => messageRow({ messageId: `m${i}` }));
    const harness = makeHarness({ messages, ownedMessageIds: ['m0', 'm1', 'm2'] });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(results[0].summarized).toBe(false);
    expect(harness.send).toHaveBeenCalledTimes(3);
  });

  it('retires a chat Telegram refused permanently instead of retrying forever', async () => {
    const harness = makeHarness({
      sendImpl: jest
        .fn()
        .mockRejectedValue(
          new Error('Telegram send failed: Forbidden: bot was blocked by the user'),
        ),
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.recipientUpdateMany).toHaveBeenCalledWith({
      where: { userId: USER_A, channel: 'telegram', address: '12345' },
      data: { enabled: false },
    });
    // Confirmed, not released: there is nowhere left to retry to.
    expect(
      harness.notifiedUpdateMany.mock.calls.filter(
        (call) => call[0].data.confirmedAt instanceof Date,
      ),
    ).toHaveLength(1);
    expect(harness.notifiedDeleteMany).not.toHaveBeenCalled();
  });

  it('keeps one refused chat from undoing the chat that did receive it', async () => {
    const harness = makeHarness({
      recipients: ['dead', 'live'].map((address) => ({
        userId: USER_A,
        studentGuid: 'stu-1',
        channel: 'telegram',
        address,
        enabled: true,
        activeFrom: new Date('2026-09-01T00:00:00Z'),
      })),
      sendImpl: jest.fn().mockImplementation((address: string) => {
        if (address === 'dead') throw new Error('Telegram send failed: HTTP 502');
        return Promise.resolve();
      }),
    });

    const results = await harness.service.notifyAll({ now: NOW });

    // The digest is all-or-nothing per child; this is per address, which is
    // what lets the surviving chat keep its confirmation.
    expect(results.find((r) => r.address === 'live')?.status).toBe('sent');
    expect(results.find((r) => r.address === 'dead')?.status).toBe('failed');
    expect(harness.notifiedDeleteMany.mock.calls[0][0].where.address).toBe('dead');
    const confirms = harness.notifiedUpdateMany.mock.calls.filter(
      (call) => call[0].data.confirmedAt instanceof Date,
    );
    expect(confirms).toHaveLength(1);
    expect(confirms[0][0].where.address).toBe('live');
  });

  it('takes over only a claim that has gone stale', async () => {
    const harness = makeHarness();

    await harness.service.notifyAll({ now: NOW });

    const takeover = harness.notifiedUpdateMany.mock.calls.find(
      (call) => call[0].data.confirmedAt === null,
    );
    expect(takeover).toBeDefined();
    expect(takeover?.[0].where).toMatchObject({
      userId: USER_A,
      channel: 'telegram',
      address: '12345',
      confirmedAt: null,
    });
    // A run still working on its claim must not have it stolen.
    expect((takeover?.[0].where.claimedAt.lt as Date).getTime()).toBe(
      NOW.getTime() - STALE_CLAIM_MS,
    );
  });

  it('sends nothing the run does not own, even after claiming', async () => {
    // The createMany count says how many rows were won, never which.
    const harness = makeHarness({ ownedMessageIds: [] });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(harness.send).not.toHaveBeenCalled();
    expect(results[0]?.status ?? 'skipped_empty').toBe('skipped_empty');
  });

  it('stays silent during quiet hours and holds the mail over', async () => {
    const harness = makeHarness();

    // 02:00 Jerusalem.
    const results = await harness.service.notifyAll({ now: new Date('2026-11-17T00:00:00Z') });

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.createMany).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('sends the held-over mail once the quiet window closes', async () => {
    const harness = makeHarness({
      conversations: [conversationRow({ sendTime: new Date('2026-11-17T00:00:00Z') })],
      messages: [messageRow({ sendTime: new Date('2026-11-17T00:00:00Z') })],
    });

    // 08:00 Jerusalem, six hours after the mail arrived at 02:00.
    await harness.service.notifyAll({ now: new Date('2026-11-17T06:00:00Z') });

    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('claims nothing on a dry run', async () => {
    // A dry run that claimed would make the first real run find nothing to say.
    const harness = makeHarness({ env: { INBOX_NOTIFY_DRY_RUN: 'true' } });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(harness.createMany).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: 'dry_run', messageCount: 1 });
  });

  it('defaults to a dry run, so a first deploy messages nobody by accident', async () => {
    const harness = makeHarness({ env: { INBOX_NOTIFY_DRY_RUN: undefined as unknown as string } });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(results[0].status).toBe('dry_run');
  });

  it('sends one summary instead of a burst when a run finds too much', async () => {
    const messages = Array.from({ length: 9 }, (_, i) =>
      messageRow({ messageId: `msg-${i}`, subject: `הודעה ${i}` }),
    );
    const harness = makeHarness({ messages });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send.mock.calls[0][1]).toContain('9');
    expect(harness.send.mock.calls[0][1]).toContain('הודעות חדשות');
    expect(results[0]).toMatchObject({ summarized: true, messageCount: 9 });
    // The whole batch is claimed, so the next run does not re-send it one by one.
    expect(harness.createMany.mock.calls[0][0].data).toHaveLength(9);
  });

  it('honours INBOX_NOTIFY_MAX_PER_RUN', async () => {
    const messages = Array.from({ length: 2 }, (_, i) => messageRow({ messageId: `msg-${i}` }));
    const harness = makeHarness({ messages, env: { INBOX_NOTIFY_MAX_PER_RUN: '1' } });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(results[0].summarized).toBe(true);
  });

  it('writes a run-log row naming no child', async () => {
    const harness = makeHarness();

    await harness.service.notifyAll({ now: NOW });

    expect(harness.deliveryCreate).toHaveBeenCalledTimes(1);
    expect(harness.deliveryCreate.mock.calls[0][0].data).toMatchObject({
      userId: USER_A,
      studentGuid: null,
      kind: 'inbox',
      status: 'sent',
      itemCount: 1,
      recipientCount: 1,
      channel: 'telegram',
      reportFor: TODAY,
    });
  });

  it('writes no run-log row when there is nothing new', async () => {
    // The cron fires 144 times a day. A row per quiet tick per parent would
    // bury the history this table exists to make readable.
    const harness = makeHarness({ messages: [] });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.deliveryCreate).not.toHaveBeenCalled();
  });

  it('runs only the parent the caller named', async () => {
    const harness = makeHarness({
      recipients: [
        {
          userId: 'user-b',
          studentGuid: 'stu-9',
          channel: 'telegram',
          address: '99999',
          enabled: true,
          activeFrom: new Date('2026-09-01T00:00:00Z'),
        },
      ],
    });

    await harness.service.notifyAll({ now: NOW, userId: USER_A });

    expect(harness.send).not.toHaveBeenCalled();
  });
});

describe('InboxNotifyService media', () => {
  const withFile = (
    overrides: Record<string, unknown> = {},
    fileName = 'אישור הורים.pdf',
  ) => messageRow({ files: [{ fileId: 'file-1', fileName }], ...overrides });

  it('sends the text first and the file after it', async () => {
    // The text message is the only thing gating ledger confirmation, so it
    // goes out before anything that might fail.
    const harness = makeHarness({ messages: [withFile()] });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.mediaSend).toHaveBeenCalledTimes(1);
    expect(harness.send.mock.invocationCallOrder[0]).toBeLessThan(
      harness.mediaSend.mock.invocationCallOrder[0],
    );
  });

  it('asks for the file as the subscribing parent, through the media token', async () => {
    const harness = makeHarness({ messages: [withFile()] });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.mediaFetch).toHaveBeenCalledWith(
      USER_A,
      [
        {
          kind: 'mail',
          ownerId: 'conv-1',
          itemId: 'msg-1',
          fileId: 'file-1',
          fileName: 'אישור הורים.pdf',
          caption: '📎 אישור הורים.pdf · יום ספורט ביום חמישי',
          captionParseMode: 'HTML',
        },
      ],
      expect.any(Number),
    );
  });

  it('keeps a caption built from a huge filename and subject inside the ceiling', async () => {
    const harness = makeHarness({
      messages: [withFile({ subject: 'ב'.repeat(4000) }, `${'א'.repeat(4000)}.pdf`)],
    });

    await harness.service.notifyAll({ now: NOW });

    const caption = harness.mediaFetch.mock.calls[0][1][0].caption as string;
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption).not.toMatch(/&[a-z]{0,4}$/);
    expect(caption).not.toMatch(/<[^>]*$/);
  });

  it('sends the notification text as HTML, so the layout renders', async () => {
    const harness = makeHarness({ messages: [withFile()] });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send.mock.calls[0][2]).toEqual({ parseMode: 'HTML' });
  });

  it('names a file it could not send in the text, before sending the text', async () => {
    const harness = makeHarness({
      messages: [withFile()],
      media: {
        fetch: jest.fn().mockResolvedValue({
          items: [
            {
              ref: { fileName: 'אישור הורים.pdf' },
              tooLarge: true,
              note: 'file too large to send',
            },
          ],
          remainingBytes: 0,
        }),
      },
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send.mock.calls[0][1]).toContain('קובץ גדול מדי לשליחה: אישור הורים.pdf');
  });

  it('records a media failure as a note on the delivery row, not as a failure', async () => {
    const harness = makeHarness({
      messages: [withFile()],
      media: { send: jest.fn().mockResolvedValue({ sent: 0, notes: ['אישור הורים.pdf: HTTP 500'] }) },
    });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(results[0].status).toBe('sent');
    expect(harness.deliveryCreate.mock.calls[0][0].data.errorMessage).toContain('HTTP 500');
  });

  it('does not touch the attachments when the media binding is disabled', async () => {
    const harness = makeHarness({
      messages: [withFile()],
      media: { enabled: false, fetch: jest.fn(), send: jest.fn() },
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.mediaFetch).not.toHaveBeenCalled();
  });

  it('sends no media at all with a summary message', async () => {
    // A summary stands in for nine messages; uploading nine files under it
    // would defeat the point of summarizing.
    const messages = Array.from({ length: 9 }, (_, i) =>
      messageRow({ messageId: `msg-${i}`, files: [{ fileId: `f${i}`, fileName: `a${i}.pdf` }] }),
    );
    const harness = makeHarness({ messages });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.mediaSend).not.toHaveBeenCalled();
  });

  it('skips the media when the send of the text failed', async () => {
    const harness = makeHarness({
      messages: [withFile()],
      sendImpl: jest.fn().mockRejectedValue(new Error('Telegram send failed: HTTP 502')),
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.mediaSend).not.toHaveBeenCalled();
  });
});

describe('InboxNotifyService hydration', () => {
  const metadataOnly = () =>
    messageRow({ bodyHtmlSanitized: null, bodyTextPreview: null, files: [] });

  it('fetches the conversation detail when the row has no body yet', async () => {
    // MailInboxTask stores message METADATA ONLY -- the inbox list payload
    // carries no `body` and no `files` at all
    // (apis/get-api-mail-inbox-conversations.md). Bodies and attachments are
    // written only when the parent opens the thread in the app. Without this,
    // every notification about mail nobody has opened -- which is every mail
    // this feature exists to announce -- is a header, a subject and nothing
    // else, and no attachment is ever forwarded.
    const harness = makeHarness({ messages: [metadataOnly()] });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.hydrate).toHaveBeenCalledWith('conv-1', USER_A);
  });

  it('re-reads the message after hydrating, so the body reaches the chat', async () => {
    let hydrated = false;
    const harness = makeHarness({
      messages: [metadataOnly()],
      hydrate: jest.fn().mockImplementation(() => {
        hydrated = true;
        return Promise.resolve();
      }),
    });
    // The second read is what the service must do its rendering from.
    (harness.prisma.mailMessage.findMany as jest.Mock).mockImplementation(() =>
      Promise.resolve([
        hydrated
          ? messageRow({ bodyHtmlSanitized: '<p>נבקש להביא בגדי ספורט.</p>' })
          : metadataOnly(),
      ]),
    );

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send.mock.calls[0][1]).toContain('נבקש להביא בגדי ספורט.');
  });

  it('asks only once for a conversation two chats both need', async () => {
    const harness = makeHarness({
      messages: [metadataOnly()],
      recipients: ['111', '222'].map((address) => ({
        userId: USER_A,
        studentGuid: 'stu-1',
        channel: 'telegram',
        address,
        enabled: true,
        activeFrom: new Date('2026-09-01T00:00:00Z'),
      })),
    });

    await harness.service.notifyAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.hydrate).toHaveBeenCalledTimes(1);
  });

  it('does not hydrate a message that already has a body', async () => {
    const harness = makeHarness();

    await harness.service.notifyAll({ now: NOW });

    expect(harness.hydrate).not.toHaveBeenCalled();
  });

  it('still sends the header when hydration fails, rather than nothing', async () => {
    // Upstream being down must not cost the parent the notification; they at
    // least learn mail arrived, from whom, about what.
    const harness = makeHarness({
      messages: [metadataOnly()],
      hydrate: jest.fn().mockRejectedValue(new Error('403 from Mashov')),
    });

    const results = await harness.service.notifyAll({ now: NOW });

    expect(results[0].status).toBe('sent');
    expect(harness.send.mock.calls[0][1]).toContain('יום ספורט ביום חמישי');
  });
});
