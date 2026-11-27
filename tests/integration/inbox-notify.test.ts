/**
 * Inbox notifications — integration tests.
 *
 * These run against a real Postgres because the guarantee being proved is a
 * database-level one that a mocked Prisma cannot show: the unique constraint on
 * `mail_notified_message` is the whole at-most-once mechanism. ADR-0017 rules
 * out a Redis lock, so nothing else holds the line — run the notifier twice
 * and the second run must be silent, and a genuinely new message must still get
 * through.
 *
 * Per the project's own hard-won lesson, every env value this needs is pinned
 * in `beforeAll` rather than inherited from `.env`: a config-driven test that
 * reads a developer's file passes locally and fails in the container.
 */

import { PrismaClient } from '../../backend/node_modules/@prisma/client';
import { InboxNotifyService } from '../../backend/src/inbox-notify/inbox-notify.service';
import type { PrismaService } from '../../backend/src/prisma/prisma.service';
import type { ConfigService } from '../../backend/node_modules/@nestjs/config';
import type {
  DigestSender,
  TelegramSendOptions,
} from '../../backend/src/digest/senders/digest-sender.interface';

const USER_ID = 'inbox-notify-user-1';
const MASHOV_USER_ID = 'inbox-notify-mashov-1';
const CONNECTION_ID = 'inbox-notify-conn-1';
const CONVERSATION_ID = 'inbox-notify-conv-1';
const CHAT = '424242';
const TIMEZONE = 'Asia/Jerusalem';

/**
 * 15:00 Jerusalem on a fixed date, well clear of the quiet window.
 *
 * Fixed rather than `new Date()`: a suite that ran between 21:00 and 07:00
 * Israel time would otherwise be held over and assert nothing.
 */
const NOW = new Date('2026-11-17T13:00:00Z');
const AN_HOUR_AGO = new Date('2026-11-17T12:00:00Z');

/** Captures what would have been delivered, so assertions can read the text. */
class CapturingSender implements DigestSender {
  readonly channel = 'telegram';
  readonly sent: { address: string; text: string; options?: TelegramSendOptions }[] = [];

  async send(address: string, text: string, options?: TelegramSendOptions): Promise<void> {
    this.sent.push({ address, text, options });
  }
}

/**
 * Pinned, never inherited. `INBOX_NOTIFY_DRY_RUN` is the one that matters
 * most: the service defaults it to true, so a test that let it default would
 * assert on a run that claimed nothing and sent nothing.
 */
function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    DIGEST_TIMEZONE: TIMEZONE,
    INBOX_NOTIFY_DRY_RUN: 'false',
    INBOX_NOTIFY_LOOKBACK_HOURS: '24',
    INBOX_NOTIFY_MAX_PER_RUN: '5',
    INBOX_NOTIFY_BODY_CHARS: '700',
    INBOX_NOTIFY_QUIET_FROM: '21:00',
    INBOX_NOTIFY_QUIET_TO: '07:00',
    PUBLIC_BASE_URL: 'https://mashov.example',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('Inbox notifications', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    await prisma.$connect();
  });

  /**
   * Cleans up, and not only out of tidiness.
   *
   * These suites share one Postgres, and `DigestService.runAll()` with no
   * userId -- which is what the cron does, and what `digest.test.ts` exercises
   * -- enumerates EVERY parent's `digest_recipient` rows. A leaked row here
   * therefore shows up as a `skipped_unowned` result in another suite's run
   * and fails an assertion that has nothing to do with mail.
   */
  afterAll(async () => {
    await prisma.mailNotifiedMessage.deleteMany({ where: { userId: USER_ID } });
    await prisma.digestDelivery.deleteMany({ where: { userId: USER_ID } });
    await prisma.digestRecipient.deleteMany({ where: { userId: USER_ID } });
    await prisma.mailMessage.deleteMany({ where: { conversationId: CONVERSATION_ID } });
    await prisma.mailConversation.deleteMany({ where: { conversationId: CONVERSATION_ID } });
    await prisma.householdConnection.deleteMany({ where: { id: CONNECTION_ID } });
    await prisma.appUser.deleteMany({ where: { id: USER_ID } });
    await prisma.$disconnect();
  });

  function makeService(sender: DigestSender, config = makeConfig()) {
    return new InboxNotifyService(prisma as unknown as PrismaService, config, sender);
  }

  async function addMessage(messageId: string, overrides: Record<string, unknown> = {}) {
    await prisma.mailMessage.create({
      data: {
        messageId,
        conversationId: CONVERSATION_ID,
        senderId: 'school-secretary',
        senderName: 'מזכירות בית הספר',
        subject: 'יום ספורט ביום חמישי',
        bodyHtmlSanitized: '<p>נבקש להביא בגדי ספורט.</p>',
        bodyTextPreview: 'נבקש להביא בגדי ספורט.',
        sendTime: AN_HOUR_AGO,
        isNew: true,
        householdConnectionId: CONNECTION_ID,
        ...overrides,
      },
    });
  }

  beforeEach(async () => {
    await prisma.mailNotifiedMessage.deleteMany({ where: { userId: USER_ID } });
    await prisma.digestDelivery.deleteMany({ where: { userId: USER_ID } });
    await prisma.digestRecipient.deleteMany({ where: { userId: USER_ID } });
    await prisma.mailMessage.deleteMany({ where: { conversationId: CONVERSATION_ID } });
    await prisma.mailConversation.deleteMany({ where: { conversationId: CONVERSATION_ID } });
    await prisma.householdConnection.deleteMany({ where: { id: CONNECTION_ID } });
    await prisma.appUser.deleteMany({ where: { id: USER_ID } });

    await prisma.appUser.create({
      data: {
        id: USER_ID,
        mashovUserId: MASHOV_USER_ID,
        semel: 997755,
        username: 'inbox-notify-test',
        displayName: 'Inbox Notify Test',
      },
    });

    await prisma.householdConnection.create({
      data: {
        id: CONNECTION_ID,
        userId: USER_ID,
        schoolCode: 997755,
        schoolYear: 2027,
        username: 'inbox-notify-login',
        encryptedPassword: 'not-a-real-secret',
        upstreamUserId: 'parent-upstream',
        active: true,
      },
    });

    await prisma.mailConversation.create({
      data: {
        conversationId: CONVERSATION_ID,
        subject: 'יום ספורט ביום חמישי',
        sendTime: AN_HOUR_AGO,
        isUnread: true,
        householdConnectionId: CONNECTION_ID,
      },
    });

    await addMessage('inbox-notify-msg-1');

    await prisma.digestRecipient.create({
      data: {
        userId: USER_ID,
        studentGuid: 'inbox-notify-child',
        channel: 'telegram',
        address: CHAT,
        enabled: true,
        activeFrom: new Date('2026-09-01T00:00:00Z'),
      },
    });
  });

  it('sends the new mail once and records exactly one ledger row', async () => {
    const sender = new CapturingSender();

    const results = await makeService(sender).notifyAll({ now: NOW });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'sent', messageCount: 1, address: CHAT });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).toContain('דואר חדש מבית הספר');
    expect(sender.sent[0].text).toContain('נבקש להביא בגדי ספורט.');
    // The URL is an anchor's href, not a bare line: the link is anchored on
    // words the parent reads. See ADR-0047.
    expect(sender.sent[0].text).toContain(
      `<a href="https://mashov.example/inbox/${CONVERSATION_ID}">לפתוח את ההודעה</a>`,
    );
    expect(sender.sent[0].options).toEqual({ parseMode: 'HTML' });
    // Structure, and still not one word of model prose: the school wrote the
    // mail, and their words are quoted rather than summarized.
    expect(sender.sent[0].text).toContain('📬 <b>דואר חדש מבית הספר</b>');
    expect(sender.sent[0].text).toContain('<blockquote>');

    const ledger = await prisma.mailNotifiedMessage.findMany({ where: { userId: USER_ID } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].confirmedAt).not.toBeNull();
    expect(ledger[0].claimedBy).toBeNull();
  });

  it('is silent on the second run', async () => {
    const first = new CapturingSender();
    await makeService(first).notifyAll({ now: NOW });
    expect(first.sent).toHaveLength(1);

    const second = new CapturingSender();
    const results = await makeService(second).notifyAll({ now: NOW });

    expect(second.sent).toHaveLength(0);
    expect(results.every((result) => result.status === 'skipped_empty')).toBe(true);
    expect(await prisma.mailNotifiedMessage.count({ where: { userId: USER_ID } })).toBe(1);
  });

  it('sends again when a genuinely new message arrives', async () => {
    await makeService(new CapturingSender()).notifyAll({ now: NOW });

    await addMessage('inbox-notify-msg-2', { subject: 'אסיפת הורים' });

    const sender = new CapturingSender();
    await makeService(sender).notifyAll({ now: NOW });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).toContain('<b>אסיפת הורים</b>');
    expect(await prisma.mailNotifiedMessage.count({ where: { userId: USER_ID } })).toBe(2);
  });

  it('writes a run-log row that names no child', async () => {
    await makeService(new CapturingSender()).notifyAll({ now: NOW });

    const rows = await prisma.digestDelivery.findMany({ where: { userId: USER_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('inbox');
    expect(rows[0].studentGuid).toBeNull();
    expect(rows[0].status).toBe('sent');
  });

  it('claims nothing on a dry run, so the first real run still has news', async () => {
    const dry = new CapturingSender();
    await makeService(dry, makeConfig({ INBOX_NOTIFY_DRY_RUN: 'true' })).notifyAll({ now: NOW });

    expect(dry.sent).toHaveLength(0);
    expect(await prisma.mailNotifiedMessage.count({ where: { userId: USER_ID } })).toBe(0);

    const real = new CapturingSender();
    await makeService(real).notifyAll({ now: NOW });
    expect(real.sent).toHaveLength(1);
  });

  it('holds mail over through the quiet window rather than dropping it', async () => {
    // 02:00 Jerusalem, inside the default window.
    const quiet = new CapturingSender();
    await makeService(quiet).notifyAll({ now: new Date('2026-11-17T00:00:00Z') });
    expect(quiet.sent).toHaveLength(0);
    expect(await prisma.mailNotifiedMessage.count({ where: { userId: USER_ID } })).toBe(0);

    const morning = new CapturingSender();
    await makeService(morning).notifyAll({ now: NOW });
    expect(morning.sent).toHaveLength(1);
  });

  it('leaves the claims behind when the send fails, so the next run retries', async () => {
    const failing: DigestSender = {
      channel: 'telegram',
      send: async () => {
        throw new Error('Telegram send failed: HTTP 502');
      },
    };

    const results = await makeService(failing).notifyAll({ now: NOW });

    expect(results[0].status).toBe('failed');
    expect(await prisma.mailNotifiedMessage.count({ where: { userId: USER_ID } })).toBe(0);

    const retry = new CapturingSender();
    await makeService(retry).notifyAll({ now: NOW });
    expect(retry.sent).toHaveLength(1);
  });

  it('retires a chat Telegram refused permanently instead of retrying it forever', async () => {
    const blocked: DigestSender = {
      channel: 'telegram',
      send: async () => {
        throw new Error('Telegram send failed: Forbidden: bot was blocked by the user');
      },
    };

    await makeService(blocked).notifyAll({ now: NOW });

    const recipient = await prisma.digestRecipient.findFirst({ where: { userId: USER_ID } });
    expect(recipient?.enabled).toBe(false);
    // Confirmed rather than released: there is nowhere left to retry to.
    const ledger = await prisma.mailNotifiedMessage.findMany({ where: { userId: USER_ID } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].confirmedAt).not.toBeNull();
  });

  it('does not notify a parent about their own reply', async () => {
    await prisma.mailMessage.deleteMany({ where: { conversationId: CONVERSATION_ID } });
    await addMessage('inbox-notify-own-reply', { senderId: 'parent-upstream' });

    const sender = new CapturingSender();
    const results = await makeService(sender).notifyAll({ now: NOW });

    expect(sender.sent).toHaveLength(0);
    expect(results).toEqual([]);
  });

  it('does not notify about a conversation already read in the app', async () => {
    await prisma.mailConversation.update({
      where: { conversationId: CONVERSATION_ID },
      data: { locallyReadThroughAt: NOW },
    });

    const sender = new CapturingSender();
    await makeService(sender).notifyAll({ now: NOW });

    expect(sender.sent).toHaveLength(0);
  });

  it('sends one summary rather than a burst above the per-run ceiling', async () => {
    for (let i = 2; i <= 8; i += 1) {
      await addMessage(`inbox-notify-msg-${i}`, { subject: `הודעה ${i}` });
    }

    const sender = new CapturingSender();
    const results = await makeService(sender).notifyAll({ now: NOW });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].text).toContain('הודעות חדשות');
    expect(results[0].summarized).toBe(true);
    // The whole batch is claimed, so the next run does not send them one by one.
    expect(await prisma.mailNotifiedMessage.count({ where: { userId: USER_ID } })).toBe(8);

    const second = new CapturingSender();
    await makeService(second).notifyAll({ now: NOW });
    expect(second.sent).toHaveLength(0);
  });

  it('keeps the messages it delivered when a later one fails, and sends only the rest next time', async () => {
    // The Critical finding from review. The whole batch used to be released on
    // any failure, so the next tick re-sent the ones that had already arrived
    // -- every ten minutes, for as long as a 429 or a 5xx window lasted.
    await addMessage('inbox-notify-msg-2', { subject: 'אסיפת הורים' });
    await addMessage('inbox-notify-msg-3', { subject: 'טיול שנתי' });

    let calls = 0;
    const partial: DigestSender = {
      channel: 'telegram',
      send: async () => {
        calls += 1;
        if (calls === 3) throw new Error('Telegram send failed: HTTP 500');
      },
    };

    await makeService(partial).notifyAll({ now: NOW });

    // Two delivered, two confirmed; the third left for the next run.
    const ledger = await prisma.mailNotifiedMessage.findMany({ where: { userId: USER_ID } });
    expect(ledger).toHaveLength(2);
    expect(ledger.every((row) => row.confirmedAt !== null)).toBe(true);

    const retry = new CapturingSender();
    await makeService(retry).notifyAll({ now: NOW });

    expect(retry.sent).toHaveLength(1);
    expect(await prisma.mailNotifiedMessage.count({ where: { userId: USER_ID } })).toBe(3);
  });

  it('does not notify about a conversation no connection owns', async () => {
    // Stricter than householdMailScope on purpose: a NULL-stamped row matches
    // every household, so pushing it would hand a shared chat the same mail
    // twice and could put a stranger's mail in a parent's Telegram.
    await prisma.mailConversation.update({
      where: { conversationId: CONVERSATION_ID },
      data: { householdConnectionId: null },
    });

    const sender = new CapturingSender();
    const results = await makeService(sender).notifyAll({ now: NOW });

    expect(sender.sent).toHaveLength(0);
    expect(results).toEqual([]);
  });

  it('sends once to a chat the parent linked for three children', async () => {
    for (const studentGuid of ['inbox-notify-child-2', 'inbox-notify-child-3']) {
      await prisma.digestRecipient.create({
        data: {
          userId: USER_ID,
          studentGuid,
          channel: 'telegram',
          address: CHAT,
          enabled: true,
          activeFrom: new Date('2026-09-01T00:00:00Z'),
        },
      });
    }

    const sender = new CapturingSender();
    await makeService(sender).notifyAll({ now: NOW });

    expect(sender.sent).toHaveLength(1);
  });
});
