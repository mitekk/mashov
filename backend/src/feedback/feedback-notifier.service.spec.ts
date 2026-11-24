import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { DigestSender } from '../digest/senders/digest-sender.interface';
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

function build(options: { chatId?: string; baseUrl?: string; maxPerRun?: string } = {}) {
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
  const telegram = { channel: 'telegram', send } as unknown as DigestSender;

  const service = new FeedbackNotifierService(prisma, config, telegram);
  // The run logs a retirement; silence it so a passing suite stays readable.
  jest.spyOn((service as unknown as { logger: { error: () => void; warn: () => void } }).logger, 'error').mockImplementation(() => undefined);

  return { service, findMany, update, send };
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

    it('retires a permanent failure immediately rather than spending three attempts', async () => {
      const { service, findMany, update, send } = build({ chatId: '-100123' });
      findMany.mockResolvedValue([row()]);
      send.mockRejectedValue(new Error('Telegram send failed: Bad Request: chat not found'));

      const results = await service.deliverPending();

      expect(results).toEqual([{ id: 'fb-1', status: 'retired' }]);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'fb-1' },
        data: {
          notifyAttempts: FEEDBACK_NOTIFY_MAX_ATTEMPTS,
          notifyError: 'Telegram send failed: Bad Request: chat not found',
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
});
