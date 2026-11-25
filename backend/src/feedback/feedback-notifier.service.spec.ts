import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { FeedbackTelegramSender } from './feedback-telegram.sender';
import {
  FEEDBACK_NOTIFY_MAX_ATTEMPTS,
  FeedbackNotifierService,
  type FeedbackOutboxRow,
} from './feedback-notifier.service';

function row(overrides: Partial<FeedbackOutboxRow> = {}): FeedbackOutboxRow {
  return {
    id: 'fb-1',
    subject: 'bug',
    subjectOther: null,
    contactEmail: 'parent@example.com',
    content: 'המערכת לא מציגה ציונים',
    pagePath: '/children/abc',
    appVersion: '1.4.2',
    displayName: 'קורס דמיטרי',
    username: 'parent-one',
    schoolsSnapshot: [
      { id: 'c1', schoolCode: 540175, schoolName: 'תיכון הרצוג', label: 'הרצוג', schoolYear: 2026 },
    ],
    createdAt: new Date('2026-11-28T08:30:00.000Z'),
    notifyAttempts: 0,
    ...overrides,
  };
}

function build(
  options: { chatId?: string; baseUrl?: string; maxPerRun?: string; hasToken?: boolean } = {},
) {
  const findMany = jest.fn();
  const update = jest.fn().mockResolvedValue({});
  const prisma = { feedback: { findMany, update } } as unknown as PrismaService;

  const env: Record<string, string | undefined> = {
    FEEDBACK_TELEGRAM_CHAT_ID: options.chatId,
    PUBLIC_BASE_URL: options.baseUrl,
    FEEDBACK_NOTIFY_MAX_PER_RUN: options.maxPerRun,
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;

  const send = jest.fn().mockResolvedValue(undefined);
  // The feedback bot, not the parent-facing one. `hasToken` is what the outbox
  // gates on, so it defaults to configured and the token tests turn it off.
  const hasToken = jest.fn().mockReturnValue(options.hasToken ?? true);
  const telegram = {
    channel: 'telegram',
    send,
    hasToken,
  } as unknown as FeedbackTelegramSender;

  const service = new FeedbackNotifierService(prisma, config, telegram);
  // The run logs a retirement; silence it so a passing suite stays readable.
  // Returned as well, because "one log line per run, not one per row" is
  // itself an assertion in the destination-failure tests below.
  const logError = jest
    .spyOn(
      (service as unknown as { logger: { error: (message: string) => void } }).logger,
      'error',
    )
    .mockImplementation(() => undefined);

  return { service, findMany, update, send, hasToken, logError };
}

describe('FeedbackNotifierService', () => {
  describe('buildMessage', () => {
    it('includes the subject, reporter, schools, context and the row id', () => {
      const { service } = build();
      const text = service.buildMessage(row(), null);

      expect(text).toContain('bug');
      expect(text).toContain('קורס דמיטרי');
      expect(text).toContain('parent-one');
      expect(text).toContain('parent@example.com');
      expect(text).toContain('הרצוג');
      expect(text).toContain('540175');
      expect(text).toContain('/children/abc');
      expect(text).toContain('1.4.2');
      expect(text).toContain('המערכת לא מציגה ציונים');
      expect(text).toContain('fb-1');
    });

    it("spells out the parent's own wording behind the 'other' subject", () => {
      const { service } = build();
      const text = service.buildMessage(
        row({ subject: 'other', subjectOther: 'משהו אחר לגמרי' }),
        null,
      );
      expect(text).toContain('משהו אחר לגמרי');
    });

    it('omits the email line entirely when the parent cleared it', () => {
      const { service } = build();
      const text = service.buildMessage(row({ contactEmail: null }), null);
      expect(text).not.toMatch(/Email:/);
      expect(text).not.toContain('none');
    });

    it('appends a deep link when a public base url is configured', () => {
      const { service } = build();
      const text = service.buildMessage(row(), 'https://mashov.example.com');
      expect(text).toContain('https://mashov.example.com/admin/feedback/fb-1');
    });

    it('renders no link line at all when the base url is unset', () => {
      const { service } = build();
      const text = service.buildMessage(row(), null);
      expect(text).not.toContain('/admin/feedback/');
    });

    it('truncates long content rather than relying on the chunker', () => {
      const { service } = build();
      const text = service.buildMessage(row({ content: 'א'.repeat(3000) }), null);
      expect(text.length).toBeLessThan(1500);
      expect(text).toContain('…');
    });

    it('says so when the household has no active school', () => {
      const { service } = build();
      const text = service.buildMessage(row({ schoolsSnapshot: [] }), null);
      expect(text).toContain('Schools: none');
    });

    it('survives a schoolsSnapshot that is not the shape we wrote', () => {
      // Json column: `db push` never validated it and a hand-edited row can
      // hold anything. A notifier that throws here would retire the report.
      const { service } = build();
      const text = service.buildMessage(
        row({ schoolsSnapshot: 'not an array' as unknown as FeedbackOutboxRow['schoolsSnapshot'] }),
        null,
      );
      expect(text).toContain('Schools: none');
    });
  });

  describe('deliverPending', () => {
    it('sends nothing and queries nothing when no chat id is configured', async () => {
      const { service, findMany, send } = build();

      const results = await service.deliverPending();

      expect(results).toEqual([]);
      expect(findMany).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('treats a blank chat id as unset', async () => {
      const { service, findMany } = build({ chatId: '   ' });
      expect(await service.deliverPending()).toEqual([]);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('delivers nothing when the feedback bot token is missing', async () => {
      // This is the one that protects the reports. A send without a token
      // throws, a throw costs the row an attempt, and three attempts retire it
      // for good -- so a stack with a chat id but no token would quietly
      // destroy every pending report within six minutes. The gate must come
      // before the query, not after the failure.
      const { service, findMany, send } = build({ chatId: '-100123', hasToken: false });

      expect(await service.deliverPending()).toEqual([]);
      expect(findMany).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('asks the sender for the token rather than reading the env var itself', async () => {
      const { service, hasToken } = build({ chatId: '-100123', hasToken: false });

      await service.deliverPending();

      expect(hasToken).toHaveBeenCalled();
    });

    it('selects undelivered rows under the attempt ceiling, oldest first', async () => {
      const { service, findMany } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([]);

      await service.deliverPending();

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            notifiedAt: null,
            notifyAttempts: { lt: FEEDBACK_NOTIFY_MAX_ATTEMPTS },
          },
          orderBy: { createdAt: 'asc' },
          take: 20,
        }),
      );
    });

    it('honours FEEDBACK_NOTIFY_MAX_PER_RUN and an explicit limit', async () => {
      const { service, findMany } = build({ chatId: '-100123', maxPerRun: '5' });
      findMany.mockResolvedValue([]);

      await service.deliverPending();
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));

      await service.deliverPending(2);
      expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 2 }));
    });

    it('stamps notifiedAt and clears the error after a successful send', async () => {
      const { service, findMany, update, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row({ notifyAttempts: 1, notifyError: 'earlier blip' })]);

      const results = await service.deliverPending();

      expect(send).toHaveBeenCalledWith('-100123', expect.stringContaining('fb-1'));
      expect(results).toEqual([{ id: 'fb-1', status: 'sent' }]);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: {
          notifiedAt: expect.any(Date),
          notifyAttempts: 2,
          notifyError: null,
        },
      });
    });

    it('records a transient failure and leaves the row for the next run', async () => {
      const { service, findMany, update, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row()]);
      send.mockRejectedValue(new Error('Telegram send failed: HTTP 502'));

      const results = await service.deliverPending();

      expect(results).toEqual([{ id: 'fb-1', status: 'failed' }]);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: {
          notifyAttempts: 1,
          notifyError: 'Telegram send failed: HTTP 502',
        },
      });
    });

    it('retires the row on the third failure', async () => {
      const { service, findMany, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row({ notifyAttempts: FEEDBACK_NOTIFY_MAX_ATTEMPTS - 1 })]);
      send.mockRejectedValue(new Error('Telegram send failed: HTTP 502'));

      expect(await service.deliverPending()).toEqual([{ id: 'fb-1', status: 'retired' }]);
    });

    it('retires a recipient-permanent failure immediately rather than spending three attempts', async () => {
      // A bot a USER blocked is permanently undeliverable and nothing an
      // operator can fix by editing config, so it still retires on the first
      // attempt. Destination-shaped refusals -- a channel the bot has not been
      // made an admin of -- are the opposite case and park instead; see the
      // describe block below.
      const { service, findMany, update, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row()]);
      send.mockRejectedValue(
        new Error('Telegram send failed: Forbidden: bot was blocked by the user'),
      );

      const results = await service.deliverPending();

      expect(results).toEqual([{ id: 'fb-1', status: 'retired' }]);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: {
          notifyAttempts: FEEDBACK_NOTIFY_MAX_ATTEMPTS,
          notifyError: 'Telegram send failed: Forbidden: bot was blocked by the user',
        },
      });
    });

    it('keeps going after one row fails, and never lets a throw escape', async () => {
      const { service, findMany, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row({ id: 'fb-1' }), row({ id: 'fb-2' })]);
      send
        .mockRejectedValueOnce(new Error('Telegram send failed: HTTP 502'))
        .mockResolvedValueOnce(undefined);

      await expect(service.deliverPending()).resolves.toEqual([
        { id: 'fb-1', status: 'failed' },
        { id: 'fb-2', status: 'sent' },
      ]);
    });

    it('does not unwind a send that succeeded when stamping the row fails', async () => {
      const { service, findMany, update } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row()]);
      update.mockRejectedValue(new Error('db gone'));

      // The message is already in the chat. The row stays undelivered and the
      // next run re-sends it -- a duplicate message is cheaper than a lost one.
      await expect(service.deliverPending()).resolves.toEqual([
        { id: 'fb-1', status: 'failed' },
      ]);
    });
  });
  describe('a destination that refuses the bot', () => {
    // The hazard this covers: a private channel refuses a non-admin bot with
    // "bot is not a member of the channel chat" / "need administrator rights
    // in the channel chat". Neither phrase is in PERMANENT_TELEGRAM_FAILURES,
    // so it classifies as transient -- three attempts, six minutes, then
    // retired for good. During rollout, with the token and chat id set before
    // the bot is made a channel admin, every report already waiting would
    // lose its notification permanently. A failure about the DESTINATION must
    // not consume the ROW's budget.
    const REFUSALS = [
      'Telegram send failed: Bad Request: chat not found',
      'Telegram send failed: Bad Request: bot is not a member of the channel chat',
      'Telegram send failed: Bad Request: need administrator rights in the channel chat',
      'Telegram send failed: Bad Request: CHAT_ADMIN_REQUIRED',
      'Telegram send failed: Forbidden: bot was kicked from the channel chat',
      // An admin WITHOUT the "Post Messages" right -- the likeliest version of
      // this mistake, because the runbook tells the operator that right is a
      // toggle and the rest of the admin rights can be off.
      'Telegram send failed: Bad Request: not enough rights to send text messages to the chat',
      'Telegram send failed: Bad Request: CHAT_WRITE_FORBIDDEN',
      'Telegram send failed: Bad Request: have no rights to send a message',
      // A stale id: the channel/group was migrated and this one no longer
      // addresses it. Still the address, not the row.
      'Telegram send failed: Bad Request: group chat was upgraded to a supergroup chat',
      // A wrong or revoked token. Same class of mistake as a typo'd chat id,
      // in the same rollout window, with the same consequence -- and it never
      // recovers on its own, so spending attempts on it only guarantees the
      // waiting reports are lost.
      'Telegram send failed: Unauthorized',
      'Telegram send failed: HTTP 401',
    ];

    it.each(REFUSALS)('parks the row rather than spending an attempt: %s', async (message) => {
      const { service, findMany, update, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row()]);
      send.mockRejectedValue(new Error(message));

      const results = await service.deliverPending();

      expect(results).toEqual([{ id: 'fb-1', status: 'parked' }]);
      // notifyAttempts is absent from the update, not set to 0: the row keeps
      // whatever budget it had, and the error is still recorded for the
      // dashboard.
      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: { notifyError: message },
      });
    });

    it('leaves a row that has already spent attempts exactly where it was', async () => {
      const { service, findMany, update, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row({ notifyAttempts: 2 })]);
      send.mockRejectedValue(new Error(REFUSALS[1]));

      expect(await service.deliverPending()).toEqual([{ id: 'fb-1', status: 'parked' }]);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: { notifyError: REFUSALS[1] },
      });
    });

    it('logs once per run, not once per row', async () => {
      const { service, findMany, send, logError } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row({ id: 'fb-1' }), row({ id: 'fb-2' }), row({ id: 'fb-3' })]);
      send.mockRejectedValue(new Error(REFUSALS[2]));

      const results = await service.deliverPending();

      expect(results.map((result) => result.status)).toEqual(['parked', 'parked', 'parked']);
      // A misconfigured channel must not flood the log with one line per
      // pending report every two minutes.
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError.mock.calls[0][0]).toContain('need administrator rights');
    });

    it.each([
      'Telegram send failed: HTTP 502',
      'Telegram send failed: HTTP 429',
      'Telegram send failed: Too Many Requests: retry after 30',
      'Telegram send failed: ECONNRESET: socket hang up',
      'Telegram send failed: Telegram reported ok=false',
    ])('does not park a failure that is about the transport, not the address: %s', async (message) => {
      const { service, findMany, update, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row()]);
      send.mockRejectedValue(new Error(message));

      expect(await service.deliverPending()).toEqual([{ id: 'fb-1', status: 'failed' }]);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: { notifyAttempts: 1, notifyError: message },
      });
    });

    it("cannot be tripped by a parent writing a refusal phrase in their own report", async () => {
      // describeTelegramError only ever returns Telegram's own description, an
      // HTTP status, or an axios code -- never the request body. Pinned
      // because the alternative is a parent parking their own report forever
      // by typing "chat not found" into the form.
      const { service, findMany, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row({ content: 'chat not found, bot is not a member' })]);
      send.mockRejectedValue(new Error('Telegram send failed: HTTP 502'));

      expect(await service.deliverPending()).toEqual([{ id: 'fb-1', status: 'failed' }]);
    });

    it('still logs a genuinely transient failure per row', async () => {
      const { service, findMany, send, logError } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row({ id: 'fb-1' }), row({ id: 'fb-2' })]);
      send.mockRejectedValue(new Error('Telegram send failed: HTTP 502'));

      await service.deliverPending();

      expect(logError).toHaveBeenCalledTimes(2);
    });

    it('does not stop the rows behind it from being delivered', async () => {
      const { service, findMany, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row({ id: 'fb-1' }), row({ id: 'fb-2' })]);
      send
        .mockRejectedValueOnce(new Error(REFUSALS[1]))
        .mockResolvedValueOnce(undefined);

      expect(await service.deliverPending()).toEqual([
        { id: 'fb-1', status: 'parked' },
        { id: 'fb-2', status: 'sent' },
      ]);
    });

    it('retires a transient failure at the ceiling even so', async () => {
      // The parking rule is scoped to destination-shaped refusals. Everything
      // else keeps the three-attempt ceiling: this is deliberately NOT a
      // "retry forever" change.
      const { service, findMany, update, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row({ notifyAttempts: FEEDBACK_NOTIFY_MAX_ATTEMPTS - 1 })]);
      send.mockRejectedValue(new Error('Telegram send failed: HTTP 502'));

      expect(await service.deliverPending()).toEqual([{ id: 'fb-1', status: 'retired' }]);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: {
          notifyAttempts: FEEDBACK_NOTIFY_MAX_ATTEMPTS,
          notifyError: 'Telegram send failed: HTTP 502',
        },
      });
    });
  });

  describe('isConfigured', () => {
    it('needs both halves of the address: a bot and a chat', () => {
      expect(build({ chatId: '-100123', hasToken: true }).service.isConfigured()).toBe(true);
      expect(build({ chatId: '-100123', hasToken: false }).service.isConfigured()).toBe(false);
      expect(build({ hasToken: true }).service.isConfigured()).toBe(false);
      expect(build({ chatId: '   ', hasToken: true }).service.isConfigured()).toBe(false);
      expect(build().service.isConfigured()).toBe(false);
    });
  });
});
