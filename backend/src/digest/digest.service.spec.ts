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
  takeoverCount?: number;
  ownedHashes?: string[];
  latestSyncAt?: Date;
  recipients?: { channel: string; address: string; enabled: boolean }[];
  deadlineResolutions?: { ref: string; explicitDueDate: string | null }[];
  dueTomorrowLine?: string;
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
  const updateMany = jest.fn().mockResolvedValue({ count: options.takeoverCount ?? 0 });
  const deleteMany = jest.fn().mockResolvedValue({ count: candidates.length });
  const deliveryCreate = jest.fn().mockImplementation(({ data }) => ({ id: 'del-1', ...data }));
  // The run reads back the rows it actually owns, because a createMany count
  // says how many you won but never which.
  const ownedHashes =
    options.ownedHashes ??
    ((options.claimCount ?? candidates.length) === 0 && (options.takeoverCount ?? 0) === 0
      ? []
      : candidates.map((candidate) => candidate.contentHash));
  const reportedFindMany = jest
    .fn()
    .mockImplementation(() => ownedHashes.map((contentHash) => ({ contentHash })));

  const prisma = {
    syncRun: {
      findFirst: jest.fn().mockResolvedValue(
        options.latestSyncAt === undefined
          ? { endedAt: NOW, startedAt: NOW }
          : { endedAt: options.latestSyncAt, startedAt: options.latestSyncAt },
      ),
    },
    digestReportedItem: { createMany, updateMany, deleteMany, findMany: reportedFindMany },
    digestDelivery: { create: deliveryCreate },
    digestRecipient: {
      // Honours the where-clause, as Postgres would: the service relies on
      // `where: { enabled: true }` rather than filtering again in code.
      findMany: jest.fn().mockImplementation(({ where }) => {
        const all = options.recipients ?? [
          { channel: 'telegram', address: '12345', enabled: true },
        ];
        return all.filter((r) => (where?.enabled === undefined ? true : r.enabled === where.enabled));
      }),
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
        dueTomorrowLine: options.dueTomorrowLine ?? 'מחר',
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
    reportedFindMany,
  };
}

/** The claim step always issues a takeover updateMany; these name the rest. */
function confirmCalls(updateMany: jest.Mock) {
  return updateMany.mock.calls.filter(
    (call) => call[0].data.confirmedAt instanceof Date && call[0].data.resolvedDueDate === null,
  );
}

function deferralCalls(updateMany: jest.Mock) {
  return updateMany.mock.calls.filter((call) => call[0].data.resolvedDueDate instanceof Date);
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
    // confirmedAt is what distinguishes a delivered item from a crashed claim,
    // and a null resolvedDueDate is what distinguishes it from a deferral.
    expect(confirmCalls(harness.updateMany)).toHaveLength(1);
    expect(confirmCalls(harness.updateMany)[0][0].where.contentHash.in).toEqual(['hash-beh']);
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
    // Nothing inserted and nothing taken over means every row belongs to a run
    // that is still working on it, or was already delivered.
    const harness = makeHarness({ claimCount: 0, takeoverCount: 0, ownedHashes: [] });

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
    expect(confirmCalls(harness.updateMany)).toHaveLength(0);
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
    expect(confirmCalls(harness.updateMany)).toHaveLength(0);
    expect(deferralCalls(harness.updateMany)).toHaveLength(0);
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
    // The dropped item must not be marked fully reported. Marking it would mean
    // that on Wednesday -- when the Thursday deadline really is tomorrow -- it
    // counts as already reported and the parent never hears about it, silently
    // defeating the half of the feature this exists for. Instead the resolved
    // date is recorded, and the checker re-admits the item on that day.
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

    expect(confirmCalls(harness.updateMany)).toHaveLength(0);
    expect(deferralCalls(harness.updateMany)).toHaveLength(1);
    expect(
      (deferralCalls(harness.updateMany)[0][0].data.resolvedDueDate as Date).toISOString(),
    ).toBe('2026-11-19T00:00:00.000Z');
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


  it('takes over a claim an earlier run abandoned without sending', async () => {
    // A container killed between claiming and sending leaves rows unconfirmed.
    // The checker reclaims them, but the insert then conflicts and returns 0 --
    // so without an explicit takeover the item is stuck for good and every run
    // reports a quiet day.
    const harness = makeHarness({
      claimCount: 0,
      takeoverCount: 1,
      ownedHashes: ['hash-beh'],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('sent');
    expect(harness.send).toHaveBeenCalledTimes(1);
    // The takeover must restamp ownership and clear the stale claim state.
    const takeover = harness.updateMany.mock.calls[0][0];
    expect(takeover.data.claimedBy).toBeDefined();
    expect(takeover.data.confirmedAt).toBeNull();
  });

  it('acts only on the rows it actually owns, not on everything it asked for', async () => {
    // Run A owns the behavior item; run B inserted the homework item a moment
    // earlier. Reporting both would send the homework twice.
    const harness = makeHarness({
      candidates: [
        BEHAVIOR_CANDIDATE,
        { itemType: 'homework_new', itemId: 'hw-1', contentHash: 'hash-hw' },
      ],
      claimCount: 1,
      ownedHashes: ['hash-beh'],
    });

    await harness.service.runAll({ now: NOW });

    const collected = (harness.collector.collect as jest.Mock).mock.calls[0][0].candidates;
    expect(collected.map((c: { contentHash: string }) => c.contentHash)).toEqual(['hash-beh']);
  });

  it('does not confirm a deferred deadline just because the rest of the report sent', async () => {
    // The burying case. A behavior event makes the report non-empty, so it
    // sends -- and the homework whose deadline resolved to Thursday must not be
    // marked reported, or on Wednesday the parent is never warned.
    const harness = makeHarness({
      candidates: [
        BEHAVIOR_CANDIDATE,
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-due', hasTextHint: true },
      ],
      ownedHashes: ['hash-beh', 'hash-due'],
      payload: makePayload({ homeworkDueTomorrow: [duePayloadItem('hw-1', null)] }),
      deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: '2026-11-19' }],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('sent');
    const confirmed = harness.updateMany.mock.calls.filter(
      (call) => call[0].data.confirmedAt instanceof Date && call[0].data.resolvedDueDate == null,
    );
    const confirmedHashes = confirmed.flatMap((call) => call[0].where.contentHash.in);
    expect(confirmedHashes).toContain('hash-beh');
    expect(confirmedHashes).not.toContain('hash-due');
  });

  it('records the resolved date on a deferred item so the model is not re-asked hourly', async () => {
    const harness = makeHarness({
      candidates: [
        BEHAVIOR_CANDIDATE,
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-due', hasTextHint: true },
      ],
      ownedHashes: ['hash-beh', 'hash-due'],
      payload: makePayload({ homeworkDueTomorrow: [duePayloadItem('hw-1', null)] }),
      deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: '2026-11-19' }],
    });

    await harness.service.runAll({ now: NOW });

    const deferral = harness.updateMany.mock.calls.find(
      (call) => call[0].data.resolvedDueDate instanceof Date,
    );
    expect(deferral).toBeDefined();
    expect(deferral![0].where.contentHash.in).toEqual(['hash-due']);
    expect((deferral![0].data.resolvedDueDate as Date).toISOString()).toBe(
      '2026-11-19T00:00:00.000Z',
    );
  });

  it('releases a deferred item it could not date at all, rather than burying it', async () => {
    // No explicit date and no timetable estimate: there is nothing to defer
    // to, so the claim goes back and the item is looked at again.
    const harness = makeHarness({
      candidates: [
        BEHAVIOR_CANDIDATE,
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-due', hasTextHint: true },
      ],
      ownedHashes: ['hash-beh', 'hash-due'],
      payload: makePayload({ homeworkDueTomorrow: [duePayloadItem('hw-1', null)] }),
      deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: null }],
    });

    await harness.service.runAll({ now: NOW });

    const released = harness.deleteMany.mock.calls[0][0];
    expect(released.where.contentHash.in).toEqual(['hash-due']);
  });

  it('still delivers to the working recipient when another one is unreachable', async () => {
    // Dad blocked the bot. Rolling the whole claim back would re-send the same
    // digest to Mum every hour, forever, with a fresh model call each time.
    const send = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Telegram send failed: bot was blocked by the user'));
    const harness = makeHarness({
      recipients: [
        { channel: 'telegram', address: '111', enabled: true },
        { channel: 'telegram', address: '222', enabled: true },
      ],
      sendImpl: send,
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('sent');
    expect(results[0].recipientCount).toBe(1);
    expect(results[0].error).toMatch(/blocked/);
    // Confirmed, so Mum is not sent the same digest again next hour.
    expect(harness.updateMany).toHaveBeenCalled();
    expect(harness.deleteMany).not.toHaveBeenCalled();
  });

  it('fails and rolls back only when no recipient could be reached', async () => {
    const harness = makeHarness({
      recipients: [
        { channel: 'telegram', address: '111', enabled: true },
        { channel: 'telegram', address: '222', enabled: true },
      ],
      sendImpl: jest.fn().mockRejectedValue(new Error('chat not found')),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('failed');
    expect(harness.deleteMany).toHaveBeenCalled();
  });

  it('does not let the model describe items that narrowing removed', async () => {
    // The prose is written before narrowing. If narrowing drops an item, the
    // model's sentence can promise a deadline the bullets do not list.
    const harness = makeHarness({
      candidates: [
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-a' },
        { itemType: 'homework_due', itemId: 'hw-2', contentHash: 'hash-b' },
      ],
      ownedHashes: ['hash-a', 'hash-b'],
      payload: makePayload({
        behavior: [],
        homeworkDueTomorrow: [duePayloadItem('hw-1', TOMORROW), duePayloadItem('hw-2', TOMORROW)],
      }),
      deadlineResolutions: [
        { ref: 'hw-1', explicitDueDate: '2026-11-18' },
        { ref: 'hw-2', explicitDueDate: '2026-11-19' },
      ],
      dueTomorrowLine: 'שתי מטלות להגשה מחר, בהיסטוריה ובגאוגרפיה',
    });

    await harness.service.runAll({ now: NOW });

    // The model described two items in two subjects; only one survived, so its
    // sentence must not be the one that reaches the parent.
    const sent = harness.send.mock.calls[0][1];
    expect(sent).not.toContain('היסטוריה');
    expect(sent).not.toContain('שתי מטלות');
  });

  it('flags a quiet day that is really a stalled sync', async () => {
    // The digest reads only local Postgres. If the school data has not been
    // refreshed for hours, "nothing happened today" is a wrong belief to leave
    // a parent with, and it must at least be distinguishable in the history.
    const harness = makeHarness({
      candidates: [],
      latestSyncAt: new Date(NOW.getTime() - 9 * 60 * 60 * 1000),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('skipped_stale');
    expect(harness.deliveryCreate.mock.calls[0][0].data.status).toBe('skipped_stale');
  });

  it('calls a quiet day quiet when the sync is current', async () => {
    const harness = makeHarness({
      candidates: [],
      latestSyncAt: new Date(NOW.getTime() - 20 * 60 * 1000),
    });

    expect((await harness.service.runAll({ now: NOW }))[0].status).toBe('skipped_empty');
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
