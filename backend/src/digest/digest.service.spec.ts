import { DigestService } from './digest.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { SchoolYearService } from '../common/school-year/school-year.service';
import type { DigestCheckerService } from './digest-checker.service';
import type { DigestCollectorService } from './digest-collector.service';
import type { DigestSummarizerService } from './digest-summarizer.service';
import type { DigestRecipientService } from './digest-recipient.service';
import type { DigestSender } from './senders/digest-sender.interface';
import type { DigestCandidate, DigestPayload } from './digest.types';

const NOW = new Date('2026-11-17T13:00:00Z');
const TODAY = new Date('2026-11-17T00:00:00Z');
const TOMORROW = new Date('2026-11-18T00:00:00Z');

const BEHAVIOR_CANDIDATE: DigestCandidate = {
  itemType: 'behavior',
  itemId: 'beh-1',
  contentHash: 'hash-beh',
};

function duePayloadItem(id: string, estimated: Date | null) {
  return {
    id,
    subjectName: 'חשבון',
    homeworkText: 'להגיש עד יום חמישי',
    remark: null,
    lessonDate: TODAY,
    groupId: 55,
    estimatedDueDate: estimated,
  };
}

function makePayload(overrides: Partial<DigestPayload> = {}): DigestPayload {
  return {
    childFirstName: 'אבי',
    reportFor: TODAY,
    behavior: [
      {
        id: 'beh-1',
        achvaName: 'איחור',
        classification: 'negative',
        justifiable: true,
        subject: 'מתמטיקה',
        remark: null,
        lessonDate: TODAY,
        eventAt: NOW,
      },
    ],
    homeworkNew: [],
    homeworkDueTomorrow: [],
    ...overrides,
  };
}

interface HarnessOptions {
  targets?: { studentGuid: string; activeFrom: Date; recipientCount: number }[];
  candidates?: DigestCandidate[];
  payload?: DigestPayload;
  claimCount?: number;
  recipients?: { channel: string; address: string; enabled: boolean }[];
  deadlineResolutions?: { ref: string; explicitDueDate: string | null }[];
  sendImpl?: jest.Mock;
  checkImpl?: jest.Mock;
  dryRunEnv?: string;
}

function makeHarness(options: HarnessOptions = {}) {
  const targets = options.targets ?? [
    { studentGuid: 'stu-1', activeFrom: new Date('2026-09-01T00:00:00Z'), recipientCount: 1 },
  ];
  const candidates = options.candidates ?? [BEHAVIOR_CANDIDATE];

  const createMany = jest
    .fn()
    .mockResolvedValue({ count: options.claimCount ?? candidates.length });
  const updateMany = jest.fn().mockResolvedValue({ count: candidates.length });
  const deleteMany = jest.fn().mockResolvedValue({ count: candidates.length });
  const deliveryCreate = jest.fn().mockImplementation(({ data }) => ({ id: 'del-1', ...data }));

  const prisma = {
    digestReportedItem: { createMany, updateMany, deleteMany },
    digestDelivery: { create: deliveryCreate },
    digestRecipient: {
      findMany: jest.fn().mockResolvedValue(
        options.recipients ?? [{ channel: 'telegram', address: '12345', enabled: true }],
      ),
    },
  } as unknown as PrismaService;

  const config = {
    get: jest.fn((key: string) => ({
      DIGEST_TIMEZONE: 'Asia/Jerusalem',
      DIGEST_DRY_RUN: options.dryRunEnv ?? 'false',
    })[key]),
  } as unknown as ConfigService;

  const checker = {
    check:
      options.checkImpl ??
      jest.fn().mockResolvedValue({ candidates, reportFor: TODAY }),
  } as unknown as DigestCheckerService;

  const collector = {
    collect: jest.fn().mockResolvedValue(options.payload ?? makePayload()),
  } as unknown as DigestCollectorService;

  const summarizer = {
    summarize: jest.fn().mockResolvedValue({
      lines: {
        headline: 'כותרת',
        behaviorLine: 'התנהגות',
        homeworkLine: '',
        dueTomorrowLine: 'מחר',
      },
      deadlineResolutions: options.deadlineResolutions ?? [],
      usedLlm: true,
    }),
  } as unknown as DigestSummarizerService;

  const recipients = {
    listDeliveryTargets: jest.fn().mockResolvedValue(targets),
  } as unknown as DigestRecipientService;

  const send = options.sendImpl ?? jest.fn().mockResolvedValue(undefined);
  const telegram = { channel: 'telegram', send } as unknown as DigestSender;
  const logSend = jest.fn().mockResolvedValue(undefined);
  const logSender = { channel: 'log', send: logSend } as unknown as DigestSender;

  const schoolYear = {
    currentSchoolYearFor: jest.fn().mockResolvedValue(2027),
  } as unknown as SchoolYearService;

  const service = new DigestService(
    prisma,
    config,
    schoolYear,
    checker,
    collector,
    summarizer,
    recipients,
    telegram,
    logSender,
  );

  return {
    service,
    prisma,
    checker,
    collector,
    summarizer,
    send,
    logSend,
    createMany,
    updateMany,
    deleteMany,
    deliveryCreate,
  };
}

/** Yields to the event loop until `predicate` holds, or fails the test. */
async function waitUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('waitUntil: condition never became true');
}

describe('DigestService.runAll', () => {
  it('sends the report and confirms the claim', async () => {
    const harness = makeHarness();

    const results = await harness.service.runAll({ now: NOW });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ studentGuid: 'stu-1', status: 'sent' });
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.updateMany).toHaveBeenCalledTimes(1);
    // confirmedAt is what distinguishes a delivered item from a crashed claim.
    expect(harness.updateMany.mock.calls[0][0].data.confirmedAt).toBeInstanceOf(Date);
  });

  it('records a quiet day without calling the model or sending anything', async () => {
    const harness = makeHarness({ candidates: [] });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('skipped_empty');
    expect(harness.summarizer.summarize).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    // The row is the only way to tell a quiet day from a broken job.
    expect(harness.deliveryCreate.mock.calls[0][0].data.status).toBe('skipped_empty');
  });

  it('sends nothing when another runner already owns every item', async () => {
    // createMany with skipDuplicates returning 0 means every claim row already
    // existed, so someone else is sending or already sent.
    const harness = makeHarness({ claimCount: 0 });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('skipped_empty');
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.summarizer.summarize).not.toHaveBeenCalled();
  });

  it('rolls the claim back when the send fails, so the next hour retries', async () => {
    const harness = makeHarness({
      sendImpl: jest.fn().mockRejectedValue(new Error('chat not found')),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('failed');
    expect(harness.deleteMany).toHaveBeenCalledTimes(1);
    expect(harness.updateMany).not.toHaveBeenCalled();
    expect(harness.deliveryCreate.mock.calls[0][0].data.status).toBe('failed');
  });

  it('keeps one child failing from stopping the others', async () => {
    const harness = makeHarness({
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1 },
        { studentGuid: 'stu-2', activeFrom: TODAY, recipientCount: 1 },
      ],
      checkImpl: jest
        .fn()
        .mockRejectedValueOnce(new Error('database hiccup'))
        .mockResolvedValue({ candidates: [BEHAVIOR_CANDIDATE], reportFor: TODAY }),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ studentGuid: 'stu-1', status: 'failed' });
    expect(results[1]).toMatchObject({ studentGuid: 'stu-2', status: 'sent' });
  });

  it('renders and logs but sends nothing on a dry run', async () => {
    const harness = makeHarness({ dryRunEnv: 'true' });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('dry_run');
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.logSend).toHaveBeenCalledTimes(1);
    // A dry run must not mark items as reported, or the real first run would
    // find nothing left to say.
    expect(harness.updateMany).not.toHaveBeenCalled();
    expect(harness.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('does not overlap itself when a run is already in flight', async () => {
    // The hourly cron would otherwise start a second pass over the same
    // children while the first is still waiting on a model or on Telegram.
    let release: () => void = () => undefined;
    const check = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ candidates: [], reportFor: TODAY });
        }),
    );
    const harness = makeHarness({ checkImpl: check });

    const first = harness.service.runAll({ now: NOW });
    // Let the first run get as far as the checker before probing the guard --
    // releasing earlier would leave `release` as the no-op default and hang.
    await waitUntil(() => check.mock.calls.length === 1);

    const second = await harness.service.runAll({ now: NOW });
    expect(second).toEqual([]);

    release();
    await expect(first).resolves.toHaveLength(1);
  });

  it('skips a child whose only due item turns out not to be due tomorrow', async () => {
    // The checker widened this in on a text hint. The model read the text and
    // resolved Thursday, which is not tomorrow, so there is nothing to tell
    // the parent today.
    const harness = makeHarness({
      candidates: [
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-due', hasTextHint: true },
      ],
      payload: makePayload({
        behavior: [],
        homeworkDueTomorrow: [duePayloadItem('hw-1', null)],
      }),
      deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: '2026-11-19' }],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('skipped_empty');
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('re-evaluates a deferred deadline instead of burying it', async () => {
    // The claim for a dropped item must NOT be confirmed. Confirming it would
    // mean that on Wednesday -- when the Thursday deadline really is tomorrow
    // -- the item is already "reported" and the parent never hears about it.
    // That would silently defeat the half of the feature this exists for.
    const harness = makeHarness({
      candidates: [
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-due', hasTextHint: true },
      ],
      payload: makePayload({
        behavior: [],
        homeworkDueTomorrow: [duePayloadItem('hw-1', null)],
      }),
      deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: '2026-11-19' }],
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.updateMany).not.toHaveBeenCalled();
    expect(harness.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('keeps an item whose explicit deadline really is tomorrow', async () => {
    const harness = makeHarness({
      candidates: [
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-due', hasTextHint: true },
      ],
      payload: makePayload({
        behavior: [],
        homeworkDueTomorrow: [duePayloadItem('hw-1', null)],
      }),
      deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: '2026-11-18' }],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('sent');
    expect(harness.send.mock.calls[0][1]).toContain('18/11/2026');
  });

  it('prefers the text deadline over the timetable estimate', async () => {
    // ADR-0026: explicit from text beats the next-lesson heuristic.
    const harness = makeHarness({
      candidates: [
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-due', estimatedDueDate: TOMORROW },
      ],
      payload: makePayload({
        behavior: [],
        homeworkDueTomorrow: [duePayloadItem('hw-1', TOMORROW)],
      }),
      deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: '2026-11-18' }],
    });

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1];
    expect(sent).toContain('18/11/2026');
    expect(sent).not.toContain('19/11/2026');
  });

  it('keeps a timetable-estimated item when the model found no explicit date', async () => {
    const harness = makeHarness({
      candidates: [
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-due', estimatedDueDate: TOMORROW },
      ],
      payload: makePayload({
        behavior: [],
        homeworkDueTomorrow: [duePayloadItem('hw-1', TOMORROW)],
      }),
      deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: null }],
    });

    expect((await harness.service.runAll({ now: NOW }))[0].status).toBe('sent');
  });

  it('sends to every enabled recipient and skips the disabled ones', async () => {
    const harness = makeHarness({
      recipients: [
        { channel: 'telegram', address: '111', enabled: true },
        { channel: 'telegram', address: '222', enabled: true },
        { channel: 'telegram', address: '333', enabled: false },
      ],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.send.mock.calls.map((call) => call[0])).toEqual(['111', '222']);
    expect(results[0].recipientCount).toBe(2);
  });

  it('runs only the requested child when one is named', async () => {
    const harness = makeHarness({
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1 },
        { studentGuid: 'stu-2', activeFrom: TODAY, recipientCount: 1 },
      ],
    });

    const results = await harness.service.runAll({ now: NOW, studentGuid: 'stu-2' });

    expect(results).toHaveLength(1);
    expect(results[0].studentGuid).toBe('stu-2');
  });

  it('passes the recipients activeFrom cutoff to the checker', async () => {
    const activeFrom = new Date('2026-11-01T00:00:00Z');
    const harness = makeHarness({
      targets: [{ studentGuid: 'stu-1', activeFrom, recipientCount: 1 }],
    });

    await harness.service.runAll({ now: NOW });

    expect((harness.checker.check as jest.Mock).mock.calls[0][0]).toMatchObject({
      studentGuid: 'stu-1',
      schoolYear: 2027,
      activeFrom,
    });
  });

  it('records the message it actually sent for support', async () => {
    const harness = makeHarness();

    await harness.service.runAll({ now: NOW });

    const row = harness.deliveryCreate.mock.calls[0][0].data;
    expect(row.messageText).toContain('אבי');
    expect(row.usedLlm).toBe(true);
    expect(row.reportFor).toEqual(TODAY);
  });

  it('marks the delivery as not having used the model when it fell back', async () => {
    const harness = makeHarness();
    (harness.summarizer.summarize as jest.Mock).mockResolvedValue({
      lines: { headline: 'ח', behaviorLine: 'ח', homeworkLine: '', dueTomorrowLine: '' },
      deadlineResolutions: [],
      usedLlm: false,
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.deliveryCreate.mock.calls[0][0].data.usedLlm).toBe(false);
  });
});
