import { DigestService } from './digest.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { SchoolYearService } from '../common/school-year/school-year.service';
import type { DigestCheckerService } from './digest-checker.service';
import type { DigestCollectorService } from './digest-collector.service';
import type { DigestSummarizerService } from './digest-summarizer.service';
import type { DigestRecipientService } from './digest-recipient.service';
import type { DigestSender } from './senders/digest-sender.interface';
import type { DigestDismissalService, DismissalGate } from './digest-dismissal.service';
import type { DigestAttachmentResolver } from './digest-attachment.resolver';
import type { MediaDelivery } from '../telegram-media/media-delivery.interface';
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
        classification: 'attention',
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
    board: [],
    ...overrides,
  };
}

/** The subscribing parent every default fixture belongs to. */
const USER_A = 'user-a';
const USER_B = 'user-b';

interface HarnessOptions {
  targets?: { studentGuid: string; activeFrom: Date; recipientCount: number; userId: string }[];
  /** Targets the send-time ownership guard refused. */
  skipped?: { studentGuid: string; userId: string; reason: string }[];
  /** Delivery rows already on record for today, for the once-a-day check. */
  existingDeliveries?: { userId: string; studentGuid: string; status: string }[];
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
  publicBaseUrl?: string;
  checkImpl?: jest.Mock;
  dryRunEnv?: string;
  /**
   * What the dismissal gate answers for every child. The default is an open
   * gate -- the pre-gate behaviour -- so every other test in this file reads
   * as it did before the gate existed.
   */
  gate?: DismissalGate;
  attachments?: { itemType: 'homework' | 'behavior'; itemId: string; fileId: string; fileName: string }[];
  media?: Partial<MediaDelivery>;
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

  const recipientUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

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
    digestDelivery: {
      create: deliveryCreate,
      // Honours the where-clause, as Postgres would: the run asks whether it
      // has already recorded this stop today.
      findFirst: jest.fn().mockImplementation(({ where }) =>
        (options.existingDeliveries ?? []).find(
          (row) =>
            row.userId === where?.userId &&
            row.studentGuid === where?.studentGuid &&
            row.status === where?.status,
        ) ?? null,
      ),
    },
    digestRecipient: {
      updateMany: recipientUpdateMany,
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
      PUBLIC_BASE_URL: options.publicBaseUrl,
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
      prose: {
        headline: 'כותרת',
        intros: {},
        itemLines: {
          'behavior:beh-1': 'התנהגות',
          'dueTomorrow:hw-1': options.dueTomorrowLine ?? 'מחר',
          'dueTomorrow:hw-2': options.dueTomorrowLine ?? 'מחר',
        },
      },
      deadlineResolutions: options.deadlineResolutions ?? [],
      usedLlm: true,
    }),
  } as unknown as DigestSummarizerService;

  const recipients = {
    listDeliveryTargets: jest
      .fn()
      .mockResolvedValue({ targets, skipped: options.skipped ?? [] }),
  } as unknown as DigestRecipientService;

  const send = options.sendImpl ?? jest.fn().mockResolvedValue(undefined);
  const telegram = { channel: 'telegram', send } as unknown as DigestSender;
  const logSend = jest.fn().mockResolvedValue(undefined);
  const logSender = { channel: 'log', send: logSend } as unknown as DigestSender;

  const schoolYear = {
    currentSchoolYearFor: jest.fn().mockResolvedValue(2027),
  } as unknown as SchoolYearService;

  const gateFor = jest.fn().mockResolvedValue(
    options.gate ?? {
      releaseAtMinutes: null,
      lastLesson: null,
      lastLessonEnd: null,
      source: null,
    },
  );
  const dismissal = { gateFor } as unknown as DigestDismissalService;

  const resolveAttachments = jest.fn().mockResolvedValue(
    (options.attachments ?? []).map((row) => ({ ...row, studentGuid: 'stu-1' })),
  );
  const attachments = { resolve: resolveAttachments } as unknown as DigestAttachmentResolver;

  const mediaFetch = jest.fn().mockImplementation((_userId, refs) => ({
    items: refs.map((ref: unknown) => ({
      ref,
      file: { fileName: 'f', buffer: Buffer.alloc(4), contentType: null },
    })),
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

  const service = new DigestService(
    prisma,
    config,
    schoolYear,
    checker,
    collector,
    summarizer,
    recipients,
    dismissal,
    telegram,
    logSender,
    attachments,
    media,
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
    gateFor,
    recipientUpdateMany,
    resolveAttachments,
    mediaFetch,
    mediaSend,
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

  it('puts the configured site link in the message it sends', async () => {
    const harness = makeHarness({ publicBaseUrl: 'https://mashov.mitya.dev' });

    await harness.service.runAll({ now: NOW });

    // Not /home any more: the heading and the item each anchor the page they
    // are about, so the parent taps straight through to the note. See ADR-0047.
    const sent = harness.send.mock.calls[0][1] as string;
    expect(sent).toContain('https://mashov.mitya.dev/children/stu-1/behavior/beh-1');
    expect(sent).toContain('https://mashov.mitya.dev/children/stu-1?section=behavior');
    expect(sent).not.toMatch(/\/home(?!work)/);
  });

  it('sends no link when PUBLIC_BASE_URL is unset', async () => {
    const harness = makeHarness();

    await harness.service.runAll({ now: NOW });

    expect(harness.send.mock.calls[0][1]).not.toContain('undefined');
    expect(harness.send.mock.calls[0][1]).not.toMatch(/https?:\/\//);
  });

  it('retires a chat Telegram says will never accept another message', async () => {
    // A blocked bot or a deleted chat is not a transient failure. Releasing the
    // claims would re-report the same day's items on every run forever, each
    // with a fresh model call, to a chat that can never receive them.
    const harness = makeHarness({
      sendImpl: jest
        .fn()
        .mockRejectedValue(
          new Error('Telegram send failed: Forbidden: bot was blocked by the user'),
        ),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(harness.recipientUpdateMany).toHaveBeenCalledTimes(1);
    expect(harness.recipientUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { userId: USER_A, studentGuid: 'stu-1', channel: 'telegram', address: '12345' },
      data: { enabled: false },
    });
    // Confirmed rather than released: never retried.
    expect(confirmCalls(harness.updateMany)).toHaveLength(1);
    expect(harness.deleteMany).not.toHaveBeenCalled();
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toContain('blocked');
  });

  it('releases the claims for a transient failure so the next run retries', async () => {
    const harness = makeHarness({
      sendImpl: jest.fn().mockRejectedValue(new Error('Telegram send failed: HTTP 502')),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(harness.recipientUpdateMany).not.toHaveBeenCalled();
    expect(confirmCalls(harness.updateMany)).toHaveLength(0);
    expect(harness.deleteMany).toHaveBeenCalled();
    expect(results[0].status).toBe('failed');
  });

  it('still confirms for the chats that did receive it when one is retired', async () => {
    const harness = makeHarness({
      recipients: [
        { channel: 'telegram', address: 'dead', enabled: true, userId: USER_A },
        { channel: 'telegram', address: 'live', enabled: true, userId: USER_A },
      ],
      sendImpl: jest.fn().mockImplementation((address: string) => {
        if (address === 'dead') {
          throw new Error('Telegram send failed: Bad Request: chat not found');
        }
        return Promise.resolve();
      }),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0]).toMatchObject({ status: 'sent', recipientCount: 1 });
    expect(harness.recipientUpdateMany.mock.calls[0][0].where.address).toBe('dead');
    expect(confirmCalls(harness.updateMany)).toHaveLength(1);
  });

  it('retries when one chat was retired and another failed transiently', async () => {
    // The guard used to be `retired.length === 0`, which suppressed the throw
    // as soon as ANY chat refused permanently -- so the live chat's claims were
    // confirmed and the day's news was buried for it permanently, since
    // nothing ever re-reports an item already in the ledger.
    const harness = makeHarness({
      recipients: [
        { channel: 'telegram', address: 'blocked', enabled: true, userId: USER_A },
        { channel: 'telegram', address: 'flaky', enabled: true, userId: USER_A },
      ],
      sendImpl: jest.fn().mockImplementation((address: string) => {
        throw new Error(
          address === 'blocked'
            ? 'Telegram send failed: Forbidden: bot was blocked by the user'
            : 'Telegram send failed: HTTP 502',
        );
      }),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('failed');
    // The blocked chat is still retired -- that much was right.
    expect(harness.recipientUpdateMany.mock.calls[0][0].where.address).toBe('blocked');
    // But nothing is confirmed, so the next hourly run tries the live chat.
    expect(confirmCalls(harness.updateMany)).toHaveLength(0);
    expect(harness.deleteMany).toHaveBeenCalled();
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
    // A transient failure on purpose. A permanent one (a blocked bot, a
    // deleted chat) confirms instead of releasing -- see the retirement tests.
    const harness = makeHarness({
      sendImpl: jest.fn().mockRejectedValue(new Error('HTTP 502')),
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
      sendImpl: jest.fn().mockRejectedValue(new Error('HTTP 502')),
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('failed');
    expect(harness.deleteMany).toHaveBeenCalled();
  });

  it('does not let the model describe items that narrowing removed', async () => {
    // The prose is written before narrowing, so a line about an item narrowing
    // drops must not reach the parent -- and neither may the headline or the
    // section intro, both of which were written about the un-narrowed set.
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
    });
    (harness.summarizer.summarize as jest.Mock).mockResolvedValue({
      prose: {
        headline: 'שתי מטלות להגשה מחר',
        intros: { dueTomorrow: 'שתיהן באותו יום, בהיסטוריה ובגאוגרפיה' },
        itemLines: {
          'dueTomorrow:hw-1': 'בהיסטוריה יש להגיש מחר',
          'dueTomorrow:hw-2': 'בגאוגרפיה יש להגיש מחר',
        },
      },
      deadlineResolutions: [
        { ref: 'hw-1', explicitDueDate: '2026-11-18' },
        { ref: 'hw-2', explicitDueDate: '2026-11-19' },
      ],
      usedLlm: true,
    });

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1] as string;
    // hw-2 resolved to the day after tomorrow and left the section, so its
    // line goes with it...
    expect(sent).not.toContain('בגאוגרפיה');
    // ...and so do the two things written about the pair.
    expect(sent).not.toContain('שתי מטלות');
    expect(sent).not.toContain('שתיהן באותו יום');
    // What survived keeps its own sentence, which is the point of the finer
    // grain: one removed item no longer costs the section its prose.
    expect(sent).toContain('בהיסטוריה יש להגיש מחר');
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
      prose: {
        headline: 'עדכון יומי: שתי מטלות למחר',
        intros: { dueTomorrow: 'שתי מטלות למחר' },
        itemLines: { 'dueTomorrow:hw-1': 'מטלה אחת', 'dueTomorrow:hw-2': 'מטלה שנייה' },
      },
      deadlineResolutions: [{ ref: 'hw-2', explicitDueDate: '2026-11-25' }],
      usedLlm: true,
    });

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1] as string;
    // The model counted two because it was given two; only one survived -- so
    // both the headline and the section's own intro are dropped, and the
    // surviving item keeps its own line.
    expect(sent).not.toContain('שתי מטלות');
    expect(sent).not.toContain('שתי מטלות למחר');
    expect(sent).toContain('מטלה אחת');
    expect(sent).not.toContain('מטלה שנייה');
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
      prose: { headline: 'עדכון', intros: {}, itemLines: { 'behavior:beh-1': '   ' } },
      deadlineResolutions: [],
      usedLlm: true,
    });

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1] as string;
    // The deterministic sentence for the seeded behavior event. Per ITEM now:
    // a line the model skipped costs one bullet, not the section.
    expect(sent).toContain('איחור');
    expect(sent).toContain('מתמטיקה');
  });

  it('fills in only the item the model skipped, keeping the lines it did write', async () => {
    const harness = makeHarness({
      payload: makePayload({
        behavior: [
          {
            id: 'beh-1',
            achvaName: 'איחור',
            classification: 'attention',
            justifiable: true,
            subject: 'מתמטיקה',
            remark: null,
            lessonDate: TODAY,
            eventAt: NOW,
          },
          {
            id: 'beh-2',
            achvaName: 'הפרעה',
            classification: 'attention',
            justifiable: true,
            subject: 'אנגלית',
            remark: null,
            lessonDate: TODAY,
            eventAt: NOW,
          },
        ],
      }),
    });
    (harness.summarizer.summarize as jest.Mock).mockResolvedValue({
      prose: {
        headline: 'עדכון',
        intros: {},
        itemLines: { 'behavior:beh-1': 'אחר בעשר דקות', 'behavior:beh-2': '' },
      },
      deadlineResolutions: [],
      usedLlm: true,
    });

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1] as string;
    expect(sent).toContain('אחר בעשר דקות');
    // The second one falls back to its own deterministic sentence.
    expect(sent).toContain('הפרעה');
    expect(sent).toContain('אנגלית');
  });

  it('drops a line the model wrote for a ref no item has', async () => {
    // The model writes from the un-narrowed payload, so it can describe an
    // item narrowing removed -- and it can invent a ref outright.
    const harness = makeHarness();
    (harness.summarizer.summarize as jest.Mock).mockResolvedValue({
      prose: {
        headline: 'עדכון',
        intros: {},
        itemLines: { 'behavior:beh-1': 'איחור קטן', 'behavior:beh-999': 'המצאתי אירוע' },
      },
      deadlineResolutions: [],
      usedLlm: true,
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.send.mock.calls[0][1] as string).not.toContain('המצאתי');
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
      sendImpl: jest.fn().mockRejectedValue(new Error('HTTP 502')),
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

  it('does not count a suppressed send as a recipient reached', async () => {
    // `recipientCount` is what the delivery stats aggregate, so counting a
    // suppression there reports a message as having gone to two chats when it
    // went to one. The `delivered === 0` guard still has to see it -- a
    // suppressed-only run that threw would release its claims and retry the
    // same suppressed send every hour -- so the two counts are separate.
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

    expect(results.map((result) => result.recipientCount)).toEqual([1, 0]);
    expect(results.map((result) => result.status)).toEqual(['sent', 'sent']);
    expect(harness.deliveryCreate.mock.calls[1][0].data.recipientCount).toBe(0);
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

  it('suppresses a repeat to one chat per child, not across two children', async () => {
    // Two children of one parent, reported to one chat, whose rendered
    // messages happen to be identical -- two studentGuids for the same child
    // (a re-enrolment, or two schools listing them) is the shape that really
    // produces this. Keyed on channel + address + text alone, the second
    // child's send is suppressed while its claims are confirmed, so that
    // child's news is lost for good.
    const harness = makeHarness({
      targets: [
        { studentGuid: 'stu-1', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-2', activeFrom: TODAY, recipientCount: 1, userId: USER_A },
      ],
      recipients: [{ channel: 'telegram', address: '111', enabled: true, userId: USER_A }],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(results.every((result) => result.status === 'sent')).toBe(true);
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
    // A mixed day, so the model is called at all: a day whose ONLY news is a
    // form skips it entirely, which the next test pins.
    const harness = makeHarness({
      candidates: [
        BEHAVIOR_CANDIDATE,
        { itemType: 'activity', itemId: '7', contentHash: 'hash-act' },
      ],
      ownedHashes: ['hash-beh', 'hash-act'],
      payload: makePayload({
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
    expect((harness.collector.collect as jest.Mock).mock.calls[0][0].candidates).toHaveLength(2);
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
      prose: {
        headline: 'כותרת',
        intros: { activity: 'יש אישור שממתין, אבל אין לי מושג איזה' },
        itemLines: { 'activity:7': 'אין לי מושג איזה טופס' },
      },
      deadlineResolutions: [],
      usedLlm: true,
    });

    await harness.service.runAll({ now: NOW });

    const sent = harness.send.mock.calls[0][1] as string;
    expect(sent).not.toContain('אין לי מושג');
    // The template's own line for the form it actually has (ADR-0035).
    expect(sent).toContain('אישורים שממתינים לך');
    expect(sent).toContain('טיול שנתי לגליל');
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

  it('does not call the model for a run with nothing but consent forms', async () => {
    // Forms are withheld from the summarizer, so on a day whose only news is a
    // form the prompt carries no facts at all -- just the child's gender and
    // the date. The model is then asked for a headline and four section lines
    // with nothing to base them on, and `linesFor` keeps the headline it
    // invents. One Sonnet call per run, seven times a day, for prose that is
    // either discarded or made up.
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

    const results = await harness.service.runAll({ now: NOW });

    expect(harness.summarizer.summarize).not.toHaveBeenCalled();
    expect(results[0].status).toBe('sent');
    expect(results[0].usedLlm).toBe(false);
    // The section is still there, from the deterministic line.
    expect(harness.send.mock.calls[0][1]).toContain('טיול שנתי לגליל');
  });

  it('records a target the ownership guard refused, instead of going quiet', async () => {
    // Every other way a run stops writes a delivery row, which is what makes a
    // quiet child distinguishable from a broken job. A parent whose digest
    // stops because the school it was connected through is gone deserves the
    // same: without this their history simply ends, and support has nothing
    // but a log line.
    const harness = makeHarness({
      targets: [],
      skipped: [
        { studentGuid: 'stu-9', userId: USER_B, reason: 'this account no longer owns this child' },
      ],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results).toEqual([
      expect.objectContaining({
        studentGuid: 'stu-9',
        userId: USER_B,
        status: 'skipped_unowned',
        itemCount: 0,
        recipientCount: 0,
      }),
    ]);
    const row = harness.deliveryCreate.mock.calls[0][0].data;
    expect(row.status).toBe('skipped_unowned');
    expect(row.userId).toBe(USER_B);
    expect(row.errorMessage).toMatch(/no longer owns/i);
    // Nothing was checked, collected, summarized or sent for it.
    expect(harness.checker.check).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('records a refused target once a day, not once a run', async () => {
    // Seven runs a day against a permanently retired child would otherwise
    // write seven identical rows a day until the retention sweep, burying the
    // history it exists to make readable.
    const harness = makeHarness({
      targets: [],
      skipped: [{ studentGuid: 'stu-9', userId: USER_B, reason: 'no longer owns' }],
      existingDeliveries: [
        { userId: USER_B, studentGuid: 'stu-9', status: 'skipped_unowned' },
      ],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(harness.deliveryCreate).not.toHaveBeenCalled();
    // Still reported to the caller, so a manual run says what happened.
    expect(results[0]).toMatchObject({ studentGuid: 'stu-9', status: 'skipped_unowned' });
  });

  it('does not report another child’s refusal when one child is named', async () => {
    const harness = makeHarness({
      skipped: [{ studentGuid: 'stu-9', userId: USER_B, reason: 'no longer owns' }],
    });

    const results = await harness.service.runAll({ now: NOW, studentGuid: 'stu-1' });

    expect(results.map((result) => result.studentGuid)).toEqual(['stu-1']);
  });

  it('marks the delivery as not having used the model when it fell back', async () => {
    const harness = makeHarness();
    (harness.summarizer.summarize as jest.Mock).mockResolvedValue({
      prose: { headline: 'ח', behaviorLine: 'ח', homeworkLine: '', dueTomorrowLine: '' },
      deadlineResolutions: [],
      usedLlm: false,
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.deliveryCreate.mock.calls[0][0].data.usedLlm).toBe(false);
  });
});
describe('DigestService media', () => {
  const FILE = {
    itemType: 'homework' as const,
    itemId: 'hw-1',
    fileId: 'f1',
    fileName: 'דף עבודה.pdf',
  };

  it('sends the report text first and the files after it', async () => {
    // The text is the only thing gating ledger confirmation, so it goes out
    // before anything that can fail.
    const harness = makeHarness({ attachments: [FILE] });

    await harness.service.runAll({ now: NOW });

    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.mediaSend).toHaveBeenCalledTimes(1);
    expect(harness.send.mock.invocationCallOrder[0]).toBeLessThan(
      harness.mediaSend.mock.invocationCallOrder[0],
    );
  });

  it('resolves attachments only for the items it actually claimed', async () => {
    const harness = makeHarness({ attachments: [FILE] });

    await harness.service.runAll({ now: NOW });

    expect(harness.resolveAttachments).toHaveBeenCalledWith('stu-1', [BEHAVIOR_CANDIDATE]);
  });

  it('downloads as the subscribing parent, with a caption naming the item', async () => {
    const harness = makeHarness({ attachments: [FILE] });

    await harness.service.runAll({ now: NOW });

    expect(harness.mediaFetch).toHaveBeenCalledWith(
      USER_A,
      [
        {
          kind: 'homework',
          ownerId: 'stu-1',
          itemId: 'hw-1',
          fileId: 'f1',
          fileName: 'דף עבודה.pdf',
          caption: '📎 דף עבודה.pdf',
          captionParseMode: 'HTML',
        },
      ],
      expect.any(Number),
    );
  });

  it('captions a file with the item it came from and a link to it', async () => {
    // A bare filename arrived detached from the thing it belongs to. The
    // caption now says which assignment it hangs off and opens it.
    const harness = makeHarness({
      attachments: [FILE],
      publicBaseUrl: 'https://mashov.mitya.dev',
      payload: makePayload({
        homeworkNew: [
          {
            id: 'hw-1',
            subjectName: 'חשבון',
            homeworkText: 'לפתור עמוד 42',
            remark: null,
            lessonDate: TODAY,
            groupId: 55,
          },
        ],
      }),
    });

    await harness.service.runAll({ now: NOW });

    const caption = harness.mediaFetch.mock.calls[0][1][0].caption as string;
    expect(caption).toContain('📎');
    expect(caption).toContain(
      '<a href="https://mashov.mitya.dev/children/stu-1/homework/hw-1">דף עבודה.pdf</a>',
    );
    expect(caption).toContain('חשבון');
  });

  it('captions a behaviour attachment with the event type it came from', async () => {
    const harness = makeHarness({
      attachments: [{ itemType: 'behavior' as const, itemId: 'beh-1', fileId: 'f2', fileName: 'סריקה.pdf' }],
      publicBaseUrl: 'https://mashov.mitya.dev',
    });

    await harness.service.runAll({ now: NOW });

    const caption = harness.mediaFetch.mock.calls[0][1][0].caption as string;
    expect(caption).toContain('https://mashov.mitya.dev/children/stu-1/behavior/beh-1');
    // The seeded behaviour event's achvaName.
    expect(caption).toContain('איחור');
  });

  it('escapes a hostile filename in a caption', async () => {
    const harness = makeHarness({
      attachments: [{ ...FILE, fileName: '<b>x</b> & y.pdf' }],
      publicBaseUrl: 'https://mashov.mitya.dev',
    });

    await harness.service.runAll({ now: NOW });

    const caption = harness.mediaFetch.mock.calls[0][1][0].caption as string;
    expect(caption).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y.pdf');
  });

  it('keeps a caption built from a huge filename parseable and inside the ceiling', async () => {
    // truncateCaption slices at 1000 characters, which on an HTML caption can
    // land inside href="..." or between <a> and </a> -- a guaranteed parse
    // failure whose retry re-uploads the whole buffer, up to 20 MB.
    const harness = makeHarness({
      attachments: [{ ...FILE, fileName: `${'א'.repeat(5000)}.pdf` }],
      publicBaseUrl: 'https://mashov.mitya.dev',
      payload: makePayload({
        homeworkNew: [
          {
            id: 'hw-1',
            subjectName: 'ב'.repeat(3000),
            homeworkText: 'לפתור עמוד 42',
            remark: null,
            lessonDate: TODAY,
            groupId: 55,
          },
        ],
      }),
    });

    await harness.service.runAll({ now: NOW });

    const caption = harness.mediaFetch.mock.calls[0][1][0].caption as string;
    expect(caption.length).toBeLessThanOrEqual(1024);
    // Balanced, and not cut mid-tag or mid-entity.
    expect((caption.match(/<a /g) ?? []).length).toBe((caption.match(/<\/a>/g) ?? []).length);
    expect(caption).toContain('</a>');
    expect(caption).not.toMatch(/&[a-z]{0,4}$/);
    expect(caption).not.toMatch(/<[^>]*$/);
  });

  it('captions a file with no link when PUBLIC_BASE_URL is unset', async () => {
    const harness = makeHarness({ attachments: [FILE] });

    await harness.service.runAll({ now: NOW });

    expect(harness.mediaFetch.mock.calls[0][1][0].caption).not.toContain('<a href');
  });

  it('links a file too large to send to the item that holds it', async () => {
    const harness = makeHarness({
      attachments: [FILE],
      publicBaseUrl: 'https://mashov.mitya.dev',
      media: {
        fetch: jest.fn().mockResolvedValue({
          items: [
            {
              ref: { kind: 'homework', itemId: 'hw-1', fileName: 'דף עבודה.pdf' },
              tooLarge: true,
              note: 'too large',
            },
          ],
          remainingBytes: 0,
        }),
      },
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.send.mock.calls[0][1] as string).toContain(
      '<a href="https://mashov.mitya.dev/children/stu-1/homework/hw-1">דף עבודה.pdf</a>',
    );
  });

  it('names a file it could not send in the report text', async () => {
    const harness = makeHarness({
      attachments: [FILE],
      media: {
        fetch: jest.fn().mockResolvedValue({
          items: [
            {
              ref: { kind: 'homework', itemId: 'hw-1', fileName: 'דף עבודה.pdf' },
              tooLarge: true,
              note: 'too large',
            },
          ],
          remainingBytes: 0,
        }),
      },
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.send.mock.calls[0][1]).toContain('קובץ גדול מדי לשליחה: דף עבודה.pdf');
  });

  it('records a media failure as a note on the delivery row, not as a failed run', async () => {
    const harness = makeHarness({
      attachments: [FILE],
      media: { send: jest.fn().mockResolvedValue({ sent: 0, notes: ['דף עבודה.pdf: HTTP 500'] }) },
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0].status).toBe('sent');
    expect(confirmCalls(harness.updateMany)).toHaveLength(1);
    expect(harness.deliveryCreate.mock.calls[0][0].data.errorMessage).toContain('HTTP 500');
  });

  it('sends the files to every chat that received the text', async () => {
    const harness = makeHarness({
      attachments: [FILE],
      recipients: [
        { channel: 'telegram', address: '111', enabled: true, userId: USER_A },
        { channel: 'telegram', address: '222', enabled: true, userId: USER_A },
      ],
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.mediaSend.mock.calls.map((call) => call[0]).sort()).toEqual(['111', '222']);
  });

  it('sends no files to a chat whose text failed', async () => {
    const harness = makeHarness({
      attachments: [FILE],
      recipients: [
        { channel: 'telegram', address: 'dead', enabled: true, userId: USER_A },
        { channel: 'telegram', address: 'live', enabled: true, userId: USER_A },
      ],
      sendImpl: jest.fn().mockImplementation((address: string) => {
        if (address === 'dead') throw new Error('Telegram send failed: HTTP 502');
        return Promise.resolve();
      }),
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.mediaSend.mock.calls.map((call) => call[0])).toEqual(['live']);
  });

  it('touches no attachment on a dry run', async () => {
    const harness = makeHarness({ attachments: [FILE], dryRunEnv: 'true' });

    await harness.service.runAll({ now: NOW });

    expect(harness.mediaSend).not.toHaveBeenCalled();
  });

  it('resolves nothing when the media binding is disabled', async () => {
    const harness = makeHarness({
      attachments: [FILE],
      media: { enabled: false, fetch: jest.fn(), send: jest.fn() },
    });

    await harness.service.runAll({ now: NOW });

    expect(harness.resolveAttachments).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
});

describe('DigestService.runAll dismissal gate', () => {
  /** NOW is 13:00Z, which is 15:00 in Jerusalem -- 900 minutes past midnight. */
  const HELD = { releaseAtMinutes: 15 * 60 + 30, lastLesson: 8, lastLessonEnd: '15:00', source: 'default' as const };
  const RELEASED = { ...HELD, releaseAtMinutes: 15 * 60 - 1 };

  it('holds the run when the child is still in class', async () => {
    const harness = makeHarness({ gate: HELD });

    const results = await harness.service.runAll({ now: NOW });

    expect(results).toEqual([
      {
        studentGuid: 'stu-1',
        userId: USER_A,
        status: 'skipped_before_dismissal',
        itemCount: 0,
        recipientCount: 0,
        usedLlm: false,
      },
    ]);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('claims nothing while it holds', async () => {
    // The single most important invariant in the feature. A held tick that
    // claimed would mark the day's items reported, and the post-dismissal tick
    // would find a quiet day -- turning a delay into permanent suppression.
    const harness = makeHarness({ gate: HELD });

    await harness.service.runAll({ now: NOW });

    expect(harness.createMany).not.toHaveBeenCalled();
    expect(harness.updateMany).not.toHaveBeenCalled();
    expect(harness.deleteMany).not.toHaveBeenCalled();
  });

  it('holds before the checker runs, so it costs nothing', async () => {
    const harness = makeHarness({ gate: HELD });

    await harness.service.runAll({ now: NOW });

    expect(harness.checker.check).not.toHaveBeenCalled();
    expect(harness.collector.collect).not.toHaveBeenCalled();
    expect(harness.summarizer.summarize).not.toHaveBeenCalled();
  });

  it('writes no digest_delivery row for a held tick', async () => {
    // Deliberate (ADR-0040): a row per child per held hour would add ~3 noise
    // rows a day and drown the skipped_empty / skipped_stale signal that
    // GET /digest/deliveries exists to make readable. The hold is a scheduling
    // decision, not an outcome.
    const harness = makeHarness({ gate: HELD });

    await harness.service.runAll({ now: NOW });

    expect(harness.deliveryCreate).not.toHaveBeenCalled();
  });

  it('sends normally once the release time has passed', async () => {
    const harness = makeHarness({ gate: RELEASED });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0]).toMatchObject({ status: 'sent' });
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('sends at exactly the release minute', async () => {
    const harness = makeHarness({ gate: { ...HELD, releaseAtMinutes: 15 * 60 } });

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0]).toMatchObject({ status: 'sent' });
  });

  it('never holds a child whose timetable has nothing for today', async () => {
    // The open gate is the default fixture; asserted explicitly because
    // missing data holding a digest back would be the feature's worst failure.
    const harness = makeHarness();

    const results = await harness.service.runAll({ now: NOW });

    expect(results[0]).toMatchObject({ status: 'sent' });
  });

  it('bypasses the gate for a manual run', async () => {
    // A parent pressing the button is asking for the digest now; the gate
    // exists to stop unattended noise, not to refuse an explicit request.
    const harness = makeHarness({ gate: HELD });

    const results = await harness.service.runAll({ now: NOW, ignoreDismissalGate: true });

    expect(results[0]).toMatchObject({ status: 'sent' });
    expect(harness.gateFor).not.toHaveBeenCalled();
  });

  it('asks the gate once for a child two parents subscribe to', async () => {
    const harness = makeHarness({
      gate: HELD,
      targets: [
        { studentGuid: 'stu-1', activeFrom: new Date('2026-09-01T00:00:00Z'), recipientCount: 1, userId: USER_A },
        { studentGuid: 'stu-1', activeFrom: new Date('2026-09-01T00:00:00Z'), recipientCount: 1, userId: USER_B },
      ],
    });

    const results = await harness.service.runAll({ now: NOW });

    expect(results.map((result) => result.status)).toEqual([
      'skipped_before_dismissal',
      'skipped_before_dismissal',
    ]);
    expect(harness.gateFor).toHaveBeenCalledTimes(1);
  });

  it('gates on the Jerusalem wall clock, not on UTC', async () => {
    // 09:00Z in November is 11:00 in Jerusalem. A child released at 11:50 must
    // still be held -- and a gate that read UTC would see 09:00 and hold a
    // child who had already gone home at 09:30.
    const harness = makeHarness({ gate: { ...HELD, releaseAtMinutes: 11 * 60 + 50 } });

    const held = await harness.service.runAll({ now: new Date('2026-11-17T09:00:00Z') });
    expect(held[0]).toMatchObject({ status: 'skipped_before_dismissal' });

    const sent = await harness.service.runAll({ now: new Date('2026-11-17T10:00:00Z') });
    expect(sent[0]).toMatchObject({ status: 'sent' });
  });

  it('asks the gate for the school day the run covers', async () => {
    const harness = makeHarness({ gate: HELD });

    await harness.service.runAll({ now: NOW });

    expect(harness.gateFor).toHaveBeenCalledWith('stu-1', 2027, TODAY);
  });
});
