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
    childGender: 'male',
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
    releases: [],
    activities: [],
    ...overrides,
  };
}

/** The subscribing parent every default fixture belongs to. */
const USER_A = 'user-a';
const USER_B = 'user-b';

interface HarnessOptions {
  targets?: { studentGuid: string; activeFrom: Date; recipientCount: number; userId: string }[];
  candidates?: DigestCandidate[];
  payload?: DigestPayload;
  claimCount?: number;
  takeoverCount?: number;
  ownedHashes?: string[];
  latestSyncAt?: Date;
  syncRuns?: { source: string; endedAt: Date; startedAt: Date }[];
  recipients?: { channel: string; address: string; enabled: boolean; userId?: string }[];
  deadlineResolutions?: { ref: string; explicitDueDate: string | null }[];
  dueTomorrowLine?: string;
  sendImpl?: jest.Mock;
  checkImpl?: jest.Mock;
  dryRunEnv?: string;
}

function makeHarness(options: HarnessOptions = {}) {
  const targets = options.targets ?? [
    {
      studentGuid: 'stu-1',
      activeFrom: new Date('2026-09-01T00:00:00Z'),
      recipientCount: 1,
      userId: USER_A,
    },
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
      // Honours the where-clause, as Postgres would. This matters more than it
      // looks: the sync tasks write per-child source names
      // (`homework:<guid>`), so a mock that answers regardless of `where` will
      // report a freshness guard as working when no row could ever match it.
      findFirst: jest.fn().mockImplementation(({ where }) => {
        const at = options.latestSyncAt === undefined ? NOW : options.latestSyncAt;
        const rows =
          options.syncRuns ??
          ['homework', 'behavior'].flatMap((base) =>
            targets.map((target) => ({
              source: `${base}:${target.studentGuid}`,
              endedAt: at,
              startedAt: at,
            })),
          );
        const wanted = (where?.OR ?? [{ source: where?.source }]).map(
          (clause: { source?: string }) => clause.source,
        );
        return rows.find((row) => wanted.includes(row.source)) ?? null;
      }),
    },
    digestReportedItem: { createMany, updateMany, deleteMany, findMany: reportedFindMany },
    digestDelivery: { create: deliveryCreate },
    digestRecipient: {
      // Honours the where-clause, as Postgres would: the service relies on
      // `where: { enabled: true, userId }` rather than filtering again in
      // code. The userId arm matters most -- a mock that answered every
      // household's chats to every run would report the per-user isolation as
      // working while the run sent one parent's message to the other's chat.
      findMany: jest.fn().mockImplementation(({ where }) => {
        const all = options.recipients ?? [
          { channel: 'telegram', address: '12345', enabled: true, userId: USER_A },
        ];
        return all.filter(
          (r) =>
            (where?.enabled === undefined || r.enabled === where.enabled) &&
            (where?.userId === undefined || (r.userId ?? USER_A) === where.userId),
        );
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
    recipients,
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
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-2', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
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
    // ADR-0027: explicit from text beats the next-lesson heuristic.
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
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-2', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
      ],
    });

    const results = await harness.service.runAll({ now: NOW, studentGuid: 'stu-2' });

    expect(results).toHaveLength(1);
    expect(results[0].studentGuid).toBe('stu-2');
  });

  it('passes the recipients activeFrom cutoff to the checker', async () => {
    const activeFrom = new Date('2026-11-01T00:00:00Z');
    const harness = makeHarness({
      targets: [{ studentGuid: 'stu-1', activeFrom, recipientCount: 1, userId: USER_A }],
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

  it('finds the stalled sync under the per-child source name the tasks write', async () => {
    // homework.task.ts and behavior.task.ts open their runs as
    // `homework:<guid>` / `behavior:<guid>`. A guard that matches the bare
    // base name finds nothing, ever, and calls every stalled day quiet.
    const long_ago = new Date(NOW.getTime() - 9 * 60 * 60 * 1000);
    const harness = makeHarness({
      candidates: [],
      syncRuns: [
        { source: 'homework:stu-1', endedAt: long_ago, startedAt: long_ago },
        { source: 'behavior:stu-1', endedAt: long_ago, startedAt: long_ago },
      ],
    });

    expect((await harness.service.runAll({ now: NOW }))[0].status).toBe('skipped_stale');
  });

  it('judges staleness per child, not across the whole household', async () => {
    const fresh = NOW;
    const long_ago = new Date(NOW.getTime() - 9 * 60 * 60 * 1000);
    const harness = makeHarness({
      candidates: [],
      targets: [
        {
          studentGuid: 'stu-2',
          activeFrom: new Date('2026-09-01T00:00:00Z'),
          recipientCount: 1,
          userId: USER_A,
        },
      ],
      syncRuns: [
        { source: 'homework:stu-1', endedAt: long_ago, startedAt: long_ago },
        { source: 'behavior:stu-1', endedAt: long_ago, startedAt: long_ago },
        { source: 'homework:stu-2', endedAt: fresh, startedAt: fresh },
        { source: 'behavior:stu-2', endedAt: fresh, startedAt: fresh },
      ],
    });

    expect((await harness.service.runAll({ now: NOW }))[0].status).toBe('skipped_empty');
  });

  it('does not mark items reported when no recipient is enabled to receive them', async () => {
    // Recipients are read per child, after the model call. A parent who
    // disables their only recipient mid-run must not have the day's items
    // confirmed as delivered to nobody.
    const harness = makeHarness({
      recipients: [{ channel: 'telegram', address: '12345', enabled: false }],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).not.toBe('sent');
    expect(results[0].recipientCount).toBe(0);
    expect(confirmCalls(harness.updateMany)).toHaveLength(0);
    expect(harness.deleteMany).toHaveBeenCalled();
    expect(harness.deliveryCreate.mock.calls[0][0].data.status).not.toBe('sent');
  });

  it('releases rather than defers a deadline that falls past the lookback horizon', async () => {
    // Deferral only works if the checker will re-query the row on the day.
    // The due-candidate query scans lessonDate back DIGEST_DUE_LOOKBACK_DAYS,
    // so a date further out than that is a date the row never gets re-read on.
    const harness = makeHarness({
      candidates: [{ itemType: 'homework_due', itemId: 'hw-9', contentHash: 'hash-due' }],
      payload: makePayload({ behavior: [], homeworkDueTomorrow: [duePayloadItem('hw-9', null)] }),
      deadlineResolutions: [{ ref: 'hw-9', explicitDueDate: '2027-02-01' }],
    });

    await harness.service.runAll({ now: NOW });

    expect(deferralCalls(harness.updateMany)).toHaveLength(0);
    expect(harness.deleteMany).toHaveBeenCalled();
  });

  it('releases rather than defers a deadline the model read as already past', async () => {
    const harness = makeHarness({
      candidates: [{ itemType: 'homework_due', itemId: 'hw-9', contentHash: 'hash-due' }],
      payload: makePayload({ behavior: [], homeworkDueTomorrow: [duePayloadItem('hw-9', null)] }),
      // No year in the Hebrew text is the common case, so a wrong-year read is
      // the common failure. Burying the item on it is the expensive outcome.
      deadlineResolutions: [{ ref: 'hw-9', explicitDueDate: '2025-12-03' }],
    });

    await harness.service.runAll({ now: NOW });

    expect(deferralCalls(harness.updateMany)).toHaveLength(0);
    expect(harness.deleteMany).toHaveBeenCalled();
  });

  it('replaces the whole summary, headline included, when narrowing changed the set', async () => {
    const harness = makeHarness({
      candidates: [
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-1' },
        { itemType: 'homework_due', itemId: 'hw-2', contentHash: 'hash-2' },
      ],
      payload: makePayload({
        behavior: [],
        homeworkDueTomorrow: [duePayloadItem('hw-1', TOMORROW), duePayloadItem('hw-2', TOMORROW)],
      }),
      deadlineResolutions: [{ ref: 'hw-2', explicitDueDate: '2026-11-25' }],
    });
    (harness.summarizer.summarize as jest.Mock).mockResolvedValue({
      lines: {
        headline: 'עדכון יומי: שתי מטלות למחר',
        behaviorLine: '',
        homeworkLine: '',
        dueTomorrowLine: 'שתי מטלות',
      },
      deadlineResolutions: [{ ref: 'hw-2', explicitDueDate: '2026-11-25' }],
      usedLlm: true,
    });

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1] as string;
    // The model counted two because it was given two; only one survived.
    expect(sent).not.toContain('שתי מטלות');
  });

  it('runs only the children the caller has a recipient row for', async () => {
    const harness = makeHarness();

    await harness.service.runAll({ now: NOW, userId: 'user-1' });

    expect(harness.recipients.listDeliveryTargets).toHaveBeenCalledWith('user-1');
  });

  it('fills in a section the model left blank, rather than dropping the news', async () => {
    // With the item bullets gone the prose is the only place the facts appear,
    // so an empty line for a section that has items would silently lose it --
    // and the ledger would still mark it reported, so it would never come back.
    const harness = makeHarness();
    (harness.summarizer.summarize as jest.Mock).mockResolvedValue({
      lines: {
        headline: 'עדכון',
        behaviorLine: '   ',
        homeworkLine: '',
        dueTomorrowLine: '',
        releaseLine: '',
        activityLine: '',
      },
      deadlineResolutions: [],
      usedLlm: true,
    });

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1] as string;
    // The deterministic sentence for the seeded behavior event.
    expect(sent).toContain('איחור');
    expect(sent).toContain('מתמטיקה');
  });

  it('keeps the model prose for the sections it did write', async () => {
    const harness = makeHarness();

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1] as string;
    expect(sent).toContain('התנהגות');
  });

  it('runs once per subscribing parent for a child they share', async () => {
    // One run per child meant one message, rendered from one parent's consent
    // forms, sent to both chats -- and one dedup ledger, so whichever run went
    // first silenced the item for the other parent.
    const harness = makeHarness({
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_B },
      ],
      recipients: [
        { channel: 'telegram', address: '111', enabled: true, userId: USER_A },
        { channel: 'telegram', address: '222', enabled: true, userId: USER_B },
      ],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.userId)).toEqual([USER_A, USER_B]);
    // Each parent's own chat, once -- not both chats twice.
    expect(harness.send.mock.calls.map((call) => call[0])).toEqual(['111', '222']);
    expect(
      (harness.checker.check as jest.Mock).mock.calls.map((call) => call[0].userId),
    ).toEqual([USER_A, USER_B]);
  });

  it('reads back only its own recipients, not the other parent’s chat', async () => {
    const harness = makeHarness({
      recipients: [
        { channel: 'telegram', address: '111', enabled: true, userId: USER_A },
        { channel: 'telegram', address: '999', enabled: true, userId: USER_B },
      ],
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.send.mock.calls.map((call) => call[0])).toEqual(['111']);
    expect(
      (harness.prisma.digestRecipient.findMany as jest.Mock).mock.calls[0][0].where,
    ).toMatchObject({ studentGuid: 'stu-1', enabled: true, userId: USER_A });
  });

  it('claims, confirms and releases under its own userId', async () => {
    const harness = makeHarness({
      sendImpl: jest.fn().mockRejectedValue(new Error('chat not found')),
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.createMany.mock.calls[0][0].data[0].userId).toBe(USER_A);
    expect(harness.deleteMany.mock.calls[0][0].where.userId).toBe(USER_A);
  });

  it('confirms only its own rows', async () => {
    const harness = makeHarness();

    await harness.service.runAll({ now: NOW });

    expect(confirmCalls(harness.updateMany)[0][0].where.userId).toBe(USER_A);
  });

  it('does not restamp another parent’s rows when taking over a stale claim', async () => {
    // The takeover is the only write not already scoped by `claimedBy`.
    // Unscoped, user A's run restamps user B's rows -- claimedBy=A,
    // confirmedAt=null -- so B's own confirm matches nothing and B is told the
    // same thing again half an hour later.
    const harness = makeHarness({ claimCount: 0, takeoverCount: 1, ownedHashes: ['hash-beh'] });

    await harness.service.runAll({ now: NOW });

    const takeover = harness.updateMany.mock.calls[0][0];
    expect(takeover.where.userId).toBe(USER_A);
  });

  it('defers a deadline only on its own row', async () => {
    const harness = makeHarness({
      candidates: [
        { itemType: 'homework_due', itemId: 'hw-1', contentHash: 'hash-due', hasTextHint: true },
      ],
      payload: makePayload({ behavior: [], homeworkDueTomorrow: [duePayloadItem('hw-1', null)] }),
      deadlineResolutions: [{ ref: 'hw-1', explicitDueDate: '2026-11-19' }],
    });

    await harness.service.runAll({ now: NOW });

    expect(deferralCalls(harness.updateMany)[0][0].where.userId).toBe(USER_A);
  });

  it('records whose run each delivery row was', async () => {
    // GET /digest/deliveries scopes on this: the row holds the message text,
    // which now contains that parent's own consent forms.
    const harness = makeHarness();

    await harness.service.runAll({ now: NOW });

    expect(harness.deliveryCreate.mock.calls[0][0].data.userId).toBe(USER_A);
  });

  it('records the userId on a quiet day too', async () => {
    const harness = makeHarness({ candidates: [] });

    await harness.service.runAll({ now: NOW });

    expect(harness.deliveryCreate.mock.calls[0][0].data.userId).toBe(USER_A);
  });

  it('asks about a child’s sync freshness once, not once per subscribing parent', async () => {
    // Staleness depends on the child alone, and the query is two rows per
    // child. Two parents of three children would otherwise be twelve.
    const harness = makeHarness({
      candidates: [],
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_B },
      ],
      latestSyncAt: new Date(NOW.getTime() - 9 * 60 * 60 * 1000),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results.map((result) => result.status)).toEqual(['skipped_stale', 'skipped_stale']);
    expect(harness.prisma.syncRun.findFirst).toHaveBeenCalledTimes(2);
  });

  it('sends one copy of an identical message to a chat both parents linked', async () => {
    // One family, one group chat, both parents linked it. Each of them now has
    // their own row and their own run, so without this the chat gets the same
    // message twice in a row.
    const harness = makeHarness({
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_B },
      ],
      recipients: [
        { channel: 'telegram', address: '111', enabled: true, userId: USER_A },
        { channel: 'telegram', address: '111', enabled: true, userId: USER_B },
      ],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(1);
    // Both runs count as delivered. The `delivered === 0` guard throws, which
    // would release the claims and retry the same suppressed send every hour,
    // forever.
    expect(results.map((result) => result.status)).toEqual(['sent', 'sent']);
    expect(confirmCalls(harness.updateMany)).toHaveLength(2);
    // Recorded, so support can tell a delivery from a suppression.
    expect(harness.deliveryCreate.mock.calls[1][0].data.errorMessage).toMatch(/suppressed/i);
    expect(harness.deliveryCreate.mock.calls[0][0].data.errorMessage).toBeNull();
  });

  it('sends to the shared chat again when the two parents’ messages differ', async () => {
    // Byte-identical is the only thing suppressed. A consent form only one of
    // them has to answer makes the messages differ, and then both are news.
    const harness = makeHarness({
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_B },
      ],
      recipients: [
        { channel: 'telegram', address: '111', enabled: true, userId: USER_A },
        { channel: 'telegram', address: '111', enabled: true, userId: USER_B },
      ],
    });
    // The real difference is a consent form only one parent has to answer;
    // any difference in the rendered text does, and a second child name keeps
    // this test about the suppression rather than about the forms section.
    (harness.collector.collect as jest.Mock)
      .mockResolvedValueOnce(makePayload())
      .mockResolvedValueOnce(makePayload({ childFirstName: 'נועה' }));

    await harness.service.runAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it('suppresses only within one run, never across runs', async () => {
    // The ledger is what stops a repeat between runs. Carrying the set over
    // would silence a genuinely identical digest the next day.
    const harness = makeHarness();

    await harness.service.runAll({ now: NOW });
    await harness.service.runAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it('hands the summarizer no consent forms, having collected them', async () => {
    // The forms section is the one input that is per parent, so the prose --
    // which is shared between the parents of one child -- must not depend on
    // it. The deterministic Hebrew line renders the section instead.
    const harness = makeHarness({
      candidates: [{ itemType: 'activity', itemId: '7', contentHash: 'hash-act' }],
      payload: makePayload({
        behavior: [],
        activities: [
          {
            id: '7',
            title: 'טיול שנתי לגליל',
            activityStartDate: TOMORROW,
            endAnswerDate: TOMORROW,
          },
        ],
      }),
    });

    await harness.service.runAll({ now: NOW });

    // Collected, so the section can be rendered and the claim confirmed...
    expect((harness.collector.collect as jest.Mock).mock.calls[0][0].candidates).toHaveLength(1);
    // ...and summarized without them.
    expect((harness.summarizer.summarize as jest.Mock).mock.calls[0][0].activities).toEqual([]);
    expect(harness.send.mock.calls[0][1]).toContain('טיול שנתי לגליל');
  });

  it('ignores a forms line the model wrote anyway', async () => {
    // Today's substitution only fires when the model's line is blank, so a
    // hallucinated sentence about a section the model was given nothing for
    // would ship to the parent.
    const harness = makeHarness({
      candidates: [{ itemType: 'activity', itemId: '7', contentHash: 'hash-act' }],
      payload: makePayload({
        behavior: [],
        activities: [
          {
            id: '7',
            title: 'טיול שנתי לגליל',
            activityStartDate: TOMORROW,
            endAnswerDate: TOMORROW,
          },
        ],
      }),
    });
    (harness.summarizer.summarize as jest.Mock).mockResolvedValue({
      lines: {
        headline: 'כותרת',
        behaviorLine: '',
        homeworkLine: '',
        dueTomorrowLine: '',
        releaseLine: '',
        activityLine: 'יש אישור שממתין, אבל אין לי מושג איזה',
      },
      deadlineResolutions: [],
      usedLlm: true,
    });

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1] as string;
    expect(sent).not.toContain('אין לי מושג');
    expect(sent).toContain('ממתינים לתשובתך');
  });

  it('spends one model call on a child two parents subscribe to', async () => {
    // The prose covers only per-child facts, which are identical for both
    // parents -- the one input that is not, consent forms, is withheld from
    // the model. So a second run for the same child and the same claimed
    // items would pay Sonnet twice for the same paragraph.
    const harness = makeHarness({
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_B },
      ],
      recipients: [
        { channel: 'telegram', address: '111', enabled: true, userId: USER_A },
        { channel: 'telegram', address: '222', enabled: true, userId: USER_B },
      ],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(harness.summarizer.summarize).toHaveBeenCalledTimes(1);
    // Both parents still get their message.
    expect(results.map((result) => result.status)).toEqual(['sent', 'sent']);
    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it('does not share one child’s summary with another child', async () => {
    const harness = makeHarness({
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-2', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
      ],
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.summarizer.summarize).toHaveBeenCalledTimes(2);
  });

  it('summarizes again when the two parents have claimed different items', async () => {
    // One parent was already told about the behaviour event, so their payload
    // is not the other parent's payload and the prose cannot be shared.
    const harness = makeHarness({
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_B },
      ],
      recipients: [
        { channel: 'telegram', address: '111', enabled: true, userId: USER_A },
        { channel: 'telegram', address: '222', enabled: true, userId: USER_B },
      ],
      candidates: [
        BEHAVIOR_CANDIDATE,
        { itemType: 'homework_new', itemId: 'hw-1', contentHash: 'hash-hw' },
      ],
      payload: makePayload({
        homeworkNew: [
          {
            id: 'hw-1',
            subjectName: 'חשבון',
            homeworkText: 'לפתור עמוד 42',
            remark: null,
            lessonDate: TODAY,
            groupId: 55,
            estimatedDueDate: null,
          },
        ],
      }),
    });
    const owned = harness.reportedFindMany as jest.Mock;
    owned
      .mockImplementationOnce(() => [{ contentHash: 'hash-beh' }, { contentHash: 'hash-hw' }])
      .mockImplementationOnce(() => [{ contentHash: 'hash-beh' }]);

    await harness.service.runAll({ now: NOW });

    expect(harness.summarizer.summarize).toHaveBeenCalledTimes(2);
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
