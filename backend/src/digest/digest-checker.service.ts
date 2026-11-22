import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { schoolYearScope } from '../common/school-year/school-year.scope';
import { DigestDeadlineService, hasDeadlineHint, jerusalemDayBounds } from './digest-deadline.service';
import { DigestCandidate, DigestItemType } from './digest.types';

/**
 * How long a claimed-but-unconfirmed row is respected before another run may
 * take it over. A row stays unconfirmed only when the run that claimed it died
 * between claiming and sending, which means nothing was delivered -- so the
 * item must come back rather than be lost. Long enough that a slow LLM call
 * plus a slow Telegram call cannot trip it.
 */
export const STALE_CLAIM_MS = 30 * 60 * 1000;

const DEFAULT_TIMEZONE = 'Asia/Jerusalem';
const DEFAULT_DUE_LOOKBACK_DAYS = 14;

/**
 * How far back to look for homework to report as newly assigned.
 *
 * Not today-only. Israeli teachers routinely enter homework in the evening,
 * after the 19:00 run, and `lessonDate` is the lesson's date -- so a
 * today-only window loses that assignment permanently: tomorrow's window is
 * tomorrow, and a plain assignment ("שאלות על הלוח") trips no deadline hint
 * either, so nothing else picks it up. There is no `firstSeenAt` column to key
 * off, since `updatedAt` is churned by the 12-minute sync upserts.
 *
 * Widening is safe because dedup is by content hash: anything already reported
 * stays reported, and only genuinely unreported late arrivals come through,
 * bounded further by the recipient's activeFrom. Three days covers an evening
 * entry plus a weekend.
 */
const DEFAULT_NEW_LOOKBACK_DAYS = 3;

/**
 * How far ahead an unanswered consent deadline becomes worth mentioning.
 *
 * Long enough that a parent has time to act, short enough that a form due in
 * March is not in today's message. A form stays reportable until it is
 * answered or the deadline passes, but the content hash covers `isAnswered`,
 * so answering it is what stops it coming back.
 */
const DEFAULT_ACTIVITY_WINDOW_DAYS = 7;

/**
 * Behaviour event codes the digest never reports.
 *
 * `18` is נוכחות -- a presence row Mashov writes for every lesson of every
 * day. It is the single largest source of behaviour rows in the table and
 * tells a parent nothing they did not assume: the child was at school.
 *
 * Filtered by event CODE and not by `classification`. 18 is not in
 * `DEFAULT_CLASSIFICATION_MAP` (behavior-classifier.service.ts:11), so it is
 * `neutral` only through the fallback -- which is also what every *unknown*
 * code gets. Filtering on the bucket would therefore swallow, silently and
 * permanently, every code a school adds after this was written.
 */
const DEFAULT_MUTED_BEHAVIOR_CODES = [18];

export interface DigestCheckInput {
  studentGuid: string;
  schoolYear: number;
  now: Date;
  /**
   * The earliest `activeFrom` among the child's enabled recipients. Items dated
   * before it are never reported, which is what stops the first run after a
   * parent signs up blasting the whole school year at them.
   */
  activeFrom: Date;
  /**
   * The subscribing parent this run reports to. Required: the dedup ledger is
   * per (child, user), so a check that does not know whose it is cannot ask
   * whether *they* have been told. It is also what keys the one input class
   * that is not per child -- consent forms, where
   * `/api/schoolActivities/permitted` takes no studentGuid and `isAnswered`
   * belongs to a parent. Empty means no owning user is known (a ledger row
   * left at the schema default) and activities are skipped.
   */
  userId: string;
}

export interface DigestCheckResult {
  candidates: DigestCandidate[];
  /** The school day this run covers, UTC midnight of the Jerusalem date. */
  reportFor: Date;
}

/** Row shapes the checker selects. Narrower than the Prisma models on purpose. */
interface BehaviorCandidateRow {
  id: string;
  eventCode: number;
  achvaName: string;
  classification: string;
  justifiable: boolean;
  subject: string;
  remark: string | null;
  lessonDate: Date;
  eventAt: Date;
}

interface ReleaseCandidateRow {
  releaseId: number;
  releaseDate: Date;
  startHour: string;
  remark: string | null;
  status: number;
}

interface ActivityCandidateRow {
  activityId: number;
  title: string;
  activityStartDate: Date;
  endAnswerDate: Date | null;
}

interface HomeworkCandidateRow {
  id: string;
  groupId: number;
  subjectName: string;
  homeworkText: string;
  remark: string | null;
  lessonDate: Date;
}

/**
 * Decides cheaply whether a child has anything unreported, and names it.
 *
 * Runs per child, seven times a day, so it is four narrow queries plus one
 * dedup lookup -- no model calls and no upstream HTTP. The LLM cannot be the
 * gate here; see `hasDeadlineHint`.
 */
@Injectable()
export class DigestCheckerService {
  /**
   * Parsed once. A per-query parse would re-split the same string seven times
   * a day per child, and the value cannot change without a restart anyway.
   */
  private mutedBehaviorCodes?: number[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly deadlines: DigestDeadlineService,
  ) {}

  async check(input: DigestCheckInput): Promise<DigestCheckResult> {
    const { studentGuid, schoolYear, now, activeFrom, userId } = input;
    const timeZone = this.config.get<string>('DIGEST_TIMEZONE') ?? DEFAULT_TIMEZONE;
    const { todayStart, tomorrowStart, reportFor } = jerusalemDayBounds(now, timeZone);
    const yearScope = schoolYearScope(schoolYear);

    const candidates: InternalCandidate[] = [
      ...(await this.behaviorToday(studentGuid, yearScope, todayStart, tomorrowStart)),
      ...(await this.homeworkAssignedRecently(studentGuid, yearScope, todayStart, tomorrowStart)),
      ...(await this.homeworkDueTomorrow(
        studentGuid,
        schoolYear,
        yearScope,
        todayStart,
        tomorrowStart,
      )),
      ...(await this.releasesSoon(studentGuid, yearScope, todayStart, tomorrowStart)),
      ...(await this.activitiesAwaitingAnswer(userId, yearScope, todayStart)),
      // activeFrom is a timestamp (now() when the recipient was created) while
      // lessonDate is a date at UTC midnight. Comparing them directly
      // suppressed every homework item on the sign-up day while still
      // reporting that day's behavior, whose eventAt is later in the day.
    ].filter(
      (candidate) => candidate.itemDate >= jerusalemDayBounds(activeFrom, timeZone).todayStart,
    );

    const unreported = await this.dropAlreadyReported(
      userId,
      studentGuid,
      candidates,
      now,
      tomorrowStart,
    );

    return {
      candidates: unreported,
      reportFor,
    };
  }

  /**
   * Behavior carries two dates: `lessonDate` (when the event happened) and
   * `eventAt` (when the teacher recorded it). Matching on either means a
   * teacher entering yesterday's absence this afternoon still reaches the
   * parent today, which is exactly the news they want. Widening cannot cause a
   * repeat, because dedup is by contentHash.
   */
  private async behaviorToday(
    studentGuid: string,
    yearScope: ReturnType<typeof schoolYearScope>,
    todayStart: Date,
    tomorrowStart: Date,
  ): Promise<InternalCandidate[]> {
    const rows = (await this.prisma.behaviorItem.findMany({
      where: {
        studentGuid,
        ...yearScope,
        // Excluded in the QUERY, not after it. A row the checker returns is a
        // row the run claims, and a claim with nothing in the payload behind
        // it is released by settleUnsent and re-claimed on the next run --
        // seven times a day, forever -- while summaryFor still spends a model
        // call on it and renders a message with no sections. Excluded here, an
        // attendance-only day is a genuinely quiet day.
        eventCode: { notIn: this.readMutedBehaviorCodes() },
        OR: [
          { lessonDate: { gte: todayStart, lt: tomorrowStart } },
          { eventAt: { gte: todayStart, lt: tomorrowStart } },
        ],
      },
      select: {
        id: true,
        eventCode: true,
        achvaName: true,
        classification: true,
        justifiable: true,
        subject: true,
        remark: true,
        lessonDate: true,
        eventAt: true,
      },
    })) as BehaviorCandidateRow[];

    return rows.map((row) => ({
      itemType: 'behavior' as DigestItemType,
      itemId: row.id,
      contentHash: hashFields('behavior', [
        row.id,
        String(row.eventCode),
        row.achvaName,
        row.classification,
        String(row.justifiable),
        row.subject,
        row.remark ?? '',
        row.lessonDate.toISOString(),
      ]),
      // The later of the two dates: an event recorded today is today's news even
      // when it happened yesterday, so activeFrom must not exclude it.
      itemDate: row.eventAt > row.lessonDate ? row.eventAt : row.lessonDate,
    }));
  }

  private async homeworkAssignedRecently(
    studentGuid: string,
    yearScope: ReturnType<typeof schoolYearScope>,
    todayStart: Date,
    tomorrowStart: Date,
  ): Promise<InternalCandidate[]> {
    const rows = (await this.prisma.homeworkItem.findMany({
      where: {
        studentGuid,
        ...yearScope,
        lessonDate: {
          gte: daysBefore(todayStart, this.readDays('DIGEST_NEW_LOOKBACK_DAYS', DEFAULT_NEW_LOOKBACK_DAYS)),
          lt: tomorrowStart,
        },
      },
      select: HOMEWORK_SELECT,
    })) as HomeworkCandidateRow[];

    return rows.map((row) => ({
      itemType: 'homework_new' as DigestItemType,
      itemId: row.id,
      contentHash: hashHomework('homework_new', row),
      itemDate: row.lessonDate,
    }));
  }

  /**
   * Homework that may be needed tomorrow. A row qualifies if the timetable puts
   * its group's next lesson tomorrow, or if the Hebrew text names a deadline of
   * its own -- the second condition widens the set so the LLM can resolve a
   * deadline the timetable would have missed, and the LLM narrows it afterwards.
   *
   * Mashov has no due-date field, so this is an estimate throughout; the report
   * labels it as one. See ADR-0027.
   */
  /**
   * Early releases scheduled for today or tomorrow.
   *
   * Deliberately narrow. The parent filed these themselves, so a release three
   * weeks out is not news -- it is their own form read back to them. What has
   * value is the reminder on the day, and the second parent who never saw the
   * request. Deleted requests are excluded in the query rather than filtered
   * after, so a cancelled release can never be announced.
   */
  private async releasesSoon(
    studentGuid: string,
    yearScope: ReturnType<typeof schoolYearScope>,
    todayStart: Date,
    tomorrowStart: Date,
  ): Promise<InternalCandidate[]> {
    const dayAfterTomorrow = new Date(tomorrowStart.getTime() + 24 * 60 * 60 * 1000);

    const rows = (await this.prisma.studentRelease.findMany({
      where: {
        studentGuid,
        ...yearScope,
        isDeleted: false,
        releaseDate: { gte: todayStart, lt: dayAfterTomorrow },
      },
      select: {
        releaseId: true,
        releaseDate: true,
        startHour: true,
        remark: true,
        status: true,
      },
    })) as ReleaseCandidateRow[];

    return rows.map((row) => ({
      itemType: 'release' as DigestItemType,
      itemId: String(row.releaseId),
      contentHash: hashFields('release', [
        String(row.releaseId),
        row.releaseDate.toISOString(),
        row.startHour,
        row.remark ?? '',
        String(row.status),
      ]),
      itemDate: row.releaseDate,
    }));
  }

  /**
   * Consent forms this household has not answered, with the deadline near.
   *
   * The only household-scoped input the digest has. The hash covers the
   * `userId`, which is what makes the cross-child dedup in
   * `dropAlreadyReported` household-wide rather than school-wide: two children
   * of the same parent share a hash and the form is reported once, while the
   * same form for a different parent hashes differently and is still reported
   * to them.
   */
  private async activitiesAwaitingAnswer(
    userId: string,
    yearScope: ReturnType<typeof schoolYearScope>,
    todayStart: Date,
  ): Promise<InternalCandidate[]> {
    if (!userId) return [];

    const horizon = new Date(
      Date.UTC(
        todayStart.getUTCFullYear(),
        todayStart.getUTCMonth(),
        todayStart.getUTCDate() +
          this.readDays('DIGEST_ACTIVITY_WINDOW_DAYS', DEFAULT_ACTIVITY_WINDOW_DAYS),
      ),
    );

    const rows = (await this.prisma.schoolActivity.findMany({
      where: {
        userId,
        ...yearScope,
        isAnswered: false,
        // A deadline that has already passed is not actionable, and nagging
        // about it would be the only thing in the message every single day.
        //
        // This also excludes an activity with NO deadline, and correctly: a
        // comparison against NULL is never true in SQL, and there is nothing to
        // remind the parent about by. The guard below says so in the types.
        endAnswerDate: { gte: todayStart, lt: horizon },
      },
      select: {
        activityId: true,
        title: true,
        activityStartDate: true,
        endAnswerDate: true,
      },
    })) as ActivityCandidateRow[];

    return rows
      .filter(
        (row): row is ActivityCandidateRow & { endAnswerDate: Date } =>
          row.endAnswerDate !== null,
      )
      .map((row) => ({
        itemType: 'activity' as DigestItemType,
        itemId: String(row.activityId),
        contentHash: hashFields('activity', [
          userId,
          String(row.activityId),
          row.title,
          row.endAnswerDate.toISOString(),
        ]),
        // Future-dated by definition, so the activeFrom cutoff never excludes a
        // form -- which is right: a deadline is a deadline whenever you signed up.
        itemDate: row.endAnswerDate,
      }));
  }

  private async homeworkDueTomorrow(
    studentGuid: string,
    schoolYear: number,
    yearScope: ReturnType<typeof schoolYearScope>,
    todayStart: Date,
    tomorrowStart: Date,
  ): Promise<InternalCandidate[]> {
    const lookbackStart = daysBefore(
      todayStart,
      this.readDays('DIGEST_DUE_LOOKBACK_DAYS', DEFAULT_DUE_LOOKBACK_DAYS),
    );

    const rows = (await this.prisma.homeworkItem.findMany({
      where: {
        studentGuid,
        ...yearScope,
        lessonDate: { gte: lookbackStart, lt: tomorrowStart },
      },
      select: HOMEWORK_SELECT,
    })) as HomeworkCandidateRow[];

    // A 14-day lookback returns many rows sharing a group, and the estimate
    // depends only on (group, day) -- so resolve each group once per run rather
    // than once per homework row.
    const estimateByGroup = new Map<number, Date | null>();
    const estimateFor = async (groupId: number): Promise<Date | null> => {
      const memoed = estimateByGroup.get(groupId);
      if (memoed !== undefined) return memoed;
      const resolved = await this.deadlines.estimateFromTimetable(
        studentGuid,
        schoolYear,
        groupId,
        todayStart,
      );
      estimateByGroup.set(groupId, resolved);
      return resolved;
    };

    const candidates: InternalCandidate[] = [];
    for (const row of rows) {
      const estimated = await estimateFor(row.groupId);
      const dueTomorrow = estimated !== null && estimated.getTime() === tomorrowStart.getTime();
      const textHint = hasDeadlineHint(row.homeworkText);
      if (!dueTomorrow && !textHint) continue;

      candidates.push({
        itemType: 'homework_due' as DigestItemType,
        itemId: row.id,
        contentHash: hashHomework('homework_due', row),
        estimatedDueDate: estimated,
        hasTextHint: textHint,
        itemDate: row.lessonDate,
      });
    }

    return candidates;
  }

  /**
   * One query for the whole batch. A row already in the ledger means the item
   * was reported -- unless it was claimed and never confirmed, in which case the
   * run that owned it died before sending and the item has to come back.
   */
  private async dropAlreadyReported(
    userId: string,
    studentGuid: string,
    candidates: InternalCandidate[],
    now: Date,
    tomorrowStart: Date,
  ): Promise<InternalCandidate[]> {
    if (candidates.length === 0) return [];

    const SELECT = {
      contentHash: true,
      confirmedAt: true,
      claimedAt: true,
      resolvedDueDate: true,
    } as const;

    // Both arms are scoped to this subscribing parent: the ledger is per
    // (child, user), so another parent having been told something says nothing
    // about whether this one has.
    //
    // Per-child inputs are then deduped per child. Consent forms belong to the
    // parent rather than the child, so theirs is looked up across children: the
    // form was already sent to them if *any* of their children's runs reported
    // it. That is why the activity arm omits `studentGuid` -- and why it needs
    // the `[userId, contentHash]` index to stay cheap.
    const childHashes = candidates
      .filter((candidate) => candidate.itemType !== 'activity')
      .map((candidate) => candidate.contentHash);
    const householdHashes = candidates
      .filter((candidate) => candidate.itemType === 'activity')
      .map((candidate) => candidate.contentHash);

    const rows = [
      ...(childHashes.length > 0
        ? await this.prisma.digestReportedItem.findMany({
            where: { userId, studentGuid, contentHash: { in: childHashes } },
            select: SELECT,
          })
        : []),
      ...(householdHashes.length > 0
        ? await this.prisma.digestReportedItem.findMany({
            where: { userId, contentHash: { in: householdHashes } },
            select: SELECT,
          })
        : []),
    ];

    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
    const spokenFor = new Set(
      rows.filter((row) => isSpokenFor(row, staleBefore, tomorrowStart)).map((r) => r.contentHash),
    );

    return candidates.filter((candidate) => !spokenFor.has(candidate.contentHash));
  }

  private readDays(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string | number>(key));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  /**
   * `DIGEST_MUTED_BEHAVIOR_CODES` as a comma-separated list of event codes.
   *
   * Unset means the default. Set-but-empty means mute nothing, which is the
   * kill switch: an operator who needs the raw stream back should not have to
   * find a code that means "none". Non-numeric entries are dropped rather
   * than failing the run -- a typo must not take the digest down.
   */
  private readMutedBehaviorCodes(): number[] {
    if (this.mutedBehaviorCodes !== undefined) return this.mutedBehaviorCodes;

    const raw = this.config.get<string>('DIGEST_MUTED_BEHAVIOR_CODES');
    if (raw === undefined || raw === null) {
      this.mutedBehaviorCodes = DEFAULT_MUTED_BEHAVIOR_CODES;
      return this.mutedBehaviorCodes;
    }

    this.mutedBehaviorCodes = String(raw)
      .split(',')
      .map((part) => part.trim())
      // Before Number(), not after: Number('') is 0, so an empty entry would
      // mute event code 0 rather than nothing -- which is the opposite of what
      // an operator setting the var to empty asked for.
      .filter((part) => part.length > 0)
      .map((part) => Number(part))
      .filter((code) => Number.isInteger(code));
    return this.mutedBehaviorCodes;
  }
}

/** A candidate plus the date `activeFrom` is compared against. */
interface InternalCandidate extends DigestCandidate {
  itemDate: Date;
}

const HOMEWORK_SELECT = {
  id: true,
  groupId: true,
  subjectName: true,
  homeworkText: true,
  remark: true,
  lessonDate: true,
} as const;

/**
 * sha256 over exactly the fields the parent will see, prefixed by the reason the
 * item is being reported so the same homework row can be reported once as newly
 * assigned and later as estimated-due.
 *
 * Never include `updatedAt`: the 12-minute sync tasks upsert identical rows and
 * churn it on every pass, which would make every item look new every hour.
 */
function hashFields(itemType: string, fields: string[]): string {
  return createHash('sha256').update([itemType, ...fields].join('\u0000')).digest('hex');
}

function hashHomework(itemType: DigestItemType, row: HomeworkCandidateRow): string {
  return hashFields(itemType, [
    row.id,
    row.subjectName,
    row.homeworkText,
    row.remark ?? '',
    row.lessonDate.toISOString(),
  ]);
}

/**
 * Whether a ledger row means "do not report this again, for now".
 *
 * A confirmed row with no `resolvedDueDate` is fully reported. A confirmed row
 * *with* one was deferred by the orchestrator to that date, and must come back
 * on the day that date is tomorrow -- otherwise a homework item whose text said
 * "hand in Thursday" is silently buried on Wednesday, which is exactly the day
 * the parent needed to hear about it.
 *
 * An unconfirmed row belongs to a run that is still working, unless it has sat
 * there past the staleness window, in which case that run died before sending
 * and the item has to be picked up again.
 */
function isSpokenFor(
  row: { confirmedAt: Date | null; claimedAt: Date; resolvedDueDate?: Date | null },
  staleBefore: Date,
  tomorrowStart: Date,
): boolean {
  if (row.confirmedAt !== null) {
    // Absent and null both mean "not deferred, fully reported".
    if (!row.resolvedDueDate) return true;
    return row.resolvedDueDate.getTime() !== tomorrowStart.getTime();
  }
  return row.claimedAt > staleBefore;
}

/** UTC-midnight date `days` before `from`. Date.UTC normalises the underflow. */
function daysBefore(from: Date, days: number): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - days),
  );
}
